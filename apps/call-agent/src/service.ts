/**
 * placeCall service: the only way a call gets dialled.
 *
 *  1. core `canPlaceCallWithRepo` policy: case ready, business allowlisted and
 *     not opted out, effective calling hour (`simulatedHourIst ?? 14`, or the
 *     IST wall clock when strict) within 09:00-20:00, daily cap.
 *  2. The dialled number comes from the directory entry and is re-checked
 *     against the allowlist. Refused -> no carrier is even created.
 *  3. A CallSession runs the call; events are persisted (hash-chained) and the
 *     outcome becomes a case promise plus a follow-up job (dueBy + 1 day).
 */
import {
  CallingHoursOptionsSchema,
  canPlaceCallWithRepo,
  type Business,
  type Call,
  type CallMachineConfig,
  type Carrier,
  type Case,
  type CasePromise,
  type Clock,
  type Job,
  type Repo,
  type Scheduler,
} from '@standin/core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CallSession, safeFactKeys, type CallSessionSnapshot, type SessionTimers } from './call-session.js';
import { isAllowlistedNumber } from './directory.js';
import type { Planner } from './planner.js';
import { parseDueBy } from './text-rules.js';

export const PlaceCallOptionsSchema = CallingHoursOptionsSchema.pick({ simulatedHourIst: true }).extend({
  /** Follow-up of an earlier promise (S6): the agent quotes its ticket id. */
  followupOfTicketId: z.string().min(1).max(200).optional(),
});
export type PlaceCallOptions = z.infer<typeof PlaceCallOptionsSchema>;

export type PlaceCallDenyCode =
  | 'invalid_options'
  | 'case_not_found'
  | 'not_allowlisted'
  | 'invalid_case'
  | 'case_not_ready'
  | 'unknown_business'
  | 'business_opted_out'
  | 'outside_calling_hours'
  | 'daily_cap_reached'
  /** The carrier or session could not be set up; nothing was dialled and the case is back to 'ready'. */
  | 'call_setup_failed';

export type PlaceCallResult =
  | { ok: true; callId: string; state: 'DIALING'; session: CallSession; finished: Promise<CallFinished> }
  | { ok: false; code: PlaceCallDenyCode; message: string };

/**
 * What `finished` resolves with. It never rejects: a persistence failure while
 * recording the result is reported in `error` (masked: error class only) and
 * the case / call rows are updated best-effort. Callers may ignore it.
 */
export interface CallFinished {
  snapshot: CallSessionSnapshot;
  case: Case;
  call: Call;
  followupJob?: Job;
  /** Mid-call fact writes that failed (the call carried on). */
  factWriteErrors?: number;
  /** Set when the outcome could not be fully persisted. */
  error?: string;
}

export type CarrierFactory = (business: Business, ctx: { callId: string; caseId: string; attempt: number }) => Carrier;

export interface CallServiceOptions {
  repo: Repo;
  directory: readonly Business[];
  carrierFactory: CarrierFactory;
  planner: Planner;
  clock: Clock;
  timers: SessionTimers;
  scheduler?: Scheduler;
  /** STRICT_CALLING_HOURS=true: use the IST wall clock instead of the simulated hour. */
  strictCallingHours?: boolean;
  machine?: Partial<CallMachineConfig>;
  newId?: (prefix: string) => string;
}

/** A repo/setup failure while placing a call: reported as a deny code, never a rejection. */
function setupFailed(err: unknown): { ok: false; code: 'call_setup_failed'; message: string } {
  const name = err instanceof Error ? err.name : 'error';
  return { ok: false, code: 'call_setup_failed', message: `could not set up the call (${name}); nothing was dialled` };
}

export class CallService {
  readonly #o: CallServiceOptions;
  readonly #sessions = new Map<string, CallSession>();
  /** Cases with a placement or a live call in progress (one call per case). */
  readonly #inflight = new Set<string>();
  /** Serialises policy check -> 'calling' write, so concurrent requests cannot both pass the daily cap. */
  #placeLock: Promise<void> = Promise.resolve();
  #backgroundErrors = 0;
  #attempts = 0;

