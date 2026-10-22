/**
 * Built-in OAuth 2.1 authorization server for Alexa+ account linking.
 *
 *   GET  /authorize   validates the request, shows a consent page (CSRF token, optional passcode)
 *   POST /authorize   Approve / Deny -> redirect to the registered redirect_uri with code or error
 *   POST /token       authorization_code (PKCE S256), refresh_token (rotation, reuse revokes the
 *                     family), optional client_credentials (Tier 1, mcp:service only)
 *
 * One pre-registered client from env (no dynamic registration). Codes and tokens
 * are opaque random strings stored as SHA-256 hashes (see oauth-store.ts).
 * Codes, verifiers, secrets and tokens are never logged.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ServerEnv } from './config.js';
import { hashSecret, type NewToken, type OAuthStore } from './oauth-store.js';
import { consentPage, errorPage } from './pages.js';

export const SERVICE_SCOPE = 'mcp:service';
const FORM_BODY_LIMIT = 16 * 1024;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 500;
const MAX_PASSCODE_ATTEMPTS = 5;
/** Rolling window for the global and per-IP wrong-passcode budgets. */
export const PASSCODE_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_IPS = 10_000;
const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export type OAuthEnv = Pick<
  ServerEnv,
  | 'OAUTH_CLIENT_ID'
  | 'OAUTH_CLIENT_SECRET'
  | 'OAUTH_REDIRECT_URIS'
  | 'OAUTH_SCOPES'
  | 'OAUTH_LINK_PASSCODE'
  | 'OAUTH_ACCESS_TTL_SEC'
  | 'OAUTH_REFRESH_TTL_DAYS'
  | 'OAUTH_CODE_TTL_SEC'
  | 'OAUTH_CLIENT_CREDENTIALS'
  | 'OAUTH_PASSCODE_MAX_FAILURES'
  | 'STANDIN_USER_NAME'
>;

interface OAuthClient {
  id: string;
  /** sha256 of the secret; undefined = public client (PKCE only). */
  secretDigest: Buffer | undefined;
  redirectUris: ReadonlySet<string>;
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  state: string | undefined;
  codeChallenge: string;
  csrf: string;
  expiresMs: number;
  attempts: number;
}

export interface AccessGrant {
  clientId: string;
  scope: string;
  /** True for a Tier 1 client_credentials token: discovery only, no user data. */
  serviceOnly: boolean;
}

export interface OAuthServerOptions {
  env: OAuthEnv;
  /** Undefined when OAuth is not configured. */
  store: OAuthStore | undefined;
  /** Issuer / public base URL for this request (no trailing slash). */
  baseUrl: (req: IncomingMessage) => string;
  /** The canonical MCP resource URI for this request. */
  resourceUrl: (req: IncomingMessage) => string;
  now: () => number;
  log: (line: string) => void;
  /** Client address for the per-IP passcode budget (default: the socket's remote address). */
  clientIp?: (req: IncomingMessage) => string;
}

/**
 * Wrong-passcode budget that survives new linking requests: a rolling-hour
 * window of failures counted globally and per client IP. Opening a fresh
 * /authorize request does not reset it, so the passcode cannot be brute-forced
 * by cycling pending requests.
 */
export class PasscodeLockout {
  private readonly global: number[] = [];
  private readonly perIp = new Map<string, number[]>();
  readonly maxPerIp: number;

  constructor(
    readonly maxGlobal: number,
    private readonly now: () => number,
    private readonly windowMs = PASSCODE_FAILURE_WINDOW_MS,
  ) {
    this.maxPerIp = Math.max(1, Math.floor(maxGlobal / 3));
  }

  private prune(list: number[]): number[] {
    const cutoff = this.now() - this.windowMs;
    while (list.length > 0 && (list[0] ?? 0) <= cutoff) list.shift();
    return list;
  }

  /** 'global' / 'ip' when approvals must be refused right now, else undefined. */
  locked(ip: string): 'global' | 'ip' | undefined {
    if (this.prune(this.global).length >= this.maxGlobal) return 'global';
    const mine = this.perIp.get(ip);
    if (mine !== undefined && this.prune(mine).length >= this.maxPerIp) return 'ip';
    return undefined;
  }

