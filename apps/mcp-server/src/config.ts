/**
 * Server configuration (spec 7, 13), parsed with zod from a plain env record.
 * `KEY=` lines in .env arrive as '' and are treated as unset. Error messages
 * name the offending variable, never its value (STANDIN_TOKEN is a secret).
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const blankToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema);

const boolFlag = opt(
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default('false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes'),
);

const csv = opt(
  z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    ),
);

export const ServerEnvSchema = z.object({
  HOST: opt(z.string().min(1).default('127.0.0.1')),
  PORT: opt(z.coerce.number().int().min(0).max(65535).default(8787)),
  /** Bearer token for /mcp and /sim/api/*. Required; never logged. */
  STANDIN_TOKEN: opt(z.string().min(8, 'STANDIN_TOKEN must be at least 8 characters').optional()),
  /** Extra allowed Origins (comma list). Same-origin and Origin-less requests are always allowed. */
  STANDIN_ALLOWED_ORIGINS: csv,
  /** Allowed Host header values (comma list, host[:port]) for DNS-rebinding protection. */
  STANDIN_ALLOWED_HOSTS: csv,
  /** Hosted judge demo: /sim/config hands the token to the static page. */
  DEMO_EMBED_TOKEN: boolFlag,
  /** Public base URL for the discovery documents (defaults to the request's own origin). */
  PUBLIC_BASE_URL: opt(z.url().optional()),
  /** Behind a reverse proxy: trust X-Forwarded-For / X-Forwarded-Proto. */
  TRUST_PROXY: boolFlag,
  /**
   * Number of trusted proxies in front of the server. The client IP is the
   * X-Forwarded-For entry this many places from the right (the address the
   * outermost trusted proxy saw); entries to its left are client-supplied.
   */
  TRUST_PROXY_HOPS: opt(z.coerce.number().int().min(1).max(10).default(1)),
  /** Per-IP token bucket for /mcp and /sim/api. */
  RATE_LIMIT_RPS: opt(z.coerce.number().positive().default(20)),
  RATE_LIMIT_BURST: opt(z.coerce.number().int().positive().default(60)),
  /**
   * Stricter per-IP buckets for /sim/api/llm and /sim/api/tts when they reach
   * a real model or Polly (the hosted demo token is public). Over the limit the
   * LLM endpoint answers with the scripted matcher and TTS with 204 (browser speech).
   */
  SIM_LLM_RPS: opt(z.coerce.number().positive().default(1)),
  SIM_LLM_BURST: opt(z.coerce.number().int().positive().default(12)),
  SIM_TTS_RPS: opt(z.coerce.number().positive().default(3)),
  SIM_TTS_BURST: opt(z.coerce.number().int().positive().default(30)),
  /** Global hourly budget of model calls / Polly requests across all clients (0 = never call them). */
  SIM_LLM_HOURLY_CAP: opt(z.coerce.number().int().min(0).default(300)),
  SIM_TTS_HOURLY_CAP: opt(z.coerce.number().int().min(0).default(1500)),
  /**
   * Global daily budget (per UTC day, process-wide) of model calls / Polly
   * requests, on top of the hourly caps. Once spent, /sim/api/llm answers with
   * the scripted orchestrator and /sim/api/tts with 204 (browser voice) until
   * 00:00 UTC, and the page shows a small "demo budget reached" note.
   */
  SIM_LLM_DAILY_CAP: opt(z.coerce.number().int().min(0).default(400)),
  SIM_TTS_DAILY_CAP: opt(z.coerce.number().int().min(0).default(1000)),
  /**
   * Polly is billed per character (neural: about $16 per 1M), so /sim/api/tts
   * is also metered in characters: a global hourly and per-UTC-day budget of
   * synthesized characters, on top of the request caps. 50k chars/day is
   * about $0.80/day at neural list prices.
   */
  SIM_TTS_HOURLY_CHAR_CAP: opt(z.coerce.number().int().min(0).default(15_000)),
  SIM_TTS_DAILY_CHAR_CAP: opt(z.coerce.number().int().min(0).default(50_000)),
  /** Transcript privacy (spec 13): cases, their calls and transcripts are purged this many days after their last update. */
  TRANSCRIPT_TTL_DAYS: opt(z.coerce.number().int().min(1).max(365).default(30)),
  /** How often the TTL purge runs (ms). */
  RETENTION_SWEEP_MS: opt(z.coerce.number().int().min(1000).default(60 * 60 * 1000)),
  /** Max concurrent MCP sessions. */
  MAX_SESSIONS: opt(z.coerce.number().int().positive().default(200)),
  /** Max concurrent MCP sessions created from one client address; above it that address's oldest session is evicted. */
  MAX_SESSIONS_PER_IP: opt(z.coerce.number().int().positive().default(8)),
  /** Idle MCP sessions are closed after this many ms. */
  SESSION_IDLE_MS: opt(z.coerce.number().int().positive().default(30 * 60 * 1000)),
  /** An open SSE stream keeps an otherwise idle session alive for at most this many ms (never less than SESSION_IDLE_MS). */
  SESSION_STREAM_MAX_IDLE_MS: opt(z.coerce.number().int().positive().default(2 * 60 * 60 * 1000)),
  /** Name used in the AI disclosure when open_case gets no userName. */
  STANDIN_USER_NAME: opt(z.string().min(1).max(200).default('Mahal')),
  /** Sim speed: sim ms per real ms while talking / on hold / waiting for the user. */
  SIM_SPEED_TALK: opt(z.coerce.number().positive().default(2)),
  SIM_SPEED_HOLD: opt(z.coerce.number().positive().default(30)),
  SIM_SPEED_HANDOFF: opt(z.coerce.number().positive().default(1)),
  /** Simulated user on a hand-off: speaks after / leaves after (sim ms). */
  SIM_JOIN_SPEAK_MS: opt(z.coerce.number().int().nonnegative().default(2500)),
  SIM_JOIN_LEAVE_MS: opt(z.coerce.number().int().positive().default(9000)),
  /** Follow-up ticker interval (ms). */
  FOLLOWUP_TICK_MS: opt(z.coerce.number().int().positive().default(2000)),
  /** Static files of the simulated host. Defaults to apps/alexa-sim/dist. */
  ALEXA_SIM_DIST: opt(z.string().min(1).optional()),
  STRICT_CALLING_HOURS: boolFlag,
  /**
   * Overrides every directory entry's per-business daily call cap. Unset keeps
   * data/business-directory.json. The offline demo (`--daily-cap`) raises it so
   * repeated takes against the in-process fake business are not refused.
   */
  STANDIN_DAILY_CALL_CAP: opt(z.coerce.number().int().min(0).max(10_000).optional()),
  /** Max sim call duration (spec 4: 25 min). */
  MAX_CALL_MINUTES: opt(z.coerce.number().positive().max(240).default(25)),
  POLLY_VOICE_ALEXA: opt(z.string().min(1).default('Joanna')),

  /* ---------------- OAuth 2.1 account linking (Alexa+ add-on) ---------------- */
  /**
   * Pre-registered OAuth client (no dynamic registration). Setting it enables
   * /authorize and /token. The value is what you give `alexa-ai
   * configure-account-linking --client-id`.
   */
  OAUTH_CLIENT_ID: opt(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21-\x7e]+$/, 'OAUTH_CLIENT_ID must be printable ASCII without spaces')
      .optional(),
  ),
  /**
   * Client secret (never logged). Set: a confidential client authenticated with
   * client_secret_basic or client_secret_post. Unset: a public PKCE-only client
   * (Amazon describes the secret as optional); allowed only on a loopback-only
   * dev server, required when the server is reachable from other machines.
   */
  OAUTH_CLIENT_SECRET: opt(z.string().min(16, 'OAUTH_CLIENT_SECRET must be at least 16 characters').max(512).optional()),
  /** Exact-match allowlist of redirect URIs (comma list). Alexa shows its list after configure-account-linking. */
  OAUTH_REDIRECT_URIS: csv,
  /** Scopes advertised in scopes_supported (space or comma list). Alexa requests these during linking. */
  OAUTH_SCOPES: opt(
    z
      .string()
      .default('standin')
      .transform((s) => [...new Set(s.split(/[\s,]+/).filter((x) => x.length > 0))])
      .pipe(z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).min(1)),
  ),
  /**
   * Passcode the consent page asks for, so strangers cannot link the hosted
   * demo. Required whenever the server is reachable beyond loopback. At least
   * 8 characters; wrong guesses are also capped per IP and globally (oauth.ts).
   */
  OAUTH_LINK_PASSCODE: opt(z.string().min(8, 'OAUTH_LINK_PASSCODE must be at least 8 characters').max(200).optional()),
  /**
   * Wrong passcodes allowed per rolling hour across all linking requests. Once
   * spent, approvals are refused until the window clears (even with the right
   * passcode). Per client IP the budget is a third of this (at least 1).
   */
  OAUTH_PASSCODE_MAX_FAILURES: opt(z.coerce.number().int().min(1).max(1000).default(20)),
  OAUTH_ACCESS_TTL_SEC: opt(z.coerce.number().int().min(30).max(86_400).default(3600)),
  OAUTH_REFRESH_TTL_DAYS: opt(z.coerce.number().int().min(1).max(365).default(30)),
  OAUTH_CODE_TTL_SEC: opt(z.coerce.number().int().min(5).max(600).default(60)),
  /**
   * Tier 1 client_credentials grant (Amazon: "if you have a private MCP
   * server"). Issues `mcp:service` tokens (no refresh token) that may only
   * initialize and list; tools/call still needs a user token. Needs a secret.
   */
  OAUTH_CLIENT_CREDENTIALS: boolFlag,
  /**
   * Let initialize / tools/list / resources/list (and reading the ui:// card)
   * through without a token, so a host can discover tools before linking;
   * tools/call and everything else still answer 401. Off by default.
   */
  MCP_PUBLIC_DISCOVERY: boolFlag,
  /** Contact line on /privacy and /terms. */
  STANDIN_CONTACT: opt(z.string().min(1).max(300).default('the owner of the Stand-In GitHub repository (open an issue there)')),
});
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export class ServerConfigError extends Error {
  constructor(readonly variables: string[]) {
    super(`invalid server configuration: ${variables.join(', ')}`);
    this.name = 'ServerConfigError';
  }
}

