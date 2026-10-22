/**
 * OAuth 2.1 account linking for Alexa+ (real HTTP server on an ephemeral port):
 * authorize -> consent -> code -> token (PKCE S256) -> MCP with the access
 * token -> refresh rotation, plus the negative paths.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseServerEnv, ServerConfigError } from './config.js';
import { isDiscoveryOnly } from './http.js';
import { connectClient, startServer, TOKEN, type Started } from './test-helpers.js';

const CLIENT_ID = 'alexa-standin-test';
const SECRET = 'test-client-secret-0123456789abcdef';
const REDIRECT = 'https://alexa.amazon.com/api/skill/link/M3TESTVENDOR';
const REDIRECT_EU = 'https://layla.amazon.com/api/skill/link/M3TESTVENDOR';
const PASSCODE = 'open-sesame-42';

const OAUTH_ENV = {
  OAUTH_CLIENT_ID: CLIENT_ID,
  OAUTH_CLIENT_SECRET: SECRET,
  OAUTH_REDIRECT_URIS: `${REDIRECT}, ${REDIRECT_EU}`,
};

let started: Started[] = [];
afterEach(async () => {
  for (const s of started) await s.close();
  started = [];
});

interface Clock {
  t: number;
}

async function server(env: Record<string, string> = {}, opts: { clock?: Clock; sqlitePath?: string } = {}): Promise<Started> {
  const clock = opts.clock;
  const s = await startServer(
    { ...OAUTH_ENV, ...env },
    {
      ...(clock !== undefined ? { oauthNow: () => clock.t } : {}),
      ...(opts.sqlitePath !== undefined ? { providersEnv: { STANDIN_MODE: 'offline', SQLITE_PATH: opts.sqlitePath } } : {}),
    },
  );
  started.push(s);
  return s;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl(s: Started, challenge: string, over: Record<string, string | null> = {}): string {
  const p: Record<string, string | null> = {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'standin',
    state: 'alexa-state-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${s.url}/mcp`,
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== null) q.set(k, v);
  return `${s.url}/authorize?${q.toString()}`;
}

interface Consent {
  status: number;
  html: string;
  pending: string;
  csrf: string;
  location: string | null;
}

async function openConsent(url: string): Promise<Consent> {
  const r = await fetch(url, { redirect: 'manual' });
  const html = await r.text();
  return {
    status: r.status,
    html,
    pending: /name="pending" value="([^"]+)"/.exec(html)?.[1] ?? '',
    csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '',
    location: r.headers.get('location'),
  };
}

async function submitConsent(s: Started, c: Consent, form: Record<string, string> = {}, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${s.url}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: s.url, ...extraHeaders },
    body: new URLSearchParams({ pending: c.pending, csrf: c.csrf, action: 'approve', ...form }).toString(),
  });
}

/** authorize -> consent -> approve; returns the code from the redirect. */
async function getCode(s: Started, challenge: string, over: Record<string, string | null> = {}, form: Record<string, string> = {}): Promise<string> {
  const c = await openConsent(authorizeUrl(s, challenge, over));
  expect(c.status).toBe(200);
  const r = await submitConsent(s, c, form);
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get('location') ?? '');
  const code = loc.searchParams.get('code');
  if (code === null) throw new Error(`no code in redirect: ${loc.searchParams.get('error') ?? ''}`);
  return code;
}

function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
}

async function token(s: Started, form: Record<string, string>, opts: { auth?: 'basic' | 'post' | 'none'; secret?: string } = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const auth = opts.auth ?? 'basic';
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(form);
  if (auth === 'basic') headers.authorization = basic(CLIENT_ID, opts.secret ?? SECRET);
  if (auth === 'post') {
    body.set('client_id', CLIENT_ID);
    body.set('client_secret', opts.secret ?? SECRET);
  }
  if (auth === 'none') body.set('client_id', CLIENT_ID);
  const r = await fetch(`${s.url}/token`, { method: 'POST', headers, body: body.toString() });
  return { status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers };
}

