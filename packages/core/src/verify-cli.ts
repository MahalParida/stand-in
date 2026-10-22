#!/usr/bin/env node
/**
 * `pnpm verify [--db PATH] [--call ID]` — checks the hash chain of every call
 * stored in a Stand-In SQLite database (spec 13). Read-only.
 *
 * PATH defaults to $SQLITE_PATH, else ./standin.db. Exit codes: 0 every chain
 * intact, 1 at least one chain broken, 2 usage or I/O error.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatStoreReport, verifyStore } from './verify-store.js';

const USAGE = 'usage: standin-verify [--db PATH] [--call CALL_ID]';

export interface CliResult {
  code: 0 | 1 | 2;
  out: string[];
  err: string[];
}

export function runVerifyCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): CliResult {
  let db = env.SQLITE_PATH ?? './standin.db';
  let callId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--') continue;
    if (a === '-h' || a === '--help') return { code: 0, out: [USAGE], err: [] };
    if ((a === '--db' || a === '--call') && (next === undefined || next.startsWith('--'))) {
      return { code: 2, out: [], err: [`${a} needs a value`, USAGE] };
    }
    if (a === '--db' && next !== undefined) {
      db = next;
      i++;
    } else if (a === '--call' && next !== undefined) {
      callId = next;
      i++;
    } else {
      return { code: 2, out: [], err: [`unknown argument: ${a ?? ''}`, USAGE] };
    }
  }
  if (db === ':memory:') return { code: 2, out: [], err: ['SQLITE_PATH is :memory:; pass --db with a database file'] };
  try {
    const report = verifyStore(db, callId === undefined ? {} : { callId });
    return { code: report.ok ? 0 : 1, out: formatStoreReport(report), err: [] };
  } catch (e) {
    return { code: 2, out: [], err: [`cannot verify ${db}: ${(e as Error).message}`] };
  }
}

const isMain = ((): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const r = runVerifyCli(process.argv.slice(2), process.env);
  for (const l of r.out) process.stdout.write(`${l}\n`);
  for (const l of r.err) process.stderr.write(`${l}\n`);
  process.exitCode = r.code;
}
