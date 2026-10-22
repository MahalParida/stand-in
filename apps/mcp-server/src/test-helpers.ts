/** Test-only helpers (excluded from the build). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolErrorSchema } from '@standin/core';
import { createProviders, type Providers } from '@standin/providers';
import { parseServerEnv } from './config.js';
import { createStandinServer, type StandinServer } from './http.js';

export const TOKEN = 'test-token-for-vitest-only-0123456789';

export interface Started {
  url: string;
  server: StandinServer;
  providers: Providers;
  close(): Promise<void>;
}

export interface StartOptions {
  staticDir?: string;
  /** Provider env (default offline, in-memory SQLite). */
  providersEnv?: Record<string, string>;
  /** Swap providers (e.g. a counting fake LLM / TTS). */
  providers?: (p: Providers) => Providers;
}

export async function startServer(envOver: Record<string, string> = {}, opts: StartOptions = {}): Promise<Started> {
  const env = parseServerEnv({
    STANDIN_TOKEN: TOKEN,
    PORT: '0',
    SIM_SPEED_TALK: '40',
    SIM_SPEED_HOLD: '400',
    SIM_SPEED_HANDOFF: '20',
    SIM_JOIN_SPEAK_MS: '1500',
    SIM_JOIN_LEAVE_MS: '6000',
    RATE_LIMIT_RPS: '1000',
    RATE_LIMIT_BURST: '1000',
    ...envOver,
  });
  const base = createProviders(opts.providersEnv ?? { STANDIN_MODE: 'offline', SQLITE_PATH: ':memory:' });
  const providers = opts.providers === undefined ? base : opts.providers(base);
  const server = createStandinServer({
    env,
    providers,
    staticDir: opts.staticDir ?? join(mkdtempSync(join(tmpdir(), 'standin-static-')), 'missing'),
  });
  const { url } = await server.listen(0, '127.0.0.1');
  return {
    url,
    server,
    providers,
    async close() {
      await server.close();
      providers.close();
    },
  };
}

export async function connectClient(
  url: string,
  opts: { elicitation?: boolean; token?: string } = {},
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: 'vitest-host', version: '1.0.0' }, { capabilities: opts.elicitation === true ? { elicitation: {} } : {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${opts.token ?? TOKEN}` } },
  });
  await client.connect(transport);
  // Real hosts (alexa-sim, Alexa+) call tools/list first, which makes the SDK
  // Client cache every tool's outputSchema and validate later results against
  // it. Do the same so error results are exercised through that validator.
  await client.listTools();
  return { client, transport };
}

/** The spec-7 ToolError of an isError result (sent as text, no structuredContent). */
export function toolErrorOf(r: unknown): { error: { code: string; message: string } } {
  const res = r as CallToolResult;
  if (res.isError !== true) throw new Error('not an error result');
  if (res.structuredContent !== undefined) throw new Error('error result must not carry structuredContent');
  const text = res.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
  return ToolErrorSchema.parse(JSON.parse(text));
}

export function structured(r: unknown): Record<string, unknown> {
  const res = r as CallToolResult;
  if (res.structuredContent === undefined) throw new Error('no structuredContent');
  return res.structuredContent;
}

export async function callOk(client: Client, name: string, args: Record<string, unknown>, log?: unknown[]): Promise<Record<string, unknown>> {
  const r = await client.callTool({ name, arguments: args });
  log?.push(r);
  if (r.isError === true) throw new Error(`${name} failed: ${JSON.stringify(r.structuredContent ?? r.content)}`);
  return structured(r);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll call_status until `until` holds (or the call is terminal). */
export async function pollStatus(
  client: Client,
  callId: string,
  until: (s: Record<string, unknown>) => boolean,
  log?: unknown[],
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await callOk(client, 'call_status', { callId }, log);
    if (until(s)) return s;
    if (s.state === 'ENDED' || s.state === 'FAILED') return s;
    if (Date.now() > deadline) throw new Error(`timeout waiting for call ${callId}; last state ${String(s.state)}`);
    await sleep(40);
  }
}