async function exchange(s: Started, code: string, verifier: string, extra: Record<string, string> = {}, opts: { auth?: 'basic' | 'post' | 'none'; secret?: string } = {}) {
  return token(s, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${s.url}/mcp`, ...extra }, opts);
}

/** Full link: returns a fresh token pair. */
async function link(s: Started): Promise<{ access: string; refresh: string }> {
  const { verifier, challenge } = pkce();
  const code = await getCode(s, challenge);
  const t = await exchange(s, code, verifier);
  expect(t.status).toBe(200);
  return { access: String(t.body.access_token), refresh: String(t.body.refresh_token) };
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Alexa+ MCP Client', version: '1.0.0' } },
};

function mcpPost(s: Started, headers: Record<string, string> = {}, body: unknown = INIT, path = '/mcp'): Promise<Response> {
  return fetch(`${s.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

async function expect401(r: Response): Promise<void> {
  expect(r.status).toBe(401);
  expect(r.headers.get('www-authenticate')).toBeNull();
  await r.text();
}

describe('OAuth happy path', () => {
  it('authorize -> consent -> code -> token (PKCE) -> MCP initialize + tools/list -> refresh rotation', async () => {
    const s = await server();
    const { verifier, challenge } = pkce();
    const consent = await openConsent(authorizeUrl(s, challenge));
    expect(consent.status).toBe(200);
    expect(consent.html).toContain('Link Stand-In to Alexa for Mahal');
    expect(consent.html).not.toContain('name="passcode"');
    expect(consent.pending).not.toBe('');

    const approved = await submitConsent(s, consent);
    expect(approved.status).toBe(302);
    const loc = new URL(approved.headers.get('location') ?? '');
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('alexa-state-123');
    expect(loc.searchParams.get('iss')).toBe(s.url);
    const code = loc.searchParams.get('code') ?? '';
    expect(code.length).toBeGreaterThan(30);

    const t = await exchange(s, code, verifier);
    expect(t.status).toBe(200);
    expect(t.headers.get('cache-control')).toBe('no-store');
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'standin' });
    expect(typeof t.body.access_token).toBe('string');
    expect(typeof t.body.refresh_token).toBe('string');

    const { client } = await connectClient(s.url, { token: String(t.body.access_token) });
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name)).toContain('open_case');
    await client.close();

    // Refresh (no resource parameter, like Alexa), client_secret_post this time.
    const r1 = await token(s, { grant_type: 'refresh_token', refresh_token: String(t.body.refresh_token) }, { auth: 'post' });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t.body.refresh_token);
    expect(r1.body.access_token).not.toBe(t.body.access_token);
    expect(r1.body).toMatchObject({ token_type: 'Bearer', scope: 'standin' });
    const init = await mcpPost(s, { authorization: `Bearer ${String(r1.body.access_token)}` });
    expect(init.status).toBe(200);
    await init.text();

    // The rotated-out refresh token no longer works.
    const again = await token(s, { grant_type: 'refresh_token', refresh_token: String(t.body.refresh_token) });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('serves metadata documents that agree with each other and with the endpoints', async () => {
    const s = await server();
    const prm = (await (await fetch(`${s.url}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    const as = (await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${s.url}/mcp`);
    expect(prm.authorization_servers).toEqual([as.issuer]);
    expect(prm.bearer_methods_supported).toEqual(['header']);
    expect(prm.scopes_supported).toEqual(as.scopes_supported);
    expect(prm.scopes_supported).toEqual(['standin']);
    expect(as).toMatchObject({
      issuer: s.url,
      authorization_endpoint: `${s.url}/authorize`,
      token_endpoint: `${s.url}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    });
    expect(JSON.stringify(as)).not.toContain('registration_endpoint');
    // The advertised endpoints exist.
    const authz = await fetch(String(as.authorization_endpoint));
    expect(authz.status).toBe(400); // no client_id: error page, not a 404
    expect(authz.headers.get('content-type')).toMatch(/text\/html/);
    await authz.text();
    const tok = await fetch(String(as.token_endpoint), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code' });
    expect(tok.status).toBe(401);
    expect(await tok.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('uses PUBLIC_BASE_URL for issuer, resource and the token audience', async () => {
    const s = await server({ PUBLIC_BASE_URL: 'https://standin.example.com', OAUTH_LINK_PASSCODE: PASSCODE });
    const prm = (await (await fetch(`${s.url}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe('https://standin.example.com/mcp');
    expect(prm.authorization_servers).toEqual(['https://standin.example.com']);
    const { challenge } = pkce();
    // The local URL is not the canonical resource any more.
    const c = await openConsent(authorizeUrl(s, challenge));
    expect(c.status).toBe(302);
    expect(new URL(c.location ?? '').searchParams.get('error')).toBe('invalid_target');
    const ok = await openConsent(authorizeUrl(s, challenge, { resource: 'https://standin.example.com/mcp' }));
    expect(ok.status).toBe(200);
  });

  it('keeps STANDIN_TOKEN working alongside OAuth', async () => {
    const s = await server();
    const r = await mcpPost(s, { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    await r.text();
  });

  it('persists tokens in SQLite so a restart does not unlink Alexa', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'standin-oauth-'));
    const dbPath = join(dir, 'standin.db');
    const a = await server({}, { sqlitePath: dbPath });
    const pair = await link(a);
    await a.close();
    started = started.filter((x) => x !== a);
    const b = await server({}, { sqlitePath: dbPath });
    // The token audience is the canonical URI (http://127.0.0.1:<port>/mcp) and the port changed,
    // so check the refresh grant, which carries the audience of the original grant.
    const r = await token(b, { grant_type: 'refresh_token', refresh_token: pair.refresh });
    expect(r.status).toBe(200);
    expect(typeof r.body.access_token).toBe('string');
  });
});

describe('authorization request validation', () => {
  it('rejects plain or missing PKCE challenges with a redirect error', async () => {
    const s = await server();
    const { challenge } = pkce();
    for (const over of [{ code_challenge_method: 'plain' }, { code_challenge_method: null }, { code_challenge: null }, { code_challenge: 'short' }]) {
      const c = await openConsent(authorizeUrl(s, challenge, over));
      expect(c.status).toBe(302);
      const loc = new URL(c.location ?? '');
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('state')).toBe('alexa-state-123');
      expect(loc.searchParams.get('code')).toBeNull();
    }
  });

  it('unknown client: error page, no redirect', async () => {
    const s = await server();
    const { challenge } = pkce();
    const c = await openConsent(authorizeUrl(s, challenge, { client_id: 'someone-else' }));
    expect(c.status).toBe(400);
    expect(c.location).toBeNull();
    expect(c.html).toContain('Unknown client');
  });

  it('unregistered or near-miss redirect_uri: error page, never a redirect', async () => {
    const s = await server();
    const { challenge } = pkce();
    for (const redirect_uri of ['https://evil.example/cb', `${REDIRECT}/`, `${REDIRECT}?x=1`, REDIRECT.toUpperCase(), null]) {
      const c = await openConsent(authorizeUrl(s, challenge, { redirect_uri }));
      expect(c.status).toBe(400);
      expect(c.location).toBeNull();
      expect(c.html).toContain('Redirect URI not registered');
    }
  });

  it('accepts every registered redirect URI and returns to exactly that one', async () => {
    const s = await server();
    const { verifier, challenge } = pkce();
    const code = await getCode(s, challenge, { redirect_uri: REDIRECT_EU });
    const t = await token(s, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_EU, code_verifier: verifier, resource: `${s.url}/mcp` });
    expect(t.status).toBe(200);
  });

  it('wrong resource or unsupported scope or response_type: redirect errors', async () => {
    const s = await server();
    const { challenge } = pkce();
    const cases: [Record<string, string | null>, string][] = [
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
      [{ resource: null }, 'invalid_target'],
      [{ resource: `${s.url}/mcp/` }, 'invalid_target'],
      [{ scope: 'standin admin' }, 'invalid_scope'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
    ];
    for (const [over, error] of cases) {
      const c = await openConsent(authorizeUrl(s, challenge, over));
      expect(c.status).toBe(302);
      expect(new URL(c.location ?? '').searchParams.get('error')).toBe(error);
    }
    // Omitting scope is allowed.
    const ok = await openConsent(authorizeUrl(s, challenge, { scope: null }));
    expect(ok.status).toBe(200);
  });

  it('Deny redirects with access_denied; a bad CSRF token is refused', async () => {
    const s = await server();
    const { challenge } = pkce();
    const c = await openConsent(authorizeUrl(s, challenge));
    const bad = await submitConsent(s, { ...c, csrf: 'forged' });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('location')).toBeNull();
    await bad.text();
    const deny = await submitConsent(s, c, { action: 'deny' });
    expect(deny.status).toBe(302);
    const loc = new URL(deny.headers.get('location') ?? '');
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('alexa-state-123');
    // The pending request is single-use.
    const replay = await submitConsent(s, c);
    expect(replay.status).toBe(400);
    await replay.text();
  });

  it('asks for OAUTH_LINK_PASSCODE when set and checks it', async () => {
    const s = await server({ OAUTH_LINK_PASSCODE: PASSCODE });
    const { verifier, challenge } = pkce();
    const c = await openConsent(authorizeUrl(s, challenge));
    expect(c.html).toContain('name="passcode"');
    const none = await submitConsent(s, c);
    expect(none.status).toBe(400);
    expect(none.headers.get('location')).toBeNull();
    expect(await none.text()).toContain('passcode is not right');
    const wrong = await submitConsent(s, c, { passcode: 'nope' });
    expect(wrong.status).toBe(400);
    await wrong.text();
    const right = await submitConsent(s, c, { passcode: PASSCODE });
    expect(right.status).toBe(302);
    const code = new URL(right.headers.get('location') ?? '').searchParams.get('code') ?? '';
    expect((await exchange(s, code, verifier)).status).toBe(200);
  });

  it('gives up after repeated wrong passcodes', async () => {
    const s = await server({ OAUTH_LINK_PASSCODE: PASSCODE });
    const { challenge } = pkce();
    const c = await openConsent(authorizeUrl(s, challenge));
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) {
      last = await submitConsent(s, c, { passcode: `wrong-${i}` });
      if (last.status === 302) break;
      await last.text();
    }
    expect(last?.status).toBe(302);
    expect(new URL(last?.headers.get('location') ?? '').searchParams.get('error')).toBe('access_denied');
  });

  it('opening new linking requests does not reset the per-IP wrong-passcode budget', async () => {
    // 30 per hour globally -> 10 per client IP.
    const s = await server({ OAUTH_LINK_PASSCODE: PASSCODE, OAUTH_PASSCODE_MAX_FAILURES: '30', TRUST_PROXY: 'true' });
    const attacker = { 'x-forwarded-for': '203.0.113.7' };
    const { challenge } = pkce();
    for (let cycle = 0; cycle < 5; cycle++) {
      const c = await openConsent(authorizeUrl(s, challenge));
      expect(c.status).toBe(200);
      for (let i = 0; i < 2; i++) {
        const r = await submitConsent(s, c, { passcode: `guess-${cycle}-${i}` }, attacker);
        expect(r.status).toBe(400);
        await r.text();
      }
    }
    // Budget spent: even the right passcode from that address is refused, with no redirect and no code.
    const fresh = await openConsent(authorizeUrl(s, challenge));
    const locked = await submitConsent(s, fresh, { passcode: PASSCODE }, attacker);
    expect(locked.status).toBe(429);
    expect(locked.headers.get('location')).toBeNull();
    expect(await locked.text()).toContain('temporarily locked');
    // The owner on another address can still link.
    const { verifier, challenge: ownerChallenge } = pkce();
    const owner = await openConsent(authorizeUrl(s, ownerChallenge));
    const ok = await submitConsent(s, owner, { passcode: PASSCODE }, { 'x-forwarded-for': '198.51.100.9' });
    expect(ok.status).toBe(302);
    const code = new URL(ok.headers.get('location') ?? '').searchParams.get('code') ?? '';
    expect((await exchange(s, code, verifier)).status).toBe(200);
  });

  it('a global wrong-passcode budget locks approvals across all addresses for the window', async () => {
    const clock = { t: Date.now() };
    const s = await server({ OAUTH_LINK_PASSCODE: PASSCODE, OAUTH_PASSCODE_MAX_FAILURES: '3', TRUST_PROXY: 'true' }, { clock });
    const { challenge } = pkce();
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      const c = await openConsent(authorizeUrl(s, challenge));
      const r = await submitConsent(s, c, { passcode: 'wrong-guess' }, { 'x-forwarded-for': ip });
      expect(r.status).toBe(400);
      await r.text();
    }
    const c = await openConsent(authorizeUrl(s, challenge));
    const locked = await submitConsent(s, c, { passcode: PASSCODE }, { 'x-forwarded-for': '198.51.100.9' });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('location')).toBeNull();
    await locked.text();
    // After the rolling hour the lock clears.
    clock.t += 61 * 60 * 1000;
    const later = await openConsent(authorizeUrl(s, challenge));
    const ok = await submitConsent(s, later, { passcode: PASSCODE }, { 'x-forwarded-for': '198.51.100.9' });
    expect(ok.status).toBe(302);
    expect(new URL(ok.headers.get('location') ?? '').searchParams.get('code')).not.toBeNull();
  });
});

