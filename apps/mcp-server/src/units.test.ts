import type { Case, CallEvent } from '@standin/core';
import { describe, expect, it } from 'vitest';
import { CALL_CARD_HTML } from './card.js';
import { parseServerEnv, ServerConfigError } from './config.js';
import { clientAddress } from './http.js';
import { PacedScheduler } from './paced-scheduler.js';
import { RateLimiter } from './rate-limit.js';
import { missingFacts, pickScenario } from './scenarios.js';
import { caseView, digestEvents, maskText } from './views.js';

describe('PacedScheduler', () => {
  it('fires timers in sim order and runs faster at a higher rate', async () => {
    let real = 0;
    const s = new PacedScheduler({ rate: 10, realNow: () => real });
    expect(s.now()).toBe(0);
    real = 100;
    expect(s.now()).toBe(1000);
    s.setRate(100);
    real = 110;
    expect(s.now()).toBe(2000);
    s.stop();
  });

  it('fires real timers, survives throwing callbacks, and stop() drops pending ones', async () => {
    const s = new PacedScheduler({ rate: 1000 });
    const fired: string[] = [];
    s.setTimer(() => fired.push('b'), 2000);
    s.setTimer(() => {
      throw new Error('boom');
    }, 500);
    s.setTimer(() => fired.push('a'), 1000);
    const dropped = s.setTimer(() => fired.push('x'), 1500);
    s.clearTimer(dropped);
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toEqual(['a', 'b']);
    s.setTimer(() => fired.push('late'), 10_000);
    s.stop();
    expect(s.pending()).toBe(0);
    expect(() => s.setRate(0)).toThrow(RangeError);
  });
});

describe('RateLimiter', () => {
  it('allows a burst, then refills at the configured rate', () => {
    let now = 0;
    const r = new RateLimiter({ ratePerSec: 2, burst: 2, now: () => now });
    expect(r.take('a')).toBe(0);
    expect(r.take('a')).toBe(0);
    expect(r.take('a')).toBeCloseTo(0.5);
    expect(r.take('b')).toBe(0);
    now = 500;
    expect(r.take('a')).toBe(0);
  });
});

describe('RateLimiter at the key cap', () => {
  it('evicts least-recently-used buckets only: flooding new keys does not reset an active client', () => {
    let now = 0;
    const r = new RateLimiter({ ratePerSec: 0.001, burst: 2, now: () => now, maxKeys: 3 });
    expect(r.take('victim')).toBe(0);
    expect(r.take('victim')).toBe(0);
    expect(r.take('victim')).toBeGreaterThan(0); // empty
    for (let i = 0; i < 50; i++) {
      now += 1;
      r.take(`flood-${i}`);
      // The active client keeps hitting the server, so it stays most recently used.
      expect(r.take('victim')).toBeGreaterThan(0);
    }
    expect(r.size).toBeLessThanOrEqual(3);
  });
});

describe('clientAddress (rate-limit key behind proxies)', () => {
  const req = (xff: string | string[] | undefined, remote = '10.9.9.9') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });
  it('ignores X-Forwarded-For unless a proxy is trusted', () => {
    expect(clientAddress(req('1.2.3.4'), 0)).toBe('10.9.9.9');
  });
  it('takes the entry the trusted proxy appended (right-most), not the client-supplied left-most one', () => {
    expect(clientAddress(req('6.6.6.6, 203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientAddress(req(['6.6.6.6', '203.0.113.7']), 1)).toBe('203.0.113.7');
    expect(clientAddress(req('6.6.6.6, 203.0.113.7, 10.0.0.2'), 2)).toBe('203.0.113.7');
    expect(clientAddress(req('203.0.113.7'), 2)).toBe('10.9.9.9');
    expect(clientAddress(req(undefined), 1)).toBe('10.9.9.9');
  });
});

describe('config', () => {
  it('treats blank values as unset and requires STANDIN_TOKEN (named, never echoed)', () => {
    const env = parseServerEnv({ STANDIN_TOKEN: 'abcdefgh-123', PORT: '', HOST: '', AWS_PROFILE: '', STANDIN_ALLOWED_ORIGINS: ' http://a , ,http://b' });
    expect(env.PORT).toBe(8787);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.STANDIN_ALLOWED_ORIGINS).toEqual(['http://a', 'http://b']);
    expect(env.DEMO_EMBED_TOKEN).toBe(false);
    expect(() => parseServerEnv({ STANDIN_TOKEN: '' })).toThrow(ServerConfigError);
    try {
      parseServerEnv({ STANDIN_TOKEN: 'short', PORT: 'x' });
    } catch (err) {
      expect((err as ServerConfigError).variables.sort()).toEqual(['PORT', 'STANDIN_TOKEN']);
      expect((err as Error).message).not.toContain('short');
    }
  });
});