const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1']);

export interface ParseServerEnvOptions {
  /**
   * Offline demo on a clean clone (no .env): when STANDIN_TOKEN is unset and
   * the server binds to loopback, generate a random per-process token. It is
   * never printed; /sim/config hands it to the local sim page only (loopback
   * Host). Never used when the server is reachable from other machines.
   */
  allowEphemeralToken?: boolean;
}

function isLoopbackHostname(h: string): boolean {
  const n = h.toLowerCase();
  return n === 'localhost' || n === '127.0.0.1' || n === '[::1]' || n === '::1';
}

/** A registered redirect URI: absolute https (or http on loopback, for local tests), no fragment. */
export function isValidRedirectUri(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.hash !== '' || s.includes('#')) return false;
  if (u.username !== '' || u.password !== '') return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHostname(u.hostname));
}

/** Cross-field OAuth checks. Returns offending variable names (never values). */
function oauthConfigErrors(e: ServerEnv): string[] {
  const bad: string[] = [];
  const enabled = e.OAUTH_CLIENT_ID !== undefined;
  if (!enabled) {
    if (e.OAUTH_CLIENT_SECRET !== undefined || e.OAUTH_REDIRECT_URIS.length > 0) bad.push('OAUTH_CLIENT_ID');
    return bad;
  }
  if (!e.OAUTH_REDIRECT_URIS.every(isValidRedirectUri)) bad.push('OAUTH_REDIRECT_URIS');
  // Reachable from other machines: the consent page must authenticate the
  // owner (passcode) and the token endpoint must authenticate the client
  // (secret). Otherwise anyone who knows the public client_id and a registered
  // redirect URI can approve their own request and redeem the code with PKCE.
  const publicDeployment = !LOOPBACK_BIND.has(e.HOST) || (e.PUBLIC_BASE_URL !== undefined && !isLoopbackHostname(new URL(e.PUBLIC_BASE_URL).hostname));
  if ((e.OAUTH_CLIENT_CREDENTIALS || publicDeployment) && e.OAUTH_CLIENT_SECRET === undefined) bad.push('OAUTH_CLIENT_SECRET');
  if (publicDeployment && e.OAUTH_LINK_PASSCODE === undefined) bad.push('OAUTH_LINK_PASSCODE');
  if (e.PUBLIC_BASE_URL === undefined) {
    // The issuer and the canonical resource URI come from the request only on a loopback-bound dev server.
    if (!LOOPBACK_BIND.has(e.HOST)) bad.push('PUBLIC_BASE_URL');
  } else {
    const u = new URL(e.PUBLIC_BASE_URL);
    const httpsOrLocal = u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHostname(u.hostname));
    if (!httpsOrLocal || u.search !== '' || u.hash !== '') bad.push('PUBLIC_BASE_URL');
  }
  return bad;
}

export function parseServerEnv(
  env: Record<string, string | undefined>,
  opts: ParseServerEnvOptions = {},
): ServerEnv & { STANDIN_TOKEN: string; STANDIN_TOKEN_EPHEMERAL: boolean } {
  const r = ServerEnvSchema.safeParse(env);
  if (!r.success) {
    throw new ServerConfigError([...new Set(r.error.issues.map((i) => String(i.path[0] ?? '(root)')))]);
  }
  const oauthErrors = oauthConfigErrors(r.data);
  if (oauthErrors.length > 0) throw new ServerConfigError(oauthErrors);
  if (r.data.STANDIN_TOKEN === undefined) {
    if (opts.allowEphemeralToken === true && LOOPBACK_BIND.has(r.data.HOST)) {
      return { ...r.data, STANDIN_TOKEN: randomBytes(32).toString('base64url'), STANDIN_TOKEN_EPHEMERAL: true };
    }
    throw new ServerConfigError(['STANDIN_TOKEN']);
  }
  return { ...r.data, STANDIN_TOKEN: r.data.STANDIN_TOKEN, STANDIN_TOKEN_EPHEMERAL: false };
}