  constructor(opts: CallServiceOptions) {
    this.#o = opts;
  }

  /** Failures in background work (mid-call fact writes, recording a finished call). */
  get backgroundErrors(): number {
    return this.#backgroundErrors;
  }

  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#placeLock;
    let release: () => void = () => undefined;
    this.#placeLock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  session(callId: string): CallSession | undefined {
    return this.#sessions.get(callId);
  }

  #id(prefix: string): string {
    if (this.#o.newId !== undefined) return this.#o.newId(prefix);
    // Unique across processes / service instances sharing one file-backed repo (plain INSERTs).
    return `${prefix}-${Date.now().toString(36)}-${randomUUID()}`;
  }

  /**
   * Places one call. Concurrent requests for the same case (an MCP retry, a
   * double tool call) are refused with `case_not_ready` before anything is
   * read; the policy check and the 'calling' write run under one lock.
   */
  async placeCall(caseId: string, rawOpts: unknown = {}): Promise<PlaceCallResult> {
    const parsedOpts = PlaceCallOptionsSchema.safeParse(rawOpts ?? {});
    if (!parsedOpts.success) return { ok: false, code: 'invalid_options', message: 'place_call options failed validation' };
    const opts = parsedOpts.data;
    if (this.#inflight.has(caseId)) {
      return { ok: false, code: 'case_not_ready', message: `a call for case ${caseId} is already in progress` };
    }
    this.#inflight.add(caseId);
    let handedOff = false;
    try {
      const placed = await this.#locked(() => this.#reserve(caseId, opts)).catch((err: unknown) => setupFailed(err));
      if (!placed.ok) return placed;
      const r = await this.#run(placed, opts).catch(async (err: unknown) => {
        // Only a call that never got a live session is rolled back; a started session settles itself.
        if (!this.#sessions.has(placed.call.id)) await this.#abortSetup(placed.kase.id, placed.call);
        return setupFailed(err);
      });
      // A failed setup never created `finished`, so the slot is released here.
      handedOff = r.ok;
      return r;
    } finally {
      if (!handedOff) this.#inflight.delete(caseId);
    }
  }

  /** Policy check + call row + case 'calling', atomically with respect to other placements. */
  async #reserve(
    caseId: string,
    opts: PlaceCallOptions,
  ): Promise<{ ok: true; kase: Case; calling: Case; call: Call; business: Business } | { ok: false; code: PlaceCallDenyCode; message: string }> {
    const { repo, directory, clock } = this.#o;
    const kase = await repo.getCase(caseId);
    if (kase === undefined) return { ok: false, code: 'case_not_found', message: `case ${caseId} not found` };

    const policyOpts: { simulatedHourIst?: number; strictCallingHours?: boolean } = {};
    if (opts.simulatedHourIst !== undefined) policyOpts.simulatedHourIst = opts.simulatedHourIst;
    if (this.#o.strictCallingHours === true) policyOpts.strictCallingHours = true;
    const decision = await canPlaceCallWithRepo(kase, directory, clock, repo, policyOpts);
    if (!decision.ok) return { ok: false, code: decision.code, message: decision.message };
    const business = decision.business;
    if (!isAllowlistedNumber(business.number, directory)) {
      return { ok: false, code: 'not_allowlisted', message: 'number is not in the business directory' };
    }

    const callId = this.#id('call');
    const startedAt = clock.now().toISOString();
    const call: Call = { id: callId, caseId: kase.id, businessId: business.id, state: 'DIALING', startedAt };
    await repo.createCall(call);
    const calling: Case = { ...kase, status: 'calling', calls: [...kase.calls, callId], updatedAt: startedAt };
    try {
      await repo.updateCase(calling);
    } catch (err) {
      await this.#abortSetup(kase.id, call);
      throw err;
    }
    return { ok: true, kase, calling, call, business };
  }

  async #run(
    placed: { kase: Case; calling: Case; call: Call; business: Business },
    opts: PlaceCallOptions,
  ): Promise<PlaceCallResult> {
    const { repo, clock } = this.#o;
    const { kase, calling, call, business } = placed;
    const callId = call.id;
    const priorPromise =
      opts.followupOfTicketId === undefined
        ? undefined
        : kase.promises.find((p) => p.ticketId === opts.followupOfTicketId);

    let session: CallSession;
    try {
      const carrier = this.#o.carrierFactory(business, { callId, caseId: kase.id, attempt: ++this.#attempts });
      session = new CallSession({
        callId,
        kase: calling,
        business,
        carrier,
        planner: this.#o.planner,
        clock,
        timers: this.#o.timers,
        ...(this.#o.machine !== undefined ? { machine: this.#o.machine } : {}),
        ...(priorPromise !== undefined ? { priorPromise: stripCallId(priorPromise) } : {}),
        onEvent: (e) => repo.appendEvent(e),
      });
    } catch (err) {
      await this.#abortSetup(kase.id, call);
      const name = err instanceof Error ? err.name : 'error';
      return { ok: false, code: 'call_setup_failed', message: `could not set up the call (${name}); nothing was dialled` };
    }
    this.#sessions.set(callId, session);

    // Mid-call fact writes run in the background: a failure is counted, never an unhandled rejection.
    let factWrites: Promise<void> = Promise.resolve();
    let factWriteErrors = 0;
    session.onFactAdded((fact) => {
      factWrites = factWrites
        .then(async () => {
          const cur = await repo.getCase(kase.id);
          if (cur === undefined) return;
          await repo.updateCase({
            ...cur,
            // Re-keyed like the session's list: a never answer must not leave a stored key that embeds it
            // (CaseSchema rejects that, and the fact would be lost).
            facts: safeFactKeys([...cur.facts.filter((f) => f.key !== fact.key), fact]),
            updatedAt: clock.now().toISOString(),
          });
        })
        .catch(() => {
          factWriteErrors++;
          this.#backgroundErrors++;
        });
    });

    // `finished` never rejects (see CallFinished); the in-flight slot is released when it settles.
    const finished: Promise<CallFinished> = (async () => {
      const snapshot = await session.done;
      await session.idle();
      await factWrites;
      let out: CallFinished;
      try {
        out = await this.#finish(kase.id, call, snapshot, opts.followupOfTicketId !== undefined);
      } catch (err) {
        this.#backgroundErrors++;
        out = await this.#finishAfterError(calling, call, snapshot, err);
      }
      if (factWriteErrors > 0) out.factWriteErrors = factWriteErrors;
      return out;
    })().finally(() => {
      this.#inflight.delete(kase.id);
    });
    await session.start();
    return { ok: true, callId, state: 'DIALING', session, finished };
  }

  /** Setup failed before anything was dialled: close the call row and release the case. Never throws. */
  async #abortSetup(caseId: string, call: Call): Promise<void> {
    const { repo, clock } = this.#o;
    const endedAt = clock.now().toISOString();
    try {
      await repo.updateCall({ ...call, state: 'FAILED', failureReason: 'carrier_error', endedAt });
    } catch {
      this.#backgroundErrors++;
    }
    try {
      const cur = await repo.getCase(caseId);
      if (cur !== undefined && cur.status === 'calling') await repo.updateCase({ ...cur, status: 'ready', updatedAt: endedAt });
    } catch {
      this.#backgroundErrors++;
    }
  }

  /** Best-effort terminal write after #finish failed. Never throws. */
  async #finishAfterError(fallbackCase: Case, call: Call, snap: CallSessionSnapshot, err: unknown): Promise<CallFinished> {
    const { repo, clock } = this.#o;
    const endedAt = clock.now().toISOString();
    const finalCall: Call = { ...call, state: snap.state, endedAt };
    if (snap.failureReason !== undefined) finalCall.failureReason = snap.failureReason;
    if (snap.outcome !== undefined) finalCall.outcome = snap.outcome;
    try {
      await repo.updateCall(finalCall);
    } catch {
      // already reported through `error`
    }
    let kase: Case = { ...fallbackCase, status: 'failed', updatedAt: endedAt };
    try {
      const cur = await repo.getCase(fallbackCase.id);
      if (cur !== undefined) kase = await repo.updateCase({ ...cur, status: cur.status === 'calling' ? 'failed' : cur.status, updatedAt: endedAt });
    } catch {
      // best effort
    }
    const name = err instanceof Error ? err.name : 'error';
    return { snapshot: snap, case: kase, call: finalCall, error: `recording the call result failed (${name})` };
  }

  async #finish(caseId: string, call: Call, snap: CallSessionSnapshot, followup: boolean): Promise<CallFinished> {
    const { repo, clock } = this.#o;
    const endedAt = clock.now().toISOString();
    const finalCall: Call = { ...call, state: snap.state, endedAt };
    if (snap.failureReason !== undefined) finalCall.failureReason = snap.failureReason;
    if (snap.outcome !== undefined) finalCall.outcome = snap.outcome;
    await repo.updateCall(finalCall);

    const cur = await repo.getCase(caseId);
    if (cur === undefined) throw new Error(`case ${caseId} vanished during the call`);
    let next: Case = { ...cur, updatedAt: endedAt };
    let followupJob: Job | undefined;
    if (snap.outcome !== undefined) {
      const promise: CasePromise = { ...snap.outcome, callId: call.id };
      next = { ...next, promises: [...next.promises, promise], status: followup ? 'escalated' : 'promised' };
      const due = snap.outcome.dueBy === undefined ? undefined : parseDueBy(snap.outcome.dueBy);
      // dueBy + 1 day, but never in the past: a stale or garbled promised date must not fire the follow-up at once.
      const nowMs = clock.now().getTime();
      const dueMs = due === undefined || due.getTime() <= nowMs ? nowMs + 2 * 86_400_000 : due.getTime();
      const runAt = new Date(dueMs + 86_400_000);
      if (this.#o.scheduler !== undefined && !followup) {
        const payload: Record<string, unknown> = { callId: call.id };
        if (snap.outcome.ticketId !== undefined) payload.ticketId = snap.outcome.ticketId;
        followupJob = await this.#o.scheduler.schedule({
          id: this.#id('job'),
          kind: 'followup',
          caseId,
          runAt: runAt.toISOString(),
          payload,
        });
      }
    } else {
      next = { ...next, status: snap.state === 'FAILED' ? 'failed' : 'ready' };
    }
    const saved = await repo.updateCase(next);
    const out: CallFinished = { snapshot: snap, case: saved, call: finalCall };
    if (followupJob !== undefined) out.followupJob = followupJob;
    return out;
  }

  /**
   * Follow-up job handler (spec S6): the promise is due + 1 day and the case
   * is not resolved, so call again quoting the ticket id.
   */
  async runFollowup(job: Job, opts: { simulatedHourIst?: number } = {}): Promise<PlaceCallResult> {
    const ticketId = z.string().min(1).safeParse(job.payload.ticketId);
    const kase = await this.#o.repo.getCase(job.caseId);
    if (kase === undefined) return { ok: false, code: 'case_not_found', message: `case ${job.caseId} not found` };
    if (kase.status === 'resolved') return { ok: false, code: 'case_not_ready', message: 'case already resolved' };
    if (kase.status === 'promised') {
      await this.#o.repo.updateCase({ ...kase, status: 'ready', updatedAt: this.#o.clock.now().toISOString() });
    }
    return this.placeCall(job.caseId, {
      ...opts,
      ...(ticketId.success ? { followupOfTicketId: ticketId.data } : {}),
    });
  }
}

function stripCallId(p: CasePromise): Omit<CasePromise, 'callId'> {
  const { callId: _callId, ...rest } = p;
  return rest;
}
