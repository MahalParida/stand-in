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

export function parseServerEnv(
  env: Record<string, string | undefined>,
  opts: ParseServerEnvOptions = {},
): ServerEnv & { STANDIN_TOKEN: string; STANDIN_TOKEN_EPHEMERAL: boolean } {
  const r = ServerEnvSchema.safeParse(env);
  if (!r.success) {
    throw new ServerConfigError([...new Set(r.error.issues.map((i) => String(i.path[0] ?? '(root)')))]);
  }
  if (r.data.STANDIN_TOKEN === undefined) {
    if (opts.allowEphemeralToken === true && LOOPBACK_BIND.has(r.data.HOST)) {
      return { ...r.data, STANDIN_TOKEN: randomBytes(32).toString('base64url'), STANDIN_TOKEN_EPHEMERAL: true };
    }
    throw new ServerConfigError(['STANDIN_TOKEN']);
  }
  return { ...r.data, STANDIN_TOKEN: r.data.STANDIN_TOKEN, STANDIN_TOKEN_EPHEMERAL: false };
}