describe('scenarios and required facts', () => {
  it('picks the fake-business scenario from the goal', () => {
    expect(pickScenario('broadband down, refund please', 'refund')).toBe('happy-refund');
    expect(pickScenario('they will ask for the OTP', 'refund')).toBe('otp-trap');
    expect(pickScenario('need a technician', 'repair')).toBe('unknown-fact');
  });

  it('needs an account number (never-tier values do not count)', () => {
    const b = { id: 'x', name: 'X', number: '+1-0000', hours: { start: '09:00', end: '20:00', timezone: 'Asia/Kolkata' }, dailyCap: 5 };
    expect(missingFacts(b, [])).toHaveLength(1);
    expect(missingFacts(b, [{ key: 'account_number', label: 'a', value: 'BN1', tier: 'share', approved: true, source: 'user' }])).toHaveLength(0);
    expect(missingFacts(b, [{ key: 'account_password', label: 'a', value: 'x', tier: 'never', approved: false, source: 'user' }])).toHaveLength(1);
  });
});

describe('views never leak never-tier values', () => {
  const facts: Case['facts'] = [
    { key: 'otp', label: 'OTP', value: '482913', tier: 'never', approved: false, source: 'user' },
    { key: 'account_number', label: 'Account', value: 'BN7781234', tier: 'confirm', approved: true, source: 'user' },
  ];
  const kase: Case = {
    id: 'c1',
    userName: 'Asha',
    businessId: 'bharatnet-broadband',
    goal: 'refund; my OTP is 482913',
    desiredOutcome: 'refund',
    facts,
    status: 'ready',
    promises: [],
    calls: [],
    createdAt: '2026-10-22T08:30:00.000Z',
    updatedAt: '2026-10-22T08:30:00.000Z',
  };

  it('caseView drops never values and masks the goal', () => {
    const v = caseView(kase, undefined);
    expect(JSON.stringify(v)).not.toContain('482913');
    expect(v.facts.find((f) => f.key === 'otp')?.value).toBeUndefined();
    expect(v.facts.find((f) => f.key === 'account_number')?.value).toBe('BN7781234');
  });

  it('digestEvents re-masks stored text, counts blocked/injection events and hold time', () => {
    const ev = (type: CallEvent['type'], data: unknown, at: string): CallEvent => ({ id: at, callId: 'k', at, type, data, prevHash: '0'.repeat(64), hash: '0'.repeat(64) });
    const d = digestEvents(
      [
        ev('state', { to: 'HOLD' }, '2026-10-22T08:30:00.000Z'),
        ev('state', { to: 'HUMAN' }, '2026-10-22T08:32:05.000Z'),
        ev('heard', { kind: 'speech', speaker: 'agent', text: 'Please read the OTP 482913 back' }, '2026-10-22T08:32:06.000Z'),
        ev('said', { text: 'The code is four eight two nine one three' }, '2026-10-22T08:32:07.000Z'),
        ev('dtmf', { digits: '3' }, '2026-10-22T08:29:00.000Z'),
        ev('blocked_utterance', { purpose: 'planner' }, '2026-10-22T08:32:08.000Z'),
        ev('disclosure_request', { injection: true }, '2026-10-22T08:32:09.000Z'),
      ],
      facts,
    );
    const text = JSON.stringify(d.lines);
    expect(text).not.toContain('482913');
    expect(text.toLowerCase()).not.toContain('four eight two nine one three');
    expect(d.holdSeconds).toBe(125);
    expect(d.digitsPressed).toEqual(['3']);
    expect(d.blockedCount).toBe(1);
    expect(d.injectionCount).toBe(1);
    expect(maskText('card 4111 1111 1111 1111', [])).not.toContain('4111 1111 1111 1111');
  });
});

describe('call card (MCP App)', () => {
  it('is self-contained, speaks the MCP Apps protocol and has the 7 states', () => {
    for (const s of ['Preparing', 'Dialing', 'Menu', 'On hold', 'Talking', 'Needs you', 'Done']) expect(CALL_CARD_HTML).toContain(`'${s}'`);
    for (const m of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-result', 'ui/notifications/host-context-changed', 'tools/call']) {
      expect(CALL_CARD_HTML).toContain(m);
    }
    expect(CALL_CARD_HTML).toContain("protocolVersion: '2026-01-26'");
    expect(CALL_CARD_HTML).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\//);
    expect(CALL_CARD_HTML).not.toContain('innerHTML');
  });
});

describe('STANDIN_DAILY_CALL_CAP config', () => {
  const base = { STANDIN_TOKEN: 'test-token-0123456789' };
  it('is unset by default, blank means unset, and invalid values name the variable', () => {
    expect(parseServerEnv(base).STANDIN_DAILY_CALL_CAP).toBeUndefined();
    expect(parseServerEnv({ ...base, STANDIN_DAILY_CALL_CAP: '' }).STANDIN_DAILY_CALL_CAP).toBeUndefined();
    expect(parseServerEnv({ ...base, STANDIN_DAILY_CALL_CAP: '50' }).STANDIN_DAILY_CALL_CAP).toBe(50);
    expect(() => parseServerEnv({ ...base, STANDIN_DAILY_CALL_CAP: '-1' })).toThrow(ServerConfigError);
  });
});
