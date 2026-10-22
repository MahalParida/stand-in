/**
 * Calls interrupted by a server restart must end FAILED, not stay frozen in a
 * live state: kill -9 mid-call on a file-backed DB, restart, and the call is
 * FAILED (server_restart), the case can be called again, and end_call on the
 * stale row is not an echo of the old state. A graceful close waits for the
 * terminal write.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTerminal } from '@standin/core';
import { createProviders } from '@standin/providers';
import { afterEach, describe, expect, it } from 'vitest';
import { StandinApp } from './standin-app.js';
import { callOk, connectClient, TOKEN } from './test-helpers.js';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const FACTS = [{ key: 'account_number', label: 'BharatNet account number', value: 'BN7781234', approve: true }];

let children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children) c.kill('SIGKILL');
  children = [];
});

function start(dbPath: string): Promise<{ url: string; proc: ChildProcess; exit: Promise<unknown> }> {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    PORT: '0',
    STANDIN_TOKEN: TOKEN,
    SQLITE_PATH: dbPath,
    // Slow sim so the call is still live when the process is killed.
    SIM_SPEED_TALK: '0.05',
    SIM_SPEED_HOLD: '0.05',
    RATE_LIMIT_RPS: '1000',
    RATE_LIMIT_BURST: '1000',
  };
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--mode=offline'], { cwd: APP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  let out = '';
  const exit = new Promise((r) => p.on('exit', r));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 20_000);
    const onData = (b: Buffer): void => {
      out += b.toString();
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m?.[1] !== undefined) {
        clearTimeout(timer);
        resolve({ url: m[1], proc: p, exit });
      }
    };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', onData);
  });
}

describe('server restart mid-call', () => {
  it('kill -9 then restart: the call is FAILED (server_restart) and the case can be called again', async () => {
    const db = join(mkdtempSync(join(tmpdir(), 'standin-restart-')), 'standin.db');
    const a = await start(db);
    const { client: c1 } = await connectClient(a.url);
    const opened = await callOk(c1, 'open_case', { businessName: 'BharatNet', goal: 'refund for outage', desiredOutcome: 'refund', facts: FACTS });
    const caseId = (opened.case as { id: string }).id;
    const placed = await callOk(c1, 'place_call', { caseId });
    const callId = placed.callId as string;
    const live = await callOk(c1, 'call_status', { callId });
    expect(['ENDED', 'FAILED']).not.toContain(live.state);
    a.proc.kill('SIGKILL');
    await a.exit;

    const b = await start(db);
    const { client: c2 } = await connectClient(b.url);
    const st = await callOk(c2, 'call_status', { callId });
    expect(st).toMatchObject({ state: 'FAILED', failureReason: 'server_restart' });
    expect(st.summary).toMatch(/restarted/);
    const got = await callOk(c2, 'get_case', { caseId });
    expect((got.case as { status: string }).status).toBe('ready');
    const ended = await callOk(c2, 'end_call', { callId });
    expect(ended.state).toBe('FAILED');
    const again = await callOk(c2, 'place_call', { caseId });
    expect(again.state).toBe('DIALING');
    await c2.close();
  }, 60_000);

  it('a stale row read before startup recovery is repaired on read (end_call / call_status)', async () => {
    const providers = createProviders({ STANDIN_MODE: 'offline', SQLITE_PATH: ':memory:' });
    const slow = { speeds: { talk: 0.05, hold: 0.05 } };
    const app1 = new StandinApp({ providers, ...slow });
    const app2 = new StandinApp({ providers, ...slow });
    try {
      const { case: kase } = await app1.openCase({ businessName: 'BharatNet', goal: 'refund for outage', desiredOutcome: 'refund', facts: FACTS });
      const { callId } = await app1.placeCall({ caseId: kase.id });
      // app2 shares the DB but has no live session: to it the row is orphaned.
      const ended = await app2.endCall(callId);
      expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'server_restart' });
      expect((await app2.getCase(kase.id)).case.status).toBe('ready');
    } finally {
      await app1.close();
      await app2.close();
      providers.close();
    }
  });

  it('graceful close waits for the live call to reach a terminal row', async () => {
    const providers = createProviders({ STANDIN_MODE: 'offline', SQLITE_PATH: ':memory:' });
    const app = new StandinApp({ providers, speeds: { talk: 0.05, hold: 0.05 } });
    try {
      const { case: kase } = await app.openCase({ businessName: 'BharatNet', goal: 'refund for outage', desiredOutcome: 'refund', facts: FACTS });
      const { callId } = await app.placeCall({ caseId: kase.id });
      await app.close();
      const row = await providers.repo.getCall(callId);
      expect(row !== undefined && isTerminal(row.state)).toBe(true);
      expect((await providers.repo.getCase(kase.id))?.status).not.toBe('calling');
    } finally {
      providers.close();
    }
  });
});
