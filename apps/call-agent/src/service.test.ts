import { isTerminal, verifyChain, type Business, type CallState, type Case, type Repo } from '@standin/core';
import { FakeBusiness, VirtualScheduler, presetScenario } from '@standin/fake-business';
import { LocalScheduler, createSqliteRepo } from '@standin/providers';
import { afterEach, describe, expect, it } from 'vitest';
import { isAllowlistedNumber, loadDirectory } from './directory.js';
import { CallService } from './service.js';
import { ScriptedPlanner } from './scripted-policy.js';
import { SimCarrier } from './sim-carrier.js';
import { DEFAULT_FACTS, makeCase } from './test-support.js';
import { askedPhrase, factKeyFor, matchFact, parseDueBy, parseMenu, parseOutcome } from './text-rules.js';

const repos: { close(): void }[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});

function setup(wallClockIso = '2026-10-22T08:30:00Z') {
  const scheduler = new VirtualScheduler();
  const base = Date.parse(wallClockIso);
  const clock = { now: () => new Date(base + scheduler.now()) };
  const repo = createSqliteRepo();
  repos.push(repo);
  const directory = loadDirectory();
  const jobs = new LocalScheduler({ repo, clock });
  const dials: Business[] = [];
  const businesses: FakeBusiness[] = [];
  const service = new CallService({
    repo,
    directory,
    clock,
    timers: scheduler,
    scheduler: jobs,
    planner: new ScriptedPlanner(),
    carrierFactory: (b) => {
      dials.push(b);
      const fb = new FakeBusiness(presetScenario('happy-refund'), { scheduler, clock: () => clock.now() });
      businesses.push(fb);
      return new SimCarrier(fb, { directory });
    },
  });
  const addCase = (over: Partial<Case> = {}) => repo.createCase(makeCase(DEFAULT_FACTS, over));
  return { scheduler, clock, repo, directory, jobs, dials, businesses, service, addCase };
}

describe('directory allowlist', () => {
  it('loads data/business-directory.json and only allowlists its numbers', () => {
    const dir = loadDirectory();
    expect(dir.map((b) => b.id)).toContain('bharatnet-broadband');
    expect(isAllowlistedNumber('+91-00000-00001', dir)).toBe(true);
    expect(isAllowlistedNumber('+91 00000 00001', dir)).toBe(true);
    expect(isAllowlistedNumber('+91-00000-09999', dir)).toBe(false);
    expect(isAllowlistedNumber('', dir)).toBe(false);
  });

  it('SimCarrier refuses to dial a number outside the directory', async () => {
    const fb = new FakeBusiness(presetScenario('happy-refund'), { scheduler: new VirtualScheduler() });
    const c = new SimCarrier(fb, { directory: loadDirectory() });
    await expect(c.dial('+91-98765-43210', { callId: 'x' })).rejects.toThrow(/not in the business directory/);
    expect(fb.phase).toBe('idle');
  });
});

describe('CallService.placeCall policy (S7)', () => {
  it('simulatedHourIst 23 -> refused, nothing dialled', async () => {
    const s = setup();
    await s.addCase();
    const r = await s.service.placeCall('case-t', { simulatedHourIst: 23 });
    expect(r).toMatchObject({ ok: false, code: 'outside_calling_hours' });
    expect(s.dials).toHaveLength(0);
    expect(await s.repo.listCallsByCase('case-t')).toHaveLength(0);
  });

  it('business not in the directory -> refused, nothing dialled', async () => {
    const s = setup();
    await s.addCase({ businessId: 'acme-scam-support' });
    expect(await s.service.placeCall('case-t')).toMatchObject({ ok: false, code: 'unknown_business' });
    expect(s.dials).toHaveLength(0);
  });

  it('defaults to simulated hour 14 even at 23:30 IST wall clock (judges in PST are never blocked)', async () => {
    const s = setup('2026-10-22T18:00:00Z');
    await s.addCase();
    const r = await s.service.placeCall('case-t');
    expect(r.ok).toBe(true);
    expect(s.dials).toHaveLength(1);
    if (r.ok) await r.session.end();
  });

  it('strict calling hours use the IST wall clock', async () => {
    const s = setup('2026-10-22T18:00:00Z');
    const strict = new CallService({
      repo: s.repo,
      directory: s.directory,
      clock: s.clock,
      timers: s.scheduler,
      planner: new ScriptedPlanner(),
      strictCallingHours: true,
      carrierFactory: () => {
        throw new Error('must not dial');
      },
    });
    await s.addCase();
    expect(await strict.placeCall('case-t')).toMatchObject({ ok: false, code: 'outside_calling_hours' });
  });

  it('rejects bad options, unknown cases and cases that are not ready', async () => {
    const s = setup();
    await s.addCase({ status: 'draft' });
    expect(await s.service.placeCall('case-t', { simulatedHourIst: 25 })).toMatchObject({ ok: false, code: 'invalid_options' });
    expect(await s.service.placeCall('nope')).toMatchObject({ ok: false, code: 'case_not_found' });
    expect(await s.service.placeCall('case-t')).toMatchObject({ ok: false, code: 'case_not_ready' });
    expect(s.dials).toHaveLength(0);
  });
});

