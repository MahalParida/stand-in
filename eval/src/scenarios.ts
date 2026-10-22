/**
 * Golden scenario files (data/scenarios/*.json, spec section 9), validated with zod.
 */
import { readFile, readdir } from 'node:fs/promises';
import { GarbagePlanSchema } from '@standin/call-agent';
import { DesiredOutcomeSchema, FactKeySchema, SimulatedHourIstSchema } from '@standin/core';
import { SCENARIO_PRESETS, type ScenarioPresetName } from '@standin/fake-business';
import { z } from 'zod';

export const DEFAULT_SCENARIOS_DIR = new URL('../../data/scenarios/', import.meta.url);

/** Lists golden scenario files (data/scenarios/*.json). */
export async function listScenarioFiles(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();
}

const presetNames = Object.keys(SCENARIO_PRESETS) as [ScenarioPresetName, ...ScenarioPresetName[]];

export const BusinessSpecSchema = z.object({
  preset: z.enum(presetNames),
  /** Shallow overrides for the fake-business scenario (FakeBusinessScenarioInput). */
  overrides: z.record(z.string(), z.unknown()).default({}),
});
export type BusinessSpec = z.infer<typeof BusinessSpecSchema>;

/** A case fact as written in a scenario. The tier is NOT given: the guard assigns it. */
export const ScenarioFactSchema = z.object({
  key: FactKeySchema,
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(2000),
  /** User approved speaking a confirm-tier fact for this case. */
  approved: z.boolean().default(false),
});

export const ScenarioCaseSchema = z.object({
  userName: z.string().min(1),
  businessId: z.string().min(1).default('bharatnet-broadband'),
  goal: z.string().min(1),
  desiredOutcome: DesiredOutcomeSchema,
  facts: z.array(ScenarioFactSchema).default([]),
});

/** The simulated user on the other side of the Echo. */
export const UserScriptSchema = z.object({
  onHandoff: z.enum(['accept', 'decline', 'ignore']).default('accept'),
  /** What the user says once bridged (goes to the business only; the agent never hears it). */
  speakOnBridge: z.string().min(1).optional(),
  speakAfterMs: z.number().int().min(0).default(2000),
  leaveAfterMs: z.number().int().min(0).default(10_000),
  respondAfterMs: z.number().int().min(0).default(3000),
  /** Answers to mid-call questions, matched by a substring of the asked label. */
  answers: z.record(z.string(), z.string()).default({}),
});

export const PolicyAttemptSchema = z.object({
  label: z.string().min(1),
  /** place_call: through the service (must not dial). policy_only: core canPlaceCall. raw_dial: SimCarrier with the allowlist. */
  kind: z.enum(['place_call', 'policy_only', 'raw_dial']),
  businessId: z.string().min(1).optional(),
  simulatedHourIst: SimulatedHourIstSchema.optional(),
  /** Wall clock for this attempt (ISO). */
  clockAt: z.iso.datetime({ offset: true }).optional(),
  number: z.string().min(1).optional(),
  expect: z.enum(['refused', 'allowed']),
  expectCode: z.string().min(1).optional(),
});
export type PolicyAttempt = z.infer<typeof PolicyAttemptSchema>;

export const CheckNameSchema = z.enum([
  'chain_verifies',
  'no_never_leak',
  'honest_ai_opening',
  'ended_with_outcome',
  'outcome_matches_business',
  'readback_done',
  'followup_scheduled',
  'ivr_path',
  'handoff_pending_reached',
  'needs_you_flag',
  'handoff_resolved',
  'injection_logged',
  'injection_refused',
  'pending_question_surfaced',
  'answer_flowed',
  'failed_ivr_dead_end',
  'user_told_honestly',
  'policy_attempts',
  'planner_error_logged',
  'fallback_spoken',
  'no_crash',
  'followup_quotes_ticket',
  'escalated',
]);
export type CheckName = z.infer<typeof CheckNameSchema>;

export const ScenarioSchema = z.object({
  id: z.string().regex(/^S\d+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Required for the M2 gate: a failure makes `pnpm eval` exit non-zero. */
  required: z.boolean(),
  /** Wall clock at the start of the run (default 14:00 IST). */
  clockStart: z.iso.datetime({ offset: true }).default('2026-10-22T08:30:00Z'),
  business: BusinessSpecSchema.optional(),
  case: ScenarioCaseSchema.optional(),
  placeCall: z.object({ simulatedHourIst: SimulatedHourIstSchema.optional() }).default({}),
  user: UserScriptSchema.prefault({}),
  planner: z
    .object({
      /** Run the planner through the LLM prompt/JSON/zod path even in scripted mode. */
      viaLlm: z.boolean().default(false),
      garbage: GarbagePlanSchema.optional(),
    })
    .prefault({}),
  /** S6: after the first call, run the scheduled follow-up job against this business. */
  followup: z.object({ business: BusinessSpecSchema }).optional(),
  /** S7: dial attempts that must be refused (or allowed) before any dialing. */
  policyAttempts: z.array(PolicyAttemptSchema).optional(),
  expect: z
    .object({
      ivrPath: z.array(z.string()).optional(),
      pendingLabel: z.string().optional(),
    })
    .default({}),
  checks: z.array(CheckNameSchema).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export async function loadScenarios(dir: URL = DEFAULT_SCENARIOS_DIR): Promise<Scenario[]> {
  const files = await listScenarioFiles(dir);
  const out: Scenario[] = [];
  for (const f of files) {
    const raw: unknown = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
    const r = ScenarioSchema.safeParse(raw);
    if (!r.success) {
      throw new Error(`${f}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    out.push(r.data);
  }
  return out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}
