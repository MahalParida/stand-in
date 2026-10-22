import { describe, expect, it } from 'vitest';
import {
  EventLog,
  GENESIS_HASH,
  canonicalJson,
  firstBrokenIndex,
  sealEvent,
  verifyChain,
  type CallEvent,
} from './index.js';

function buildLog(n = 5): CallEvent[] {
  const log = new EventLog('call-1');
  for (let i = 0; i < n; i++) {
    log.append({
      id: `evt-${i}`,
      at: new Date(Date.UTC(2026, 9, 22, 6, 0, i)).toISOString(),
      type: i % 2 === 0 ? 'heard' : 'said',
      data: { text: `line ${i}`, n: i, nested: { b: 2, a: [1, { z: true, y: null }] } },
    });
  }
  return log.list();
}

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, 'x'] } })).toBe('{"a":{"c":[3,"x"]},"b":1}');
  });
  it('is insensitive to key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
  it('rejects non-JSON values', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow(TypeError);
  });
});

describe('hash-chained event log', () => {
  it('chains from genesis and verifies', () => {
    const events = buildLog();
    expect(events[0]?.prevHash).toBe(GENESIS_HASH);
    for (let i = 1; i < events.length; i++) expect(events[i]?.prevHash).toBe(events[i - 1]?.hash);
    const r = verifyChain(events);
    expect(r).toEqual({ ok: true, count: 5, head: events[4]?.hash });
    expect(firstBrokenIndex(events)).toBe(-1);
  });

  it('empty chain is valid', () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0, head: GENESIS_HASH });
  });

  it('detects edited data (tampered history)', () => {
    const events = buildLog();
    const tampered = structuredClone(events);
    (tampered[2] as { data: unknown }).data = { text: 'I never promised a refund', n: 2 };
    const r = verifyChain(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.index).toBe(2);
      expect(r.reason).toBe('hash_mismatch');
    }
  });

  it('detects an edited timestamp or type', () => {
    const a = structuredClone(buildLog());
    a[3] = { ...a[3]!, at: '2030-01-01T00:00:00.000Z' };
    expect(firstBrokenIndex(a)).toBe(3);
    const b = structuredClone(buildLog());
    b[1] = { ...b[1]!, type: 'error' };
    expect(firstBrokenIndex(b)).toBe(1);
  });

  it('detects a re-hashed edit via the next link', () => {
    const events = structuredClone(buildLog());
    // Attacker edits event 1 and recomputes its own hash, but cannot fix event 2's prevHash.
    events[1] = sealEvent(events[0]!.hash, { ...events[1]!, data: { text: 'forged' } });
    const r = verifyChain(events);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.index).toBe(2);
      expect(r.reason).toBe('prev_hash_mismatch');
    }
  });

  it('detects deletion and reordering', () => {
    const events = buildLog();
    expect(firstBrokenIndex([events[0]!, events[2]!, events[3]!])).toBe(1);
    expect(firstBrokenIndex([events[1]!, events[0]!])).toBe(0);
  });

  it('detects a forged hash string and malformed events', () => {
    const events = structuredClone(buildLog());
    events[4] = { ...events[4]!, hash: 'f'.repeat(64) };
    expect(firstBrokenIndex(events)).toBe(4);
    const r = verifyChain([{ nope: true }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('schema');
  });

  it('rejects mixing calls in one chain', () => {
    const a = buildLog(2);
    const other = new EventLog('call-2');
    const e = other.append({ id: 'x', at: '2026-10-22T06:00:00.000Z', type: 'state', data: {} });
    const r = verifyChain([a[0]!, { ...e, prevHash: a[0]!.hash }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('call_id_mismatch');
  });

  it('list() returns copies; the log itself cannot be tampered through them', () => {
    const log = new EventLog('call-1');
    log.append({ id: 'a', at: '2026-10-22T06:00:00.000Z', type: 'said', data: { text: 'hi' } });
    const copy = log.list();
    (copy[0] as { data: unknown }).data = 'changed';
    expect(log.verify().ok).toBe(true);
  });

  it('refuses to resume from a broken chain', () => {
    const events = structuredClone(buildLog(3));
    (events[1] as { data: unknown }).data = 'x';
    expect(() => new EventLog('call-1', events)).toThrow(/broken at index 1/);
  });

  it('resumes from a valid chain', () => {
    const events = buildLog(3);
    const log = new EventLog('call-1', events);
    log.append({ id: 'evt-3', at: '2026-10-22T06:00:03.000Z', type: 'outcome', data: { ticketId: 'T1' } });
    expect(log.verify()).toMatchObject({ ok: true, count: 4 });
  });
});