describe('CallService: a full call persists a hash-chained log, the promise and a follow-up', () => {
  it('promises and schedules relative to the call date, never in the past (late demo date)', async () => {
    const s = setup('2026-11-15T08:30:00Z');
    await s.addCase();
    const r = await s.service.placeCall('case-t');
    if (!r.ok) throw new Error('place_call refused');
    await s.scheduler.runUntilIdle({
      settle: async () => {
        const fb = s.businesses.at(-1);
        if (fb) await fb.settled();
        await r.session.idle();
      },
      until: () => isTerminal(r.session.state),
    });
    const fin = await r.finished;
    expect(fin.call.outcome?.dueBy).toBe('22 Nov 2026');
    expect(fin.followupJob?.runAt).toBe('2026-11-23T04:30:00.000Z');
    expect(Date.parse(fin.followupJob?.runAt ?? '')).toBeGreaterThan(s.clock.now().getTime());
  });

  it('records the outcome on the case, schedules dueBy + 1 day, and runs the follow-up', async () => {
    const s = setup();
    await s.addCase();
    const r = await s.service.placeCall('case-t');
    expect(r).toMatchObject({ ok: true, state: 'DIALING' });
    if (!r.ok) return;
    await s.scheduler.runUntilIdle({
      settle: async () => {
        const fb = s.businesses.at(-1);
        if (fb) await fb.settled();
        await r.session.idle();
      },
      until: () => isTerminal(r.session.state),
    });
    const fin = await r.finished;
    expect(fin.call).toMatchObject({ state: 'ENDED', outcome: { ticketId: 'SR-48213' } });
    expect(fin.case.status).toBe('promised');
    expect(fin.case.promises).toEqual([expect.objectContaining({ ticketId: 'SR-48213', callId: r.callId })]);
    expect(fin.followupJob).toMatchObject({ kind: 'followup', runAt: '2026-10-30T04:30:00.000Z', payload: { ticketId: 'SR-48213' } });

    const stored = await s.repo.listEvents(r.callId);
    expect(stored.length).toBe(r.session.events().length);
    expect(verifyChain(stored).ok).toBe(true);
    expect(stored.some((e) => JSON.stringify(e.data).includes('482913'))).toBe(false);

    const job = fin.followupJob;
    if (job === undefined) return;
    const f = await s.service.runFollowup(job);
    expect(f.ok).toBe(true);
    if (f.ok) await f.session.end();
  });
});

describe('text rules', () => {
  it('askedPhrase / matchFact / factKeyFor', () => {
    expect(askedPhrase("Could you tell me the router serial number? It's under the router.")).toBe('router serial number');
    expect(askedPhrase('Could you tell me the registered account number, please?')).toBe('registered account number');
    expect(askedPhrase('Thank you.')).toBeUndefined();
    const facts = [
      { key: 'account_number', label: 'BharatNet account number' },
      { key: 'user_name', label: 'account holder name' },
    ];
    expect(matchFact('registered account number', facts)?.key).toBe('account_number');
    expect(matchFact('router serial number', facts)).toBeUndefined();
    expect(factKeyFor('router serial number')).toBe('router_serial_number');
    expect(factKeyFor('123')).toBe('answer');
  });

  it('parseMenu / parseOutcome / parseDueBy', () => {
    expect(parseMenu('For billing, press 1. To repeat this menu, press 9.')).toEqual([
      { digit: '1', label: 'billing' },
      { digit: '9', label: 'repeat this menu' },
    ]);
    expect(parseOutcome('Let me check SR-48213. I am escalating this.')).toBeUndefined();
    expect(parseOutcome('Your service request number is SR-50721, and this will be completed by 25 Oct 2026.')).toMatchObject({
      ticketId: 'SR-50721',
      dueBy: '25 Oct 2026',
    });
    expect(parseDueBy('29 Oct 2026')?.toISOString()).toBe('2026-10-29T04:30:00.000Z');
    expect(parseDueBy('2026-11-02')?.toISOString()).toBe('2026-11-02T04:30:00.000Z');
    expect(parseDueBy('soon')).toBeUndefined();
  });
});

