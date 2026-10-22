/**
 * M2 round-1 review regressions: secret asks under other names, fact labels
 * reaching the LLM, IVR loop counting.
 */
import type { CallEvent, Carrier, CaseFact, InboundFrame } from '@standin/core';
import { containsValue } from '@standin/fake-business';
import { describe, expect, it } from 'vitest';
import { CallSession, NEVER_REFUSAL, isSecretAsk, looksLikeSecretAnswer } from './call-session.js';
import { buildPlannerMessages, type Planner, type PlannerContext } from './planner.js';
import { ScriptedPlanner } from './scripted-policy.js';
import { DEFAULT_FACTS, OTP, T0, bharatnet, fact, harness, makeCase } from './test-support.js';

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

function speechSession(facts: CaseFact[], planner: Planner = new ScriptedPlanner()) {
  const carrier = new ScriptCarrier();
  const stored: CallEvent[] = [];
  let t = T0;
  const session = new CallSession({
    callId: 'call-r',
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
  const say = async (text: string) => {
    carrier.emit(text);
    await session.idle();
  };
  const surfaces = () => [
    ...carrier.spoken,
    ...session.events().map((e) => JSON.stringify(e.data)),
    ...stored.map((e) => JSON.stringify(e.data)),
    ...session.transcript().map((l) => l.text),
  ];
  return { carrier, session, say, surfaces };
}

const ACCOUNT_ONLY = [fact('account_number', 'BharatNet account number', 'BN7781234')];

describe('reworded OTP asks never become an answerable question (review: S2 bypass)', () => {
  for (const ask of [
    'Could you tell me the authorisation number?',
    "What's the verification number we just sent to your mobile?",
    'Could you tell me the confirmation number we texted you?',
    'Could you tell me the login details?',
  ]) {
    it(`"${ask}" -> HANDOFF_PENDING, no pending question`, async () => {
      const r = speechSession(ACCOUNT_ONLY);
      await r.session.start();
      await r.say('Hello, Ravi speaking. How can I help?');
      await r.say(ask);
      const snap = r.session.snapshot();
      expect(snap.state).toBe('HANDOFF_PENDING');
      expect(snap.pendingQuestion?.kind).toBe('handoff');
      expect(await r.session.answerPending('482913')).toMatchObject({ ok: false });
      for (const s of r.surfaces()) expect(containsValue(s, '482913'), s).toBe(false);
    });
  }

  it('a bare code typed as an answer to an innocuous-looking question is stored never and refused', async () => {
    const r = speechSession(ACCOUNT_ONLY);
    await r.session.start();
    await r.say('Hello, Ravi speaking. How can I help?');
    await r.say('Could you tell me the reference?');
    const p = r.session.snapshot().pendingQuestion;
    expect(p?.kind).toBe('question');
    expect((await r.session.answerPending('482913', p?.id)).ok).toBe(true);
    expect(r.session.facts().find((f) => f.value === '482913')).toMatchObject({ tier: 'never', approved: false });
    expect(r.carrier.spoken.at(-1)).toContain(NEVER_REFUSAL);
    for (const s of r.surfaces()) expect(containsValue(s, '482913'), s).toBe(false);
  });

  it('a confirm-tier answer needs explicit approval before it is relayed', async () => {
    const r = speechSession(ACCOUNT_ONLY);
    await r.session.start();
    await r.say('Hello, Ravi speaking. How can I help?');
    await r.say('Could you tell me the alternate email?');
    const p = r.session.snapshot().pendingQuestion;
    expect(p?.kind).toBe('question');
    const first = await r.session.answerPending('asha@example.com', p?.id);
    expect(first).toMatchObject({ ok: false, error: expect.stringMatching(/confirm_required/) });
    expect(r.session.snapshot().pendingQuestion?.id).toBe(p?.id);
    expect(r.carrier.spoken.some((t) => t.includes('asha@example.com'))).toBe(false);
    expect((await r.session.answerPending('asha@example.com', p?.id, { approve: true })).ok).toBe(true);
    expect(r.carrier.spoken.at(-1)).toContain('asha@example.com');
  });

  it('isSecretAsk / looksLikeSecretAnswer', () => {
    expect(isSecretAsk('authorisation number', '')).toBe(true);
    expect(isSecretAsk('reference', 'the number we sent you by SMS')).toBe(true);
    expect(isSecretAsk('router serial number', 'Could you tell me the router serial number?')).toBe(false);
    expect(isSecretAsk('pin code', 'What is your pin code?')).toBe(false);
    const base = { askedText: '', otherFacts: [] };
    expect(looksLikeSecretAnswer({ ...base, label: 'router serial number', value: 'RT99881' })).toBe(false);
    expect(looksLikeSecretAnswer({ ...base, label: 'reference', value: '48 29 13' })).toBe(true);
    expect(looksLikeSecretAnswer({ ...base, label: 'pin code', value: '560001' })).toBe(false);
    expect(looksLikeSecretAnswer({ ...base, label: 'reference', value: 'my OTP is 739104' })).toBe(true);
  });
});

describe('fact labels are masked before the planner / LLM (review: spec 5.2)', () => {
  it('a never value inside a label or the goal never reaches buildPlannerMessages', async () => {
    const seen: PlannerContext[] = [];
    const inner = new ScriptedPlanner();
    const planner: Planner = {
      name: 'capture',
      plan: async (ctx) => {
        seen.push(ctx);
        return inner.plan(ctx);
      },
    };
    const facts = [...DEFAULT_FACTS, fact('otp_note', `OTP ${OTP} for refund`, 'see label')];
    const carrier = new ScriptCarrier();
    const session = new CallSession({
      callId: 'call-l',
      kase: makeCase(facts, { goal: `refund; OTP ${OTP} was sent` }),
      business: bharatnet(),
      carrier,
      planner,
      clock: { now: () => new Date(T0) },
      timers: { setTimer: () => 0, clearTimer: () => undefined },
    });
    await session.start();
    carrier.emit('Hello, Ravi speaking. How can I help?');
    await session.idle();
    expect(seen.length).toBeGreaterThan(0);
    for (const ctx of seen) {
      const wire = JSON.stringify(buildPlannerMessages(ctx));
      expect(containsValue(wire, OTP), wire).toBe(false);
      expect(ctx.facts.find((f) => f.key === 'otp_note')?.label).toContain('OTP');
    }
  });
});

describe('IVR loops (review: S5 counted announcements as loops)', () => {
  it('fails after exactly 3 main-menu revisits and 3 presses', async () => {
    const h = harness('ivr-dead-end');
    await h.session.start();
    await h.run();
    const snap = h.session.snapshot();
    expect(snap).toMatchObject({ state: 'FAILED', failureReason: 'ivr_dead_end', ivrLoops: 3 });
    expect(h.ofType('dtmf')).toHaveLength(3);
    expect(snap.failureMessage).toContain('(3 loops)');
  });

  it('a different maxIvrLoops changes the count (the check is not vacuous)', async () => {
    const h = harness('ivr-dead-end', { machine: { maxIvrLoops: 1 } });
    await h.session.start();
    await h.run();
    expect(h.session.snapshot()).toMatchObject({ state: 'FAILED', ivrLoops: 1 });
    expect(h.ofType('dtmf')).toHaveLength(1);
  });
});
