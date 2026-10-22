/**
 * StandinApp: the transport-independent core behind the MCP tools.
 *
 * Cases live in the repo (SQLite). Each placed call gets its own sim world:
 * a PacedScheduler (one sim timeline shared by the call session, the clock and
 * the fake business), a FakeBusiness with the case's scenario, a SimCarrier and
 * a CallService. The call runs in the background; tools read snapshots.
 *
 * Every value returned from here is a contract view: never-tier fact values
 * are dropped, every text is masked by the disclosure guard.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CallService,
  DEFAULT_DIRECTORY_URL,
  LlmPlanner,
  ScriptedPlanner,
  SimCarrier,
  loadDirectory,
  parseDueBy,
  type CallFinished,
  type CallSession,
  type CallSessionSnapshot,
  type Planner,
  type PlaceCallResult,
} from '@standin/call-agent';
import {
  BusinessDirectoryFileSchema,
  CaseFactSchema,
  CaseSchema,
  isTerminal,
  systemClock,
  type Business,
  type Call,
  type CallLine,
  type CallMachineConfig,
  type CallState,
  type CallStatusOutput,
  type Case,
  type CaseFact,
  type CaseView,
  type Clock,
  type EndCallOutput,
  type GetCaseOutput,
  type HandoffToUserOutput,
  type Job,
  type ListCasesOutput,
  type MissingFact,
  type OpenCaseOutput,
  type Outcome,
  type PlaceCallOutput,
  type ScheduleFollowupOutput,
  type SendToCallOutput,
  type UpdateCaseFactOutput,
  type CaseStatus,
  type DesiredOutcome,
  type FactSource,
} from '@standin/core';
import { assignTier } from '@standin/disclosure-guard';
import { FakeBusiness, type FakeBusinessScenario } from '@standin/fake-business';
import { ScriptedLlmProvider, type Providers } from '@standin/providers';
import { PacedScheduler } from './paced-scheduler.js';
import {
  businessScenario,
  followupScenario,
  labelFromKey,
  missingFacts,
  pickScenario,
  type ScenarioName,
} from './scenarios.js';
import { callSummary, caseView, clip, digestEvents, fmtDate, jobView, maskText, outcomeSentence, pendingView } from './views.js';

/** A tool-level failure: becomes `isError: true` with {error:{code,message}}. */
export class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolFailure';
  }
}

export interface SimSpeeds {
  talk: number;
  hold: number;
  handoff: number;
}

export interface StandinAppOptions {
  providers: Providers;
  directory?: Business[];
  /** Used in the AI disclosure when open_case gets no userName. */
  defaultUserName?: string;
  speeds?: Partial<SimSpeeds>;
  /** Simulated account holder on a hand-off: speaks after / leaves after (sim ms). */
  join?: { speakMs?: number; leaveMs?: number };
  strictCallingHours?: boolean;
  /** Replaces each business's dailyCap (STANDIN_DAILY_CALL_CAP). */
  dailyCallCap?: number | undefined;
  machine?: Partial<CallMachineConfig>;
  /** Wall clock (cases, jobs). Each call adds its own sim time on top. */
  clock?: Clock;
  /** Planner override (tests). Default: scripted policy offline, LlmPlanner otherwise. */
  planner?: Planner;
}

export interface FactInputLike {
  key: string;
  value: string;
  label?: string | undefined;
  approve?: boolean | undefined;
}

export interface OpenCaseArgs {
  businessName: string;
  goal: string;
  desiredOutcome: DesiredOutcome;
  facts: FactInputLike[];
  userName?: string | undefined;
  scenario?: ScenarioName | undefined;
}

/** Elicits missing facts from the user; resolves with key -> value, or undefined (declined / unavailable). */
export type Elicitor = (missing: MissingFact[], business: Business) => Promise<Record<string, string> | undefined>;

export interface ChangeEvent {
  caseId: string;
  callId?: string;
}

interface LiveCall {
  callId: string;
  caseId: string;
  business: Business;
  session: CallSession;
  carrier: SimCarrier | undefined;
  paced: PacedScheduler;
  clock: Clock;
  startedAt: string;
  confirmIds: Set<string>;
  userLines: CallLine[];
  finished: Promise<CallFinished>;
  final?: CallFinished;
}

