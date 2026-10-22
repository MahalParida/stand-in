/**
 * M2 round-3 review regressions: a fact key that embeds a never-tier value
 * (e.g. `otp_482913`) must not reach the planner/LLM or any stored event.
 */
import { CaseSchema, factKeyEmbedsNeverValue, type CallEvent, type Carrier, type CaseFact, type InboundFrame } from '@standin/core';
import { containsValue } from '@standin/fake-business';
import { describe, expect, it } from 'vitest';
import { CallSession, safeFactKeys } from './call-session.js';
import type { Planner, PlannerContext, PlanResult } from './planner.js';
import { OTP, T0, bharatnet, fact, makeCase } from './test-support.js';

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

class RecordingPlanner implements Planner {
  readonly name = 'recording';
  readonly contexts: string[] = [];
  readonly #utterance: string;
  constructor(utterance: string) {
    this.#utterance = utterance;
  }
  plan(ctx: PlannerContext): Promise<PlanResult> {
    this.contexts.push(JSON.stringify(ctx));
    return Promise.resolve({ output: { action: 'say', utterance: this.#utterance } });
  }
}

const LEAKY_FACTS: CaseFact[] = [
  fact('account_number', 'BharatNet account number', 'BN7781234'),
  fact(`otp_${OTP}`, 'OTP sent to registered mobile', OTP),
];

async function run(utterance: string, userName = 'Asha Rao') {
  const carrier = new ScriptCarrier();
  const stored: CallEvent[] = [];
  const planner = new RecordingPlanner(utterance);
  let t = T0;
  const session = new CallSession({
    callId: 'call-k',
    kase: makeCase(LEAKY_FACTS, { userName }),
    business: bharatnet(),
    carrier,
    planner,
    clock: { now: () => new Date((t += 1000)) },
    timers: { setTimer: () => 0, clearTimer: () => undefined },
    onEvent: (e) => {
      stored.push(e);
    },
  });
  await session.start();
  carrier.emit('Hello this is Ravi, how can I help?');
  await session.idle();
  const surfaces = [
    ...planner.contexts,
    ...carrier.spoken,
    ...session.events().map((e) => JSON.stringify(e.data)),
    ...stored.map((e) => JSON.stringify(e.data)),
    ...session.transcript().map((l) => l.text),
  ];
  return { session, planner, surfaces };
}

describe('fact keys embedding a never value (review: M2 r3)', () => {
  it('the never fact is tiered never and its key is detected', () => {
    expect(LEAKY_FACTS[1]?.tier).toBe('never');
    expect(factKeyEmbedsNeverValue(`otp_${OTP}`, LEAKY_FACTS)).toBe(true);
    expect(factKeyEmbedsNeverValue('account_number', LEAKY_FACTS)).toBe(false);
    expect(factKeyEmbedsNeverValue('otp_4829_13', LEAKY_FACTS)).toBe(true);
  });

  it('core CaseSchema rejects such a key at the boundary, without echoing the value', () => {
    const r = CaseSchema.safeParse(makeCase(LEAKY_FACTS));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain(OTP);
    expect(CaseSchema.safeParse(makeCase([fact('otp', 'OTP sent to registered mobile', OTP)])).success).toBe(true);
  });

  it('safeFactKeys renames only the leaking key, to an opaque unique key', () => {
    const out = safeFactKeys([...LEAKY_FACTS, fact('fact_1', 'note', 'hello there')]);
    expect(out.map((f) => f.key)).toEqual(['account_number', 'fact_2', 'fact_1']);
    expect(out[1]?.value).toBe(OTP);
  });

  it('neither the planner context nor any stored event contains the value (planner uses the leaky key)', async () => {
    const r = await run(`The code is {{fact:otp_${OTP}}}`);
    expect(r.planner.contexts.length).toBeGreaterThan(0);
    for (const s of r.surfaces) expect(containsValue(s, OTP), s).toBe(false);
  });

  it('a placeholder for the renamed key is still withheld and never spoken', async () => {
    const r = await run('The code is {{fact:fact_1}}');
    for (const s of r.surfaces) expect(containsValue(s, OTP), s).toBe(false);
  });

  it('userName is masked before it reaches the planner', async () => {
    const r = await run('Thank you.', `Asha ${OTP}`);
    for (const c of r.planner.contexts) expect(containsValue(c, OTP), c).toBe(false);
  });
});