  recordFailure(ip: string): void {
    const t = this.now();
    this.global.push(t);
    let mine = this.perIp.get(ip);
    if (mine === undefined) {
      if (this.perIp.size >= MAX_TRACKED_IPS) this.sweep();
      if (this.perIp.size >= MAX_TRACKED_IPS) {
        const oldest = this.perIp.keys().next();
        if (oldest.done !== true) this.perIp.delete(oldest.value);
      }
      mine = [];
      this.perIp.set(ip, mine);
    }
    mine.push(t);
  }

  sweep(): void {
    this.prune(this.global);
    for (const [ip, list] of this.perIp) if (this.prune(list).length === 0) this.perIp.delete(ip);
  }
}

export interface OAuthServer {
  readonly enabled: boolean;
  handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
  handleToken(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
  /** A live access token issued for `resource`, or undefined. */
  verifyAccessToken(token: string, resource: string): AccessGrant | undefined;
  /** RFC 8414 metadata. */
  authorizationServerMetadata(req: IncomingMessage): Record<string, unknown>;
  /** scopes_supported for the RFC 9728 document. */
  readonly scopes: readonly string[];
  sweep(): void;
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time string equality (both sides hashed first, so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function random(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

class FormError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  if (!ct.startsWith('application/x-www-form-urlencoded')) throw new FormError(400, 'invalid_request');
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > FORM_BODY_LIMIT) throw new FormError(413, 'invalid_request');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.length;
    if (size > FORM_BODY_LIMIT) throw new FormError(413, 'invalid_request');
    chunks.push(b);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** RFC 6749 §3.1/§3.2: request and response parameters MUST NOT be included more than once. */
function hasDuplicates(p: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const k of p.keys()) {
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

const BasicCredsSchema = z.object({ id: z.string().min(1), secret: z.string() });
type BasicCreds = z.infer<typeof BasicCredsSchema>;

/** RFC 6749 §2.3.1: client_id and client_secret are form-urlencoded before base64. */
function parseBasic(header: string | undefined): BasicCreds | 'malformed' | undefined {
  if (header === undefined) return undefined;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (m?.[1] === undefined) return /^Basic\b/i.test(header) ? 'malformed' : undefined;
  const raw = Buffer.from(m[1], 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i < 0) return 'malformed';
  try {
    const dec = (s: string): string => decodeURIComponent(s.replace(/\+/g, ' '));
    const r = BasicCredsSchema.safeParse({ id: dec(raw.slice(0, i)), secret: dec(raw.slice(i + 1)) });
    return r.success ? r.data : 'malformed';
  } catch {
    return 'malformed';
  }
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
};

function csp(formTargets: string[]): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    `form-action 'self'${formTargets.map((t) => ` ${t}`).join('')}`,
  ].join('; ');
}

export function createOAuthServer(o: OAuthServerOptions): OAuthServer {
  const { env, store, now, log } = o;
  const enabled = env.OAUTH_CLIENT_ID !== undefined && store !== undefined;
  const clients = new Map<string, OAuthClient>();
  if (env.OAUTH_CLIENT_ID !== undefined) {
    clients.set(env.OAUTH_CLIENT_ID, {
      id: env.OAUTH_CLIENT_ID,
      secretDigest: env.OAUTH_CLIENT_SECRET === undefined ? undefined : digest(env.OAUTH_CLIENT_SECRET),
      redirectUris: new Set(env.OAUTH_REDIRECT_URIS),
    });
  }
  const scopes: readonly string[] = env.OAUTH_SCOPES;
  const passcodeDigest = env.OAUTH_LINK_PASSCODE === undefined ? undefined : digest(env.OAUTH_LINK_PASSCODE);
  const confidential = env.OAUTH_CLIENT_SECRET !== undefined;
  const clientCredentials = env.OAUTH_CLIENT_CREDENTIALS && confidential;
  const pending = new Map<string, PendingAuthorization>();
  const refreshTtlMs = env.OAUTH_REFRESH_TTL_DAYS * 86_400_000;
  const lockout = new PasscodeLockout(env.OAUTH_PASSCODE_MAX_FAILURES, now);
  const clientIp = o.clientIp ?? ((req: IncomingMessage): string => req.socket.remoteAddress ?? 'unknown');

  /* ---------------- responses ---------------- */

  const sendHtml = (res: ServerResponse, status: number, html: string, formTargets: string[] = []): void => {
    if (res.headersSent) return;
    res.writeHead(status, { ...HTML_HEADERS, 'content-security-policy': csp(formTargets) });
    res.end(html);
  };

  const showError = (res: ServerResponse, status: number, title: string, message: string): void =>
    sendHtml(res, status, errorPage(title, message));

  const redirectTo = (res: ServerResponse, req: IncomingMessage, redirectUri: string, params: Record<string, string | undefined>): void => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    // RFC 9207: identify the issuer in the authorization response.
    u.searchParams.set('iss', o.baseUrl(req));
    res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' });
    res.end();
  };

  const tokenError = (res: ServerResponse, status: number, error: string, description?: string, basicUsed = false): void => {
    if (res.headersSent) return;
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    };
    // RFC 6749 §5.2: a 401 for a client that used the Authorization header names the scheme.
    // (The MCP endpoint itself never sends WWW-Authenticate; that rule is about /mcp.)
    if (status === 401 && basicUsed) headers['www-authenticate'] = 'Basic realm="stand-in"';
    res.writeHead(status, headers);
    res.end(JSON.stringify(description === undefined ? { error } : { error, error_description: description }));
  };