describe('CallService: background failures and concurrency (M2 r1 review)', () => {
  function svc(preset: 'happy-refund' | 'unknown-fact', wrap: (r: Repo) => Repo = (r) => r) {
    const scheduler = new VirtualScheduler();
    const clock = { now: () => new Date(Date.parse('2026-10-22T08:30:00Z') + scheduler.now()) };
    const base = createSqliteRepo();
    repos.push(base);
    const repo = wrap(base);
    const directory = loadDirectory();
    const dials: Business[] = [];
    const businesses: FakeBusiness[] = [];
    const service = new CallService({
      repo,
      directory,
      clock,
      timers: scheduler,
      scheduler: new LocalScheduler({ repo: base, clock }),
      planner: new ScriptedPlanner(),
      carrierFactory: (b) => {
        dials.push(b);
        const fb = new FakeBusiness(presetScenario(preset), { scheduler, clock: () => clock.now() });
        businesses.push(fb);
        return new SimCarrier(fb, { directory });
      },
    });
    const drive = (session: { idle(): Promise<void>; state: CallState }, until?: () => boolean) =>
      scheduler.runUntilIdle({
        settle: async () => {
          const fb = businesses.at(-1);
          if (fb) await fb.settled();
          await session.idle();
        },
        until: until ?? (() => isTerminal(session.state)),
      });
    return { base, repo, service, dials, drive };
  }

  function trapUnhandled(): { count: () => number; dispose: () => void } {
    let n = 0;
    const h = () => {
      n++;
    };
    process.on('unhandledRejection', h);
    return { count: () => n, dispose: () => process.off('unhandledRejection', h) };
  }

  it('concurrent placeCall for the same case dials once; the second is case_not_ready', async () => {
    const s = svc('happy-refund');
    await s.base.createCase(makeCase(DEFAULT_FACTS));
    const [a, b] = await Promise.all([s.service.placeCall('case-t', {}), s.service.placeCall('case-t', {})]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ ok: false, code: 'case_not_ready' });
    expect(s.dials).toHaveLength(1);
    expect(await s.base.listCallsByCase('case-t')).toHaveLength(1);
    const live = a.ok ? a : b.ok ? b : undefined;
    if (live !== undefined) await live.session.end();
  });

  it('concurrent placeCall on two cases still serialises the policy check', async () => {
    const s = svc('happy-refund');
    await s.base.createCase(makeCase(DEFAULT_FACTS));
    await s.base.createCase(makeCase(DEFAULT_FACTS, { id: 'case-u' }));
    const rs = await Promise.all([s.service.placeCall('case-t'), s.service.placeCall('case-u')]);
    expect(rs.every((r) => r.ok)).toBe(true);
    for (const r of rs) if (r.ok) await r.session.end();
  });

  it('a failing mid-call fact write is contained: no unhandled rejection, counted on finished', async () => {
    const trap = trapUnhandled();
    try {
      let updates = 0;
      const s = svc('unknown-fact', (r) =>
        Object.assign(Object.create(r) as Repo, {
          updateCase: async (c: Case) => {
            if (++updates === 2) throw new Error('db busy');
            return r.updateCase(c);
          },
        }),
      );
      await s.base.createCase(makeCase(DEFAULT_FACTS, { desiredOutcome: 'repair' }));
      const r = await s.service.placeCall('case-t');
      if (!r.ok) throw new Error('expected ok');
      await s.drive(r.session, () => r.session.snapshot().pendingQuestion?.kind === 'question');
      expect((await r.session.answerPending('RT99881')).ok).toBe(true);
      await s.drive(r.session);
      const fin = await r.finished;
      await new Promise((res) => setTimeout(res, 10));
      expect(trap.count()).toBe(0);
      expect(fin.factWriteErrors).toBe(1);
      expect(s.service.backgroundErrors).toBe(1);
    } finally {
      trap.dispose();
    }
  });

  it('finished never rejects, even when the case vanished mid-call', async () => {
    const trap = trapUnhandled();
    try {
      const s = svc('happy-refund');
      await s.base.createCase(makeCase(DEFAULT_FACTS));
      const r = await s.service.placeCall('case-t');
      if (!r.ok) throw new Error('expected ok');
      await s.base.deleteCase('case-t');
      await r.session.end();
      const fin = await r.finished;
      await new Promise((res) => setTimeout(res, 10));
      expect(trap.count()).toBe(0);
      expect(fin.error).toMatch(/recording the call result failed/);
      expect(fin.call.state).toBe('ENDED');
      // The in-flight slot is released once the call finished.
      await s.base.createCase(makeCase(DEFAULT_FACTS));
      const again = await s.service.placeCall('case-t');
      expect(again.ok).toBe(true);
      if (again.ok) await again.session.end();
    } finally {
      trap.dispose();
    }
  });
});
