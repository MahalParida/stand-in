import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  canPlaceCall,
  canPlaceCallWithRepo,
  istDayBounds,
  parseBusinessDirectory,
  strictCallingHoursFromEnv,
  type Business,
  type Case,
} from './index.js';
import { SqliteRepo } from './sqlite.js';

const directory: Business[] = [
  {
    id: 'bharatnet-broadband',
    name: 'BharatNet Broadband',
    number: '+91-00000-00001',
    hours: { start: '09:00', end: '20:00', timezone: 'Asia/Kolkata' },
    dailyCap: 2,
  },
  {
    id: 'short-hours-co',
    name: 'Short Hours Co',
    number: '+91-00000-00002',
    hours: { start: '10:00', end: '17:00', timezone: 'Asia/Kolkata' },
    dailyCap: 5,
  },
  {
    id: 'opted-out-co',
    name: 'Opted Out Co',
    number: '+91-00000-00003',
    hours: { start: '09:00', end: '20:00', timezone: 'Asia/Kolkata' },
    dailyCap: 5,
    optOut: true,
  },
];

const kase = (over: Partial<Case> = {}): Case => ({
  id: 'case-1',
  userName: 'Asha',
  businessId: 'bharatnet-broadband',
  goal: 'Refund',
  desiredOutcome: 'refund',
  facts: [],
  status: 'ready',
  promises: [],
  calls: [],
  createdAt: '2026-10-22T04:00:00.000Z',
  updatedAt: '2026-10-22T04:00:00.000Z',
  ...over,
});

// 12:00 IST == 06:30Z
const noonIst = new FixedClock('2026-10-22T12:00:00+05:30');