  const tokenOk = (res: ServerResponse, body: Record<string, unknown>): void => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache' });
    res.end(JSON.stringify(body));
  };

  /* ---------------- /authorize ---------------- */

  const prunePending = (): void => {
    const t = now();
    for (const [id, p] of pending) if (p.expiresMs <= t) pending.delete(id);
    while (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next();
      if (oldest.done === true) break;
      pending.delete(oldest.value);
    }
  };

  const renderConsent = (res: ServerResponse, id: string, p: PendingAuthorization, status = 200, error?: string): void => {
    const target = new URL(p.redirectUri).origin;
    sendHtml(
      res,
      status,
      consentPage({
        userName: env.STANDIN_USER_NAME,
        pendingId: id,
        csrf: p.csrf,
        scope: p.scope,
        needPasscode: passcodeDigest !== undefined,
        ...(error !== undefined ? { error } : {}),
      }),
      [target],
    );
  };

  const authorizeGet = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const q = url.searchParams;
    const clientId = q.getAll('client_id');
    const client = clientId.length === 1 ? clients.get(clientId[0] ?? '') : undefined;
    if (client === undefined) {
      return showError(res, 400, 'Unknown client', 'The linking request names an OAuth client this server does not know.');
    }
    const redirect = q.getAll('redirect_uri');
    const redirectUri = redirect.length === 1 ? redirect[0] : undefined;
    // Never redirect to a URI that is not registered (exact string match).
    if (redirectUri === undefined || !client.redirectUris.has(redirectUri)) {
      return showError(res, 400, 'Redirect URI not registered', 'The linking request asked to return to an address that is not on this server’s allowlist (OAUTH_REDIRECT_URIS).');
    }
    const state = q.get('state') ?? undefined;
    const fail = (error: string, description: string): void =>
      redirectTo(res, req, redirectUri, { error, error_description: description, ...(state !== undefined ? { state } : {}) });
    if (hasDuplicates(q)) return fail('invalid_request', 'duplicate parameter');
    if (state !== undefined && state.length > 2048) return fail('invalid_request', 'state too long');
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    const challenge = q.get('code_challenge');
    if (q.get('code_challenge_method') !== 'S256' || challenge === null) return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    if (!PKCE_RE.test(challenge)) return fail('invalid_request', 'malformed code_challenge');
    const resource = q.get('resource');
    if (resource === null) return fail('invalid_target', 'resource is required');
    if (resource !== o.resourceUrl(req)) return fail('invalid_target', 'unknown resource');
    const requested = q.get('scope');
    let scope: string;
    if (requested === null || requested.trim() === '') scope = scopes.join(' ');
    else {
      const asked = [...new Set(requested.split(' ').filter((s) => s.length > 0))];
      if (!asked.every((s) => scopes.includes(s))) return fail('invalid_scope', 'unsupported scope');
      scope = asked.join(' ');
    }
    prunePending();
    const id = random();
    const p: PendingAuthorization = {
      clientId: client.id,
      redirectUri,
      resource,
      scope,
      state,
      codeChallenge: challenge,
      csrf: random(),
      expiresMs: now() + PENDING_TTL_MS,
      attempts: 0,
    };
    pending.set(id, p);
    renderConsent(res, id, p);
  };

  const authorizePost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch {
      return showError(res, 400, 'Invalid request', 'The consent form could not be read.');
    }
    const id = form.get('pending') ?? '';
    const p = pending.get(id);
    if (p === undefined || p.expiresMs <= now()) {
      pending.delete(id);
      return showError(res, 400, 'Linking request expired', 'This linking request has expired or was already used.');
    }
    if (!safeEqual(form.get('csrf') ?? '', p.csrf)) {
      return showError(res, 403, 'Invalid request', 'The consent form is not valid (CSRF check failed).');
    }
    const state = p.state === undefined ? {} : { state: p.state };
    const action = form.get('action');
    if (action !== 'approve') {
      pending.delete(id);
      return redirectTo(res, req, p.redirectUri, { error: 'access_denied', error_description: 'the user denied the request', ...state });
    }
    const ip = clientIp(req);
    const locked = passcodeDigest === undefined ? undefined : lockout.locked(ip);
    if (locked !== undefined) {
      // Checked before the passcode is compared, so a locked-out guesser learns nothing.
      pending.delete(id);
      log(locked === 'global' ? 'oauth: linking locked: too many wrong passcodes this hour (all clients)' : 'oauth: linking locked for one client address: too many wrong passcodes this hour');
      return showError(res, 429, 'Linking temporarily locked', 'Too many wrong passcodes were entered recently. Try again in an hour.');
    }
    if (passcodeDigest !== undefined && !timingSafeEqual(digest(form.get('passcode') ?? ''), passcodeDigest)) {
      lockout.recordFailure(ip);
      p.attempts += 1;
      if (p.attempts >= MAX_PASSCODE_ATTEMPTS) {
        pending.delete(id);
        log('oauth: linking request refused after repeated wrong passcodes');
        return redirectTo(res, req, p.redirectUri, { error: 'access_denied', error_description: 'wrong passcode', ...state });
      }
      return renderConsent(res, id, p, 400, 'That passcode is not right. Try again.');
    }
    pending.delete(id);
    const code = random();
    store?.putCode({
      codeHash: hashSecret(code),
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      resource: p.resource,
      scope: p.scope,
      codeChallenge: p.codeChallenge,
      expiresMs: now() + env.OAUTH_CODE_TTL_SEC * 1000,
    });
    log('oauth: authorization approved, code issued');
    redirectTo(res, req, p.redirectUri, { code, ...state });
  };

  /* ---------------- /token ---------------- */

  type ClientAuth = { ok: true; client: OAuthClient; basicUsed: boolean } | { ok: false; status: number; error: string; basicUsed: boolean };

  const authenticateClient = (req: IncomingMessage, form: URLSearchParams): ClientAuth => {
    const header = req.headers.authorization;
    const basic = parseBasic(typeof header === 'string' ? header : undefined);
    const basicUsed = basic !== undefined;
    if (basic === 'malformed') return { ok: false, status: 401, error: 'invalid_client', basicUsed };
    const bodyId = form.get('client_id') ?? undefined;
    const bodySecret = form.get('client_secret') ?? undefined;
    if (basic !== undefined && bodySecret !== undefined) return { ok: false, status: 400, error: 'invalid_request', basicUsed };
    if (basic !== undefined && bodyId !== undefined && bodyId !== basic.id) return { ok: false, status: 401, error: 'invalid_client', basicUsed };
    const id = basic?.id ?? bodyId;
    const client = id === undefined ? undefined : clients.get(id);
    if (client === undefined) return { ok: false, status: 401, error: 'invalid_client', basicUsed };
    const presented = basic?.secret ?? bodySecret;
    if (client.secretDigest !== undefined) {
      if (presented === undefined || !timingSafeEqual(digest(presented), client.secretDigest)) {
        return { ok: false, status: 401, error: 'invalid_client', basicUsed };
      }
    } else if (presented !== undefined && presented !== '') {
      // A public client must not present a secret: the add-on and server configs disagree.
      return { ok: false, status: 401, error: 'invalid_client', basicUsed };
    }
    return { ok: true, client, basicUsed };
  };

  const issuePair = (clientId: string, familyId: string, resource: string, scope: string): { tokens: NewToken[]; body: Record<string, unknown> } => {
    const t = now();
    const access = `sat_${random()}`;
    const refresh = `srt_${random()}`;
    return {
      tokens: [
        { tokenHash: hashSecret(access), kind: 'access', clientId, familyId, resource, scope, createdMs: t, expiresMs: t + env.OAUTH_ACCESS_TTL_SEC * 1000 },
        { tokenHash: hashSecret(refresh), kind: 'refresh', clientId, familyId, resource, scope, createdMs: t, expiresMs: t + refreshTtlMs },
      ],
      body: { access_token: access, token_type: 'Bearer', expires_in: env.OAUTH_ACCESS_TTL_SEC, refresh_token: refresh, scope },
    };
  };

  const tokenPost = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    // Credentials and codes are accepted only in the body, never in the query string.
    if (url.search !== '') return tokenError(res, 400, 'invalid_request', 'parameters must be sent in the request body');
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch (err) {
      return tokenError(res, err instanceof FormError ? err.status : 400, 'invalid_request', 'expected an application/x-www-form-urlencoded body');
    }
    if (hasDuplicates(form)) return tokenError(res, 400, 'invalid_request', 'duplicate parameter');
    const auth = authenticateClient(req, form);
    if (!auth.ok) return tokenError(res, auth.status, auth.error, 'client authentication failed', auth.basicUsed);
    const { client } = auth;
    const grant = form.get('grant_type');
    const resourceParam = form.get('resource') ?? undefined;

    if (grant === 'authorization_code') {
      const code = form.get('code');
      const redirectUri = form.get('redirect_uri');
      const verifier = form.get('code_verifier');
      if (code === null || redirectUri === null || verifier === null) {
        return tokenError(res, 400, 'invalid_request', 'code, redirect_uri and code_verifier are required');
      }
      if (!PKCE_RE.test(verifier)) return tokenError(res, 400, 'invalid_request', 'malformed code_verifier');
      const codeHash = hashSecret(code);
      const row = store?.consumeCode(codeHash);
      if (row === undefined) return tokenError(res, 400, 'invalid_grant', 'unknown authorization code');
      if (row.used !== 0) {
        // RFC 6749 §4.1.2: a replayed code revokes the tokens it produced.
        if (row.family_id !== null) store?.revokeFamily(row.family_id);
        log('oauth: authorization code reuse detected, tokens revoked');
        return tokenError(res, 400, 'invalid_grant', 'authorization code already used');
      }
      if (row.client_id !== client.id) return tokenError(res, 400, 'invalid_grant', 'code was issued to another client');
      if (row.expires_ms <= now()) return tokenError(res, 400, 'invalid_grant', 'authorization code expired');
      if (row.redirect_uri !== redirectUri) return tokenError(res, 400, 'invalid_grant', 'redirect_uri does not match');
      if (resourceParam !== undefined && resourceParam !== row.resource) return tokenError(res, 400, 'invalid_target', 'resource does not match');
      if (!safeEqual(pkceChallenge(verifier), row.code_challenge)) return tokenError(res, 400, 'invalid_grant', 'PKCE verification failed');
      const familyId = random(16);
      const { tokens, body } = issuePair(client.id, familyId, row.resource, row.scope);
      for (const t of tokens) store?.putToken(t);
      store?.setCodeFamily(codeHash, familyId);
      log('oauth: tokens issued (authorization_code)');
      return tokenOk(res, body);
    }

    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token');
      if (presented === null) return tokenError(res, 400, 'invalid_request', 'refresh_token is required');
      const oldHash = hashSecret(presented);
      const row = store?.getToken(oldHash);
      if (row === undefined || row.kind !== 'refresh' || row.client_id !== client.id) {
        return tokenError(res, 400, 'invalid_grant', 'unknown refresh token');
      }
      if (row.revoked !== 0) {
        store?.revokeFamily(row.family_id);
        log('oauth: refresh token reuse detected, token family revoked');
        return tokenError(res, 400, 'invalid_grant', 'refresh token revoked');
      }
      if (row.expires_ms <= now()) return tokenError(res, 400, 'invalid_grant', 'refresh token expired');
      // Alexa omits resource on refresh: the audience comes from the original grant.
      if (resourceParam !== undefined && resourceParam !== row.resource) return tokenError(res, 400, 'invalid_target', 'resource does not match');
      let scope = row.scope;
      const asked = form.get('scope');
      if (asked !== null && asked.trim() !== '') {
        const granted = new Set(row.scope.split(' '));
        const want = [...new Set(asked.split(' ').filter((s) => s.length > 0))];
        if (!want.every((s) => granted.has(s))) return tokenError(res, 400, 'invalid_scope', 'scope exceeds the original grant');
        scope = want.join(' ');
      }
      const { tokens, body } = issuePair(client.id, row.family_id, row.resource, scope);
      if (store?.rotate(oldHash, tokens) !== true) {
        store?.revokeFamily(row.family_id);
        return tokenError(res, 400, 'invalid_grant', 'refresh token revoked');
      }
      log('oauth: tokens issued (refresh_token)');
      return tokenOk(res, body);
    }

    if (grant === 'client_credentials' && clientCredentials) {
      if (client.secretDigest === undefined) return tokenError(res, 400, 'unauthorized_client', 'client_credentials needs a confidential client');
      const asked = form.get('scope');
      if (asked !== null && asked.trim() !== '' && asked.trim() !== SERVICE_SCOPE) return tokenError(res, 400, 'invalid_scope', `only ${SERVICE_SCOPE} is issued`);
      if (resourceParam === undefined) return tokenError(res, 400, 'invalid_request', 'resource is required');
      if (resourceParam !== o.resourceUrl(req)) return tokenError(res, 400, 'invalid_target', 'unknown resource');
      const t = now();
      const ttl = Math.min(env.OAUTH_ACCESS_TTL_SEC, 3600);
      const access = `sat_${random()}`;
      store?.putToken({
        tokenHash: hashSecret(access),
        kind: 'access',
        clientId: client.id,
        familyId: random(16),
        resource: resourceParam,
        scope: SERVICE_SCOPE,
        createdMs: t,
        expiresMs: t + ttl * 1000,
      });
      log('oauth: tokens issued (client_credentials)');
      return tokenOk(res, { access_token: access, token_type: 'Bearer', expires_in: ttl, scope: SERVICE_SCOPE });
    }

    if (grant === null) return tokenError(res, 400, 'invalid_request', 'grant_type is required');
    return tokenError(res, 400, 'unsupported_grant_type');
  };

  return {
    enabled,
    scopes,

    async handleAuthorize(req, res, url) {
      if (!enabled) {
        return showError(res, 503, 'Account linking is not enabled', 'This Stand-In server has no OAuth client configured (OAUTH_CLIENT_ID).');
      }
      if (req.method === 'GET' || req.method === 'HEAD') return authorizeGet(req, res, url);
      if (req.method === 'POST') return authorizePost(req, res);
      res.setHeader('allow', 'GET, POST');
      return showError(res, 405, 'Method not allowed', 'Use GET or POST.');
    },

    async handleToken(req, res, url) {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return tokenError(res, 405, 'invalid_request', 'use POST');
      }
      if (!enabled) return tokenError(res, 503, 'temporarily_unavailable', 'account linking is not configured on this server');
      return tokenPost(req, res, url);
    },

    verifyAccessToken(token, resource) {
      if (!enabled || store === undefined || token.length > 512) return undefined;
      const row = store.getToken(hashSecret(token));
      if (row === undefined || row.kind !== 'access' || row.revoked !== 0) return undefined;
      if (row.expires_ms <= now()) return undefined;
      if (row.resource !== resource) return undefined;
      if (!clients.has(row.client_id)) return undefined;
      return { clientId: row.client_id, scope: row.scope, serviceOnly: row.scope === SERVICE_SCOPE };
    },

    authorizationServerMetadata(req) {
      const base = o.baseUrl(req);
      return {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: clientCredentials ? ['authorization_code', 'refresh_token', 'client_credentials'] : ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: confidential ? ['client_secret_basic', 'client_secret_post'] : ['none'],
        scopes_supported: clientCredentials ? [...scopes, SERVICE_SCOPE] : [...scopes],
        authorization_response_iss_parameter_supported: true,
        service_documentation: `${base}/privacy`,
      };
    },

    sweep() {
      prunePending();
      lockout.sweep();
      store?.purgeExpired(now());
    },
  };
}
