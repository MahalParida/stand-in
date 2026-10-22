/**
 * `STANDIN_MODE=offline pnpm demo` must work on a clean clone (no .env, so no
 * STANDIN_TOKEN): main starts with a one-time token that only the local sim
 * page receives, and never prints it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { SimConfigSchema } from '@standin/core';
import { afterEach, describe, expect, it } from 'vitest';
import { parseServerEnv, ServerConfigError } from './config.js';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
});

/** A clean environment: no .env, no STANDIN_TOKEN. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PORT: '0', SQLITE_PATH: ':memory:', ...extra };
}

function start(extra: Record<string, string> = {}): Promise<{ url: string; out: () => string; exit: Promise<number | null> }> {
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--mode=offline'], { cwd: APP_DIR, env: cleanEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  child = p;
  let out = '';
  const exit = new Promise<number | null>((r) => p.on('exit', (code) => r(code)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 20_000);
    const onData = (b: Buffer): void => {
      out += b.toString();
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m?.[1] !== undefined) {
        clearTimeout(timer);
        resolve({ url: m[1], out: () => out, exit });
      }
    };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', onData);
    void exit.then((code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${String(code)}: ${out}`));
    });
  });
}

describe('offline demo without STANDIN_TOKEN (clean clone)', () => {
  it('main starts on loopback with a one-time token served only via /sim/config, never printed', async () => {
    const s = await start();
    const cfg = SimConfigSchema.parse(await (await fetch(`${s.url}/sim/config`)).json());
    expect(cfg.mode).toBe('offline');
    const token = cfg.demoToken ?? '';
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(s.out()).not.toContain(token);
    expect(s.out()).toMatch(/one-time token/);
    const init = await fetch(`${s.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    expect(init.status).toBe(200);
    expect((await fetch(`${s.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  }, 30_000);

  it('never generates a token when bound to a non-loopback address', () => {
    expect(() => parseServerEnv({ HOST: '0.0.0.0' }, { allowEphemeralToken: true })).toThrow(ServerConfigError);
    expect(() => parseServerEnv({}, { allowEphemeralToken: false })).toThrow(ServerConfigError);
    const a = parseServerEnv({}, { allowEphemeralToken: true });
    const b = parseServerEnv({}, { allowEphemeralToken: true });
    expect(a.STANDIN_TOKEN_EPHEMERAL).toBe(true);
    expect(a.STANDIN_TOKEN).not.toBe(b.STANDIN_TOKEN);
    expect(parseServerEnv({ STANDIN_TOKEN: 'abcdefgh-123' }, { allowEphemeralToken: true }).STANDIN_TOKEN_EPHEMERAL).toBe(false);
  });
});
