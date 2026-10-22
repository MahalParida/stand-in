/**
 * Deterministic call-session state machine (spec section 5.1).
 *
 * Pure: `transition(snapshot, input)` returns the next snapshot plus a list of
 * side-effects for the runtime to perform. It never throws and never performs
 * I/O; invalid inputs come back as `{ ok: false, error }`.
 *
 *   DIALING --connected--> IVR --menu_prompt--> IVR (planner picks digit) --dtmf--> IVR
 *   IVR --hold_detected--> HOLD --human_detected--> HUMAN
 *   HUMAN --disclosure_request(never)--> HANDOFF_PENDING --user_accepts--> USER_ON_LINE --user_leaves--> HUMAN
 *   HANDOFF_PENDING --user_declines / timeout 60s--> HUMAN (say "They'll call back to verify")
 *   HUMAN --outcome_detected--> WRAP_UP (read back, get confirmation) --outcome_confirmed--> ENDED
 *   any --error / timeout / limit--> FAILED(reason)
 *
 * Small, documented extensions needed by a real call:
 *   - IVR --human_detected--> HUMAN   (IVR routes straight to an agent, no hold)
 *   - HUMAN --hold_detected--> HOLD   (agent puts the caller on hold)
 *   - WRAP_UP --outcome_rejected--> HUMAN (read-back was wrong; keep talking)
 *   - remote hangup: WRAP_UP -> ENDED, otherwise FAILED(remote_hangup)
 *   - end (user / end_call tool): any live state -> ENDED
 */
import { z } from 'zod';
import {
  CallStateSchema,
  DtmfDigitsSchema,
  FactKeySchema,
  FailureReasonSchema,
  OutcomeSchema,
  TierSchema,
  type CallState,
  type FailureReason,
  type Outcome,
  type Tier,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export const CallMachineConfigSchema = z.object({
  /** Max call duration in ms (spec: 25 min sim, configurable). */
  maxDurationMs: z.number().int().positive().default(25 * 60 * 1000),
  /** Max IVR loops (revisits of an already-heard menu) before FAILED(ivr_dead_end). */
  maxIvrLoops: z.number().int().positive().default(3),
  /** HANDOFF_PENDING timeout in ms (spec: 60 s). */
  handoffTimeoutMs: z.number().int().positive().default(60 * 1000),
});
export type CallMachineConfig = z.infer<typeof CallMachineConfigSchema>;

export const DEFAULT_CALL_MACHINE_CONFIG: CallMachineConfig = CallMachineConfigSchema.parse({});

/** Spoken to the business when the user declines / does not take over in time. */
export const HANDOFF_DECLINED_UTTERANCE = "They'll call back to verify.";

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

export const CallSnapshotSchema = z.object({
  callId: z.string().min(1),
  state: CallStateSchema,
  /** Epoch ms the dial started. */
  startedAt: z.number().int().nonnegative(),
  /** Epoch ms of the last accepted input. */
  updatedAt: z.number().int().nonnegative(),
  /** Number of times an already-heard IVR menu was heard again. */
  ivrLoops: z.number().int().nonnegative(),
  /** Normalised IVR prompt -> times heard. */
  ivrPromptsSeen: z.record(z.string(), z.number().int().positive()),
  /** Epoch ms HANDOFF_PENDING was entered (present only in that state). */
  handoffStartedAt: z.number().int().nonnegative().optional(),
  /** Fact the business asked for that triggered the hand-off (key only, never a value). */
  handoffFactKey: FactKeySchema.optional(),
  pendingOutcome: OutcomeSchema.optional(),
  outcome: OutcomeSchema.optional(),
  failureReason: FailureReasonSchema.optional(),
  failureDetail: z.string().optional(),
  config: CallMachineConfigSchema,
});
export type CallSnapshot = z.infer<typeof CallSnapshotSchema>;

export function createCallSnapshot(
  callId: string,
  startedAt: number,
  config: Partial<CallMachineConfig> = {},
): CallSnapshot {
  return {
    callId,
    state: 'DIALING',
    startedAt,
    updatedAt: startedAt,
    ivrLoops: 0,
    ivrPromptsSeen: {},
    config: CallMachineConfigSchema.parse(config),
  };
}

/* ------------------------------------------------------------------ */
/* Inputs (machine events, not to be confused with logged CallEvents)   */
/* ------------------------------------------------------------------ */

const at = z.number().int().nonnegative();

export const CallInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected'), at }),
  z.object({ type: z.literal('menu_prompt'), at, text: z.string() }),
  z.object({ type: z.literal('dtmf'), at, digits: DtmfDigitsSchema }),
  z.object({ type: z.literal('hold_detected'), at }),
  z.object({ type: z.literal('human_detected'), at }),
  z.object({
    type: z.literal('disclosure_request'),
    at,
    tier: TierSchema,
    factKey: FactKeySchema.optional(),
  }),
  z.object({ type: z.literal('user_accepts'), at }),
  z.object({ type: z.literal('user_declines'), at }),
  z.object({ type: z.literal('user_leaves'), at }),
  z.object({ type: z.literal('outcome_detected'), at, outcome: OutcomeSchema }),
  z.object({ type: z.literal('outcome_confirmed'), at }),
  z.object({ type: z.literal('outcome_rejected'), at }),
  z.object({ type: z.literal('remote_hangup'), at }),
  z.object({ type: z.literal('end'), at, reason: z.string().optional() }),
  z.object({ type: z.literal('error'), at, reason: FailureReasonSchema.optional(), detail: z.string().optional() }),
  /** Clock tick: drives the hand-off timeout and the max-duration limit. */
  z.object({ type: z.literal('tick'), at }),
]);
export type CallInput = z.infer<typeof CallInputSchema>;
export type CallInputType = CallInput['type'];