const MAX_LIVE_CALLS = 500;
const DAY_MS = 86_400_000;

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export class StandinApp {
  readonly providers: Providers;
  readonly directory: Business[];
  readonly #aliases = new Map<string, string[]>();
  readonly #defaultUserName: string;
  readonly #speeds: SimSpeeds;
  readonly #join: { speakMs: number; leaveMs: number };
  readonly #strict: boolean;
  readonly #machine: Partial<CallMachineConfig> | undefined;
  readonly #clock: Clock;
  readonly #planner: Planner;
  readonly #events = new EventEmitter();
  readonly #calls = new Map<string, LiveCall>();
  readonly #scenarioByCase = new Map<string, ScenarioName>();
  readonly #inflight = new Set<string>();
  #placeLock: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(opts: StandinAppOptions) {
    this.providers = opts.providers;
    const directory = opts.directory ?? loadDirectory();
    const cap = opts.dailyCallCap;
    this.directory = cap === undefined ? directory : directory.map((b) => ({ ...b, dailyCap: cap }));
    this.#loadAliases();
    this.#defaultUserName = opts.defaultUserName ?? 'Mahal';
    this.#speeds = { talk: 2, hold: 30, handoff: 1, ...opts.speeds };
    this.#join = { speakMs: opts.join?.speakMs ?? 2500, leaveMs: opts.join?.leaveMs ?? 9000 };
    this.#strict = opts.strictCallingHours ?? false;
    this.#machine = opts.machine;
    this.#clock = opts.clock ?? systemClock;
    this.#planner =
      opts.planner ?? (opts.providers.llm instanceof ScriptedLlmProvider ? new ScriptedPlanner() : new LlmPlanner(opts.providers.llm));
    this.#events.setMaxListeners(0);
  }

  #loadAliases(): void {
    try {
      const file = BusinessDirectoryFileSchema.parse(JSON.parse(readFileSync(DEFAULT_DIRECTORY_URL, 'utf8')));
      for (const b of file.businesses) this.#aliases.set(b.id, b.aliases ?? []);
    } catch {
      // aliases are a convenience; names and ids still resolve
    }
  }

  get repo() {
    return this.providers.repo;
  }

  /** Subscribe to case / call changes (resource-updated notifications). */
  onChange(cb: (e: ChangeEvent) => void): () => void {
    this.#events.on('change', cb);
    return () => this.#events.off('change', cb);
  }

  #emit(e: ChangeEvent): void {
    try {
      this.#events.emit('change', e);
    } catch {
      // listeners must not break a call
    }
  }

  /** Starts the follow-up ticker (spec S6). */
  startFollowups(intervalMs: number): void {
    this.providers.scheduler.start(async (job) => {
      await this.runFollowupJob(job);
    }, intervalMs);
  }

  /**
   * Stops the ticker and ends live calls, waiting (up to `timeoutMs`) for each
   * call's terminal write so no row is left non-terminal. Does not close the
   * providers; call this before closing them.
   */
  async close(timeoutMs = 2000): Promise<void> {
    this.#closed = true;
    this.providers.scheduler.stop();
    const pending: Promise<unknown>[] = [];
    for (const c of this.#calls.values()) {
      if (c.final === undefined) {
        if (!isTerminal(c.session.state)) void c.session.end('server_shutdown').catch(() => undefined);
        pending.push(c.finished);
      }
    }
    if (pending.length > 0) {
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(pending), new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
      if (t !== undefined) clearTimeout(t);
    }
    for (const c of this.#calls.values()) {
      c.paced.stop();
      c.carrier?.close();
    }
  }

  /**
   * A call row that is not terminal, has no live session in this process and
   * is not being set up right now was left behind by a previous process
   * (crash, kill -9, redeploy). Mark it FAILED (server_restart) and release
   * its case so it can be called again. Returns the repaired row, or the row
   * unchanged when it is not orphaned. Never throws on the case update.
   */
  async #repairOrphan(call: Call): Promise<Call> {
    if (isTerminal(call.state) || this.#calls.has(call.id) || this.#inflight.has(call.caseId)) return call;
    const endedAt = this.#clock.now().toISOString();
    const fixed = await this.repo.updateCall({ ...call, state: 'FAILED', failureReason: 'server_restart', endedAt });
    try {
      const kase = await this.repo.getCase(call.caseId);
      if (kase !== undefined && (kase.status === 'calling' || kase.status === 'awaiting_user')) {
        const others = (await this.repo.listCallsByCase(kase.id)).filter((c) => c.id !== call.id && !isTerminal(c.state));
        if (others.length === 0) {
          const status: CaseStatus = kase.promises.length > 0 ? 'promised' : 'ready';
          await this.repo.updateCase({ ...kase, status, updatedAt: endedAt });
        }
      }
    } catch {
      // the call row is fixed; the case is repaired on the next pass
    }
    this.#emit({ caseId: call.caseId, callId: call.id });
    return fixed;
  }

  /** Startup recovery: repairs every call orphaned by a previous process. Returns how many. */
  async recoverOrphanedCalls(): Promise<number> {
    let n = 0;
    for (const kase of await this.repo.listCases()) {
      for (const call of await this.repo.listCallsByCase(kase.id)) {
        if (isTerminal(call.state)) continue;
        const fixed = await this.#repairOrphan(call);
        if (fixed.state !== call.state) n++;
      }
    }
    return n;
  }

  /* ------------------------------------------------------------------ */
  /* Lookups                                                             */
  /* ------------------------------------------------------------------ */

  resolveBusiness(name: string): Business | undefined {
    const n = normalizeName(name);
    if (n.length === 0) return undefined;
    const candidates = this.directory.filter((b) => b.optOut !== true);
    const names = (b: Business): string[] => [b.name, b.id, ...(this.#aliases.get(b.id) ?? [])].map(normalizeName);
    return (
      candidates.find((b) => names(b).includes(n)) ??
      candidates.find((b) => names(b).some((x) => x.length >= 4 && (n.includes(x) || x.includes(n))))
    );
  }

  #business(id: string): Business | undefined {
    return this.directory.find((b) => b.id === id);
  }

  async #case(caseId: string): Promise<Case> {
    const c = await this.repo.getCase(caseId);
    if (c === undefined) throw new ToolFailure('not_found', `case ${caseId} not found`);
    return c;
  }

  #view(c: Case): CaseView {
    return caseView(c, this.#business(c.businessId));
  }

  #buildFact(f: FactInputLike, source: FactSource): CaseFact {
    const label = clip(f.label ?? labelFromKey(f.key), 200);
    const tier = assignTier({ key: f.key, label, value: f.value });
    return CaseFactSchema.parse({
      key: f.key,
      label,
      value: f.value,
      tier,
      approved: tier === 'share' || (tier === 'confirm' && f.approve === true),
      source,
    });
  }

  #merge(facts: readonly CaseFact[], add: readonly CaseFact[]): CaseFact[] {
    const byKey = new Map<string, CaseFact>();
    for (const f of facts) byKey.set(f.key, f);
    for (const a of add) {
      byKey.delete(a.key);
      byKey.set(a.key, a);
    }
    return [...byKey.values()];
  }

  #validCase(c: Case): Case {
    const r = CaseSchema.safeParse(c);
    if (!r.success) throw new ToolFailure('invalid_input', 'a fact key must not contain a secret value; use a plain key such as "otp"');
    return r.data;
  }

  /* ------------------------------------------------------------------ */
  /* Cases                                                               */
  /* ------------------------------------------------------------------ */

  async openCase(args: OpenCaseArgs, elicit?: Elicitor): Promise<OpenCaseOutput> {
    const business = this.resolveBusiness(args.businessName);
    if (business === undefined) {
      const known = this.directory.filter((b) => b.optOut !== true).map((b) => b.name);
      throw new ToolFailure('not_allowlisted', `"${clip(args.businessName, 80)}" is not in the Stand-In directory. Known businesses: ${known.join(', ')}.`);
    }
    let facts = this.#merge([], args.facts.map((f) => this.#buildFact(f, 'user')));
    let missing = missingFacts(business, facts);
    if (missing.length > 0 && elicit !== undefined) {
      const answers = await elicit(missing, business).catch(() => undefined);
      if (answers !== undefined) {
        const add: CaseFact[] = [];
        for (const m of missing) {
          const v = answers[m.key];
          if (typeof v === 'string' && v.trim().length > 0) // The user typed it into a form that says it is needed for this call: that is approval for this case.
          add.push(this.#buildFact({ key: m.key, label: m.label, value: v.trim().slice(0, 2000), approve: true }, 'elicited'));
        }
        facts = this.#merge(facts, add);
        missing = missingFacts(business, facts);
      }
    }
    const now = this.#clock.now().toISOString();
    const userName = args.userName ?? this.#defaultUserName;
    const draft: Case = {
      id: `case-${randomUUID()}`,
      userName,
      businessId: business.id,
      // Masked at write: a goal like "my OTP is 482913" never gets stored in clear.
      goal: clip(maskText(args.goal, facts), 2000),
      desiredOutcome: args.desiredOutcome,
      facts,
      status: missing.length === 0 ? 'ready' : 'draft',
      promises: [],
      calls: [],
      createdAt: now,
      updatedAt: now,
    };
    const saved = await this.repo.createCase(this.#validCase(draft));
    this.#scenarioByCase.set(saved.id, args.scenario ?? pickScenario(args.goal, args.desiredOutcome));
    this.#emit({ caseId: saved.id });
    return { case: this.#view(saved), missingFacts: missing };
  }

  async updateCaseFact(args: { caseId: string; key: string; value: string; label?: string | undefined; approve?: boolean | undefined }): Promise<UpdateCaseFactOutput> {
    const kase = await this.#case(args.caseId);
    const existing = kase.facts.find((f) => f.key === args.key);
    const fact = this.#buildFact({ key: args.key, value: args.value, label: args.label ?? existing?.label, approve: args.approve }, 'user');
    const facts = this.#merge(kase.facts, [fact]);
    const business = this.#business(kase.businessId);
    const missing = business === undefined ? [] : missingFacts(business, facts);
    let status: CaseStatus = kase.status;
    if (status === 'draft' && missing.length === 0) status = 'ready';
    const next = this.#validCase({ ...kase, facts, status, updatedAt: this.#clock.now().toISOString() });
    const saved = await this.repo.updateCase(next);
    this.#emit({ caseId: saved.id });
    return { case: this.#view(saved), missingFacts: missing };
  }

  async getCase(caseId: string): Promise<GetCaseOutput> {
    const stored = await this.repo.listCallsByCase(caseId);
    const calls: Call[] = [];
    for (const c of stored) calls.push(await this.#repairOrphan(c));
    const kase = await this.#case(caseId);
    const business = this.#business(kase.businessId);
    const jobs = await this.providers.scheduler.list(caseId);
    const summaries = calls
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
      .map((c) => {
        const live = this.#calls.get(c.id);
        const state: CallState = live !== undefined ? live.session.state : c.state;
        const outcome = live?.session.snapshot().outcome ?? c.outcome;
        return {
          callId: c.id,
          state,
          startedAt: c.startedAt,
          ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}),
          ...(outcome !== undefined ? { outcome: this.#maskOutcome(outcome, kase.facts) } : {}),
          ...(c.failureReason !== undefined ? { failureReason: c.failureReason } : {}),
        };
      });
    const view = this.#view(kase);
    const missing = business === undefined ? [] : missingFacts(business, kase.facts);
    return {
      case: view,
      calls: summaries,
      followups: jobs.map(jobView),
      summary: this.#caseSummary(kase, business, summaries.at(-1), jobs, missing),
    };
  }

  async listCases(args: { status?: CaseStatus | undefined; limit?: number | undefined }): Promise<ListCasesOutput> {
    const all = await this.repo.listCases();
    const cases = all
      .filter((c) => args.status === undefined || c.status === args.status)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, args.limit ?? 20)
      .map((c) => this.#view(c));
    return { cases };
  }

  #maskOutcome(o: Outcome, facts: readonly CaseFact[]): Outcome {
    return { ...o, what: clip(maskText(o.what, facts), 2000) };
  }

  #caseSummary(
    kase: Case,
    business: Business | undefined,
    lastCall: { state: CallState; outcome?: Outcome; failureReason?: string } | undefined,
    jobs: Job[],
    missing: MissingFact[],
  ): string {
    const b = business?.name ?? kase.businessId;
    const promise = kase.promises.at(-1);
    const pendingJob = jobs.filter((j) => j.status === 'pending').sort((x, y) => Date.parse(x.runAt) - Date.parse(y.runAt))[0];
    let s: string;
    switch (kase.status) {
      case 'draft':
        s = `Your case with ${b} still needs: ${missing.map((m) => m.label).join(', ') || 'a few details'}.`;
        break;
      case 'ready':
        s = lastCall?.state === 'FAILED' ? `The last call to ${b} didn't get through. The case is ready to try again.` : `Your case with ${b} is ready to call.`;
        break;
      case 'calling':
      case 'awaiting_user':
        s = `I'm on a call with ${b} about this right now.`;
        break;
      case 'promised':
        s = promise !== undefined ? `${b} promised ${outcomeSentence(promise)}.` : `${b} made a commitment on the last call.`;
        if (pendingJob !== undefined) s += ` If it doesn't happen I'll call them again on ${fmtDate(pendingJob.runAt)}.`;
        break;
      case 'escalated':
        s = promise !== undefined ? `On the follow-up call ${b} escalated it: ${outcomeSentence(promise)}.` : `${b} escalated your case on the follow-up call.`;
        break;
      case 'resolved':
        s = `Your case with ${b} is resolved.`;
        break;
      case 'failed':
        s = `The last call to ${b} failed${lastCall?.failureReason !== undefined ? ` (${lastCall.failureReason.replace(/_/g, ' ')})` : ''}.`;
        break;
    }
    return clip(maskText(s, kase.facts), 1000);
  }

  /* ------------------------------------------------------------------ */
  /* Calls                                                               */
  /* ------------------------------------------------------------------ */

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

  async placeCall(args: { caseId: string; simulatedHourIst?: number | undefined }): Promise<PlaceCallOutput> {
    // A call orphaned by a previous process must not block the case for good.
    for (const c of await this.repo.listCallsByCase(args.caseId)) await this.#repairOrphan(c);
    const kase = await this.#case(args.caseId);
    const scenario = businessScenario(this.#scenarioByCase.get(kase.id) ?? pickScenario(kase.goal, kase.desiredOutcome), kase);
    const opts = args.simulatedHourIst === undefined ? {} : { simulatedHourIst: args.simulatedHourIst };
    const live = await this.#launch(kase, scenario, (svc) => svc.placeCall(kase.id, opts));
    return { callId: live.callId, caseId: kase.id, state: 'DIALING' };
  }

  /** Follow-up job handler (S6). Throws when the call cannot be placed (the job is then marked failed). */
  async runFollowupJob(job: Job): Promise<string> {
    const kase = await this.#case(job.caseId);
    const ticket = typeof job.payload.ticketId === 'string' ? job.payload.ticketId : undefined;
    const live = await this.#launch(kase, followupScenario(kase, ticket), (svc) => svc.runFollowup(job));
    return live.callId;
  }

  async #launch(kase: Case, scenario: FakeBusinessScenario, place: (svc: CallService) => Promise<PlaceCallResult>): Promise<LiveCall> {
    if (this.#closed) throw new ToolFailure('shutting_down', 'the server is shutting down');
    if (this.#inflight.has(kase.id)) throw new ToolFailure('case_not_ready', 'a call for this case is already in progress');
    this.#inflight.add(kase.id);
    let launched = false;
    try {
      return await this.#locked(async () => {
        const paced = new PacedScheduler({ rate: this.#speeds.talk });
        const wallStart = this.#clock.now().getTime();
        const clock: Clock = { now: () => new Date(wallStart + paced.now()) };
        let carrier: SimCarrier | undefined;
        const svc = new CallService({
          repo: this.repo,
          directory: this.directory,
          planner: this.#planner,
          clock,
          timers: paced,
          scheduler: this.providers.scheduler,
          strictCallingHours: this.#strict,
          ...(this.#machine !== undefined ? { machine: this.#machine } : {}),
          carrierFactory: () => {
            const fb = new FakeBusiness(scenario, { scheduler: paced, clock: () => clock.now() });
            carrier = new SimCarrier(fb, { directory: this.directory });
            return carrier;
          },
        });
        let r: PlaceCallResult;
        try {
          r = await place(svc);
        } catch (err) {
          paced.stop();
          throw new ToolFailure('call_setup_failed', `could not set up the call (${errName(err)})`);
        }
        if (!r.ok) {
          paced.stop();
          carrier?.close();
          throw new ToolFailure(r.code, r.message);
        }
        const business = r.session.business;
        const live: LiveCall = {
          callId: r.callId,
          caseId: kase.id,
          business,
          session: r.session,
          carrier,
          paced,
          clock,
          startedAt: clock.now().toISOString(),
          confirmIds: new Set(),
          userLines: [],
          finished: r.finished,
        };
        this.#remember(live);
        launched = true;
        r.session.onChange((s) => this.#onSnapshot(live, s));
        this.#onSnapshot(live, r.session.snapshot());
        void r.finished.then((fin) => {
          live.final = fin;
          this.#inflight.delete(kase.id);
          // Let the business finish its goodbye frames, then drop the timeline.
          live.paced.setTimer(() => {
            live.paced.stop();
            live.carrier?.close();
          }, 5000);
          this.#emit({ caseId: kase.id, callId: live.callId });
        });
        this.#emit({ caseId: kase.id, callId: live.callId });
        return live;
      });
    } finally {
      if (!launched) this.#inflight.delete(kase.id);
    }
  }

  #remember(live: LiveCall): void {
    this.#calls.set(live.callId, live);
    if (this.#calls.size <= MAX_LIVE_CALLS) return;
    for (const [id, c] of this.#calls) {
      if (this.#calls.size <= MAX_LIVE_CALLS) break;
      if (c.final !== undefined) this.#calls.delete(id);
    }
  }

  #onSnapshot(live: LiveCall, s: CallSessionSnapshot): void {
    const rate = s.state === 'HOLD' ? this.#speeds.hold : s.state === 'HANDOFF_PENDING' ? this.#speeds.handoff : this.#speeds.talk;
    if (!isTerminal(s.state)) live.paced.setRate(rate);
    this.#emit({ caseId: live.caseId, callId: live.callId });
  }

  #live(callId: string): LiveCall {
    const c = this.#calls.get(callId);
    if (c === undefined) throw new ToolFailure('not_found', `call ${callId} is not active on this server`);
    return c;
  }

  async #storedCall(callId: string): Promise<{ call: Call; kase: Case }> {
    const stored = await this.repo.getCall(callId);
    if (stored === undefined) throw new ToolFailure('not_found', `call ${callId} not found`);
    const call = await this.#repairOrphan(stored);
    return { call, kase: await this.#case(call.caseId) };
  }

  async callStatus(callId: string): Promise<CallStatusOutput> {
    const live = this.#calls.get(callId);
    if (live === undefined) return this.#storedStatus(callId);
    const kase = await this.#case(live.caseId);
    const snap = live.session.snapshot();
    const digest = digestEvents(live.session.events(), kase.facts, live.userLines);
    const pending = pendingView(snap.pendingQuestion, kase.facts, live.confirmIds);
    const followup = live.final?.followupJob;
    const out: CallStatusOutput = {
      callId,
      caseId: live.caseId,
      state: snap.state,
      holdSeconds: Math.max(0, Math.floor(snap.holdSeconds)),
      lastLines: digest.lines.slice(-4),
      digitsPressed: digest.digitsPressed,
      blockedCount: digest.blockedCount,
      injectionCount: digest.injectionCount,
      summary: callSummary(
        {
          businessName: live.business.name,
          state: snap.state,
          holdSeconds: snap.holdSeconds,
          digitsPressed: digest.digitsPressed,
          ...(pending !== undefined ? { pending } : {}),
          ...(snap.outcome !== undefined ? { outcome: snap.outcome } : {}),
          ...(snap.failureReason !== undefined ? { failureReason: snap.failureReason } : {}),
          ...(snap.failureMessage !== undefined ? { failureMessage: snap.failureMessage } : {}),
          ...(followup !== undefined ? { followupRunAt: followup.runAt } : {}),
        },
        kase.facts,
      ),
    };
    if (pending !== undefined) out.pendingQuestion = pending;
    if (snap.outcome !== undefined) out.outcome = this.#maskOutcome(snap.outcome, kase.facts);
    if (snap.failureReason !== undefined) out.failureReason = snap.failureReason;
    if (followup !== undefined) out.followupScheduled = { jobId: followup.id, runAt: followup.runAt };
    return out;
  }

  async #storedStatus(callId: string): Promise<CallStatusOutput> {
    const { call, kase } = await this.#storedCall(callId);
    const business = this.#business(call.businessId);
    const digest = digestEvents(await this.repo.listEvents(callId), kase.facts);
    const job = (await this.providers.scheduler.list(kase.id)).find((j) => j.payload.callId === callId);
    const out: CallStatusOutput = {
      callId,
      caseId: kase.id,
      state: call.state,
      holdSeconds: digest.holdSeconds,
      lastLines: digest.lines.slice(-4),
      digitsPressed: digest.digitsPressed,
      blockedCount: digest.blockedCount,
      injectionCount: digest.injectionCount,
      summary: callSummary(
        {
          businessName: business?.name ?? call.businessId,
          state: call.state,
          holdSeconds: digest.holdSeconds,
          digitsPressed: digest.digitsPressed,
          ...(call.outcome !== undefined ? { outcome: call.outcome } : {}),
          ...(call.failureReason !== undefined ? { failureReason: call.failureReason } : {}),
          ...(job !== undefined ? { followupRunAt: job.runAt } : {}),
        },
        kase.facts,
      ),
    };
    if (call.outcome !== undefined) out.outcome = this.#maskOutcome(call.outcome, kase.facts);
    if (call.failureReason !== undefined) out.failureReason = call.failureReason;
    if (job !== undefined) out.followupScheduled = { jobId: job.id, runAt: job.runAt };
    return out;
  }

  async transcript(callId: string): Promise<{ callId: string; caseId: string; lines: CallLine[] }> {
    const live = this.#calls.get(callId);
    if (live !== undefined) {
      const kase = await this.#case(live.caseId);
      return { callId, caseId: live.caseId, lines: digestEvents(live.session.events(), kase.facts, live.userLines).lines };
    }
    const { kase } = await this.#storedCall(callId);
    return { callId, caseId: kase.id, lines: digestEvents(await this.repo.listEvents(callId), kase.facts).lines };
  }

  async sendToCall(args: { callId: string; answer: string; approve?: boolean | undefined }): Promise<SendToCallOutput> {
    const live = this.#live(args.callId);
    const state = live.session.state;
    if (isTerminal(state)) return { callId: args.callId, ok: false, state, message: 'This call has already finished.' };
    const p = live.session.snapshot().pendingQuestion;
    if (p === undefined) return { callId: args.callId, ok: false, state, message: 'The business is not waiting on a question right now.' };
    if (p.kind === 'handoff') {
      return { callId: args.callId, ok: false, state, message: 'Only the account holder can answer this. Use handoff_to_user to join the call.' };
    }
    const r = await live.session.answerPending(args.answer, p.id, args.approve === undefined ? {} : { approve: args.approve });
    this.#emit({ caseId: live.caseId, callId: live.callId });
    if (r.ok) return { callId: args.callId, ok: true, state: r.state, message: 'Passed your answer on to the business.' };
    if (r.error.startsWith('confirm_required')) {
      live.confirmIds.add(p.id);
      return {
        callId: args.callId,
        ok: false,
        state: r.state,
        confirmRequired: true,
        message: 'That is a personal detail. Ask the user if it may be shared, then send it again with approve=true.',
      };
    }
    return { callId: args.callId, ok: false, state: r.state, message: clip(r.error, 500) };
  }

  async handoffToUser(args: { callId: string; accept: boolean }): Promise<HandoffToUserOutput> {
    const live = this.#live(args.callId);
    const state = live.session.state;
    if (state === 'HUMAN' && args.accept) return this.#takeOver(live);
    if (state === 'USER_ON_LINE' && !args.accept) {
      // The user hands the call back (after a take-over or a hand-off).
      const r = await live.session.userLeave();
      this.#emit({ caseId: live.caseId, callId: live.callId });
      return { callId: args.callId, ok: r.ok, state: r.state, message: r.ok ? "Okay, I'm back on the line and carrying on." : clip(r.error, 500) };
    }
    if (state !== 'HANDOFF_PENDING') {
      const message = isTerminal(state)
        ? 'This call has already finished.'
        : state === 'USER_ON_LINE'
          ? "You're already on the line."
          : `You can take over once a person is on the line (the call is ${state === 'HOLD' ? 'on hold' : state === 'IVR' ? 'in the phone menu' : state}).`;
      return { callId: args.callId, ok: false, state, message };
    }
    if (!args.accept) {
      const r = await live.session.declineHandoff();
      this.#emit({ caseId: live.caseId, callId: live.callId });
      return {
        callId: args.callId,
        ok: r.ok,
        state: r.state,
        message: r.ok ? `Okay. I'll tell ${live.business.name} you'll verify later, and carry on.` : clip(r.error, 500),
      };
    }
    const r = await live.session.acceptHandoff();
    if (r.ok) this.#simulateUserOnLine(live);
    this.#emit({ caseId: live.caseId, callId: live.callId });
    return {
      callId: args.callId,
      ok: r.ok,
      state: r.state,
      message: r.ok
        ? `You're on the line with ${live.business.name}. (Simulated: the account holder verifies directly, then hands back to Stand-In.)`
        : clip(r.error, 500),
    };
  }

  /** "Take over call" while a person is on the line (HUMAN -> USER_ON_LINE). */
  async #takeOver(live: LiveCall): Promise<HandoffToUserOutput> {
    const r = await live.session.takeOver();
    if (r.ok) this.#simulateUserOnLine(live, 'takeover');
    this.#emit({ caseId: live.caseId, callId: live.callId });
    return {
      callId: live.callId,
      ok: r.ok,
      state: r.state,
      message: r.ok
        ? `You've taken over the call with ${live.business.name}. (Simulated: the account holder speaks directly, then hands back to Stand-In.)`
        : clip(r.error, 500),
    };
  }

  /**
   * The sim stands in for the account holder: they speak to the business
   * directly (never through the agent, its log or an LLM), then leave so the
   * agent carries on. The transcript only records that they spoke.
   */
  #simulateUserOnLine(live: LiveCall, why: 'handoff' | 'takeover' = 'handoff'): void {
    const carrier = live.carrier;
    live.paced.setTimer(() => {
      if (live.session.state !== 'USER_ON_LINE' || carrier === undefined) return;
      if (why === 'takeover') {
        live.userLines.push({ speaker: 'user', text: '[account holder spoke directly with the agent]', at: live.clock.now().toISOString() });
        void carrier.userSay("Hi, this is the account holder. I'm just checking in; my assistant will carry on from here.").catch(() => undefined);
        this.#emit({ caseId: live.caseId, callId: live.callId });
        return;
      }
      live.userLines.push({ speaker: 'user', text: '[account holder verified directly with the agent]', at: live.clock.now().toISOString() });
      // A stand-in code: the server never reads the user's real never-tier values aloud.
      void carrier.userSay('Yes, this is the account holder. The code on my phone is seven three zero five one nine.').catch(() => undefined);
      this.#emit({ caseId: live.caseId, callId: live.callId });
    }, this.#join.speakMs);
    live.paced.setTimer(() => {
      if (live.session.state !== 'USER_ON_LINE') return;
      void live.session.userLeave().catch(() => undefined);
    }, this.#join.leaveMs);
  }

  async endCall(callId: string): Promise<EndCallOutput> {
    const live = this.#calls.get(callId);
    if (live !== undefined && !isTerminal(live.session.state)) {
      await live.session.end('user_ended');
      await Promise.race([live.finished, new Promise((r) => setTimeout(r, 5000).unref())]);
    }
    const st = await this.callStatus(callId);
    return {
      callId,
      state: st.state,
      ...(st.outcome !== undefined ? { outcome: st.outcome } : {}),
      ...(st.failureReason !== undefined ? { failureReason: st.failureReason } : {}),
      summary: st.summary,
    };
  }

  async scheduleFollowup(args: { caseId: string; at?: string | undefined }): Promise<ScheduleFollowupOutput> {
    const kase = await this.#case(args.caseId);
    const sched = this.providers.scheduler;
    const pending = (await sched.list(kase.id)).filter((j) => j.status === 'pending');
    const promise = kase.promises.at(-1);
    if (args.at === undefined) {
      const existing = pending.sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))[0];
      if (existing !== undefined) return { job: jobView(existing) };
      if (promise === undefined) throw new ToolFailure('no_promise', 'Nothing to follow up yet: no promise has been recorded on this case.');
    }
    let runAt: string;
    if (args.at !== undefined) {
      runAt = new Date(args.at).toISOString();
    } else {
      const due = promise?.dueBy === undefined ? undefined : parseDueBy(promise.dueBy);
      const now = this.#clock.now().getTime();
      const base = due === undefined || due.getTime() <= now ? now + 2 * DAY_MS : due.getTime();
      runAt = new Date(base + DAY_MS).toISOString();
    }
    for (const j of pending) await sched.cancel(j.id);
    const payload: Record<string, unknown> = {};
    if (promise?.ticketId !== undefined) payload.ticketId = promise.ticketId;
    if (promise?.callId !== undefined) payload.callId = promise.callId;
    const job = await sched.schedule({ id: `job-${randomUUID()}`, kind: 'followup', caseId: kase.id, runAt, payload });
    this.#emit({ caseId: kase.id });
    return { job: jobView(job) };
  }

  /** Never-tier values of every case (for masking text bound for an LLM or TTS). */
  async neverFacts(): Promise<CaseFact[]> {
    const cases = await this.repo.listCases();
    return cases.flatMap((c) => c.facts.filter((f) => f.tier === 'never'));
  }

  /** Test/diagnostic helper: the live session for a call, if any. */
  liveSession(callId: string): CallSession | undefined {
    return this.#calls.get(callId)?.session;
  }

  /** Remember an explicit scenario for a case (e.g. autoplay). */
  setScenario(caseId: string, scenario: ScenarioName): void {
    this.#scenarioByCase.set(caseId, scenario);
  }
}
