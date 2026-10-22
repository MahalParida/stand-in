/**
 * M2 round-4 review regressions:
 *  - a fact answered mid-call as `never` must not leave its value in any fact key
 *    the planner/LLM, later stored events or the repo see (its own key, or an
 *    existing case-fact key that happens to embed it);
 *  - CallService default IDs are unique across processes, and placeCall never
 *    rejects on a repo failure.
 */
import { CaseSchema, type CallEvent, type Carrier, type CaseFact, type InboundFrame, type Repo } from '@standin/core';
import { createSqliteRepo } from '@standin/providers';
import { VirtualScheduler, containsValue } from '@standin/fake-business';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallSession } from './call-session.js';
import { loadDirectory } from './directory.js';
import type { Planner, PlannerContext, PlanResult } from './planner.js';
import { ScriptedPlanner } from './scripted-policy.js';
import { CallService } from './service.js';
import { DEFAULT_FACTS, OTP, T0, bharatnet, fact, makeCase } from './test-support.js';

class ScriptCarrier implements Carrier {
  readonly spoken: string[] = [];
  #cb: ((f: InboundFrame) => void) | undefined;
  async dial(): Promise<void> {}
  async say(text: string): Promise<void> {
    this.spoken.push(text);
  }
  async pressDigits(): Promise<void> {}
  async bridgeUser(): Promise<void> {}
  async unbridgeUser(): Promise<void> {}
  async hangup(): Promise<void> {}
  on(_event: 'frame', cb: (f: InboundFrame) => void): void {
    this.#cb = cb;
  }
  emit(text: string): void {
    this.#cb?.({ kind: 'speech', speaker: 'agent', text });
  }
}

/** Delegates to the scripted policy, recording every context the "LLM" would receive. */
class RecordingPlanner implements Planner {
  readonly name = 'recording';
  readonly contexts: string[] = [];
  readonly #inner = new ScriptedPlanner();
  plan(ctx: PlannerContext): Promise<PlanResult> {
    this.contexts.push(JSON.stringify(ctx));
    return this.#inner.plan(ctx);
  }
}

const SECRET = '4321';

function session(facts: CaseFact[]) {
  const carrier = new ScriptCarrier();
  const planner = new RecordingPlanner();
  const stored: CallEvent[] = [];
  const added: CaseFact[] = [];
  let t = T0;
  const s = new CallSession({
    callId: 'call-r4',
    kase: makeCase(facts),
    business: bharatnet(),
    carrier,
    planner,
    clock: { now: () => new Date((t += 1000)) },
    timers: { setTimer: () => 0, clearTimer: () => undefined },
    onEvent: (e) => {
      stored.push(e);
    },
  });
  s.onFactAdded((f) => added.push(f));
  const say = async (text: string) => {
    carrier.emit(text);
    await s.idle();
  };
  return { carrier, planner, stored, added, session: s, say };
}

/** Everything produced after the answer: planner contexts, stored events, fact writes, speech. */
async function answerThenContinue(r: ReturnType<typeof session>) {
  const ctxBefore = r.planner.contexts.length;
  const evBefore = r.stored.length;
  const spokenBefore = r.carrier.spoken.length;
  const p = r.session.snapshot().pendingQuestion;
  expect(p?.kind).toBe('question');
  expect((await r.session.answerPending(SECRET)).ok).toBe(true);
  await r.say('Okay, anything else I should note?');
  await r.say('Alright, what is the account number?');
  const after = [
    ...r.planner.contexts.slice(ctxBefore),
    ...r.stored.slice(evBefore).map((e) => JSON.stringify(e.data)),
    ...r.added.map((f) => f.key),
    ...r.carrier.spoken.slice(spokenBefore),
  ];
  expect(r.planner.contexts.length).toBeGreaterThan(ctxBefore);
  return after;
}

