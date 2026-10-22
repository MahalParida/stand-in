/**
 * Offline integrity check of a stored SQLite event log (spec 13: "Tampered
 * history -> hash-chained event log with `verify` command").
 *
 * Opens the database read-only, replays each call's events in insertion order
 * through verifyChain, and reports the first broken event per call. Only ids,
 * counts, reasons and hashes are reported, never event data (event data is
 * masked at write, but the report has no need for it either way).
 *
 * Node-only (better-sqlite3); exported from '@standin/core/sqlite'.
 */
import Database from 'better-sqlite3';
import { z } from 'zod';
import { verifyChain, type VerifyResult } from './event-log.js';

const EventRowSchema = z.object({
  seq: z.number().int(),
  id: z.string(),
  call_id: z.string(),
  at: z.string(),
  type: z.string(),
  data_json: z.string(),
  prev_hash: z.string(),
  hash: z.string(),
});
type EventRow = z.infer<typeof EventRowSchema>;

export type CallVerifyReport =
  | { callId: string; ok: true; count: number; head: string }
  | { callId: string; ok: false; count: number; index: number; eventId: string | undefined; reason: Extract<VerifyResult, { ok: false }>['reason'] | 'bad_json'; message: string };

export interface StoreVerifyReport {
  ok: boolean;
  calls: CallVerifyReport[];
}

export interface VerifyStoreOptions {
  /** Only this call. */
  callId?: string;
}

/** Row -> the raw event shape verifyChain checks. Unparseable data is a break of its own. */
function rowToRaw(r: EventRow): { ok: true; event: unknown } | { ok: false; message: string } {
  let data: unknown;
  try {
    data = JSON.parse(r.data_json) as unknown;
  } catch {
    return { ok: false, message: 'data_json is not valid JSON' };
  }
  return { ok: true, event: { id: r.id, callId: r.call_id, at: r.at, type: r.type, data, prevHash: r.prev_hash, hash: r.hash } };
}

function verifyCall(callId: string, rows: readonly EventRow[]): CallVerifyReport {
  const events: unknown[] = [];
  for (const [i, r] of rows.entries()) {
    const raw = rowToRaw(r);
    if (!raw.ok) return { callId, ok: false, count: rows.length, index: i, eventId: r.id, reason: 'bad_json', message: raw.message };
    events.push(raw.event);
  }
  const v = verifyChain(events);
  if (v.ok) return { callId, ok: true, count: v.count, head: v.head };
  return { callId, ok: false, count: rows.length, index: v.index, eventId: rows[v.index]?.id, reason: v.reason, message: v.message };
}

/** Verifies every call's chain (or one call's) in the SQLite file at `filename`. Never writes to it. */
export function verifyStore(filename: string, opts: VerifyStoreOptions = {}): StoreVerifyReport {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const cols = 'seq, id, call_id, at, type, data_json, prev_hash, hash';
    const raw: unknown[] =
      opts.callId === undefined
        ? db.prepare(`SELECT ${cols} FROM events ORDER BY call_id, seq`).all()
        : db.prepare(`SELECT ${cols} FROM events WHERE call_id = ? ORDER BY seq`).all(opts.callId);
    const byCall = new Map<string, EventRow[]>();
    for (const r of raw) {
      const row = EventRowSchema.parse(r);
      const list = byCall.get(row.call_id) ?? [];
      list.push(row);
      byCall.set(row.call_id, list);
    }
    const calls = [...byCall.entries()].map(([callId, rows]) => verifyCall(callId, rows));
    return { ok: calls.every((c) => c.ok), calls };
  } finally {
    db.close();
  }
}

/** Human-readable report lines (ids, counts and hashes only). */
export function formatStoreReport(r: StoreVerifyReport): string[] {
  const lines = r.calls.map((c) =>
    c.ok
      ? `OK      ${c.callId}  ${c.count} events  head ${c.head}`
      : `BROKEN  ${c.callId}  at event index ${c.index}${c.eventId === undefined ? '' : ` (${c.eventId})`}: ${c.reason}: ${c.message}`,
  );
  const broken = r.calls.filter((c) => !c.ok).length;
  lines.push(
    r.calls.length === 0
      ? 'No events found.'
      : `${r.calls.length} call(s) checked: ${r.calls.length - broken} intact, ${broken} broken.`,
  );
  return lines;
}
