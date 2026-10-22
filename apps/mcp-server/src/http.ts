/**
 * The one HTTP process (spec 7, 13):
 *   /mcp                      MCP Streamable HTTP, stateful sessions, Bearer, Origin allowlist
 *   /health, /.well-known/*   public
 *   /sim/api/llm, /sim/api/tts  Bearer (server-side LLM / Polly for the sim host)
 *   /sim/config               public; demoToken only when DEMO_EMBED_TOKEN=true
 *   everything else           static apps/alexa-sim/dist with SPA fallback
 *
 * Unauthenticated requests get 401 with NO WWW-Authenticate header (Alexa+
 * MCP QuickStart). Request bodies, tokens and transcript text are never logged.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  SIM_PATHS,
  SIM_TTS_AUDIO_MIME,
  SimConfigSchema,
  SimLlmRequestSchema,
  SimTtsRequestSchema,
  type SimConfig,
  type TtsProvider,
} from '@standin/core';
import { scanOutbound } from '@standin/disclosure-guard';
import { LlmPlanner, createPolicyLlm } from '@standin/call-agent';
import { PollyTts, PollyVoiceSchema, ScriptedLlmProvider, type Providers } from '@standin/providers';
import type { ServerEnv } from './config.js';
import { createMcpServer, SERVER_INFO, type McpSessionHandle } from './mcp.js';
import { llmOrchestrator, scriptedOrchestrator, type DirectoryEntry } from './orchestrator.js';
import { RateLimiter } from './rate-limit.js';
import { BUDGET_HEADER, BudgetedLlm, UtcDayCap, WindowCap, boundModelRequest, takeBudget, takeBudgets } from './sim-guard.js';
import { StandinApp } from './standin-app.js';
import { guardFacts, maskText } from './views.js';

const MAX_JSON_BODY = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type StandinServerEnv = ServerEnv & {
  STANDIN_TOKEN: string;
  /** Generated per process for the offline loopback demo (no .env); see parseServerEnv. */
  STANDIN_TOKEN_EPHEMERAL?: boolean;
};

export interface StandinServerOptions {
  env: StandinServerEnv;
  providers: Providers;
  /** Pre-built app (tests); default is built from the providers and env. */
  app?: StandinApp;
  /** Directory of the built alexa-sim (default apps/alexa-sim/dist). */
  staticDir?: string;
  /** Business names/aliases for the scripted orchestrator (default: the app directory). */
  businesses?: DirectoryEntry[];
  log?: (line: string) => void;
  /** Start the follow-up ticker and the transcript TTL purge (default true). */
  followups?: boolean;
  /** Wall clock in ms for the daily budgets (tests). */
  now?: () => number;
}

export interface StandinServer {
  readonly http: Server;
  readonly app: StandinApp;
  listen(port?: number, host?: string): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
  sessionCount(): number;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  handle: McpSessionHandle;
  lastSeen: number;
  /** Open GET (SSE) streams: a session with a live stream counts as in use (for a bounded time). */
  streams: number;
  /** Client address that created the session (per-IP cap). */
  ip: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
};

export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../alexa-sim/dist/', import.meta.url));

