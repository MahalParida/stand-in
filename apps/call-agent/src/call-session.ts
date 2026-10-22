/**
 * CallSession (spec 5): drives core's pure state machine over a Carrier.
 *
 *  - Every inbound frame is logged (masked) and mapped to a machine input.
 *  - Callee speech is untrusted: classifyInbound runs before the planner.
 *    A `never`-tier request -> HANDOFF_PENDING ("Needs you"); an injection ->
 *    logged and politely refused; the call continues.
 *  - Every outbound utterance goes planner -> guardUtterance (expand
 *    {{fact:key}} + output DLP) -> carrier.say. Blocked text is replaced by a
 *    safe fallback and a `blocked_utterance` event.
 *  - Events are appended to a hash-chained log; `said` / `heard` text is
 *    masked before it is stored.
 *  - Time comes from an injectable Clock + timers, so eval runs instantly.
 */
import {
  CaseFactSchema,
  DEFAULT_CALL_MACHINE_CONFIG,
  EventLog,
  OutcomeSchema,
  PlannerOutputSchema,
  createCallSnapshot,
  factKeyEmbedsNeverValue,
  isTerminal,
  systemClock,
  transition,
  type Business,
  type CallEffect,
  type CallEvent,
  type CallEventType,
  type CallInput,
  type CallMachineConfig,
  type CallSnapshot,
  type CallState,
  type Carrier,
  type Case,
  type CaseFact,
  type Clock,
  type FailureReason,
  type InboundFrame,
  type Outcome,
  type PlannerOutput,
  type VerifyResult,
} from '@standin/core';
import {
  DEFAULT_FALLBACK_UTTERANCE,
  assignTier,
  classifyInbound,
  guardUtterance,
  isSpeakable,
  mask,
  scanOutbound,
  type DisclosureCategory,
  type Fact,
} from '@standin/disclosure-guard';
import { z } from 'zod';
import {
  fallbackOutput,
  type PlanResult,
  type Planner,
  type PlannerContext,
  type PlannerFactRef,
  type TranscriptLine,
} from './planner.js';
import { askedPhrase, factKeyFor, matchFact, parseMenu } from './text-rules.js';

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** Timer source. A fake-business VirtualScheduler satisfies it (sim time). */
export interface SessionTimers {
  setTimer(fn: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
}

/** Wall-clock timers for real calls. */
export function createRealTimers(): SessionTimers {
  let seq = 0;
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    setTimer(fn, delayMs) {
      const id = ++seq;
      const h = setTimeout(() => {
        handles.delete(id);
        fn();
      }, Math.max(0, delayMs));
      h.unref?.();
      handles.set(id, h);
      return id;
    },
    clearTimer(id) {
      const h = handles.get(id);
      if (h !== undefined) clearTimeout(h);
      handles.delete(id);
    },
  };
}

export type PendingQuestion =
  | {
      kind: 'handoff';
      id: string;
      /** What the business asked for (category only, never a value). */
      what: DisclosureCategory | 'unknown';
      /** User-facing prompt ("Needs you"). */
      prompt: string;
      askedAt: string;
    }
  | {
      kind: 'question';
      id: string;
      prompt: string;
      /** Key the answer will be stored under. */
      factKey: string;
      label: string;
      askedAt: string;
    };

export interface CallSessionSnapshot {
  callId: string;
  state: CallState;
  holdSeconds: number;
  /** Revisits of an already-heard IVR menu (S5). */
  ivrLoops: number;
  lastLines: TranscriptLine[];
  pendingQuestion?: PendingQuestion;
  outcome?: Outcome;
  failureReason?: FailureReason;
  /** Honest, user-facing explanation when the call failed. */
  failureMessage?: string;
}

export type ActionResult = { ok: true; state: CallState } | { ok: false; error: string; state: CallState };

export interface CallSessionOptions {
  callId: string;
  kase: Case;
  /** Allowlisted directory entry. The number dialled comes only from here. */
  business: Business;
  carrier: Carrier;
  planner: Planner;
  clock?: Clock;
  timers?: SessionTimers;
  machine?: Partial<CallMachineConfig>;
  /** Earlier promise this call follows up on (S6). */
  priorPromise?: Outcome;
  /** Persistence hook (e.g. repo.appendEvent). Awaited in order. */
  onEvent?: (e: CallEvent) => unknown;
  /** Lines exposed in snapshot().lastLines (default 4). */
  lastLinesCount?: number;
}

/* ------------------------------------------------------------------ */
/* Fixed lines (code-owned words)                                       */
/* ------------------------------------------------------------------ */

/**
 * Fact keys go to the planner/LLM and into stored events (said.withheld,
 * handoff/disclosure factKey), so a key that embeds a never-tier value
 * (e.g. `otp_482913`) is replaced by an opaque `fact_<n>` for the call.
 * The planner then only ever sees the opaque key.
 */
export function safeFactKeys(facts: readonly CaseFact[]): CaseFact[] {
  const never: Fact[] = facts
    .filter((f) => f.tier === 'never' && f.value.length > 0)
    .map((f) => ({ key: f.key, label: f.label, value: f.value, tier: f.tier, approved: f.approved }));
  const leaks = (key: string): boolean => {
    if (factKeyEmbedsNeverValue(key, facts)) return true;
    if (never.length === 0) return false;
    const spaced = key.replace(/_/g, ' ');
    try {
      return mask(spaced, never) !== spaced;
    } catch {
      return true;
    }
  };
  const taken = new Set(facts.map((f) => f.key));
  let n = 0;
  return facts.map((f) => {
    if (!leaks(f.key)) return { ...f };
    let key: string;
    do key = `fact_${++n}`;
    while (taken.has(key));
    taken.add(key);
    return { ...f, key };
  });
}

