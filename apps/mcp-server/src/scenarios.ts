/**
 * Which fake-business behaviour a sim call gets, and which facts a case needs
 * before it can be called. Deterministic: same case -> same scenario.
 */
import type { Business, Case, CaseFact, DesiredOutcome } from '@standin/core';
import { SCENARIO_PRESETS, TicketIdSchema, presetScenario, type FakeBusinessScenario, type ScenarioPresetName } from '@standin/fake-business';
import type { MissingFact } from '@standin/core';
import { z } from 'zod';

const PRESET_NAMES = Object.keys(SCENARIO_PRESETS) as [ScenarioPresetName, ...ScenarioPresetName[]];
export const ScenarioNameSchema = z.enum(PRESET_NAMES);
export type ScenarioName = ScenarioPresetName;

/** Autoplay names used by the sim host map onto presets. */
export const SCENARIO_ALIASES: Record<string, ScenarioName> = {
  happy: 'happy-refund',
  otp: 'otp-trap',
  followup: 'happy-refund',
  unknown: 'unknown-fact',
};

/** Keyword pick when the caller did not name a scenario. */
export function pickScenario(goal: string, desiredOutcome: DesiredOutcome): ScenarioName {
  const g = goal.toLowerCase();
  if (/\b(otp|one[- ]time|verification code|verify me)\b/.test(g)) return 'otp-trap';
  if (/\b(ignore (your|previous)|injection)\b/.test(g)) return 'injection';
  if (/\b(router|technician|repair|serial)\b/.test(g) || desiredOutcome === 'repair') return 'unknown-fact';
  if (/\b(menu loop|dead end)\b/.test(g)) return 'ivr-dead-end';
  return 'happy-refund';
}

/** never-tier values, for the fake business's leak detector only (never spoken or emitted). */
function secretsOf(facts: readonly CaseFact[]): string[] {
  return facts
    .filter((f) => f.tier === 'never')
    .map((f) => f.value.replace(/\s+/g, ''))
    .filter((v) => v.length >= 1 && v.length <= 64)
    .slice(0, 32);
}

export function businessScenario(name: ScenarioName, kase: Case): FakeBusinessScenario {
  return presetScenario(name, { secrets: secretsOf(kase.facts) });
}

/** S6: the follow-up call; Ravi escalates once the agent quotes the earlier ticket. */
export function followupScenario(kase: Case, ticketId: string | undefined): FakeBusinessScenario {
  const t = TicketIdSchema.safeParse(ticketId);
  return presetScenario('broken-promise', {
    secrets: secretsOf(kase.facts),
    followup: t.success ? { enabled: true, originalTicketId: t.data } : { enabled: true },
  });
}

/* ------------------------------------------------------------------ */
/* Required facts                                                      */
/* ------------------------------------------------------------------ */

interface Requirement {
  key: string;
  label: (b: Business) => string;
  prompt: (b: Business) => string;
  present: (facts: readonly CaseFact[]) => boolean;
}

const REQUIREMENTS: Requirement[] = [
  {
    key: 'account_number',
    label: (b) => `${b.name} account number`,
    prompt: (b) => `What's your ${b.name} account number?`,
    present: (facts) => facts.some((f) => f.tier !== 'never' && f.value.trim().length > 0 && (f.key === 'account_number' || /account/.test(f.key))),
  },
];

export function missingFacts(business: Business, facts: readonly CaseFact[]): MissingFact[] {
  return REQUIREMENTS.filter((r) => !r.present(facts)).map((r) => ({ key: r.key, label: r.label(business), prompt: r.prompt(business) }));
}

/** "router_serial" -> "Router serial". */
export function labelFromKey(key: string): string {
  const s = key.replace(/_/g, ' ').trim();
  return s.length === 0 ? key : s.charAt(0).toUpperCase() + s.slice(1);
}