describe('canPlaceCall (spec 4 invariants)', () => {
  it('allows a ready case to an allowlisted business at noon IST', () => {
    const r = canPlaceCall(kase(), directory, noonIst);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.business.id).toBe('bharatnet-broadband');
  });

  it.each(['draft', 'calling', 'awaiting_user', 'promised', 'resolved', 'escalated', 'failed'] as const)(
    'rejects case status %s',
    (status) => {
      expect(canPlaceCall(kase({ status }), directory, noonIst)).toMatchObject({ ok: false, code: 'case_not_ready' });
    },
  );

  it('rejects an unknown business', () => {
    expect(canPlaceCall(kase({ businessId: 'real-bank' }), directory, noonIst)).toMatchObject({
      ok: false,
      code: 'unknown_business',
    });
  });

  it('rejects an opted-out business', () => {
    expect(canPlaceCall(kase({ businessId: 'opted-out-co' }), directory, noonIst)).toMatchObject({
      ok: false,
      code: 'business_opted_out',
    });
  });

  it.each([
    ['08:59 IST', '2026-10-22T08:59:00+05:30', false],
    ['09:00 IST', '2026-10-22T09:00:00+05:30', true],
    ['19:59 IST', '2026-10-22T19:59:00+05:30', true],
    ['20:00 IST', '2026-10-22T20:00:00+05:30', false],
    ['02:00 IST', '2026-10-22T02:00:00+05:30', false],
    // 15:00 UTC is 20:30 IST: off-hours even though it is afternoon in UTC.
    ['15:00 UTC', '2026-10-22T15:00:00Z', false],
    // 03:30 UTC is 09:00 IST.
    ['03:30 UTC', '2026-10-22T03:30:00Z', true],
  ])('strict mode: wall-clock calling hours at %s -> %s', (_label, iso, allowed) => {
    const r = canPlaceCall(kase(), directory, new FixedClock(iso), { strictCallingHours: true });
    expect(r.ok).toBe(allowed);
    if (!r.ok) expect(r.code).toBe('outside_calling_hours');
  });

  it("also respects the business's own narrower hours", () => {
    const r = canPlaceCall(kase({ businessId: 'short-hours-co' }), directory, new FixedClock('2026-10-22T09:30:00+05:30'), {
      strictCallingHours: true,
    });
    expect(r).toMatchObject({ ok: false, code: 'outside_calling_hours' });
    expect(canPlaceCall(kase({ businessId: 'short-hours-co' }), directory, noonIst, { simulatedHourIst: 9 })).toMatchObject({
      ok: false,
      code: 'outside_calling_hours',
    });
    expect(canPlaceCall(kase({ businessId: 'short-hours-co' }), directory, noonIst, { simulatedHourIst: 16 }).ok).toBe(true);
  });

  it('defaults to simulated hour 14 IST, so a 02:00 IST wall clock is allowed', () => {
    const night = new FixedClock('2026-10-22T02:00:00+05:30');
    expect(canPlaceCall(kase(), directory, night).ok).toBe(true);
    // 22:00 UTC (PST afternoon) is 03:30 IST.
    expect(canPlaceCall(kase(), directory, new FixedClock('2026-10-22T22:00:00Z')).ok).toBe(true);
  });

  it.each([
    [23, false],
    [8, false],
    [9, true],
    [19, true],
    [20, false],
    [0, false],
  ])('simulatedHourIst %i -> %s', (hour, allowed) => {
    const r = canPlaceCall(kase(), directory, noonIst, { simulatedHourIst: hour });
    expect(r.ok).toBe(allowed);
    if (!r.ok) expect(r.code).toBe('outside_calling_hours');
  });

  it('S7: simulatedHourIst 23 is refused with outside_calling_hours', () => {
    expect(canPlaceCall(kase(), directory, noonIst, { simulatedHourIst: 23 })).toMatchObject({
      ok: false,
      code: 'outside_calling_hours',
    });
  });

  it('strict mode ignores simulatedHourIst and uses the wall clock', () => {
    const night = new FixedClock('2026-10-22T02:00:00+05:30');
    expect(canPlaceCall(kase(), directory, night, { strictCallingHours: true, simulatedHourIst: 14 })).toMatchObject({
      ok: false,
      code: 'outside_calling_hours',
    });
    expect(canPlaceCall(kase(), directory, noonIst, { strictCallingHours: true, simulatedHourIst: 23 }).ok).toBe(true);
  });

  it('rejects an invalid simulatedHourIst', () => {
    expect(canPlaceCall(kase(), directory, noonIst, { simulatedHourIst: 24 }).ok).toBe(false);
    expect(canPlaceCall(kase(), directory, noonIst, { simulatedHourIst: 13.5 }).ok).toBe(false);
  });

  it('strictCallingHoursFromEnv reads STRICT_CALLING_HOURS', () => {
    expect(strictCallingHoursFromEnv({ STRICT_CALLING_HOURS: 'true' })).toBe(true);
    expect(strictCallingHoursFromEnv({ STRICT_CALLING_HOURS: 'false' })).toBe(false);
    expect(strictCallingHoursFromEnv({})).toBe(false);
  });

  it('enforces the per-business daily cap', () => {
    expect(canPlaceCall(kase(), directory, noonIst, { callsPlacedToday: 1 }).ok).toBe(true);
    expect(canPlaceCall(kase(), directory, noonIst, { callsPlacedToday: 2 })).toMatchObject({
      ok: false,
      code: 'daily_cap_reached',
    });
  });

  it('rejects an invalid case object', () => {
    const bad = { ...kase(), createdAt: 'yesterday' };
    expect(canPlaceCall(bad, directory, noonIst)).toMatchObject({ ok: false, code: 'invalid_case' });
  });

  it('istDayBounds uses the IST calendar day', () => {
    // 2026-10-22T20:00Z is 2026-10-23 01:30 IST
    expect(istDayBounds(new Date('2026-10-22T20:00:00Z'))).toEqual({
      from: '2026-10-22T18:30:00.000Z',
      to: '2026-10-23T18:30:00.000Z',
    });
  });

  it('canPlaceCallWithRepo counts only today (IST) calls to that business', async () => {
    const repo = new SqliteRepo();
    try {
      const call = (id: string, startedAt: string) => ({
        id,
        caseId: 'case-1',
        businessId: 'bharatnet-broadband',
        state: 'ENDED' as const,
        startedAt,
      });
      await repo.createCall(call('c-yesterday', '2026-10-21T10:00:00+05:30'));
      await repo.createCall(call('c-today-1', '2026-10-22T09:15:00+05:30'));
      expect((await canPlaceCallWithRepo(kase(), directory, noonIst, repo)).ok).toBe(true);
      await repo.createCall(call('c-today-2', '2026-10-22T10:15:00+05:30'));
      expect(await canPlaceCallWithRepo(kase(), directory, noonIst, repo)).toMatchObject({
        ok: false,
        code: 'daily_cap_reached',
      });
      expect(await canPlaceCallWithRepo(kase(), directory, noonIst, repo, { simulatedHourIst: 23 })).toMatchObject({
        ok: false,
        code: 'outside_calling_hours',
      });
    } finally {
      repo.close();
    }
  });
});

describe('business directory', () => {
  it('parses data/business-directory.json', () => {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('../../../data/business-directory.json', import.meta.url), 'utf8'),
    );
    const dir = parseBusinessDirectory(raw);
    expect(dir[0]).toMatchObject({
      id: 'bharatnet-broadband',
      number: '+91-00000-00001',
      hours: { start: '09:00', end: '20:00', timezone: 'Asia/Kolkata' },
      dailyCap: 5,
    });
  });

  it('rejects duplicates and malformed entries', () => {
    const entry = {
      id: 'a',
      name: 'A',
      phone: '+91-00000-00009',
      callingHours: { start: '09:00', end: '20:00' },
      dailyCallCap: 1,
    };
    expect(() => parseBusinessDirectory({ version: 1, businesses: [entry, entry] })).toThrow(/duplicate/);
    expect(() =>
      parseBusinessDirectory({ version: 1, businesses: [{ ...entry, callingHours: { start: '9am', end: '20:00' } }] }),
    ).toThrow();
  });
});
