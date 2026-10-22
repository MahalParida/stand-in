/**
 * ?autoplay=happy|otp|followup — hands-free scripted takes for recording
 * (spec §8, storyboard §11). The script only types/speaks the user's lines
 * and waits on observable state; the elicitation and hand-off are answered
 * by the auto-responders below, so the same code paths run as when a person
 * clicks the buttons.
 */
import { AutoplayScenarioSchema, type AutoplayScenario, type CallState } from '@standin/core';

/** Observable host state the script waits on. */
export interface AutoplayWorld {
  /** Orchestrator turn in flight. */
  busy: boolean;
  /** State of the most recent call, if any. */
  callState?: CallState;
  /** Number of calls placed this take. */
  callsStarted: number;
}

export type AutoplayCondition =
  /** No orchestrator turn running and no elicitation open. */
  | 'idle'
  /** A call is placed and not finished. */
  | 'call_active'
  /** The most recent call reached ENDED or FAILED. */
  | 'call_finished'
  /** No call has been placed since the step's take mark. */
  | 'no_new_call'
  /** A call placed after the last `mark` step is active or finished. */
  | 'new_call_started';

export type AutoplayStep =
  | { kind: 'wait'; ms: number }
  | { kind: 'say'; text: string }
  | { kind: 'say_if'; text: string; when: AutoplayCondition }
  | { kind: 'wait_for'; until: AutoplayCondition; timeoutMs: number }
  | { kind: 'banner'; text: string | null }
  /** Remember callsStarted, for `no_new_call` / `new_call_started`. */
  | { kind: 'mark' };

const TERMINAL: readonly CallState[] = ['ENDED', 'FAILED'];

export function evalCondition(c: AutoplayCondition, w: AutoplayWorld, mark: number): boolean {
  const finished = w.callState !== undefined && TERMINAL.includes(w.callState);
  switch (c) {
    case 'idle':
      return !w.busy;
    case 'call_active':
      return w.callState !== undefined && !finished;
    case 'call_finished':
      return finished;
    case 'no_new_call':
      return w.callsStarted <= mark;
    case 'new_call_started':
      return w.callsStarted > mark;
  }
}

/** §11 storyboard lines. */
export const STORY_LINES = {
  opening: 'Alexa, my BharatNet broadband has been down three days. Sort it out — I want a technician and a bill credit.',
  goAhead: 'Yes, go ahead and call them.',
  promise: 'Thanks. What happened with my complaint?',
  followup: 'Alexa, what happened with my BharatNet complaint? The technician never came.',
  escalate: 'Call them again, quote the ticket and ask for a supervisor.',
} as const;

const CALL_TIMEOUT_MS = 240_000;
const TURN_TIMEOUT_MS = 60_000;

/** Opening beat shared by every take: complaint -> case (elicitation auto-answered) -> call placed. */
const openingSteps: AutoplayStep[] = [
  { kind: 'wait', ms: 1500 },
  { kind: 'mark' },
  { kind: 'say', text: STORY_LINES.opening },
  { kind: 'wait_for', until: 'idle', timeoutMs: TURN_TIMEOUT_MS },
  { kind: 'wait', ms: 1200 },
  // Some orchestrators confirm before dialing; nudge only if no call was placed.
  { kind: 'say_if', text: STORY_LINES.goAhead, when: 'no_new_call' },
  { kind: 'wait_for', until: 'new_call_started', timeoutMs: TURN_TIMEOUT_MS },
  { kind: 'wait_for', until: 'call_finished', timeoutMs: CALL_TIMEOUT_MS },
  { kind: 'wait_for', until: 'idle', timeoutMs: TURN_TIMEOUT_MS },
];