describe('token endpoint', () => {
  it('wrong PKCE verifier -> invalid_grant', async () => {
    const s = await server();
    const { challenge } = pkce();
    const code = await getCode(s, challenge);
    const t = await exchange(s, code, pkce().verifier);
    expect(t.status).toBe(400);
    expect(t.body.error).toBe('invalid_grant');
  });

  it('mismatched redirect_uri or resource at the token step', async () => {
    const s = await server();
    const { verifier, challenge } = pkce();
    const code1 = await getCode(s, challenge);
    expect((await exchange(s, code1, verifier, { redirect_uri: REDIRECT_EU })).body.error).toBe('invalid_grant');
    const code2 = await getCode(s, challenge);
    expect((await exchange(s, code2, verifier, { resource: 'https://other.example/mcp' })).body.error).toBe('invalid_target');
  });

  it('a code works once; reuse fails and revokes the tokens it produced', async () => {
    const s = await server();
    const { verifier, challenge } = pkce();
    const code = await getCode(s, challenge);
    const first = await exchange(s, code, verifier);
    expect(first.status).toBe(200);
    const ok = await mcpPost(s, { authorization: `Bearer ${String(first.body.access_token)}` });
    expect(ok.status).toBe(200);
    await ok.text();
    const second = await exchange(s, code, verifier);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
    await expect401(await mcpPost(s, { authorization: `Bearer ${String(first.body.access_token)}` }));
    expect((await token(s, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token) })).body.error).toBe('invalid_grant');
  });

  it('expired code -> invalid_grant', async () => {
    const clock = { t: Date.now() };
    const s = await server({}, { clock });
    const { verifier, challenge } = pkce();
    const code = await getCode(s, challenge);
    clock.t += 61_000;
    const t = await exchange(s, code, verifier);
    expect(t.status).toBe(400);
    expect(t.body.error).toBe('invalid_grant');
  });

  it('bad client secret via Basic and via POST body -> 401 invalid_client', async () => {
    const s = await server();
    const { verifier, challenge } = pkce();
    const code = await getCode(s, challenge);
    const b = await exchange(s, code, verifier, {}, { auth: 'basic', secret: 'wrong-secret-0123456789' });
    expect(b.status).toBe(401);
    expect(b.body.error).toBe('invalid_client');
    const p = await exchange(s, code, verifier, {}, { auth: 'post', secret: 'wrong-secret-0123456789' });
    expect(p.status).toBe(401);
    expect(p.body.error).toBe('invalid_client');
    const none = await exchange(s, code, verifier, {}, { auth: 'none' });
    expect(none.status).toBe(401);
    // A failed client authentication does not burn the code.
    expect((await exchange(s, code, verifier, {}, { auth: 'post' })).status).toBe(200);
  });

  it('rejects parameters in the query string and non-form bodies', async () => {
    const s = await server();
    const q = await fetch(`${s.url}/token?client_secret=${SECRET}&grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(CLIENT_ID, SECRET) },
      body: 'refresh_token=x',
    });
    expect(q.status).toBe(400);
    expect(await q.json()).toMatchObject({ error: 'invalid_request' });
    const j = await fetch(`${s.url}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(j.status).toBe(400);
    await j.text();
    const g = await fetch(`${s.url}/token`);
    expect(g.status).toBe(405);
    await g.text();
  });

  it('reusing a rotated refresh token revokes the whole family', async () => {
    const s = await server();
    const pair = await link(s);
    const r1 = await token(s, { grant_type: 'refresh_token', refresh_token: pair.refresh });
    expect(r1.status).toBe(200);
    const live = String(r1.body.access_token);
    const ok = await mcpPost(s, { authorization: `Bearer ${live}` });
    expect(ok.status).toBe(200);
    await ok.text();
    // Replay of the old refresh token: refused, and every token of the family dies.
    const replay = await token(s, { grant_type: 'refresh_token', refresh_token: pair.refresh });
    expect(replay.body.error).toBe('invalid_grant');
    await expect401(await mcpPost(s, { authorization: `Bearer ${live}` }));
    expect((await token(s, { grant_type: 'refresh_token', refresh_token: String(r1.body.refresh_token) })).body.error).toBe('invalid_grant');
  });

  it('expired access token -> 401 without WWW-Authenticate; refresh still works', async () => {
    const clock = { t: Date.now() };
    const s = await server({}, { clock });
    const pair = await link(s);
    clock.t += 3601_000;
    await expect401(await mcpPost(s, { authorization: `Bearer ${pair.access}` }));
    const r = await token(s, { grant_type: 'refresh_token', refresh_token: pair.refresh });
    expect(r.status).toBe(200);
    const ok = await mcpPost(s, { authorization: `Bearer ${String(r.body.access_token)}` });
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it('a token in the query string is never accepted', async () => {
    const s = await server();
    const pair = await link(s);
    await expect401(await mcpPost(s, {}, INIT, `/mcp?access_token=${pair.access}`));
    await expect401(await mcpPost(s, {}, INIT, `/mcp?access_token=${TOKEN}`));
    // Even alongside a valid header.
    await expect401(await mcpPost(s, { authorization: `Bearer ${pair.access}` }, INIT, `/mcp?access_token=${pair.access}`));
  });

  it('unsupported grant types are refused (client_credentials is off by default)', async () => {
    const s = await server();
    const r = await token(s, { grant_type: 'client_credentials', scope: 'mcp:service', resource: `${s.url}/mcp` });
    expect(r.body.error).toBe('unsupported_grant_type');
    const p = await token(s, { grant_type: 'password', username: 'a', password: 'b' });
    expect(p.body.error).toBe('unsupported_grant_type');
  });
});

describe('client variants and discovery', () => {
  it('public client (no secret): PKCE-only, advertises auth method none, refuses a presented secret', async () => {
    const s = await server({ OAUTH_CLIENT_SECRET: '' });
    const as = (await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.token_endpoint_auth_methods_supported).toEqual(['none']);
    const { verifier, challenge } = pkce();
    const code = await getCode(s, challenge);
    expect((await exchange(s, code, verifier, {}, { auth: 'post', secret: 'some-secret-value-123' })).status).toBe(401);
    expect((await exchange(s, code, verifier, {}, { auth: 'none' })).status).toBe(200);
  });

  it('Tier 1 client_credentials (opt-in): mcp:service only, no refresh token, discovery only', async () => {
    const s = await server({ OAUTH_CLIENT_CREDENTIALS: 'true' });
    const as = (await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.grant_types_supported).toContain('client_credentials');
    expect(as.scopes_supported).toContain('mcp:service');
    const bad = await token(s, { grant_type: 'client_credentials', scope: 'mcp:tools', resource: `${s.url}/mcp` });
    expect(bad.body.error).toBe('invalid_scope');
    const noRes = await token(s, { grant_type: 'client_credentials', scope: 'mcp:service' });
    expect(noRes.body.error).toBe('invalid_request');
    const r = await token(s, { grant_type: 'client_credentials', scope: 'mcp:service', resource: `${s.url}/mcp` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token_type: 'Bearer', scope: 'mcp:service' });
    expect(Number(r.body.expires_in)).toBeLessThanOrEqual(3600);
    expect(r.body.refresh_token).toBeUndefined();
    const auth = { authorization: `Bearer ${String(r.body.access_token)}` };
    const init = await mcpPost(s, auth);
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id') ?? '';
    await init.text();
    const list = await mcpPost(s, { ...auth, 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
    await list.text();
    // A user-specific tool call with a service token starts account linking.
    await expect401(await mcpPost(s, { ...auth, 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_cases', arguments: {} } }));
    const cfg = () => parseServerEnv({ STANDIN_TOKEN: TOKEN, ...OAUTH_ENV, OAUTH_CLIENT_SECRET: '', OAUTH_CLIENT_CREDENTIALS: 'true' });
    expect(cfg).toThrow(/OAUTH_CLIENT_SECRET/);
  });

  it('MCP_PUBLIC_DISCOVERY lets initialize/tools/list through without a token; tools/call is 401', async () => {
    const off = await server();
    await expect401(await mcpPost(off));
    const s = await server({ MCP_PUBLIC_DISCOVERY: 'true' });
    const init = await mcpPost(s);
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id') ?? '';
    await init.text();
    const list = await mcpPost(s, { 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('open_case');
    await expect401(await mcpPost(s, { 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_cases', arguments: {} } }));
    await expect401(await mcpPost(s, { 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'standin://cases/x' } }));
    // An invalid token is still a 401 (Alexa refreshes or relinks), not anonymous discovery.
    await expect401(await mcpPost(s, { authorization: 'Bearer nope' }));
    const get = await fetch(`${s.url}/mcp`, { headers: { 'mcp-session-id': sid, accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
    await get.text();
    // A linked user continues on the same server with full access.
    const pair = await link(s);
    const { client } = await connectClient(s.url, { token: pair.access });
    const cases = await client.callTool({ name: 'list_cases', arguments: {} });
    expect(cases.isError).not.toBe(true);
    await client.close();
  });

  it('isDiscoveryOnly classifies JSON-RPC bodies', () => {
    expect(isDiscoveryOnly({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).toBe(true);
    expect(isDiscoveryOnly([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])).toBe(true);
    expect(isDiscoveryOnly({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://standin/call-card' } })).toBe(true);
    expect(isDiscoveryOnly({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'standin://cases/1' } })).toBe(false);
    expect(isDiscoveryOnly({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })).toBe(false);
    expect(isDiscoveryOnly([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call' }])).toBe(false);
    expect(isDiscoveryOnly({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
    expect(isDiscoveryOnly([])).toBe(false);
  });

  it('without OAUTH_CLIENT_ID the endpoints say linking is not configured', async () => {
    const s = await startServer();
    started.push(s);
    const a = await fetch(`${s.url}/authorize?client_id=x`);
    expect(a.status).toBe(503);
    await a.text();
    const t = await fetch(`${s.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token' });
    expect(t.status).toBe(503);
    expect(await t.json()).toMatchObject({ error: 'temporarily_unavailable' });
  });
});

describe('OAuth configuration', () => {
  const base = { STANDIN_TOKEN: TOKEN, ...OAUTH_ENV };
  it('requires PUBLIC_BASE_URL (https) when bound beyond loopback', () => {
    expect(() => parseServerEnv({ ...base, HOST: '0.0.0.0' })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => parseServerEnv({ ...base, HOST: '0.0.0.0', PUBLIC_BASE_URL: 'http://standin.example.com' })).toThrow(/PUBLIC_BASE_URL/);
    expect(parseServerEnv({ ...base, HOST: '0.0.0.0', PUBLIC_BASE_URL: 'https://standin.example.com', OAUTH_LINK_PASSCODE: PASSCODE }).OAUTH_CLIENT_ID).toBe(CLIENT_ID);
  });

  it('a public deployment needs both a passcode and a client secret', () => {
    const variables = (env: Record<string, string>): string[] => {
      try {
        parseServerEnv(env);
        return [];
      } catch (err) {
        expect(err).toBeInstanceOf(ServerConfigError);
        expect((err as Error).message).not.toContain(SECRET);
        return (err as ServerConfigError).variables;
      }
    };
    const pub = { ...base, PUBLIC_BASE_URL: 'https://standin.example.com' };
    // Public URL (even when bound to loopback behind a tunnel), no passcode.
    expect(variables(pub)).toEqual(['OAUTH_LINK_PASSCODE']);
    expect(variables({ ...pub, HOST: '0.0.0.0' })).toEqual(['OAUTH_LINK_PASSCODE']);
    // Public client (no secret) on a public URL: anyone could redeem a self-approved code.
    expect(variables({ ...pub, OAUTH_CLIENT_SECRET: '', OAUTH_LINK_PASSCODE: PASSCODE })).toEqual(['OAUTH_CLIENT_SECRET']);
    expect(variables({ ...pub, OAUTH_CLIENT_SECRET: '' })).toEqual(['OAUTH_CLIENT_SECRET', 'OAUTH_LINK_PASSCODE']);
    // Short passcodes are rejected.
    expect(variables({ ...pub, OAUTH_LINK_PASSCODE: '1234' })).toEqual(['OAUTH_LINK_PASSCODE']);
    expect(variables({ ...pub, OAUTH_LINK_PASSCODE: PASSCODE })).toEqual([]);
    // Loopback-only dev servers may still use a public client without a passcode.
    expect(variables({ ...base, OAUTH_CLIENT_SECRET: '' })).toEqual([]);
    expect(variables({ ...base, PUBLIC_BASE_URL: 'http://127.0.0.1:8787' })).toEqual([]);
  });

  it('validates redirect URIs, scopes, and names variables, never values', () => {
    for (const uris of ['not a url', 'http://alexa.amazon.com/cb', 'https://a.example/cb#frag', 'javascript:alert(1)']) {
      try {
        parseServerEnv({ ...base, OAUTH_REDIRECT_URIS: uris });
        throw new Error('expected a config error');
      } catch (err) {
        expect(err).toBeInstanceOf(ServerConfigError);
        expect((err as ServerConfigError).variables).toEqual(['OAUTH_REDIRECT_URIS']);
        expect((err as Error).message).not.toContain(SECRET);
      }
    }
    expect(() => parseServerEnv({ ...base, OAUTH_CLIENT_SECRET: 'short' })).toThrow(/OAUTH_CLIENT_SECRET/);
    expect(() => parseServerEnv({ STANDIN_TOKEN: TOKEN, OAUTH_CLIENT_SECRET: SECRET })).toThrow(/OAUTH_CLIENT_ID/);
    expect(parseServerEnv({ ...base, OAUTH_SCOPES: 'standin, mcp:tools standin' }).OAUTH_SCOPES).toEqual(['standin', 'mcp:tools']);
    expect(parseServerEnv({ ...base, OAUTH_REDIRECT_URIS: 'http://localhost:9999/cb' }).OAUTH_REDIRECT_URIS).toEqual(['http://localhost:9999/cb']);
  });
});