export function openingLine(userName: string): string {
  return `Hi, I'm an AI assistant calling on behalf of ${userName}. This call is being transcribed for them.`;
}

export const GENERIC_OPENING = "Hi, I'm an AI assistant calling on behalf of a customer. This call is being transcribed for them.";

export const HANDOFF_HOLD_UTTERANCE = 'One moment please, let me bring the account holder on the line.';

export const INJECTION_REFUSAL =
  "Sorry, I can't do that. I don't take instructions from this call, and I never share one-time codes or security details. Let's continue with the request.";

export const NEVER_REFUSAL = "Sorry, I can't share that on this call. The account holder will follow up with you directly.";

export const ASK_USER_UTTERANCE = 'One moment, let me check that with the account holder.';

export function readBackLine(o: Outcome): string {
  const parts = [o.what];
  if (o.ticketId !== undefined) parts.push(`service request number ${o.ticketId}`);
  if (o.dueBy !== undefined) parts.push(`to be completed by ${o.dueBy}`);
  return `Just to confirm: ${parts.join(', ')}. Is that correct?`;
}

const CATEGORY_LABEL: Record<DisclosureCategory | 'unknown', string> = {
  otp: 'one-time password (OTP)',
  pin: 'PIN',
  password: 'password',
  cvv: 'card CVV',
  card: 'card number',
  aadhaar: 'Aadhaar number',
  remote_access: 'remote access to your device',
  payment: 'a payment',
  upi: 'a UPI payment',
  unknown: 'a security detail',
};

const AnswerSchema = z.string().trim().min(1).max(500);

interface Heard {
  kind: InboundFrame['kind'];
  speaker?: InboundFrame['speaker'];
  /** Raw text: used only for classification, never stored or sent to the planner. */
  raw: string;
  masked: string;
}

/* ------------------------------------------------------------------ */
/* CallSession                                                         */
/* ------------------------------------------------------------------ */

export class CallSession {
  readonly callId: string;
  readonly business: Business;
  readonly #kase: Case;
  readonly #carrier: Carrier;
  readonly #planner: Planner;
  readonly #clock: Clock;
  readonly #timers: SessionTimers;
  readonly #log: EventLog;
  readonly #onEvent: ((e: CallEvent) => unknown) | undefined;
  readonly #priorPromise: Outcome | undefined;
  readonly #lastLinesCount: number;

  #snap: CallSnapshot;
  #facts: CaseFact[];
  #lines: TranscriptLine[] = [];
  #chain: Promise<void> = Promise.resolve();
  #persist: Promise<void> = Promise.resolve();
  #seq = 0;
  #started = false;

  #respondTo: Heard | undefined;
  #pending: PendingQuestion | undefined;
  #pendingFrame: Heard | undefined;
  #handoffWhat: DisclosureCategory | 'unknown' = 'unknown';
  #openingDone = false;
  #issueStated = false;
  #outcome: Outcome | undefined;
  #failureMessage: string | undefined;

  #holdMs = 0;
  #holdSince: number | undefined;

  #handoffTimer: number | undefined;
  #durationTimer: number | undefined;

  #persistErrors = 0;
  readonly #changeListeners = new Set<(s: CallSessionSnapshot) => void>();
  readonly #factListeners = new Set<(f: CaseFact) => void>();
  readonly #done: Promise<CallSessionSnapshot>;
  #resolveDone: (s: CallSessionSnapshot) => void = () => undefined;

