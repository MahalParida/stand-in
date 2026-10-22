/**
 * What a seed changes in a scenario run (spec 9: "≥7/8 with LLM over 5 seeds").
 *
 * Seed 1 is the golden run: presets exactly as written (ticket SR-48213, the
 * preset hold length), LLM temperature 0. Every other seed changes real inputs:
 *  - Ravi's wording variants and reply jitter (the fake business's own seeded RNG),
 *  - the hold length (0.5x-2.5x the preset),
 *  - the ticket number Ravi issues (and, for S6, the one the follow-up must quote
 *    plus the supervisor's new one),
 *  - the LLM sampling: temperature 0.3 and the seed itself (passed to LocalLlm).
 */
import { FollowupSchema, SCENARIO_PRESETS, SeededRng, type FakeBusinessScenarioInput, type ScenarioPresetName } from '@standin/fake-business';

export const GOLDEN_SEED = 1;
const GOLDEN_TICKET = 'SR-48213';
const DEFAULT_HOLD_SECONDS = 120;

export interface SeedVariation {
  seed: number;
  /** Multiplier on the preset's hold length (1 for the golden seed). */
  holdScale: number;
  /** Ticket Ravi issues on the first call (undefined = the preset's). */
  ticketId?: string;
  /** Ticket the supervisor issues on the S6 follow-up (undefined = the preset's). */
  escalationTicketId?: string;
  /** LLM planner sampling for localllm / bedrock runs. */
  temperature: number;
}

function ticket(rng: SeededRng, avoid: readonly string[]): string {
  for (;;) {
    const t = `SR-${rng.int(10000, 99999)}`;
    if (!avoid.includes(t)) return t;
  }
}

export function seedVariation(seed: number): SeedVariation {
  if (seed === GOLDEN_SEED) return { seed, holdScale: 1, temperature: 0 };
  const rng = new SeededRng(Math.imul(seed, 0x9e3779b1) >>> 0);
  const holdScale = Math.round((0.5 + 2 * rng.next()) * 100) / 100;
  const ticketId = ticket(rng, [GOLDEN_TICKET]);
  const escalationTicketId = ticket(rng, [GOLDEN_TICKET, ticketId, 'SR-50721']);
  return { seed, holdScale, ticketId, escalationTicketId, temperature: 0.3 };
}

/** Business overrides for one preset under a seed (merged under the scenario file's own overrides). */
export function seedOverrides(preset: ScenarioPresetName, v: SeedVariation): FakeBusinessScenarioInput {
  if (v.seed === GOLDEN_SEED) return {};
  const base: FakeBusinessScenarioInput = SCENARIO_PRESETS[preset];
  const out: FakeBusinessScenarioInput = {};
  const hold = base.holdSeconds ?? DEFAULT_HOLD_SECONDS;
  out.holdSeconds = Math.max(5, Math.round(hold * v.holdScale));
  if (base.outcome !== undefined && v.ticketId !== undefined) out.outcome = { ...base.outcome, ticketId: v.ticketId };
  if (base.followup?.enabled === true && v.ticketId !== undefined) {
    const d = FollowupSchema.parse({});
    out.followup = {
      ...base.followup,
      originalTicketId: v.ticketId,
      escalation: { what: d.escalation.what, dueInDays: d.escalation.dueInDays ?? 3, ...(v.escalationTicketId !== undefined ? { ticketId: v.escalationTicketId } : {}) },
    };
  }
  return out;
}

export function describeVariation(v: SeedVariation): string {
  if (v.seed === GOLDEN_SEED) return 'golden: preset hold, SR-48213, T=0';
  return `hold x${v.holdScale}, ticket ${v.ticketId ?? '?'}, escalation ${v.escalationTicketId ?? '?'}, T=${v.temperature}, Ravi wording seed ${v.seed}`;
}