describe('a never answer given mid-call re-keys the fact list (review: M2 r4)', () => {
  it('repro A: an existing key embedding the answered never value is made opaque', async () => {
    const r = session([
      fact('account_number', 'BharatNet account number', 'BN7781234'),
      fact(`ticket_ref_${SECRET}`, 'old ticket reference', 'REF-AB'),
      fact('otp', 'OTP sent to registered mobile', OTP),
    ]);
    await r.session.start();
    await r.say('Hello, Ravi speaking. How can I help?');
    await r.say('Could you tell me the router serial number?');
    const surfaces = await answerThenContinue(r);
    const answered = r.session.facts().find((f) => f.value === SECRET);
    expect(answered?.tier).toBe('never');
    expect(r.session.facts().some((f) => f.key.includes(SECRET))).toBe(false);
    expect(r.session.facts().find((f) => f.value === 'REF-AB')?.key).toMatch(/^fact_\d+$/);
    for (const s of surfaces) expect(containsValue(s, SECRET), s).toBe(false);
  });

  it('repro B: the asked key itself embeds the answered never value', async () => {
    const r = session([fact('account_number', 'BharatNet account number', 'BN7781234')]);
    await r.session.start();
    await r.say('Hello, Ravi speaking. How can I help?');
    await r.say(`Could you tell me the modem ${SECRET} serial?`);
    const surfaces = await answerThenContinue(r);
    const answered = r.session.facts().find((f) => f.value === SECRET);
    expect(answered?.tier).toBe('never');
    expect(answered?.key).toMatch(/^fact_\d+$/);
    expect(r.added.map((f) => f.key)).toEqual([answered?.key]);
    for (const s of surfaces) expect(containsValue(s, SECRET), s).toBe(false);
  });

  it('the mid-call never fact persists to the repo (no CaseSchema rejection, no leaking key)', async () => {
    const repo = createSqliteRepo();
    try {
      const scheduler = new VirtualScheduler();
      const carrier = new ScriptCarrier();
      const service = new CallService({
        repo,
        directory: loadDirectory(),
        clock: { now: () => new Date(T0 + scheduler.now()) },
        timers: scheduler,
        planner: new ScriptedPlanner(),
        carrierFactory: () => carrier,
      });
      await repo.createCase(
        makeCase([
          fact('account_number', 'BharatNet account number', 'BN7781234'),
          fact(`ticket_ref_${SECRET}`, 'old ticket reference', 'REF-AB'),
        ]),
      );
      const placed = await service.placeCall('case-t');
      if (!placed.ok) throw new Error(placed.message);
      const s = placed.session;
      carrier.emit('Hello, Ravi speaking. How can I help?');
      await s.idle();
      carrier.emit('Could you tell me the router serial number?');
      await s.idle();
      expect((await s.answerPending(SECRET)).ok).toBe(true);
      await s.end();
      const done = await placed.finished;
      expect(done.factWriteErrors).toBeUndefined();
      const kase = await repo.getCase('case-t');
      expect(kase).toBeDefined();
      if (kase === undefined) return;
      expect(() => CaseSchema.parse(kase)).not.toThrow();
      expect(kase.facts.find((f) => f.value === SECRET)?.tier).toBe('never');
      expect(kase.facts.some((f) => f.key.includes(SECRET))).toBe(false);
      expect(kase.facts.find((f) => f.value === 'REF-AB')).toBeDefined();
    } finally {
      repo.close();
    }
  });
});

describe('CallService IDs and repo failures (review: M2 r4)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function service(repo: Repo) {
    const scheduler = new VirtualScheduler();
    return new CallService({
      repo,
      directory: loadDirectory(),
      clock: { now: () => new Date(T0 + scheduler.now()) },
      timers: scheduler,
      planner: new ScriptedPlanner(),
      carrierFactory: () => new ScriptCarrier(),
    });
  }

  it('a restarted service on the same file-backed repo does not reuse call IDs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'standin-r4-'));
    dirs.push(dir);
    const path = join(dir, 't.db');
    const repo1 = createSqliteRepo({ path });
    await repo1.createCase(makeCase(DEFAULT_FACTS, { id: 'case-a' }));
    const a = await service(repo1).placeCall('case-a');
    expect(a.ok).toBe(true);
    if (a.ok) await a.session.end();
    repo1.close();

    const repo2 = createSqliteRepo({ path });
    try {
      await repo2.createCase(makeCase(DEFAULT_FACTS, { id: 'case-b' }));
      const b = await service(repo2).placeCall('case-b');
      expect(b.ok).toBe(true);
      if (a.ok && b.ok) expect(b.callId).not.toBe(a.callId);
      if (b.ok) await b.session.end();
    } finally {
      repo2.close();
    }
  });

  it('a repo failure while reserving resolves to call_setup_failed instead of rejecting', async () => {
    const repo = createSqliteRepo();
    try {
      await repo.createCase(makeCase(DEFAULT_FACTS));
      const failing: Repo = Object.create(repo) as Repo;
      failing.createCall = () => Promise.reject(new Error('disk full 9876'));
      const svc = service(failing);
      const r = await svc.placeCall('case-t');
      expect(r).toMatchObject({ ok: false, code: 'call_setup_failed' });
      if (!r.ok) expect(r.message).not.toContain('9876');
      // The in-flight slot is released: a retry is evaluated again (and fails the same way).
      expect(await svc.placeCall('case-t')).toMatchObject({ ok: false, code: 'call_setup_failed' });
      expect((await repo.getCase('case-t'))?.status).toBe('ready');
    } finally {
      repo.close();
    }
  });
});
