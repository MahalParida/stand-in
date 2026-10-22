/** HTTP layer: auth (401 without WWW-Authenticate), Origin/Host checks, rate limit, discovery, sim API, static. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { SimConfigSchema } from '@standin/core';
import { afterEach, describe, expect, it } from 'vitest';
import { connectClient, startServer, TOKEN, type Started } from './test-helpers.js';

let started: Started[] = [];
afterEach(async () => {
  for (const s of started) await s.close();
  started = [];
});
async function server(env: Record<string, string> = {}, staticDir?: string): Promise<Started> {
  const s = await startServer(env, staticDir === undefined ? {} : { staticDir });
  started.push(s);
  return s;
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'curl', version: '1' } },
};

function mcpPost(url: string, headers: Record<string, string> = {}, body: unknown = INIT): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

describe('/mcp auth', () => {
  it('401 WITHOUT a WWW-Authenticate header when unauthenticated or the token is wrong', async () => {
    const s = await server();
    const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer wrong-token' }, { authorization: `Basic ${TOKEN}` }, { authorization: 'Bearer' }];
    for (const headers of attempts) {
      const r = await mcpPost(s.url, headers);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toBeNull();
      expect(await r.json()).toEqual({ error: 'unauthorized' });
    }
    const get = await fetch(`${s.url}/mcp`);
    expect(get.status).toBe(401);
    expect(get.headers.get('www-authenticate')).toBeNull();
  });

  it('accepts the Bearer token and runs a stateful session (initialize, Mcp-Session-Id, DELETE)', async () => {
    const s = await server();
    const r = await mcpPost(s.url, { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    const sid = r.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    await r.text();
    expect(s.server.sessionCount()).toBe(1);
    const noSession = await mcpPost(s.url, { authorization: `Bearer ${TOKEN}` }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(noSession.status).toBe(400);
    const badSession = await mcpPost(s.url, { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': 'nope' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(badSession.status).toBe(404);
    const del = await fetch(`${s.url}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sid ?? '' } });
    expect(del.status).toBe(200);
    expect(s.server.sessionCount()).toBe(0);
  });

  it('rejects invalid JSON bodies with 400', async () => {
    const s = await server();
    const r = await fetch(`${s.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{not json' });
    expect(r.status).toBe(400);
  });
});

describe('Origin / Host validation', () => {
  it('403 for a foreign Origin even with a valid token', async () => {
    const s = await server();
    const r = await mcpPost(s.url, { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'forbidden_origin' });
    const nul = await mcpPost(s.url, { authorization: `Bearer ${TOKEN}`, origin: 'null' });
    expect(nul.status).toBe(403);
  });

  it('allows same-origin and allowlisted Origins (with CORS headers for the allowlist)', async () => {
    const s = await server({ STANDIN_ALLOWED_ORIGINS: 'http://localhost:5173, https://demo.example' });
    const same = await mcpPost(s.url, { authorization: `Bearer ${TOKEN}`, origin: s.url });
    expect(same.status).toBe(200);
    await same.text();
    const listed = await mcpPost(s.url, { authorization: `Bearer ${TOKEN}`, origin: 'http://localhost:5173' });
    expect(listed.status).toBe(200);
    expect(listed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(listed.headers.get('access-control-expose-headers')).toMatch(/Mcp-Session-Id/);
    await listed.text();
    const pre = await fetch(`${s.url}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://demo.example', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    const badPre = await fetch(`${s.url}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(badPre.status).toBe(403);
  });

  it('403 for a non-loopback Host header when bound to 127.0.0.1 (DNS rebinding)', async () => {
    const s = await server();
    const port = new URL(s.url).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: `rebind.evil.example:${port}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(INIT));
    });
    expect(status).toBe(403);
  });
});

describe('rate limit', () => {
  it('429 with Retry-After once the per-IP bucket is empty', async () => {
    const s = await server({ RATE_LIMIT_BURST: '3', RATE_LIMIT_RPS: '0.01' });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${s.url}/sim/config`);
      statuses.push(r.status);
      if (r.status === 429) expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
      await r.text();
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    // Unauthenticated /mcp attempts count too (brute force).
    const r = await mcpPost(s.url);
    expect(r.status).toBe(429);
    // Public discovery is not rate limited.
    expect((await fetch(`${s.url}/health`)).status).toBe(200);
  });
});

describe('rate limit behind a trusted proxy', () => {
  it('spoofed X-Forwarded-For values do not buy a fresh bucket (TRUST_PROXY=true)', async () => {
    const s = await server({ TRUST_PROXY: 'true', RATE_LIMIT_BURST: '2', RATE_LIMIT_RPS: '0.01' });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      // The proxy appends the real client address (198.51.100.20); the client rotates the left part.
      const r = await fetch(`${s.url}/sim/api/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': `10.0.0.${i}, 198.51.100.20` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      });
      statuses.push(r.status);
      await r.text();
    }
    expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
  });
});

describe('idle MCP sessions', () => {
  it('a session with an open SSE stream is not swept; one without is (404 Session not found)', async () => {
    const s = await server({ SESSION_IDLE_MS: '300' });
    // SDK client: opens the standalone GET SSE stream after initialize.
    const { client } = await connectClient(s.url);
    // Raw client: initialize only, no stream.
    const init = await mcpPost(s.url, { authorization: `Bearer ${TOKEN}` });
    expect(init.status).toBe(200);
    await init.text();
    const sid = init.headers.get('mcp-session-id') ?? '';
    expect(sid).not.toBe('');
    await new Promise((r) => setTimeout(r, 1200));
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    const stale = await fetch(`${s.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sid, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(stale.status).toBe(404);
    expect(await stale.text()).toContain('Session not found');
    await client.close();
  });
});

describe('MCP session caps (no lock-out)', () => {
  const post = (url: string, ip: string, sid?: string): Promise<Response> =>
    mcpPost(
      url,
      { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': ip, ...(sid === undefined ? {} : { 'mcp-session-id': sid, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION }) },
      sid === undefined ? INIT : { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    );
  const init = async (url: string, ip: string): Promise<string> => {
    const r = await post(url, ip);
    expect(r.status).toBe(200);
    await r.text();
    const sid = r.headers.get('mcp-session-id') ?? '';
    expect(sid).not.toBe('');
    return sid;
  };

  it('N+1 initializes from one IP evict that IP\'s oldest session and never block a second IP', async () => {
    const s = await server({ TRUST_PROXY: 'true', MAX_SESSIONS_PER_IP: '3', MAX_SESSIONS: '50' });
    const attacker: string[] = [];
    for (let i = 0; i < 10; i++) attacker.push(await init(s.url, '203.0.113.66'));
    expect(s.server.sessionCount()).toBe(3);
    // The attacker's oldest sessions are gone, the newest 3 remain.
    const first = await post(s.url, '203.0.113.66', attacker[0]);
    expect(first.status).toBe(404);
    await first.text();
    const last = await post(s.url, '203.0.113.66', attacker[9]);
    expect(last.status).toBe(200);
    await last.text();
    // A second client is admitted and its session works.
    const judge = await init(s.url, '198.51.100.7');
    const ok = await post(s.url, '198.51.100.7', judge);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('open_case');
  });

  it('at the global cap a new session evicts the least-recently-seen one instead of 503', async () => {
    const s = await server({ TRUST_PROXY: 'true', MAX_SESSIONS_PER_IP: '2', MAX_SESSIONS: '4' });
    const sids: string[] = [];
    for (let i = 0; i < 4; i++) sids.push(await init(s.url, `203.0.113.${i + 1}`));
    // Touch session 0 so session 1 is the least recently seen.
    await new Promise((r) => setTimeout(r, 5));
    const touch = await post(s.url, '203.0.113.1', sids[0]);
    expect(touch.status).toBe(200);
    await touch.text();
    const judge = await init(s.url, '198.51.100.7');
    expect(s.server.sessionCount()).toBe(4);
    const evicted = await post(s.url, '203.0.113.2', sids[1]);
    expect(evicted.status).toBe(404);
    await evicted.text();
    const kept = await post(s.url, '203.0.113.1', sids[0]);
    expect(kept.status).toBe(200);
    await kept.text();
    const mine = await post(s.url, '198.51.100.7', judge);
    expect(mine.status).toBe(200);
    await mine.text();
  });

  it('an open SSE stream keeps an idle session alive only up to SESSION_STREAM_MAX_IDLE_MS', async () => {
    const s = await server({ SESSION_IDLE_MS: '200', SESSION_STREAM_MAX_IDLE_MS: '500' });
    const { client } = await connectClient(s.url);
    expect(s.server.sessionCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(s.server.sessionCount()).toBe(0);
    await client.close().catch(() => undefined);
  });
});

describe('discovery and health', () => {
  it('serves /health and both RFC 9728 / RFC 8414 documents publicly', async () => {
    const s = await server();
    const h = await fetch(`${s.url}/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ ok: true, mode: 'offline' });
    const prm = (await (await fetch(`${s.url}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe(`${s.url}/mcp`);
    expect(prm.authorization_servers).toEqual([s.url]);
    expect(prm.bearer_methods_supported).toEqual(['header']);
    const prm2 = await fetch(`${s.url}/.well-known/oauth-protected-resource/mcp`);
    expect(prm2.status).toBe(200);
    await prm2.text();
    const as = (await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.issuer).toBe(s.url);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.response_types_supported).toEqual(['code']);
  });

  it('uses PUBLIC_BASE_URL when set', async () => {
    const s = await server({ PUBLIC_BASE_URL: 'https://standin.example.com/' });
    const prm = (await (await fetch(`${s.url}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(prm.resource).toBe('https://standin.example.com/mcp');
  });
});

describe('/sim endpoints', () => {
  it('/sim/config: no demoToken unless DEMO_EMBED_TOKEN=true', async () => {
    const a = await server();
    const cfg = SimConfigSchema.parse(await (await fetch(`${a.url}/sim/config`)).json());
    expect(cfg).toEqual({ mode: 'offline', llm: 'scripted', tts: 'browser' });
    const b = await server({ DEMO_EMBED_TOKEN: 'true' });
    const cfg2 = SimConfigSchema.parse(await (await fetch(`${b.url}/sim/config`)).json());
    expect(cfg2.demoToken).toBe(TOKEN);
  });

  it('/sim/api/tts: Bearer required; offline answers 204 (browser speechSynthesis); bad input 400', async () => {
    const s = await server();
    const body = JSON.stringify({ text: 'Hello there', voice: 'alexa' });
    const noAuth = await fetch(`${s.url}/sim/api/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toBeNull();
    const ok = await fetch(`${s.url}/sim/api/tts`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body });
    expect(ok.status).toBe(204);
    const bad = await fetch(`${s.url}/sim/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ text: '', voice: 'robot' }),
    });
    expect(bad.status).toBe(400);
  });

  it('/sim/api/llm: Bearer required, input validated', async () => {
    const s = await server();
    const noAuth = await fetch(`${s.url}/sim/api/llm`, { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    const bad = await fetch(`${s.url}/sim/api/llm`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ messages: [] }) });
    expect(bad.status).toBe(400);
  });
});

describe('static alexa-sim', () => {
  it('serves a placeholder when apps/alexa-sim/dist is missing', async () => {
    const s = await server();
    const r = await fetch(`${s.url}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(await r.text()).toMatch(/Stand-In MCP server/);
  });

  it('serves files, falls back to index.html for SPA routes, and never escapes the dist folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'standin-dist-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>sim</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    const s = await server({}, dir);
    const root = await fetch(`${s.url}/`);
    expect(await root.text()).toContain('<title>sim</title>');
    const js = await fetch(`${s.url}/assets/app.js`);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(js.headers.get('cache-control')).toMatch(/immutable/);
    expect(await js.text()).toBe('console.log(1)');
    const spa = await fetch(`${s.url}/autoplay/otp?x=1`);
    expect(await spa.text()).toContain('<title>sim</title>');
    expect((await fetch(`${s.url}/assets/missing.js`)).status).toBe(404);
    const trav = await fetch(`${s.url}/%2e%2e/%2e%2e/package.json`);
    expect(await trav.text()).not.toContain('"name"');
    expect((await fetch(`${s.url}/`, { method: 'PUT' })).status).toBe(405);
  });
});

describe('MCP client with a wrong token', () => {
  it('fails to connect', async () => {
    const s = await server();
    await expect(connectClient(s.url, { token: 'nope-nope-nope' })).rejects.toThrow();
  });
});
