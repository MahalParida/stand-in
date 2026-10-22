/**
 * Append-only, hash-chained call event log (spec section 4, section 13 "Tampered history").
 *
 * hash_n = sha256( prevHash_n + canonicalJson({ id, callId, at, type, data }) )
 * prevHash_0 = GENESIS_HASH; prevHash_n = hash_{n-1}.
 *
 * Any edit, insertion, deletion or reorder of an event breaks the chain at that
 * index; `verifyChain` reports the first broken index.
 *
 * NOTE: callers must mask `never`-tier values BEFORE appending (the log stores
 * whatever `data` it is given, and it is persisted).
 */
import { sha256Hex } from './sha256.js';
import { CallEventSchema, type CallEvent, type CallEventType } from './types.js';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic JSON: object keys sorted (code-unit order), no whitespace,
 * `undefined` object members omitted. Throws TypeError for values JSON cannot
 * represent faithfully (NaN/Infinity, bigint, functions, symbols, cycles, non-plain objects).
 */
export function canonicalJson(value: unknown): string {
  const stack = new Set<object>();
  const enc = (v: unknown): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string':
        return JSON.stringify(v);
      case 'boolean':
        return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError('canonicalJson: non-finite number');
        return JSON.stringify(v);
      case 'object': {
        if (stack.has(v)) throw new TypeError('canonicalJson: cyclic structure');
        stack.add(v);
        try {
          if (Array.isArray(v)) {
            return `[${v.map((x) => (x === undefined ? 'null' : enc(x))).join(',')}]`;
          }
          const proto: unknown = Object.getPrototypeOf(v);
          if (proto !== Object.prototype && proto !== null) {
            throw new TypeError('canonicalJson: only plain objects are supported');
          }
          const rec = v as Record<string, unknown>;
          const keys = Object.keys(rec)
            .filter((k) => rec[k] !== undefined)
            .sort();
          return `{${keys.map((k) => `${JSON.stringify(k)}:${enc(rec[k])}`).join(',')}}`;
        } finally {
          stack.delete(v);
        }
      }
      default:
        throw new TypeError(`canonicalJson: unsupported type ${typeof v}`);
    }
  };
  return enc(value);
}

export { sha256Hex };

export interface UnsealedEvent {
  id: string;
  callId: string;
  at: string;
  type: CallEventType;
  data: unknown;
}

export function computeEventHash(prevHash: string, e: UnsealedEvent): string {
  return sha256Hex(
    prevHash + canonicalJson({ id: e.id, callId: e.callId, at: e.at, type: e.type, data: e.data }),
  );
}

/** Seal an event onto a chain whose last hash is `prevHash` (GENESIS_HASH for the first). */
export function sealEvent(prevHash: string, e: UnsealedEvent): CallEvent {
  // Round-trip data through canonical JSON so what is stored is exactly what was hashed.
  const data: unknown = e.data === undefined ? null : JSON.parse(canonicalJson(e.data));
  const sealed = { id: e.id, callId: e.callId, at: e.at, type: e.type, data };
  return CallEventSchema.parse({ ...sealed, prevHash, hash: computeEventHash(prevHash, sealed) });
}

export type VerifyResult =
  | { ok: true; count: number; head: string }
  | {
      ok: false;
      /** Index of the first event that fails verification. */
      index: number;
      reason: 'schema' | 'prev_hash_mismatch' | 'hash_mismatch' | 'call_id_mismatch';
      message: string;
    };

/**
 * Verify a single call's chain from genesis. Never throws.
 * Returns the first broken index, or ok with the head hash.
 */
export function verifyChain(events: readonly unknown[]): VerifyResult {
  let prev = GENESIS_HASH;
  let callId: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const parsed = CallEventSchema.safeParse(events[i]);
    if (!parsed.success) {
      return { ok: false, index: i, reason: 'schema', message: parsed.error.issues.map((x) => x.message).join('; ') };
    }
    const e = parsed.data;
    callId ??= e.callId;
    if (e.callId !== callId) {
      return { ok: false, index: i, reason: 'call_id_mismatch', message: `expected callId ${callId}, got ${e.callId}` };
    }
    if (e.prevHash !== prev) {
      return { ok: false, index: i, reason: 'prev_hash_mismatch', message: 'prevHash does not match previous event hash' };
    }
    let expected: string;
    try {
      expected = computeEventHash(prev, e);
    } catch (err) {
      return { ok: false, index: i, reason: 'hash_mismatch', message: (err as Error).message };
    }
    if (e.hash !== expected) {
      return { ok: false, index: i, reason: 'hash_mismatch', message: 'hash does not match event contents' };
    }
    prev = e.hash;
  }
  return { ok: true, count: events.length, head: prev };
}

/** Index of the first broken event, or -1 if the chain is intact. */
export function firstBrokenIndex(events: readonly unknown[]): number {
  const r = verifyChain(events);
  return r.ok ? -1 : r.index;
}

/** In-memory append-only log for one call. */
export class EventLog {
  readonly #callId: string;
  readonly #events: CallEvent[] = [];

  constructor(callId: string, existing: readonly CallEvent[] = []) {
    this.#callId = callId;
    const r = verifyChain(existing);
    if (!r.ok) throw new Error(`EventLog: existing chain broken at index ${r.index} (${r.reason})`);
    if (existing.some((e) => e.callId !== callId)) throw new Error('EventLog: existing events belong to another call');
    this.#events.push(...existing);
  }

  get callId(): string {
    return this.#callId;
  }

  get head(): string {
    return this.#events.at(-1)?.hash ?? GENESIS_HASH;
  }

  append(e: Omit<UnsealedEvent, 'callId'>): CallEvent {
    const sealed = sealEvent(this.head, { ...e, callId: this.#callId });
    this.#events.push(sealed);
    return sealed;
  }

  /** Defensive copy; mutating it does not affect the log. */
  list(): CallEvent[] {
    return this.#events.map((e) => structuredClone(e));
  }

  verify(): VerifyResult {
    return verifyChain(this.#events);
  }
}