  constructor(opts: CallSessionOptions) {
    this.callId = opts.callId;
    this.business = opts.business;
    this.#kase = opts.kase;
    this.#facts = safeFactKeys(opts.kase.facts);
    this.#carrier = opts.carrier;
    this.#planner = opts.planner;
    this.#clock = opts.clock ?? systemClock;
    this.#timers = opts.timers ?? createRealTimers();
    this.#onEvent = opts.onEvent;
    this.#priorPromise = opts.priorPromise;
    this.#lastLinesCount = opts.lastLinesCount ?? 4;
    this.#log = new EventLog(opts.callId);
    this.#snap = createCallSnapshot(opts.callId, this.#now(), { ...DEFAULT_CALL_MACHINE_CONFIG, ...opts.machine });
    this.#done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
    this.#carrier.on('frame', (f) => {
      this.#enqueue(() => this.#onFrame(f));
    });
  }

  /* ---------------- public API ---------------- */

  get state(): CallState {
    return this.#snap.state;
  }

  /** Resolves with the final snapshot once the call is ENDED or FAILED. */
  get done(): Promise<CallSessionSnapshot> {
    return this.#done;
  }

  /** Current case facts (including ones answered mid-call). */
  facts(): CaseFact[] {
    return this.#facts.map((f) => ({ ...f }));
  }

  snapshot(): CallSessionSnapshot {
    const s: CallSessionSnapshot = {
      callId: this.callId,
      state: this.#snap.state,
      holdSeconds: Math.floor(this.#holdTotalMs() / 1000),
      ivrLoops: this.#snap.ivrLoops,
      lastLines: this.#lines.slice(-this.#lastLinesCount).map((l) => ({ ...l })),
    };
    if (this.#pending !== undefined) s.pendingQuestion = { ...this.#pending };
    if (this.#outcome !== undefined) s.outcome = { ...this.#outcome };
    if (this.#snap.failureReason !== undefined) s.failureReason = this.#snap.failureReason;
    if (this.#failureMessage !== undefined) s.failureMessage = this.#failureMessage;
    return s;
  }

  /** Full masked transcript (what may be stored). */
  transcript(): TranscriptLine[] {
    return this.#lines.map((l) => ({ ...l }));
  }

  /** Hash-chained events (defensive copy). */
  events(): CallEvent[] {
    return this.#log.list();
  }

  verify(): VerifyResult {
    return this.#log.verify();
  }

  get persistErrors(): number {
    return this.#persistErrors;
  }

  /** Called after every processed step with a fresh snapshot. Returns an unsubscribe function. */
  onChange(cb: (s: CallSessionSnapshot) => void): () => void {
    this.#changeListeners.add(cb);
    return () => this.#changeListeners.delete(cb);
  }

  /** Called when a fact is added mid-call (answerPending). The fact carries its value: persist, never log. */
  onFactAdded(cb: (f: CaseFact) => void): () => void {
    this.#factListeners.add(cb);
    return () => this.#factListeners.delete(cb);
  }

  /** Resolves once every queued step (and its persistence) has been processed. */
  async idle(): Promise<void> {
    for (;;) {
      const c = this.#chain;
      const p = this.#persist;
      await c;
      await p;
      if (c === this.#chain && p === this.#persist) return;
    }
  }

  /** Dial the allowlisted number. Call once. */
  start(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#started) return;
      this.#started = true;
      this.#append('state', { to: 'DIALING', reason: 'dial' });
      this.#durationTimer = this.#timers.setTimer(() => this.#tick('duration'), this.#snap.config.maxDurationMs);
      try {
        await this.#carrier.dial(this.business.number, { callId: this.callId });
      } catch (err) {
        await this.#input({ type: 'error', at: this.#now(), reason: 'dial_failed', detail: errName(err) });
      }
    });
  }

  /** The user takes the call (the Echo rings, they say yes). */
  acceptHandoff(): Promise<ActionResult> {
    return this.#action('HANDOFF_PENDING', { type: 'user_accepts' });
  }

  /** The user declines; the agent tells the business they will call back to verify. */
  declineHandoff(): Promise<ActionResult> {
    return this.#action('HANDOFF_PENDING', { type: 'user_declines' });
  }

  /** The bridged user leaves; the agent carries on. */
  userLeave(): Promise<ActionResult> {
    return this.#action('USER_ON_LINE', { type: 'user_leaves' });
  }

  /** End the call now (user / end_call tool). */
  end(reason = 'user_ended'): Promise<ActionResult> {
    return this.#enqueueResult(async () => {
      if (isTerminal(this.#snap.state)) return { ok: false, error: 'call already finished', state: this.#snap.state };
      await this.#input({ type: 'end', at: this.#now(), reason });
      return { ok: true, state: this.#snap.state };
    });
  }

  /**
   * The user answers a mid-call question (S4). The answer becomes a case fact
   * whose tier is assigned by code (never by the caller), then the agent
   * answers the business through the normal planner -> guard path.
   *
   * Secret-shaped answers are never relayed, even when the callee avoided the
   * word "OTP" ("the authorisation number we texted you"): see
   * {@link looksLikeSecretAnswer}. Such an answer is stored as `never`, the
   * business gets NEVER_REFUSAL. A `confirm`-tier answer (phone, address, ...)
   * is relayed only with explicit approval (`opts.approve === true`); without
   * it the question stays pending and the call returns `confirm_required`.
   */
  answerPending(answer: string, questionId?: string, opts: { approve?: boolean } = {}): Promise<ActionResult> {
    return this.#enqueueResult(async () => {
      const parsed = AnswerSchema.safeParse(answer);
      if (!parsed.success) return { ok: false, error: 'answer must be 1-500 characters', state: this.#snap.state };
      const p = this.#pending;
      if (p?.kind !== 'question') return { ok: false, error: 'no pending question to answer', state: this.#snap.state };
      if (questionId !== undefined && questionId !== p.id) {
        return { ok: false, error: 'that question is no longer pending', state: this.#snap.state };
      }
      if (this.#snap.state !== 'HUMAN') return { ok: false, error: `cannot answer in state ${this.#snap.state}`, state: this.#snap.state };
      const value = parsed.data;
      const others = this.#guardFacts().filter((f) => f.key !== p.factKey);
      const secret = looksLikeSecretAnswer({
        label: p.label,
        askedText: this.#pendingFrame?.raw ?? '',
        value,
        otherFacts: others,
      });
      const tier = secret ? 'never' : assignTier({ key: p.factKey, label: p.label, value });
      if (tier === 'confirm' && opts.approve !== true) {
        // Nothing is stored or said yet: the user must explicitly approve sharing a personal detail.
        return { ok: false, error: 'confirm_required: this is a personal detail; answer again with approve=true to share it', state: this.#snap.state };
      }
      const draft = CaseFactSchema.parse({
        key: p.factKey,
        label: p.label,
        value,
        tier,
        approved: tier === 'share' || (tier === 'confirm' && opts.approve === true),
        source: 'call',
      });
      // Re-key the whole list with the new value in it: a never answer can make the new key, or an
      // existing one (e.g. `ticket_ref_4321` once 4321 is never), embed a secret. Those become opaque
      // `fact_<n>` before anything is logged, persisted or shown to the planner. Safe keys (including
      // earlier `fact_<n>` aliases) are kept as they are.
      const next = safeFactKeys([...this.#facts.filter((f) => f.key !== draft.key), draft]);
      const fact = next.at(-1);
      if (fact === undefined) throw new Error('unreachable: re-keyed fact list is empty');
      this.#facts = next;
      this.#append('handoff', { kind: 'question', status: 'answered', factKey: fact.key, tier });
      for (const l of this.#factListeners) safeCall(() => l({ ...fact }));
      const frame = this.#pendingFrame;
      this.#pending = undefined;
      this.#pendingFrame = undefined;
      if (fact.tier === 'never') {
        this.#append('disclosure_request', { injection: false, tier: 'never', what: 'fact', factKey: fact.key, handled: 'refused' });
        await this.#say(NEVER_REFUSAL, 'never_refusal');
      } else if (frame !== undefined) {
        // Answer the business's original question. The planner chooses the words; if it does
        // not use the new fact, code says it plainly (still through the guard).
        const out = await this.#plan(frame);
        if (out.action === 'say' && out.utterance !== undefined && out.utterance.includes(`{{fact:${fact.key}}}`)) {
          await this.#act(out, frame);
        } else {
          await this.#say(`The ${fact.label} is {{fact:${fact.key}}}.`, 'answer_relay');
        }
      }
      return { ok: true, state: this.#snap.state };
    });
  }

  /* ---------------- serial work queue ---------------- */

  #enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.#chain.then(fn).catch((err: unknown) => this.#crash(err));
    this.#chain = next.then(() => this.#notify());
    return this.#chain;
  }

  #enqueueResult(fn: () => Promise<ActionResult>): Promise<ActionResult> {
    let result: ActionResult = { ok: false, error: 'not processed', state: this.#snap.state };
    return this.#enqueue(async () => {
      result = await fn();
    }).then(() => result);
  }

  #action(required: CallState, input: { type: 'user_accepts' | 'user_declines' | 'user_leaves' }): Promise<ActionResult> {
    return this.#enqueueResult(async () => {
      if (this.#snap.state !== required) {
        return { ok: false, error: `expected state ${required}, call is ${this.#snap.state}`, state: this.#snap.state };
      }
      const ok = await this.#input({ ...input, at: this.#now() });
      return ok ? { ok: true, state: this.#snap.state } : { ok: false, error: 'transition rejected', state: this.#snap.state };
    });
  }

  async #crash(err: unknown): Promise<void> {
    this.#append('error', { source: 'session', message: `unexpected ${errName(err)}` });
    if (!isTerminal(this.#snap.state)) {
      try {
        await this.#input({ type: 'error', at: this.#now(), reason: 'error', detail: 'session error' });
      } catch {
        // nothing more we can do; the state machine itself never throws
      }
    }
  }

  #notify(): void {
    if (this.#changeListeners.size === 0) return;
    const s = this.snapshot();
    for (const l of this.#changeListeners) safeCall(() => l(s));
  }

  /**
   * A timer fired. Timers may fire early relative to the session clock (Node's
   * setTimeout jitter, or a sped-up timer source), in which case the tick is a
   * no-op in the state machine; so the timer is re-armed for the time that is
   * still left until its deadline.
   */
  #tick(which: 'handoff' | 'duration'): void {
    void this.#enqueue(async () => {
      if (isTerminal(this.#snap.state)) return;
      await this.#input({ type: 'tick', at: this.#now() });
      if (isTerminal(this.#snap.state)) return;
      const now = this.#now();
      const s = this.#snap;
      if (which === 'duration') {
        const left = s.startedAt + s.config.maxDurationMs - now;
        if (this.#durationTimer !== undefined) this.#timers.clearTimer(this.#durationTimer);
        this.#durationTimer = this.#timers.setTimer(() => this.#tick('duration'), Math.max(1, left));
      } else if (s.state === 'HANDOFF_PENDING' && s.handoffStartedAt !== undefined) {
        const left = s.handoffStartedAt + s.config.handoffTimeoutMs - now;
        this.#clearHandoffTimer();
        this.#handoffTimer = this.#timers.setTimer(() => this.#tick('handoff'), Math.max(1, left));
      }
    });
  }

  /* ---------------- event log ---------------- */

  #now(): number {
    return this.#clock.now().getTime();
  }

  #append(type: CallEventType, data: unknown): void {
    const id = `${this.callId}-e${String(++this.#seq).padStart(4, '0')}`;
    const e = this.#log.append({ id, at: this.#clock.now().toISOString(), type, data });
    const sink = this.#onEvent;
    if (sink !== undefined) {
      this.#persist = this.#persist.then(async () => {
        try {
          await sink(e);
        } catch {
          this.#persistErrors++;
        }
      });
    }
  }

  #guardFacts(): Fact[] {
    const facts: Fact[] = this.#facts.map((f) => ({ key: f.key, label: f.label, value: f.value, tier: f.tier, approved: f.approved }));
    if (!facts.some((f) => f.key === 'user_name')) {
      facts.push({ key: 'user_name', label: 'account holder name', value: this.#kase.userName, tier: 'share', approved: true });
    }
    return facts;
  }

  /** A fact key as it may be stored or shown to the planner: one that embeds a never value is masked. */
  #safeKey(key: string): string {
    return safeFactKeys([{ key, label: key, value: '', tier: 'share', approved: false, source: 'call' }, ...this.#facts])[0]?.key === key ? key : '•••';
  }

  #mask(text: string): string {
    try {
      return mask(text, this.#guardFacts());
    } catch {
      return '•••';
    }
  }

  #line(who: TranscriptLine['who'], text: string): void {
    this.#lines.push({ who, text });
  }

  /* ---------------- state machine ---------------- */

  async #input(input: CallInput): Promise<boolean> {
    const r = transition(this.#snap, input);
    if (!r.ok) {
      this.#append('error', { source: 'state_machine', code: r.error.code, state: r.error.state, input: r.error.input });
      return false;
    }
    this.#snap = r.snapshot;
    await this.#applyEffects(r.effects);
    if (isTerminal(this.#snap.state)) this.#resolveDone(this.snapshot());
    return true;
  }

  async #applyEffects(effects: readonly CallEffect[]): Promise<void> {
    for (const eff of effects) {
      switch (eff.type) {
        case 'state_changed':
          this.#onStateChanged(eff.from, eff.to, eff.reason);
          break;
        case 'request_plan':
          await this.#respond();
          break;
        case 'press_digits':
          this.#append('dtmf', { digits: eff.digits });
          this.#line('standin', `[pressed ${eff.digits}]`);
          await this.#carrierOp(() => this.#carrier.pressDigits(eff.digits));
          break;
        case 'say':
          await this.#say(eff.text, 'state_machine');
          break;
        case 'request_handoff': {
          const what = this.#handoffWhat;
          this.#pending = {
            kind: 'handoff',
            id: `${this.callId}-q${this.#seq + 1}`,
            what,
            prompt: `${this.business.name} is asking for your ${CATEGORY_LABEL[what]}. Only you can share that. Join the call?`,
            askedAt: this.#clock.now().toISOString(),
          };
          this.#append('handoff', { kind: 'handoff', status: 'requested', what });
          await this.#say(HANDOFF_HOLD_UTTERANCE, 'handoff_hold');
          break;
        }
        case 'request_disclosure_approval':
          // confirm-tier asks (payments, UPI): nothing is approved mid-call; the planner answers without it.
          break;
        case 'start_timer':
          this.#clearHandoffTimer();
          this.#handoffTimer = this.#timers.setTimer(() => this.#tick('handoff'), eff.ms);
          break;
        case 'cancel_timer':
          this.#clearHandoffTimer();
          break;
        case 'bridge_user':
          this.#append('handoff', { kind: 'handoff', status: 'user_joined' });
          this.#line('system', '[account holder joined the call]');
          await this.#carrierOp(() => this.#carrier.bridgeUser());
          break;
        case 'unbridge_user':
          this.#append('handoff', { kind: 'handoff', status: 'user_left' });
          this.#line('system', '[account holder left the call]');
          await this.#carrierOp(() => this.#carrier.unbridgeUser());
          break;
        case 'read_back_outcome':
          await this.#say(readBackLine(eff.outcome), 'read_back');
          break;
        case 'record_outcome':
          this.#outcome = { ...eff.outcome };
          this.#append('outcome', { status: 'promised', outcome: eff.outcome });
          break;
        case 'hangup':
          await this.#carrierOp(() => this.#carrier.hangup(), false);
          break;
      }
    }
  }

  #onStateChanged(from: CallState, to: CallState, reason: string | undefined): void {
    const now = this.#now();
    this.#append('state', reason === undefined ? { from, to } : { from, to, reason });
    if (from === 'HOLD' && this.#holdSince !== undefined) {
      this.#holdMs += now - this.#holdSince;
      this.#holdSince = undefined;
    }
    if (to === 'HOLD') this.#holdSince = now;
    if (from === 'HANDOFF_PENDING' && this.#pending?.kind === 'handoff') {
      this.#pending = undefined;
      if (to === 'HUMAN') this.#append('handoff', { kind: 'handoff', status: reason ?? 'returned' });
      if (to === 'USER_ON_LINE') this.#append('handoff', { kind: 'handoff', status: 'accepted' });
    }
    if (to === 'FAILED' || to === 'ENDED') this.#finish(to);
  }

  #finish(to: 'ENDED' | 'FAILED'): void {
    this.#clearHandoffTimer();
    if (this.#durationTimer !== undefined) this.#timers.clearTimer(this.#durationTimer);
    this.#durationTimer = undefined;
    this.#pending = undefined;
    this.#pendingFrame = undefined;
    this.#respondTo = undefined;
    if (to === 'FAILED') {
      const reason = this.#snap.failureReason ?? 'error';
      this.#failureMessage = this.#failureText(reason);
      this.#append('outcome', { status: 'failed', reason, message: this.#failureMessage });
    } else if (this.#snap.outcome === undefined) {
      this.#append('outcome', { status: 'ended_without_outcome' });
    }
  }

  #failureText(reason: FailureReason): string {
    const n = this.business.name;
    switch (reason) {
      case 'ivr_dead_end':
        return `I couldn't reach a person at ${n}: their phone menu kept sending me back to the start (${this.#snap.ivrLoops} loops), so I hung up. Nothing was shared and no request was raised.`;
      case 'max_duration':
        return `The call to ${n} ran past the ${Math.round(this.#snap.config.maxDurationMs / 60_000)}-minute limit, so I hung up without a resolution.`;
      case 'remote_hangup':
        return `${n} hung up before giving a resolution. No request was confirmed.`;
      case 'dial_failed':
        return `I couldn't connect to ${n}.`;
      case 'carrier_error':
      case 'error':
        return `Something went wrong on the line with ${n}, so the call was stopped. No request was confirmed.`;
    }
  }

  #clearHandoffTimer(): void {
    if (this.#handoffTimer !== undefined) this.#timers.clearTimer(this.#handoffTimer);
    this.#handoffTimer = undefined;
  }

  #holdTotalMs(): number {
    return this.#holdMs + (this.#holdSince === undefined ? 0 : this.#now() - this.#holdSince);
  }

  async #carrierOp(op: () => Promise<void>, failOnError = true): Promise<void> {
    try {
      await op();
    } catch (err) {
      this.#append('error', { source: 'carrier', message: errName(err) });
      if (failOnError && !isTerminal(this.#snap.state)) {
        await this.#input({ type: 'error', at: this.#now(), reason: 'carrier_error', detail: errName(err) });
      }
    }
  }

  /* ---------------- inbound ---------------- */

  async #onFrame(f: InboundFrame): Promise<void> {
    if (isTerminal(this.#snap.state)) return;
    const masked = this.#mask(f.text);
    const heard: Heard = { kind: f.kind, raw: f.text, masked };
    if (f.speaker !== undefined) heard.speaker = f.speaker;
    this.#append('heard', f.speaker === undefined ? { kind: f.kind, text: masked } : { kind: f.kind, speaker: f.speaker, text: masked });
    this.#line(f.kind === 'hangup' ? 'system' : 'business', masked);

    const at = this.#now();
    if (f.kind === 'hangup') {
      await this.#input({ type: 'remote_hangup', at });
      return;
    }
    if (this.#snap.state === 'DIALING') {
      await this.#input({ type: 'connected', at });
      if (f.kind === 'speech') {
        // A person answered directly (no IVR).
        this.#respondTo = heard;
        await this.#input({ type: 'human_detected', at });
        return;
      }
    }
    const state = this.#snap.state;
    switch (f.kind) {
      case 'ivr_prompt':
        if (state === 'IVR') {
          // Only prompts that offer options are menus; announcements never count as loops.
          const isMenu = parseMenu(masked).length > 0;
          if (isMenu) this.#respondTo = heard;
          await this.#input({ type: 'menu_prompt', at, text: masked, isMenu });
        }
        return;
      case 'hold':
        if (state === 'IVR' || state === 'HOLD' || state === 'HUMAN') await this.#input({ type: 'hold_detected', at });
        return;
      case 'speech':
        if (state === 'IVR' || state === 'HOLD') {
          this.#respondTo = heard;
          await this.#input({ type: 'human_detected', at });
          return;
        }
        if (state === 'HUMAN' || state === 'WRAP_UP') {
          this.#respondTo = heard;
          await this.#respond();
        }
        // HANDOFF_PENDING / USER_ON_LINE: logged only; the user (or the hand-off) owns the turn.
        return;
    }
  }

  /** Respond to the frame waiting for a response (consumes it). */
  async #respond(): Promise<void> {
    const h = this.#respondTo;
    this.#respondTo = undefined;
    if (h === undefined || isTerminal(this.#snap.state)) return;
    const state = this.#snap.state;
    if (state === 'IVR') {
      if (h.kind !== 'ivr_prompt') return;
      const out = await this.#plan(h);
      if (out.action === 'press' && out.digits !== undefined) {
        // The planner only proposes; code presses a single key that the parsed menu actually offers.
        const offered = parseMenu(h.masked).some((o) => o.digit === out.digits);
        if (!offered) {
          this.#append('error', { source: 'planner', code: 'invalid_digits', message: 'proposed digits are not a menu option' });
          return;
        }
        await this.#input({ type: 'dtmf', at: this.#now(), digits: out.digits });
      }
      return;
    }
    if (state !== 'HUMAN' && state !== 'WRAP_UP') return;
    if (h.kind !== 'speech') return;

    // Callee speech is untrusted input: code classifies it before any planning.
    const cls = classifyInbound(h.raw);
    if (isInstructionInjection(cls.injectionPhrases)) {
      this.#append('disclosure_request', {
        injection: true,
        injectionPhrases: cls.injectionPhrases.map((p) => this.#mask(p)),
        request: cls.disclosureRequest,
        handled: 'refused',
      });
      await this.#say(INJECTION_REFUSAL, 'injection_refusal');
      return;
    }
    const req = cls.disclosureRequest;
    if (req?.tier === 'never') {
      this.#append('disclosure_request', { injection: false, tier: 'never', what: req.what, handled: state === 'HUMAN' ? 'handoff' : 'refused' });
      if (state === 'HUMAN') {
        this.#handoffWhat = req.what;
        await this.#input({ type: 'disclosure_request', at: this.#now(), tier: 'never' });
      } else {
        await this.#say(NEVER_REFUSAL, 'never_refusal');
      }
      return;
    }
    if (req?.tier === 'confirm') {
      this.#append('disclosure_request', { injection: false, tier: 'confirm', what: req.what, handled: 'not_approved' });
      if (state === 'HUMAN') await this.#input({ type: 'disclosure_request', at: this.#now(), tier: 'confirm' });
    }

    const out = await this.#plan(h);
    await this.#act(out, h);
  }

  /* ---------------- planning ---------------- */

  #context(h: Heard): PlannerContext {
    const facts = this.#guardFacts();
    // Labels come from the user / host / callee: mask them like the goal so no never value reaches the LLM.
    const refs: PlannerFactRef[] = facts.map((f) => ({ key: f.key, label: this.#mask(f.label), tier: f.tier, speakable: isSpeakable(f) }));
    const ctx: PlannerContext = {
      state: this.#snap.state,
      businessName: this.business.name,
      userName: this.#mask(this.#kase.userName),
      goal: this.#mask(this.#goalText()),
      desiredOutcome: this.#kase.desiredOutcome,
      facts: refs,
      heard: h.speaker === undefined ? { kind: h.kind, text: h.masked } : { kind: h.kind, speaker: h.speaker, text: h.masked },
      // Re-masked with today's facts: a line heard before a value became never-tier (answered mid-call) may contain it.
      transcript: this.#lines.slice(-8).map((l) => ({ who: l.who, text: this.#mask(l.text) })),
      issueStated: this.#issueStated,
    };
    if (this.#priorPromise !== undefined) ctx.priorPromise = { ...this.#priorPromise };
    if (h.kind === 'ivr_prompt') ctx.menuOptions = parseMenu(h.masked);
    if (this.#snap.pendingOutcome !== undefined) ctx.pendingOutcome = { ...this.#snap.pendingOutcome };
    return ctx;
  }

  /** The goal as the planner sees it; a follow-up call is about the broken promise. */
  #goalText(): string {
    const p = this.#priorPromise;
    if (p?.ticketId === undefined) return this.#kase.goal;
    const due = p.dueBy === undefined ? '' : ` by ${p.dueBy}`;
    return `Follow-up on service request ${p.ticketId}: ${this.business.name} promised ${p.what}${due}, but it has not happened. Quote ${p.ticketId} and ask for escalation to a supervisor. (Original issue: ${this.#kase.goal})`;
  }

  async #plan(h: Heard): Promise<PlannerOutput> {
    const ctx = this.#context(h);
    let res: PlanResult;
    try {
      res = await this.#planner.plan(ctx);
    } catch (err) {
      res = { output: fallbackOutput(ctx.state), error: { code: 'provider_error', message: `planner threw (${errName(err)})` } };
    }
    const valid = PlannerOutputSchema.safeParse(res.output);
    if (!valid.success) {
      res = { output: fallbackOutput(ctx.state), error: { code: 'invalid_schema', message: 'planner returned an invalid output object' } };
    }
    if (res.error !== undefined) {
      this.#append('error', { source: 'planner', planner: this.#planner.name, code: res.error.code, message: res.error.message, fallback: res.output.action });
    }
    return res.error === undefined && valid.success ? valid.data : res.output;
  }

  async #act(out: PlannerOutput, h: Heard): Promise<void> {
    const state = this.#snap.state;
    const at = this.#now();
    if (state === 'HUMAN') {
      switch (out.action) {
        case 'say': {
          // Code, not the planner, decides what an unknown fact means: ask the user (S4).
          const unknown = this.#unknownFactRefs(out.utterance ?? '');
          if (unknown.length > 0) {
            this.#append('error', { source: 'planner', code: 'unknown_fact_reference', message: this.#mask(`utterance referenced unknown fact(s): ${unknown.map((k) => this.#safeKey(k)).join(', ')}`) });
            await this.#askUser(h, undefined);
            return;
          }
          await this.#say(out.utterance ?? '', 'planner');
          return;
        }
        case 'wait':
          if (out.utterance !== undefined && this.#unknownFactRefs(out.utterance).length === 0) await this.#say(out.utterance, 'planner');
          return;
        case 'press':
          this.#append('error', { source: 'planner', code: 'invalid_action', message: 'press is not valid with a person on the line' });
          return;
        case 'request_handoff':
          await this.#askUser(h, out.utterance);
          return;
        case 'confirm_outcome': {
          const o = OutcomeSchema.safeParse(out.outcome);
          if (o.success) await this.#input({ type: 'outcome_detected', at, outcome: o.data });
          return;
        }
        case 'end':
          if (out.utterance !== undefined) await this.#say(out.utterance, 'planner');
          await this.#input({ type: 'end', at: this.#now(), reason: 'planner_end' });
          return;
      }
    }
    if (state === 'WRAP_UP') {
      switch (out.action) {
        case 'confirm_outcome': {
          const o = OutcomeSchema.safeParse(out.outcome);
          if (!o.success) return;
          const pending = this.#snap.pendingOutcome;
          if (pending !== undefined && o.data.ticketId === pending.ticketId) {
            await this.#input({ type: 'outcome_confirmed', at });
          } else {
            await this.#input({ type: 'outcome_detected', at, outcome: o.data });
          }
          return;
        }
        case 'end':
          if (out.utterance !== undefined) await this.#say(out.utterance, 'planner');
          await this.#input({ type: 'outcome_confirmed', at: this.#now() });
          return;
        case 'say':
        case 'request_handoff':
          if (out.utterance !== undefined) await this.#say(out.utterance, 'planner');
          return;
        case 'wait':
        case 'press':
          return;
      }
    }
  }

  /** {{fact:key}} references to keys the case does not have. */
  #unknownFactRefs(template: string): string[] {
    const known = new Set(this.#guardFacts().map((f) => f.key));
    const out: string[] = [];
    for (const m of template.matchAll(/\{\{\s*fact\s*:\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
      const k = m[1];
      if (k !== undefined && !known.has(k) && !out.includes(k)) out.push(k);
    }
    return out;
  }

  /** The business asked for something the case does not have: surface it to the user (S4). */
  async #askUser(h: Heard, utterance: string | undefined): Promise<void> {
    if (this.#pending?.kind === 'question') {
      // Already waiting on the user for this; do not replace the question they are answering.
      return;
    }
    const phrase = askedPhrase(h.masked);
    if (phrase === undefined) {
      // Nothing concrete was asked: hold politely instead of bothering the user.
      await this.#say(utterance ?? ASK_USER_UTTERANCE, 'hold');
      return;
    }
    const facts = this.#guardFacts();
    const known = matchFact(phrase, facts);
    if (known?.tier === 'never') {
      // Never-tier: not even the user's typed answer could be spoken by the agent.
      this.#append('disclosure_request', { injection: false, tier: 'never', what: 'fact', factKey: known.key, handled: 'refused' });
      await this.#say(NEVER_REFUSAL, 'never_refusal');
      return;
    }
    if (isSecretAsk(phrase, h.raw)) {
      // A code sent to the user / login or security detail under another name: hand-off, never a typed answer.
      this.#append('disclosure_request', { injection: false, tier: 'never', what: 'unknown', handled: 'handoff' });
      this.#handoffWhat = 'unknown';
      await this.#input({ type: 'disclosure_request', at: this.#now(), tier: 'never' });
      return;
    }
    let key = known?.key ?? factKeyFor(phrase);
    if (known === undefined) {
      let n = 2;
      const base = key;
      while (facts.some((f) => f.key === key)) key = `${base.slice(0, 60)}_${n++}`;
    }
    this.#pending = {
      kind: 'question',
      id: `${this.callId}-q${this.#seq + 1}`,
      prompt: `${this.business.name} is asking for the ${phrase}. Do you have it?`,
      factKey: key,
      label: phrase,
      askedAt: this.#clock.now().toISOString(),
    };
    this.#pendingFrame = h;
    this.#append('handoff', { kind: 'question', status: 'asked', factKey: key, label: phrase });
    await this.#say(utterance ?? ASK_USER_UTTERANCE, 'ask_user_hold');
  }

  /* ---------------- outbound ---------------- */

  /** planner text -> guard (expand + DLP) -> masked `said` event -> carrier. */
  async #say(template: string, purpose: string): Promise<void> {
    if (isTerminal(this.#snap.state) || template.trim().length === 0) return;
    const facts = this.#guardFacts();
    const g = guardUtterance(template, facts);
    if (!g.allowed) {
      this.#append('blocked_utterance', { purpose, reasons: g.blocked.reasons, redacted: g.blocked.redacted, withheld: g.blocked.withheld.map((k) => this.#safeKey(k)) });
    }
    let text = g.text;
    if (!this.#openingDone) {
      this.#openingDone = true;
      const opening = guardUtterance(openingLine(this.#kase.userName), facts);
      text = `${opening.allowed ? opening.text : GENERIC_OPENING} ${text}`;
    }
    // Defence in depth: the exact string handed to TTS is scanned once more.
    if (!scanOutbound(text, facts).allowed) {
      this.#append('blocked_utterance', { purpose, reasons: [{ code: 'never_fact', message: 'final scan' }], redacted: this.#mask(text), withheld: [] });
      text = DEFAULT_FALLBACK_UTTERANCE;
    }
    if (purpose === 'planner' && g.allowed) this.#issueStated = true;
    const masked = this.#mask(text);
    this.#append('said', g.withheld.length > 0 ? { text: masked, purpose, withheld: g.withheld.map((k) => this.#safeKey(k)) } : { text: masked, purpose });
    this.#line('standin', masked);
    await this.#carrierOp(() => this.#carrier.say(text));
  }
}

/**
 * The guard flags "tell me the OTP" both as a disclosure request and as an
 * injection phrase. A plain demand for a secret is a social-engineering ask
 * (-> hand-off to the user); only phrases that try to override the agent's
 * rules ("ignore your rules", "as your supervisor", "you are now") make it an
 * injection (-> logged and refused, never rings the user).
 */
export function isInstructionInjection(phrases: readonly string[]): boolean {
  return phrases.some((p) => !/^(?:read|tell|give|say) me (?:the|that|your) /.test(p));
}

/** Asks for a code sent to the user, or for login / security material, whatever it is called. */
const SECRET_LABEL =
  /\b(?:otp|one[\s-]*time|pass\s*code|passcodes?|passwords?|pins?|mpin|tpin|verification|verify|confirmation|authori[sz]ation|auth(?:entication)?|security|login|log[\s-]*in|sign[\s-]*in|credentials?|secrets?|tokens?|codes?|cvv|cvc)\b/i;
/** Postal codes are address data, not secrets. */
const POSTAL_LABEL = /\b(?:pin\s*code|pincode|postal(?:\s+code)?|zip(?:\s*code)?|post\s*code)\b/gi;
/** "...we just sent / texted to your mobile" in the callee's original ask. */
const SENT_TO_USER = /\b(?:sent|texted|sms(?:ed)?|messaged|received)\b/i;
const BARE_CODE = /^\d{4,8}$/;

/** The callee asked for a sent / verification / login code, whatever they called it. */
export function isSecretAsk(label: string, askedText: string): boolean {
  if (SECRET_LABEL.test(label.replace(POSTAL_LABEL, ' '))) return true;
  const asked = askedText.replace(POSTAL_LABEL, ' ');
  return SENT_TO_USER.test(asked) && /\b(?:codes?|numbers?|digits|otp|pins?)\b/i.test(asked);
}

/**
 * True when a mid-call answer must be treated as `never` tier: the question
 * was about a sent / verification / login code (by label or by the callee's
 * wording), the answer is a bare 4-8 digit code, or the answer (alone or in
 * its relay sentence) trips output DLP when the new fact cannot clear itself.
 */
export function looksLikeSecretAnswer(input: {
  label: string;
  askedText: string;
  value: string;
  otherFacts: readonly Fact[];
}): boolean {
  if (isSecretAsk(input.label, input.askedText)) return true;
  const isPostal = input.label.replace(POSTAL_LABEL, ' ') !== input.label;
  const compact = input.value.replace(/[\s-]+/g, '');
  if (BARE_CODE.test(compact) && !(isPostal && compact.length === 6)) return true;
  try {
    if (!scanOutbound(input.value, input.otherFacts).allowed) return true;
    if (!scanOutbound(`The ${input.label} is ${input.value}.`, input.otherFacts).allowed) return true;
  } catch {
    return true;
  }
  return false;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    // listeners must not break the call
  }
}