/* ------------------------------------------------------------------ */
/* Effects                                                             */
/* ------------------------------------------------------------------ */

export type CallEffect =
  | { type: 'state_changed'; from: CallState; to: CallState; reason?: string }
  | { type: 'request_plan' }
  | { type: 'press_digits'; digits: string }
  | { type: 'say'; text: string }
  | { type: 'request_handoff'; factKey?: string }
  | { type: 'request_disclosure_approval'; tier: Exclude<Tier, 'never'>; factKey?: string }
  | { type: 'start_timer'; name: 'handoff'; ms: number }
  | { type: 'cancel_timer'; name: 'handoff' }
  | { type: 'bridge_user' }
  | { type: 'unbridge_user' }
  | { type: 'read_back_outcome'; outcome: Outcome }
  | { type: 'record_outcome'; outcome: Outcome }
  | { type: 'hangup' };

export type TransitionErrorCode = 'invalid_input' | 'invalid_transition' | 'terminal_state' | 'clock_went_backwards';

export interface TransitionError {
  code: TransitionErrorCode;
  message: string;
  state: CallState;
  input: string;
}

export type TransitionResult =
  | { ok: true; snapshot: CallSnapshot; effects: CallEffect[] }
  | { ok: false; error: TransitionError };

/* ------------------------------------------------------------------ */
/* Transition                                                          */
/* ------------------------------------------------------------------ */

export function isTerminal(state: CallState): boolean {
  return state === 'ENDED' || state === 'FAILED';
}