const PLACEHOLDER_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stand-In</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.5;background:#fff;color:#14171f}
code{background:#f0f2f6;padding:2px 6px;border-radius:6px}@media(prefers-color-scheme:dark){body{background:#12151c;color:#eef1f7}code{background:#232833}}</style></head>
<body><h1>Stand-In MCP server</h1><p>The MCP endpoint is live at <code>/mcp</code> (Bearer token required).</p>
<p>The simulated Alexa+ host is not built yet. Run <code>pnpm demo</code> (or <code>pnpm --filter @standin/alexa-sim build</code>) and reload.</p>
<p><a href="/health">/health</a> · <a href="/.well-known/oauth-protected-resource">/.well-known/oauth-protected-resource</a></p></body></html>`;

function sha(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

async function readBody(req: IncomingMessage, limit = MAX_JSON_BODY): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'payload_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

/**
 * The rate-limit key. Behind `trustedHops` proxies, the client address is the
 * X-Forwarded-For entry that many places from the right: each proxy appends
 * the address it saw, so the left-most entries are whatever the client sent
 * (spoofable). With no trusted proxy, or a shorter header, the socket address.
 */
export function clientAddress(req: { headers: IncomingHttpHeaders; socket: { remoteAddress?: string | undefined } }, trustedHops: number): string {
  const socket = req.socket.remoteAddress ?? 'unknown';
  if (trustedHops < 1) return socket;
  const raw = req.headers['x-forwarded-for'];
  const entries = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  const pick = entries[entries.length - trustedHops];
  return pick !== undefined && pick.length <= 100 ? pick : socket;
}

export function createStandinServer(opts: StandinServerOptions): StandinServer {
  const { env, providers } = opts;
  const log = opts.log ?? (() => undefined);
  // Global LLM budget, shared by /sim/api/llm and the call planner (calls via /mcp).
  const llmBudget = new WindowCap({ max: env.SIM_LLM_HOURLY_CAP, windowMs: 3_600_000 });
  const llmDaily = new UtcDayCap({ max: env.SIM_LLM_DAILY_CAP, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const meteredPlanner =
    providers.llm instanceof ScriptedLlmProvider
      ? undefined
      : new LlmPlanner(new BudgetedLlm(providers.llm, { daily: llmDaily, hourly: llmBudget }, createPolicyLlm()));
  const app =
    opts.app ??
    new StandinApp({
      providers,
      ...(meteredPlanner !== undefined ? { planner: meteredPlanner } : {}),
      defaultUserName: env.STANDIN_USER_NAME,
      speeds: { talk: env.SIM_SPEED_TALK, hold: env.SIM_SPEED_HOLD, handoff: env.SIM_SPEED_HANDOFF },
      join: { speakMs: env.SIM_JOIN_SPEAK_MS, leaveMs: env.SIM_JOIN_LEAVE_MS },
      strictCallingHours: env.STRICT_CALLING_HOURS,
      dailyCallCap: env.STANDIN_DAILY_CALL_CAP,
      machine: { maxDurationMs: Math.round(env.MAX_CALL_MINUTES * 60_000) },
    });
  if (opts.followups !== false) {
    app.startFollowups(env.FOLLOWUP_TICK_MS);
    app.startRetention({ ttlDays: env.TRANSCRIPT_TTL_DAYS, intervalMs: env.RETENTION_SWEEP_MS, log });
  }
  const staticDir = resolve(opts.staticDir ?? env.ALEXA_SIM_DIST ?? DEFAULT_STATIC_DIR);
  const businesses: DirectoryEntry[] = opts.businesses ?? app.directory.filter((b) => b.optOut !== true).map((b) => ({ name: b.name, aliases: [] }));
  const tokenDigest = sha(env.STANDIN_TOKEN);
  const limiter = new RateLimiter({ ratePerSec: env.RATE_LIMIT_RPS, burst: env.RATE_LIMIT_BURST });
  // Cost guards for model-backed sim endpoints (see sim-guard.ts).
  const llmLimiter = new RateLimiter({ ratePerSec: env.SIM_LLM_RPS, burst: env.SIM_LLM_BURST });
  const ttsLimiter = new RateLimiter({ ratePerSec: env.SIM_TTS_RPS, burst: env.SIM_TTS_BURST });
  const ttsBudget = new WindowCap({ max: env.SIM_TTS_HOURLY_CAP, windowMs: 3_600_000 });
  const ttsDaily = new UtcDayCap({ max: env.SIM_TTS_DAILY_CAP, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const ttsCharsHourly = new WindowCap({ max: env.SIM_TTS_HOURLY_CHAR_CAP, windowMs: 3_600_000 });
  const ttsCharsDaily = new UtcDayCap({ max: env.SIM_TTS_DAILY_CHAR_CAP, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const sessions = new Map<string, Session>();
  const llmKind: SimConfig['llm'] = providers.mode === 'aws' ? 'bedrock' : providers.config.STANDIN_LLM;
  const ttsKind: SimConfig['tts'] = providers.mode === 'aws' ? 'polly' : 'browser';
  let alexaTts: TtsProvider | undefined;
  if (providers.mode === 'aws') {
    const voice = PollyVoiceSchema.safeParse(env.POLLY_VOICE_ALEXA);
    alexaTts = new PollyTts({
      region: providers.config.AWS_REGION ?? '',
      voices: { standin: { voiceId: voice.success ? voice.data : 'Joanna', languageCode: 'en-US' } },
    });
  }

  /* ---------------- helpers ---------------- */

  const clientIp = (req: IncomingMessage): string => clientAddress(req, env.TRUST_PROXY ? env.TRUST_PROXY_HOPS : 0);

  const requestHostIsLoopback = (req: IncomingMessage): boolean => {
    const host = (req.headers.host ?? '').toLowerCase();
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '');
    return LOOPBACK_HOSTS.has(name);
  };

  const hostAllowed = (req: IncomingMessage): boolean => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (env.STANDIN_ALLOWED_HOSTS.length > 0) return env.STANDIN_ALLOWED_HOSTS.map((h) => h.toLowerCase()).includes(host);
    const boundLoopback = env.HOST === '127.0.0.1' || env.HOST === 'localhost' || env.HOST === '::1';
    if (!boundLoopback) return true;
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '');
    return LOOPBACK_HOSTS.has(name);
  };

  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true; // non-browser clients
    if (env.STANDIN_ALLOWED_ORIGINS.includes(origin)) return true;
    try {
      return new URL(origin).host.toLowerCase() === (req.headers.host ?? '').toLowerCase();
    } catch {
      return false;
    }
  };

  const authorized = (req: IncomingMessage): boolean => {
    const h = req.headers.authorization;
    if (typeof h !== 'string') return false;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
    if (m?.[1] === undefined) return false;
    return timingSafeEqual(sha(m[1]), tokenDigest);
  };

  const corsHeaders = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (origin === undefined || !env.STANDIN_ALLOWED_ORIGINS.includes(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      vary: 'Origin',
      'access-control-expose-headers': 'Mcp-Session-Id, Mcp-Protocol-Version, X-Standin-Budget, X-Standin-Fallback',
    };
  };

  const baseUrl = (req: IncomingMessage): string => {
    if (env.PUBLIC_BASE_URL !== undefined) return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    const fwd = env.TRUST_PROXY ? req.headers['x-forwarded-proto'] : undefined;
    const proto = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() ?? 'http';
    return `${proto === 'https' ? 'https' : 'http'}://${req.headers.host ?? `${env.HOST}:${env.PORT}`}`;
  };

  /** Origin + Host check, rate limit, then (optionally) Bearer. Returns false when a response was sent. */
  const gate = (req: IncomingMessage, res: ServerResponse, needAuth: boolean): boolean => {
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: 'forbidden_host' });
      return false;
    }
    if (!originAllowed(req)) {
      sendJson(res, 403, { error: 'forbidden_origin' });
      return false;
    }
    const wait = limiter.take(clientIp(req));
    if (wait > 0) {
      sendJson(res, 429, { error: 'rate_limited' }, { 'retry-after': String(Math.max(1, Math.ceil(wait))) });
      return false;
    }
    if (needAuth && !authorized(req)) {
      // Deliberately no WWW-Authenticate header (Alexa+ MCP QuickStart).
      sendJson(res, 401, { error: 'unauthorized' }, corsHeaders(req));
      return false;
    }
    for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    return true;
  };

  /* ---------------- MCP ---------------- */

  const closeSession = (id: string): void => {
    const s = sessions.get(id);
    if (s === undefined) return;
    sessions.delete(id);
    s.handle.dispose();
    void s.handle.server.close().catch(() => undefined);
  };

  /** Least-recently-seen session among `pool`, preferring ones without an open stream. */
  const lru = (pool: Iterable<[string, Session]>): string | undefined => {
    let best: [string, Session] | undefined;
    for (const e of pool) {
      if (best === undefined) best = e;
      else {
        const a = e[1].streams > 0 ? 1 : 0;
        const b = best[1].streams > 0 ? 1 : 0;
        if (a < b || (a === b && e[1].lastSeen < best[1].lastSeen)) best = e;
      }
    }
    return best?.[0];
  };

  /**
   * Make room for one new session from `ip`: above the per-IP cap that IP's
   * oldest session is evicted; at the global cap the least-recently-seen one is.
   * New sessions are never refused, so one client cannot lock others out.
   */
  const makeRoom = (ip: string): void => {
    for (;;) {
      const mine = [...sessions].filter(([, s]) => s.ip === ip);
      if (mine.length < env.MAX_SESSIONS_PER_IP) break;
      const victim = lru(mine);
      if (victim === undefined) break;
      log('mcp session evicted (per-ip cap)');
      closeSession(victim);
    }
    while (sessions.size >= env.MAX_SESSIONS) {
      const victim = lru(sessions);
      if (victim === undefined) break;
      log('mcp session evicted (global cap)');
      closeSession(victim);
    }
  };

  const sweep = setInterval(
    () => {
      const now = Date.now();
      const cutoff = now - env.SESSION_IDLE_MS;
      const streamCutoff = now - Math.max(env.SESSION_IDLE_MS, env.SESSION_STREAM_MAX_IDLE_MS);
      for (const [id, s] of sessions) {
        if (s.lastSeen < (s.streams === 0 ? cutoff : streamCutoff)) closeSession(id);
      }
      limiter.prune();
      llmLimiter.prune();
      ttsLimiter.prune();
    },
    Math.min(60_000, Math.max(250, Math.floor(env.SESSION_IDLE_MS / 2))),
  );
  sweep.unref();

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sidHeader = req.headers['mcp-session-id'];
    const sid = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (sid !== undefined) {
        const s = sessions.get(sid);
        if (s === undefined) return jsonRpcError(res, 404, -32001, 'Session not found');
        s.lastSeen = Date.now();
        return s.transport.handleRequest(req, res, body);
      }
      if (!isInitializeRequest(body)) return jsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
      const ip = clientIp(req);
      const handle = createMcpServer(app);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          // Caps are enforced at registration (synchronously), so concurrent initializes cannot overshoot them.
          makeRoom(ip);
          sessions.set(id, { transport, handle, lastSeen: Date.now(), streams: 0, ip });
        },
        onsessionclosed: (id) => closeSession(id),
      });
      // Set before connect(): the SDK's Protocol wraps an existing onclose instead of replacing it.
      transport.onclose = () => {
        if (transport.sessionId !== undefined) closeSession(transport.sessionId);
        else handle.dispose();
      };
      await handle.server.connect(transport);
      return transport.handleRequest(req, res, body);
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      const s = sid === undefined ? undefined : sessions.get(sid);
      if (s === undefined) return jsonRpcError(res, sid === undefined ? 400 : 404, sid === undefined ? -32000 : -32001, sid === undefined ? 'Bad Request: No valid session ID provided' : 'Session not found');
      s.lastSeen = Date.now();
      if (req.method === 'GET') {
        // The standalone SSE stream keeps the session alive for as long as it is open.
        s.streams++;
        res.on('close', () => {
          s.streams = Math.max(0, s.streams - 1);
          s.lastSeen = Date.now();
        });
      }
      return s.transport.handleRequest(req, res);
    }
    res.setHeader('allow', 'GET, POST, DELETE');
    return jsonRpcError(res, 405, -32000, 'Method not allowed');
  };

  /* ---------------- sim API ---------------- */

  const handleSimLlm = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    const modelBacked = llmKind !== 'scripted';
    const parsed = SimLlmRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid_request' });
    const ctx = { now: new Date(), businesses };
    if (!modelBacked) return sendJson(res, 200, scriptedOrchestrator(parsed.data, ctx));
    const bounded = boundModelRequest(parsed.data);
    if (bounded === undefined) return sendJson(res, 400, { error: 'invalid_request' });
    // Over the per-IP bucket or a global (daily / hourly) budget: no model call, the scripted matcher answers.
    if (llmLimiter.take(clientIp(req)) > 0) {
      return sendJson(res, 200, scriptedOrchestrator(bounded, ctx), { 'x-standin-fallback': 'scripted-limit' });
    }
    const budget = takeBudget(llmDaily, llmBudget);
    if (budget !== 'ok') {
      if (budget === 'daily') log('sim llm: daily budget reached, scripted orchestrator until 00:00 UTC');
      return sendJson(res, 200, scriptedOrchestrator(bounded, ctx), { 'x-standin-fallback': 'scripted-budget', [BUDGET_HEADER]: `llm-${budget}` });
    }
    const r = await llmOrchestrator(providers.llm, bounded, { ...ctx, never: await app.neverFacts() });
    return sendJson(res, 200, r.response, r.fallback ? { 'x-standin-fallback': 'scripted' } : {});
  };

  const handleSimTts = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    const parsed = SimTtsRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid_request' });
    if (ttsKind === 'browser') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    // Over the per-IP bucket or a global (daily / hourly) budget: 204, the page uses browser speech.
    if (ttsLimiter.take(clientIp(req)) > 0) {
      res.writeHead(204, { 'cache-control': 'no-store', 'x-standin-fallback': 'browser-limit' });
      res.end();
      return;
    }
    // DLP again before anything reaches Polly: never-tier values and secret-shaped text are masked.
    const never = await app.neverFacts();
    const scan = scanOutbound(parsed.data.text, guardFacts(never));
    const text = scan.allowed ? parsed.data.text : maskText(parsed.data.text, never);
    // Polly bills per character: meter requests and the characters actually sent.
    const budget = takeBudgets(
      [
        { daily: ttsDaily, hourly: ttsBudget },
        { daily: ttsCharsDaily, hourly: ttsCharsHourly },
      ],
      [1, text.length],
    );
    if (budget !== 'ok') {
      if (budget === 'daily') log('sim tts: daily budget reached, browser speech until 00:00 UTC');
      res.writeHead(204, { 'cache-control': 'no-store', 'x-standin-fallback': 'browser-budget', [BUDGET_HEADER]: `tts-${budget}` });
      res.end();
      return;
    }
    const voice = parsed.data.voice;
    const tts = voice === 'alexa' ? alexaTts : providers.tts;
    if (tts === undefined) return sendJson(res, 502, { error: 'tts_unavailable' });
    try {
      const out = await tts.synthesize({ text, voice: voice === 'alexa' ? 'standin' : voice });
      if (out.audio === undefined) {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': out.mimeType ?? SIM_TTS_AUDIO_MIME, 'cache-control': 'no-store', 'content-length': String(out.audio.byteLength) });
      res.end(Buffer.from(out.audio));
    } catch {
      sendJson(res, 502, { error: 'tts_failed' });
    }
  };

  const boundToLoopback = env.HOST === '127.0.0.1' || env.HOST === 'localhost' || env.HOST === '::1';
  const simConfig = (req: IncomingMessage): SimConfig => {
    // The one-time offline token goes only to a page loaded from this machine.
    const embed = env.DEMO_EMBED_TOKEN || (env.STANDIN_TOKEN_EPHEMERAL === true && boundToLoopback && requestHostIsLoopback(req));
    return SimConfigSchema.parse({ mode: providers.mode, llm: llmKind, tts: ttsKind, ...(embed ? { demoToken: env.STANDIN_TOKEN } : {}) });
  };

  /* ---------------- discovery ---------------- */

  const protectedResource = (req: IncomingMessage) => {
    const base = baseUrl(req);
    return {
      resource: `${base}${SIM_PATHS.mcp}`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['standin'],
      resource_name: 'Stand-In MCP server',
      resource_documentation: `${base}/`,
    };
  };

  const authorizationServer = (req: IncomingMessage) => {
    const base = baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['standin'],
    };
  };

  /* ---------------- static ---------------- */

  const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string): void => {
    const index = join(staticDir, 'index.html');
    const haveIndex = existsSync(index);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return sendJson(res, 400, { error: 'bad_path' });
    }
    if (decoded.includes('\0')) return sendJson(res, 400, { error: 'bad_path' });
    const target = normalize(join(staticDir, decoded));
    const inside = target === staticDir || target.startsWith(staticDir + sep);
    let file: string | undefined;
    if (inside && decoded !== '/') {
      try {
        if (statSync(target).isFile()) file = target;
      } catch {
        file = undefined;
      }
    }
    if (file === undefined) {
      const looksLikeAsset = extname(decoded) !== '' && extname(decoded) !== '.html';
      if (looksLikeAsset) return sendJson(res, 404, { error: 'not_found' });
      if (!haveIndex) {
        res.writeHead(200, { 'content-type': MIME['.html'] ?? 'text/html', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : PLACEHOLDER_HTML);
        return;
      }
      file = index;
    }
    const ext = extname(file).toLowerCase();
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  };

  /* ---------------- router ---------------- */

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return sendJson(res, 400, { error: 'bad_url' });
    }
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS' && (pathname === SIM_PATHS.mcp || pathname.startsWith('/sim/'))) {
      const origin = req.headers.origin;
      if (origin === undefined || !env.STANDIN_ALLOWED_ORIGINS.includes(origin)) return sendJson(res, 403, { error: 'forbidden_origin' });
      res.writeHead(204, {
        ...corsHeaders(req),
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    if (pathname === '/health') return sendJson(res, 200, { ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version, mode: providers.mode });
    if (pathname === '/.well-known/oauth-protected-resource' || pathname === `/.well-known/oauth-protected-resource${SIM_PATHS.mcp}`) {
      return sendJson(res, 200, protectedResource(req), { 'cache-control': 'public, max-age=300' });
    }
    if (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/openid-configuration') {
      return sendJson(res, 200, authorizationServer(req), { 'cache-control': 'public, max-age=300' });
    }
    if (pathname.startsWith('/oauth/')) {
      return sendJson(res, 501, {
        error: 'temporarily_unavailable',
        error_description: 'This demo deployment uses a static Bearer token (STANDIN_TOKEN); the interactive OAuth flow is not enabled.',
      });
    }
    if (pathname === SIM_PATHS.mcp) {
      if (!gate(req, res, true)) return;
      return handleMcp(req, res);
    }
    if (pathname === SIM_PATHS.config) {
      if (!gate(req, res, false)) return;
      return sendJson(res, 200, simConfig(req));
    }
    if (pathname === SIM_PATHS.llm) {
      if (!gate(req, res, true)) return;
      return handleSimLlm(req, res);
    }
    if (pathname === SIM_PATHS.tts) {
      if (!gate(req, res, true)) return;
      return handleSimTts(req, res);
    }
    if (pathname.startsWith('/sim/api/')) return sendJson(res, 404, { error: 'not_found' });
    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    return serveStatic(req, res, pathname);
  };

  const http = createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      let path = '/';
      try {
        path = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        // keep '/'
      }
      log(`${req.method ?? '?'} ${path.slice(0, 120)} ${res.statusCode} ${Date.now() - started}ms`);
    });
    route(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code });
      log(`error ${err instanceof Error ? err.name : 'error'}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.destroy();
    });
  });

  return {
    http,
    app,
    sessionCount: () => sessions.size,
    async listen(port = env.PORT, host = env.HOST) {
      // Calls a previous process left mid-flight become FAILED (server_restart)
      // before any client can poll them.
      try {
        const n = await app.recoverOrphanedCalls();
        if (n > 0) log(`stand-in: marked ${n} interrupted call(s) as FAILED (server_restart)`);
      } catch {
        log('stand-in: orphaned-call recovery failed; calls are repaired when next read');
      }
      return new Promise((resolveListen, reject) => {
        http.once('error', reject);
        http.listen(port, host, () => {
          http.off('error', reject);
          const a = http.address() as AddressInfo;
          const shown = a.family === 'IPv6' ? `[${a.address}]` : a.address;
          resolveListen({ host: a.address, port: a.port, url: `http://${shown}:${a.port}` });
        });
      });
    },
    async close() {
      clearInterval(sweep);
      for (const id of [...sessions.keys()]) closeSession(id);
      await app.close();
      await new Promise<void>((r) => {
        http.close(() => r());
        http.closeAllConnections();
      });
    },
  };
}
