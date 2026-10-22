/**
 * Spec 13 "Tampered history": the `verify` command checks a stored SQLite
 * event log and reports the first broken event per call.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLog } from './index.js';
import { SqliteRepo, verifyStore } from './sqlite.js';
import { runVerifyCli } from './verify-cli.js';

const NOW = '2026-10-22T06:00:00.000Z';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let dir: string;
let dbPath: string;

async function seed(): Promise<void> {
  const repo = new SqliteRepo({ filename: dbPath });
  for (const callId of ['call-a', 'call-b']) {
    const log = new EventLog(callId);
    log.append({ id: `${callId}-e1`, at: NOW, type: 'state', data: { from: 'DIALING', to: 'IVR' } });
    log.append({ id: `${callId}-e2`, at: NOW, type: 'heard', data: { text: 'Press 1 for billing', speaker: 'ivr' } });
    log.append({ id: `${callId}-e3`, at: NOW, type: 'dtmf', data: { digits: '1' } });
    for (const e of log.list()) await repo.appendEvent(e);
  }
  repo.close();
}

/** What an attacker with write access to the file could do: drop the append-only trigger and edit a row. */
function tamper(sql: string, ...params: string[]): void {
  const db = new Database(dbPath);
  db.exec('DROP TRIGGER IF EXISTS events_no_update');
  db.prepare(sql).run(...params);
  db.close();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'standin-verify-'));
  dbPath = join(dir, 'standin.db');
  await seed();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('verifyStore', () => {
  it('reports every intact chain with its head hash', () => {
    const r = verifyStore(dbPath);
    expect(r.ok).toBe(true);
    expect(r.calls.map((c) => [c.callId, c.ok, c.count])).toEqual([
      ['call-a', true, 3],
      ['call-b', true, 3],
    ]);
  });

  it('finds an edited event row: index, event id and reason, other calls still intact', () => {
    tamper(`UPDATE events SET data_json = ? WHERE id = ?`, JSON.stringify({ digits: '2' }), 'call-b-e3');
    const r = verifyStore(dbPath);
    expect(r.ok).toBe(false);
    expect(r.calls.find((c) => c.callId === 'call-a')?.ok).toBe(true);
    expect(r.calls.find((c) => c.callId === 'call-b')).toMatchObject({ ok: false, index: 2, eventId: 'call-b-e3', reason: 'hash_mismatch' });
  });

  it('finds a deleted middle event (prev hash no longer links)', () => {
    tamper('DELETE FROM events WHERE id = ?', 'call-a-e2');
    expect(verifyStore(dbPath, { callId: 'call-a' }).calls[0]).toMatchObject({ ok: false, index: 1, reason: 'prev_hash_mismatch' });
  });

  it('never writes to the database (opened read-only)', () => {
    tamper('UPDATE events SET hash = ? WHERE id = ?', 'f'.repeat(64), 'call-a-e1');
    verifyStore(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT hash FROM events WHERE id = ?').get('call-a-e1') as { hash: string };
    db.close();
    expect(row.hash).toBe('f'.repeat(64));
  });
});

describe('verify command', () => {
  it('exit 0 and OK lines for an intact log; no event data is printed', () => {
    const r = runVerifyCli(['--db', dbPath]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^OK\s+call-a\s+3 events\s+head [0-9a-f]{64}$/);
    expect(r.out.at(-1)).toBe('2 call(s) checked: 2 intact, 0 broken.');
    expect(r.out.join('\n')).not.toContain('Press 1');
  });

  it('exit 1 and the first broken index when a stored event was tampered with', () => {
    tamper(`UPDATE events SET data_json = ? WHERE id = ?`, JSON.stringify({ text: 'Press 9', speaker: 'ivr' }), 'call-a-e2');
    const r = runVerifyCli(['--db', dbPath]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('BROKEN  call-a  at event index 1 (call-a-e2): hash_mismatch: hash does not match event contents');
    expect(r.out.join('\n')).not.toContain('Press 9');
  });

  it('exit 2 on usage or I/O errors; --call limits the check', () => {
    expect(runVerifyCli(['--db']).code).toBe(2);
    expect(runVerifyCli(['--bogus']).code).toBe(2);
    expect(runVerifyCli(['--db', join(dir, 'missing.db')]).code).toBe(2);
    expect(runVerifyCli([], { SQLITE_PATH: ':memory:' }).code).toBe(2);
    const one = runVerifyCli(['--call', 'call-b'], { SQLITE_PATH: dbPath });
    expect(one.code).toBe(0);
    expect(one.out[0]).toMatch(/^OK\s+call-b/);
    expect(one.out).toHaveLength(2);
  });

  it('`pnpm verify` entry point: runs as a script and exits non-zero on a break', () => {
    tamper(`UPDATE events SET type = 'said' WHERE id = ?`, 'call-b-e1');
    const tsx = join(ROOT, 'node_modules/tsx/dist/cli.mjs');
    const p = spawnSync(process.execPath, [tsx, join(ROOT, 'packages/core/src/verify-cli.ts'), '--db', dbPath], { encoding: 'utf8', timeout: 30_000 });
    expect(p.status).toBe(1);
    expect(p.stdout).toContain('BROKEN  call-b  at event index 0 (call-b-e1): hash_mismatch');
    expect(p.stdout).toMatch(/OK\s+call-a/);
  });
});