/** Normalise an IVR prompt so whitespace/case/punctuation differences still count as the same menu. */
export function normalizePrompt(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function fail(
  code: TransitionErrorCode,
  state: CallState,
  input: string,
  message: string,
): TransitionResult {
  return { ok: false, error: { code, state, input, message } };
}

function move(
  s: CallSnapshot,
  to: CallState,
  at: number,
  effects: CallEffect[] = [],
  patch: Partial<CallSnapshot> = {},
  reason?: string,
): TransitionResult {
  const from = s.state;
  const next: CallSnapshot = { ...s, ...patch, state: to, updatedAt: at };
  if (to !== 'HANDOFF_PENDING') {
    delete next.handoffStartedAt;
    delete next.handoffFactKey;
  }
  const changed: CallEffect[] =
    from === to ? [] : [reason === undefined ? { type: 'state_changed', from, to } : { type: 'state_changed', from, to, reason }];
  return { ok: true, snapshot: next, effects: [...changed, ...effects] };
}

function toFailed(
  s: CallSnapshot,
  at: number,
  reason: FailureReason,
  detail?: string,
): TransitionResult {
  const effects: CallEffect[] = [];
  if (s.state === 'HANDOFF_PENDING') effects.push({ type: 'cancel_timer', name: 'handoff' });
  if (s.state === 'USER_ON_LINE') effects.push({ type: 'unbridge_user' });
  if (reason !== 'remote_hangup' && reason !== 'dial_failed') effects.push({ type: 'hangup' });
  const patch: Partial<CallSnapshot> = { failureReason: reason };
  if (detail !== undefined) patch.failureDetail = detail;
  return move(s, 'FAILED', at, effects, patch, reason);
}

function handoffBackToHuman(s: CallSnapshot, at: number, reason: string): TransitionResult {
  return move(
    s,
    'HUMAN',
    at,
    [
      { type: 'cancel_timer', name: 'handoff' },
      { type: 'say', text: HANDOFF_DECLINED_UTTERANCE },
    ],
    {},
    reason,
  );
}

/**
 * Apply one input to a snapshot. Never throws.
 * Limits are checked before the input itself: once the max duration has elapsed
 * any input (including `tick`) fails the call with `max_duration`.
 */
export function transition(snapshot: CallSnapshot, rawInput: unknown): TransitionResult {
  const parsed = CallInputSchema.safeParse(rawInput);
  const inputName =
    typeof rawInput === 'object' && rawInput !== null && 'type' in rawInput && typeof rawInput.type === 'string'
      ? rawInput.type
      : 'unknown';
  if (!parsed.success) {
    return fail('invalid_input', snapshot.state, inputName, parsed.error.issues.map((i) => i.message).join('; '));
  }
  const input = parsed.data;
  const s = snapshot;
  const { config } = s;

  if (isTerminal(s.state)) {
    return fail('terminal_state', s.state, input.type, `call is ${s.state}; no further inputs accepted`);
  }
  if (input.at < s.updatedAt) {
    return fail('clock_went_backwards', s.state, input.type, `input at ${input.at} is before last update ${s.updatedAt}`);
  }

  // Global limits (any --timeout/limit--> FAILED).
  if (input.at - s.startedAt >= config.maxDurationMs) {
    return toFailed(s, input.at, 'max_duration', `exceeded ${config.maxDurationMs} ms`);
  }
  // Hand-off timeout: an expired hand-off resolves as a timeout regardless of the input.
  if (
    s.state === 'HANDOFF_PENDING' &&
    s.handoffStartedAt !== undefined &&
    input.at - s.handoffStartedAt >= config.handoffTimeoutMs &&
    input.type !== 'error' &&
    input.type !== 'remote_hangup' &&
    input.type !== 'end'
  ) {
    return handoffBackToHuman(s, input.at, 'handoff_timeout');
  }

  // Inputs valid from any live state.
  switch (input.type) {
    case 'error':
      return toFailed(s, input.at, input.reason ?? 'error', input.detail);
    case 'remote_hangup':
      if (s.state === 'WRAP_UP') {
        return move(
          s,
          'ENDED',
          input.at,
          s.pendingOutcome ? [{ type: 'record_outcome', outcome: s.pendingOutcome }] : [],
          s.pendingOutcome ? { outcome: s.pendingOutcome } : {},
          'remote_hangup',
        );
      }
      return toFailed(s, input.at, 'remote_hangup');
    case 'end': {
      const effects: CallEffect[] = [];
      if (s.state === 'HANDOFF_PENDING') effects.push({ type: 'cancel_timer', name: 'handoff' });
      if (s.state === 'USER_ON_LINE') effects.push({ type: 'unbridge_user' });
      effects.push({ type: 'hangup' });
      return move(s, 'ENDED', input.at, effects, {}, input.reason ?? 'ended');
    }
    case 'tick':
      // No limit hit (checked above): ticks are a no-op in every live state.
      return { ok: true, snapshot: { ...s, updatedAt: input.at }, effects: [] };
    default:
      break;
  }

  const invalid = (): TransitionResult =>
    fail('invalid_transition', s.state, input.type, `'${input.type}' is not valid in state ${s.state}`);

  switch (s.state) {
    case 'DIALING':
      if (input.type === 'connected') return move(s, 'IVR', input.at);
      return invalid();

    case 'IVR':
      switch (input.type) {
        case 'menu_prompt': {
          const key = normalizePrompt(input.text);
          const seen = s.ivrPromptsSeen[key] ?? 0;
          const ivrLoops = seen > 0 ? s.ivrLoops + 1 : s.ivrLoops;
          const ivrPromptsSeen = { ...s.ivrPromptsSeen, [key]: seen + 1 };
          if (ivrLoops >= config.maxIvrLoops) {
            return toFailed(
              { ...s, ivrLoops, ivrPromptsSeen },
              input.at,
              'ivr_dead_end',
              `IVR looped ${ivrLoops} times`,
            );
          }
          return move(s, 'IVR', input.at, [{ type: 'request_plan' }], { ivrLoops, ivrPromptsSeen });
        }
        case 'dtmf':
          return move(s, 'IVR', input.at, [{ type: 'press_digits', digits: input.digits }]);
        case 'hold_detected':
          return move(s, 'HOLD', input.at);
        case 'human_detected':
          return move(s, 'HUMAN', input.at, [{ type: 'request_plan' }]);
        default:
          return invalid();
      }

    case 'HOLD':
      switch (input.type) {
        case 'human_detected':
          return move(s, 'HUMAN', input.at, [{ type: 'request_plan' }]);
        case 'hold_detected':
          return move(s, 'HOLD', input.at); // still holding
        default:
          return invalid();
      }

    case 'HUMAN':
      switch (input.type) {
        case 'disclosure_request': {
          if (input.tier === 'never') {
            const patch: Partial<CallSnapshot> = { handoffStartedAt: input.at };
            if (input.factKey !== undefined) patch.handoffFactKey = input.factKey;
            const req: CallEffect =
              input.factKey === undefined
                ? { type: 'request_handoff' }
                : { type: 'request_handoff', factKey: input.factKey };
            return move(
              s,
              'HANDOFF_PENDING',
              input.at,
              [req, { type: 'start_timer', name: 'handoff', ms: config.handoffTimeoutMs }],
              patch,
              'disclosure_request(never)',
            );
          }
          // share/confirm: stay with the human; runtime asks the user / guard expands.
          const eff: CallEffect =
            input.factKey === undefined
              ? { type: 'request_disclosure_approval', tier: input.tier }
              : { type: 'request_disclosure_approval', tier: input.tier, factKey: input.factKey };
          return move(s, 'HUMAN', input.at, [eff]);
        }
        case 'hold_detected':
          return move(s, 'HOLD', input.at);
        case 'outcome_detected':
          return move(
            s,
            'WRAP_UP',
            input.at,
            [{ type: 'read_back_outcome', outcome: input.outcome }],
            { pendingOutcome: input.outcome },
          );
        default:
          return invalid();
      }

    case 'HANDOFF_PENDING':
      switch (input.type) {
        case 'user_accepts':
          return move(s, 'USER_ON_LINE', input.at, [
            { type: 'cancel_timer', name: 'handoff' },
            { type: 'bridge_user' },
          ]);
        case 'user_declines':
          return handoffBackToHuman(s, input.at, 'user_declined');
        default:
          return invalid();
      }

    case 'USER_ON_LINE':
      if (input.type === 'user_leaves') {
        return move(s, 'HUMAN', input.at, [{ type: 'unbridge_user' }, { type: 'request_plan' }]);
      }
      return invalid();

    case 'WRAP_UP':
      switch (input.type) {
        case 'outcome_confirmed': {
          if (s.pendingOutcome === undefined) return invalid();
          const outcome = s.pendingOutcome;
          const next = move(
            s,
            'ENDED',
            input.at,
            [{ type: 'record_outcome', outcome }, { type: 'hangup' }],
            { outcome },
            'outcome_confirmed',
          );
          if (next.ok) delete next.snapshot.pendingOutcome;
          return next;
        }
        case 'outcome_rejected': {
          const next = move(s, 'HUMAN', input.at, [{ type: 'request_plan' }]);
          if (next.ok) delete next.snapshot.pendingOutcome;
          return next;
        }
        case 'outcome_detected':
          // Agent restated / corrected the outcome during read-back.
          return move(s, 'WRAP_UP', input.at, [{ type: 'read_back_outcome', outcome: input.outcome }], {
            pendingOutcome: input.outcome,
          });
        default:
          return invalid();
      }

    case 'ENDED':
    case 'FAILED':
      return fail('terminal_state', s.state, input.type, `call is ${s.state}`);
  }
}

/** Fold a sequence of inputs; stops at the first error. */
export function runInputs(
  snapshot: CallSnapshot,
  inputs: readonly CallInput[],
): { snapshot: CallSnapshot; effects: CallEffect[]; error?: TransitionError } {
  let cur = snapshot;
  const effects: CallEffect[] = [];
  for (const i of inputs) {
    const r = transition(cur, i);
    if (!r.ok) return { snapshot: cur, effects, error: r.error };
    cur = r.snapshot;
    effects.push(...r.effects);
  }
  return { snapshot: cur, effects };
}
