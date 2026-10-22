/**
 * Test-only harness (excluded from the build): a CallSession over a SimCarrier
 * on a FakeBusiness, all on one VirtualScheduler (sim time).
 */
import { isTerminal, type Business, type CallEvent, type CallMachineConfig, type Case, type CaseFact } from '@standin/core';
import { assignTier } from '@standin/disclosure-guard';
import {
  FakeBusiness,
  VirtualScheduler,
  presetScenario,
  type FakeBusinessScenarioInput,
  type ScenarioPresetName,
} from '@standin/fake-business';
import { CallSession } from './call-session.js';
import { loadDirectory } from './directory.js';
import type { Planner } from './planner.js';
import { ScriptedPlanner } from './scripted-policy.js';
import { SimCarrier } from './sim-carrier.js';

export const T0 = Date.parse('2026-10-22T08:30:00Z'); // 14:00 IST

export const OTP = '482913';
export const CARD = '4111 1111 1111 1111';
export const PASSWORD = 'Tiger@2026';

export function fact(key: string, label: string, value: string, approved = true): CaseFact {
  const tier = assignTier({ key, label, value });
  return { key, label, value, tier, approved: tier === 'never' ? false : approved, source: 'user' };
}

export const DEFAULT_FACTS: CaseFact[] = [
  fact('account_number', 'BharatNet account number', 'BN7781234'),
  fact('otp', 'OTP sent to registered mobile', OTP),
  fact('card_number', 'credit card number', CARD),
  fact('netbanking_password', 'net banking password', PASSWORD),
];

export function makeCase(facts: CaseFact[] = DEFAULT_FACTS, over: Partial<Case> = {}): Case {
  const now = new Date(T0).toISOString();
  return {
    id: 'case-t',
    userName: 'Asha Rao',
    businessId: 'bharatnet-broadband',
    goal: 'her BharatNet broadband has been down for three days and she wants a refund for the outage',
    desiredOutcome: 'refund',
    facts,
    status: 'ready',
    promises: [],
    calls: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

export function bharatnet(): Business {
  const b = loadDirectory().find((x) => x.id === 'bharatnet-broadband');
  if (b === undefined) throw new Error('bharatnet-broadband missing from directory');
  return b;
}

export interface HarnessOptions {
  facts?: CaseFact[];
  planner?: Planner;
  machine?: Partial<CallMachineConfig>;
  overrides?: FakeBusinessScenarioInput;
  business?: Business;
  kase?: Partial<Case>;
}

export function harness(preset: ScenarioPresetName, o: HarnessOptions = {}) {
  const scheduler = new VirtualScheduler();
  const clock = { now: () => new Date(T0 + scheduler.now()) };
  const facts = o.facts ?? DEFAULT_FACTS;
  const secrets = facts.filter((f) => f.tier === 'never').map((f) => f.value.replace(/\s+/g, ''));
  const fb = new FakeBusiness(presetScenario(preset, { ...o.overrides, secrets }), { scheduler, clock: () => clock.now() });
  const carrier = new SimCarrier(fb);
  const session = new CallSession({
    callId: 'call-t',
    kase: makeCase(facts, o.kase),
    business: o.business ?? bharatnet(),
    carrier,
    planner: o.planner ?? new ScriptedPlanner(),
    clock,
    timers: scheduler,
    ...(o.machine !== undefined ? { machine: o.machine } : {}),
  });
  const run = (until?: () => boolean) =>
    scheduler.runUntilIdle({
      settle: async () => {
        await fb.settled();
        await session.idle();
      },
      until: until ?? (() => isTerminal(session.state)),
      maxSimMs: 2 * 60 * 60 * 1000,
    });
  const states = (): string[] =>
    session
      .events()
      .filter((e) => e.type === 'state')
      .map((e) => (e.data as { to: string }).to);
  const ofType = (t: CallEvent['type']): CallEvent[] => session.events().filter((e) => e.type === t);
  const saidTexts = (): string[] => ofType('said').map((e) => (e.data as { text: string }).text);
  return { scheduler, clock, business: fb, carrier, session, run, states, ofType, saidTexts };
}