export const AUTOPLAY_SCRIPTS: Record<AutoplayScenario, readonly AutoplayStep[]> = {
  happy: [...openingSteps, { kind: 'wait', ms: 2500 }, { kind: 'say', text: STORY_LINES.promise }, { kind: 'wait_for', until: 'idle', timeoutMs: TURN_TIMEOUT_MS }],
  // Same lines; the OTP beat (Needs you -> join -> leave) is driven by the hand-off responder.
  otp: [...openingSteps, { kind: 'wait', ms: 2500 }, { kind: 'say', text: STORY_LINES.promise }, { kind: 'wait_for', until: 'idle', timeoutMs: TURN_TIMEOUT_MS }],
  followup: [
    ...openingSteps,
    { kind: 'wait', ms: 2000 },
    { kind: 'banner', text: 'Two days later…' },
    { kind: 'wait', ms: 2500 },
    { kind: 'mark' },
    { kind: 'say', text: STORY_LINES.followup },
    { kind: 'wait_for', until: 'idle', timeoutMs: TURN_TIMEOUT_MS },
    // A scheduled follow-up is dialled by the server's ticker a few seconds later.
    { kind: 'wait_for', until: 'new_call_started', timeoutMs: 10_000 },
    { kind: 'say_if', text: STORY_LINES.escalate, when: 'no_new_call' },
    { kind: 'wait_for', until: 'new_call_started', timeoutMs: TURN_TIMEOUT_MS },
    { kind: 'banner', text: null },
    { kind: 'wait_for', until: 'call_finished', timeoutMs: CALL_TIMEOUT_MS },
    { kind: 'wait_for', until: 'idle', timeoutMs: TURN_TIMEOUT_MS },
  ],
};

export interface AutoplayDeps {
  /** Type (and submit) one user line; resolves once submitted. */
  say(text: string): Promise<void>;
  banner(text: string | null): void;
  sleep(ms: number): Promise<void>;
  world(): AutoplayWorld;
  log?(line: string): void;
}

export interface AutoplayResult {
  completed: boolean;
  /** One entry per executed step, for tests and the on-screen log. */
  log: string[];
}

const POLL_MS = 250;

/** Function (not inline) so TS does not narrow `aborted` across awaits. */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** Run a script step by step. Waits never hang: a timeout logs and moves on. */
export async function runAutoplay(steps: readonly AutoplayStep[], deps: AutoplayDeps, signal?: AbortSignal): Promise<AutoplayResult> {
  const log: string[] = [];
  const note = (line: string): void => {
    log.push(line);
    deps.log?.(line);
  };
  let mark = deps.world().callsStarted;
  for (const step of steps) {
    if (isAborted(signal)) {
      note('aborted');
      return { completed: false, log };
    }
    switch (step.kind) {
      case 'wait':
        await deps.sleep(step.ms);
        note(`wait ${step.ms}`);
        break;
      case 'mark':
        mark = deps.world().callsStarted;
        note(`mark ${mark}`);
        break;
      case 'banner':
        deps.banner(step.text);
        note(`banner ${step.text ?? '(clear)'}`);
        break;
      case 'say':
        await deps.say(step.text);
        note(`say ${step.text}`);
        break;
      case 'say_if':
        if (evalCondition(step.when, deps.world(), mark)) {
          await deps.say(step.text);
          note(`say ${step.text}`);
        } else {
          note(`skip ${step.text}`);
        }
        break;
      case 'wait_for': {
        let waited = 0;
        while (!evalCondition(step.until, deps.world(), mark)) {
          if (isAborted(signal)) {
            note('aborted');
            return { completed: false, log };
          }
          if (waited >= step.timeoutMs) break;
          await deps.sleep(POLL_MS);
          waited += POLL_MS;
        }
        note(`${evalCondition(step.until, deps.world(), mark) ? 'reached' : 'timeout'} ${step.until}`);
        break;
      }
    }
  }
  note('done');
  return { completed: true, log };
}

/* ------------------------------------------------------------------ */
/* Auto-responders                                                     */
/* ------------------------------------------------------------------ */

export interface HandoffResponse {
  action: 'join' | 'leave';
  delayMs: number;
}

