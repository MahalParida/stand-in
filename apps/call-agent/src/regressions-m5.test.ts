/**
 * M5: stored transcripts are masked at write time (spec 4 / 13), whatever path
 * a never-tier value takes into an event; failure messages are the shared,
 * honest copy; the LLM planner caps output tokens and forwards a seed.
 */
import { failureCopy, type CallEvent, type ChatRequest, type LlmProvider } from '@standin/core';
import { FakeBusiness, VirtualScheduler, containsValue, presetScenario } from '@standin/fake-business';
import { describe, expect, it } from 'vitest';
import { CallSession } from './call-session.js';
import { LlmPlanner, type PlanResult, type Planner, type PlannerContext } from './planner.js';
import { ScriptedPlanner } from './scripted-policy.js';
import { SimCarrier } from './sim-carrier.js';
import { OTP, bharatnet, harness, makeCase } from './test-support.js';

/** Wraps the scripted planner and smuggles the OTP into fields that are not spoken (reason, outcome text). */
class LeakyPlanner implements Planner {
  readonly name = 'leaky';
  readonly #inner = new ScriptedPlanner();
  async plan(ctx: PlannerContext): Promise<PlanResult> {
    const r = await this.#inner.plan(ctx);
    const o = { ...r.output, reason: `${r.output.reason} otp ${OTP}` };
    if (o.outcome !== undefined) o.outcome = { ...o.outcome, what: `${o.outcome.what} (verified with OTP ${OTP})` };
    return { ...r, output: o };
  }
}

describe('M5: stored events are masked at write time', () => {
  it('a never value in planner reason / outcome text never reaches the stored event log', async () => {
    const scheduler = new VirtualScheduler();
    const T0 = Date.parse('2026-10-22T08:30:00Z');
    const clock = { now: () => new Date(T0 + scheduler.now()) };
    const kase = makeCase();
    const fb = new FakeBusiness(presetScenario('happy-refund', { secrets: [OTP] }), { scheduler, clock: () => clock.now() });
    const stored: CallEvent[] = [];
    const session = new CallSession({
      callId: 'call-m5',
      kase,
      business: bharatnet(),
      carrier: new SimCarrier(fb),
      planner: new LeakyPlanner(),
      clock,
      timers: scheduler,
      onEvent: async (e) => {
        stored.push(structuredClone(e));
      },
    });
    await session.start();
    await scheduler.runUntilIdle({
      settle: async () => {
        await fb.settled();
        await session.idle();
      },
      until: () => session.state === 'ENDED' || session.state === 'FAILED',
      maxSimMs: 2 * 60 * 60 * 1000,
    });
    await session.idle();
    expect(stored.length).toBeGreaterThan(10);
    for (const e of stored) expect(containsValue(JSON.stringify(e.data), OTP), `${e.type}: ${JSON.stringify(e.data)}`).toBe(false);
    for (const l of session.transcript()) expect(containsValue(l.text, OTP)).toBe(false);
    // The outcome becomes a stored call row and case promise: masked too.
    const outcome = session.snapshot().outcome;
    expect(outcome?.what).toMatch(/verified with OTP/);
    expect(containsValue(JSON.stringify(outcome), OTP)).toBe(false);
    expect(session.verify().ok).toBe(true);
  });

  it('the FAILED message is the shared honest copy (S5)', async () => {
    const h = harness('ivr-dead-end');
    await h.session.start();
    await h.run();
    const snap = h.session.snapshot();
    expect(snap.state).toBe('FAILED');
    expect(snap.failureReason).toBe('ivr_dead_end');
    expect(snap.failureMessage).toBe(failureCopy('ivr_dead_end', { businessName: h.session.business.name, ivrLoops: 3, maxMinutes: 25 }).message);
    expect(snap.failureMessage).toMatch(/couldn't reach a person/);
  });
});

describe('M5: LlmPlanner request bounds', () => {
  class Capture implements LlmProvider {
    readonly name = 'capture';
    readonly reqs: ChatRequest[] = [];
    async chat(req: ChatRequest): Promise<string> {
      this.reqs.push(req);
      return '{"action":"wait","reason":"r"}';
    }
  }

  it('caps maxTokens at 512 and passes temperature + seed through', async () => {
    const llm = new Capture();
    const h = harness('happy-refund', { planner: new LlmPlanner(llm, { maxTokens: 9000, temperature: 0.3, seed: 7 }) });
    await h.session.start();
    await h.run(() => llm.reqs.length > 0);
    const req = llm.reqs[0];
    expect(req?.maxTokens).toBe(512);
    expect(req?.temperature).toBe(0.3);
    expect(req?.seed).toBe(7);
    await h.session.end('test');
  });
});