export const AUTO_JOIN_DELAY_MS = 2000;
/**
 * Fallback only: the server's simulated account holder speaks and hands back
 * on its own (SIM_JOIN_LEAVE_MS). Leaving (handoff_to_user accept=false while
 * USER_ON_LINE) really hands the call back, so autoplay waits well past that.
 */
export const AUTO_LEAVE_DELAY_MS = 10_000;

/**
 * On entering HANDOFF_PENDING, join after the ring; on entering
 * USER_ON_LINE, leave ~3 s later. Only fires on a state transition.
 */
export function handoffResponse(prev: CallState | undefined, next: CallState | undefined): HandoffResponse | null {
  if (next === undefined || prev === next) return null;
  if (next === 'HANDOFF_PENDING') return { action: 'join', delayMs: AUTO_JOIN_DELAY_MS };
  if (next === 'USER_ON_LINE') return { action: 'leave', delayMs: AUTO_LEAVE_DELAY_MS };
  return null;
}

/** Demo account holder details typed into the elicitation form during autoplay (fictional). */
export const AUTO_ANSWERS = {
  account: 'BN7781234',
  name: 'Mahal',
} as const;

/** Fields autoplay must never fill: the user answers those on the line. */
const SECRET_FIELD = /otp|one.?time|pin\b|cvv|password|passcode|aadhaar|card.?number|verification.?code/i;

export type ElicitValue = string | number | boolean | string[];

export interface ElicitProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  oneOf?: Array<{ const: string }>;
  default?: unknown;
  minimum?: number;
}

/**
 * Fill an elicitation form for autoplay. Returns null (decline) when any
 * field asks for a secret.
 */
export function autoAnswerElicitation(properties: Record<string, ElicitProperty>): Record<string, ElicitValue> | null {
  const out: Record<string, ElicitValue> = {};
  for (const [key, p] of Object.entries(properties)) {
    const label = `${key} ${p.title ?? ''} ${p.description ?? ''}`;
    if (SECRET_FIELD.test(label)) return null;
    if (p.type === 'boolean') {
      out[key] = true;
    } else if (p.type === 'number' || p.type === 'integer') {
      out[key] = typeof p.default === 'number' ? p.default : (p.minimum ?? 0);
    } else if (p.type === 'array') {
      out[key] = [];
    } else if (p.enum !== undefined && p.enum.length > 0) {
      out[key] = typeof p.default === 'string' ? p.default : (p.enum[0] ?? '');
    } else if (p.oneOf !== undefined && p.oneOf.length > 0) {
      out[key] = p.oneOf[0]?.const ?? '';
    } else if (/account/i.test(label)) {
      out[key] = AUTO_ANSWERS.account;
    } else if (/name/i.test(label)) {
      out[key] = AUTO_ANSWERS.name;
    } else {
      out[key] = typeof p.default === 'string' ? p.default : 'yes';
    }
  }
  return out;
}

/**
 * Mid-call question (call_status.pendingQuestion kind 'fact' / 'confirm')
 * answered by autoplay: only details the demo account holder would share
 * (the account number). Anything else, and every hand-off, is left alone.
 */
export function autoAnswerPending(q: { kind: 'fact' | 'handoff' | 'confirm'; factKey?: string; label: string }): { answer: string; approve: boolean } | null {
  if (q.kind === 'handoff') return null;
  const label = `${q.factKey ?? ''} ${q.label}`;
  if (SECRET_FIELD.test(label)) return null;
  if (/account/i.test(label)) return { answer: AUTO_ANSWERS.account, approve: q.kind === 'confirm' };
  return null;
}

/** ?autoplay= value, validated. */
export function parseAutoplay(search: string): AutoplayScenario | undefined {
  const raw = new URLSearchParams(search).get('autoplay');
  const r = AutoplayScenarioSchema.safeParse(raw);
  return r.success ? r.data : undefined;
}
