/**
 * Runs one golden scenario end to end, deterministically, on sim time:
 * FakeBusiness + SimCarrier + CallSession + CallService + SQLite (memory),
 * with a scripted user answering hand-offs and mid-call questions.
 */
import {
  CallService,
  GarbageInjectingLlm,
  LlmPlanner,
  NotAllowlistedError,
  ScriptedPlanner,
  SimCarrier,
  createPolicyLlm,
  loadDirectory,
  type CallFinished,
  type CallSession,
  type CallSessionSnapshot,
  type PendingQuestion,
  type Planner,
} from '@standin/call-agent';
import {
  canPlaceCall,
  isTerminal,
  type Business,
  type CallEvent,
  type CallState,
  type Case,
  type CaseFact,
  type ChatRequest,
  type Clock,
  type Job,
  type LlmProvider,
} from '@standin/core';
import { assignTier } from '@standin/disclosure-guard';
import {
  FakeBusiness,
  VirtualScheduler,
  presetScenario,
  type BusinessReport,
  type FakeBusinessScenarioInput,
  type TranscriptLine as BusinessTranscriptLine,
} from '@standin/fake-business';
import { LocalScheduler, createSqliteRepo } from '@standin/providers';
import type { BusinessSpec, PolicyAttempt, Scenario } from './scenarios.js';
import { seedOverrides, seedVariation, type SeedVariation } from './seeds.js';

export type LlmMode = 'scripted' | 'localllm' | 'bedrock' | 'openai';

/** Records every request sent to an LLM (for the never-tier leak check). */
export class RecordingLlm implements LlmProvider {
  readonly name: string;
  readonly requests: ChatRequest[] = [];
  readonly #inner: LlmProvider;
  constructor(inner: LlmProvider) {
    this.#inner = inner;
    this.name = inner.name;
  }
  chat(req: ChatRequest): Promise<string> {
    this.requests.push(structuredClone(req));
    return this.#inner.chat(req);
  }
}

export interface PendingSeen {
  state: CallState;
  pending: PendingQuestion;
}

export interface CallRun {
  callId: string;
  snapshot: CallSessionSnapshot;
  finished?: CallFinished;
  /** Events as stored in the repo (what an attacker with the DB would see). */
  storedEvents: CallEvent[];
  /** In-memory events from the session's own log. */
  sessionEvents: CallEvent[];
  sessionVerified: boolean;
  transcript: { who: string; text: string }[];
  /** Exactly what went to the line / TTS. */
  spoken: string[];
  report: BusinessReport;
  businessTranscript: readonly BusinessTranscriptLine[];
  pendingSeen: PendingSeen[];
  timedOut: boolean;
}

export interface AttemptResult {
  attempt: PolicyAttempt;
  outcome: 'refused' | 'allowed';
  code?: string;
  message: string;
  dialed: number;
}

export interface ScenarioRun {
  scenario: Scenario;
  seed: number;
  variation: SeedVariation;
  llm: LlmMode;
  userName: string;
  neverValues: string[];
  calls: CallRun[];
  attempts: AttemptResult[];
  jobs: Job[];
  caseAfter?: Case;
  llmRequests: ChatRequest[];
  crashed?: string;
}

export interface RunOptions {
  seed: number;
  llm: LlmMode;
  /** Provider for localllm/bedrock modes (already constructed). */
  llmProvider?: LlmProvider;
}

const MAX_SIM_MS = 3 * 60 * 60 * 1000;

/** The business for one scenario run: preset, then the seed's variation, then the scenario file's own overrides. */
function businessScenario(spec: BusinessSpec, seed: number, secrets: string[]): FakeBusinessScenarioInput {
  const own = spec.overrides as FakeBusinessScenarioInput;
  const varied = seedOverrides(spec.preset, seedVariation(seed));
  const merged: FakeBusinessScenarioInput = { ...varied, ...own };
  for (const k of ['outcome', 'followup', 'adversarial', 'timing'] as const) {
    const a = varied[k];
    const b = own[k];
    if (a !== undefined && b !== undefined) Object.assign(merged, { [k]: { ...a, ...b } });
  }
  return presetScenario(spec.preset, { ...merged, seed, secrets });
}

function buildFacts(sc: Scenario): CaseFact[] {
  return (sc.case?.facts ?? []).map((f) => {
    const tier = assignTier({ key: f.key, label: f.label, value: f.value });
    return { key: f.key, label: f.label, value: f.value, tier, approved: tier === 'confirm' ? f.approved : tier === 'share', source: 'user' };
  });
}

function makePlanner(sc: Scenario, opts: RunOptions, recorder: { llm?: RecordingLlm }): Planner {
  if (opts.llm === 'scripted' && !sc.planner.viaLlm && sc.planner.garbage === undefined) return new ScriptedPlanner();
  const base: LlmProvider = opts.llm === 'scripted' ? createPolicyLlm() : (opts.llmProvider ?? createPolicyLlm());
  const rec = new RecordingLlm(base);
  recorder.llm = rec;
  const llm = sc.planner.garbage === undefined ? rec : new GarbageInjectingLlm(rec, sc.planner.garbage);
  // A real model samples with the seed's temperature and seed (LocalLlm honours `seed`).
  if (opts.llm === 'scripted') return new LlmPlanner(llm);
  const v = seedVariation(opts.seed);
  return new LlmPlanner(llm, { temperature: v.temperature, seed: opts.seed });
}

export async function runScenario(sc: Scenario, opts: RunOptions): Promise<ScenarioRun> {
  const facts = buildFacts(sc);
  const neverValues = facts.filter((f) => f.tier === 'never').map((f) => f.value);
  const userName = sc.case?.userName ?? 'Asha Rao';
  const run: ScenarioRun = {
    scenario: sc,
    seed: opts.seed,
    variation: seedVariation(opts.seed),
    llm: opts.llm,
    userName,
    neverValues,
    calls: [],
    attempts: [],
    jobs: [],
    llmRequests: [],
  };

  const scheduler = new VirtualScheduler();
  const base = Date.parse(sc.clockStart);
  let offset = 0;
  const clock: Clock = { now: () => new Date(base + offset + scheduler.now()) };
  const repo = createSqliteRepo();
  const directory = loadDirectory();
  const jobs = new LocalScheduler({ repo, clock });
  const recorder: { llm?: RecordingLlm } = {};

  // Businesses for call 1 (and the follow-up call), sharing sim time.
  const businesses: FakeBusiness[] = [];
  const businessClock = (): Date => clock.now();
  if (sc.business !== undefined) {
    businesses.push(new FakeBusiness(businessScenario(sc.business, opts.seed, neverValues), { scheduler, clock: businessClock }));
  }
  if (sc.followup !== undefined) {
    businesses.push(new FakeBusiness(businessScenario(sc.followup.business, opts.seed, neverValues), { scheduler, clock: businessClock }));
  }
  const carriers: SimCarrier[] = [];
  let dialAttempts = 0;
  // Deterministic IDs: each scenario runs on its own in-memory repo, so a per-run counter cannot collide.
  let idSeq = 0;

  const service = new CallService({
    repo,
    newId: (prefix) => `${prefix}-${String(++idSeq).padStart(4, '0')}`,
    directory,
    clock,
    timers: scheduler,
    scheduler: jobs,
    planner: makePlanner(sc, opts, recorder),
    carrierFactory: (_b: Business, ctx) => {
      dialAttempts++;
      const fb = businesses[ctx.attempt - 1] ?? businesses.at(-1);
      if (fb === undefined) throw new Error('scenario has no business for this call');
      const c = new SimCarrier(fb, { directory });
      carriers.push(c);
      return c;
    },
  });

  const newCase = async (id: string, businessId?: string): Promise<Case> => {
    const now = clock.now().toISOString();
    const c: Case = {
      id,
      userName,
      businessId: businessId ?? sc.case?.businessId ?? 'bharatnet-broadband',
      goal: sc.case?.goal ?? 'test call',
      desiredOutcome: sc.case?.desiredOutcome ?? 'info',
      facts,
      status: 'ready',
      promises: [],
      calls: [],
      createdAt: now,
      updatedAt: now,
    };
    return repo.createCase(c);
  };

  try {
    /* ---------------- S7-style policy attempts ---------------- */
    if (sc.policyAttempts !== undefined) {
      let n = 0;
      for (const a of sc.policyAttempts) {
        n++;
        const before = dialAttempts;
        if (a.clockAt !== undefined) offset = Date.parse(a.clockAt) - base - scheduler.now();
        if (a.kind === 'policy_only') {
          const c = await newCase(`case-policy-${n}`, a.businessId);
          const d = canPlaceCall(c, directory, clock, a.simulatedHourIst === undefined ? {} : { simulatedHourIst: a.simulatedHourIst });
          run.attempts.push({
            attempt: a,
            outcome: d.ok ? 'allowed' : 'refused',
            ...(d.ok ? {} : { code: d.code }),
            message: d.ok ? `allowed for ${d.business.id}` : d.message,
            dialed: 0,
          });
        } else if (a.kind === 'raw_dial') {
          const fb = new FakeBusiness(presetScenario('happy-refund', { seed: opts.seed }), { scheduler, clock: businessClock });
          const carrier = new SimCarrier(fb, { directory });
          let res: AttemptResult;
          try {
            await carrier.dial(a.number ?? '', { callId: `raw-${n}` });
            res = { attempt: a, outcome: 'allowed', message: 'dialed', dialed: carrier.dialed.length };
          } catch (err) {
            const code = err instanceof NotAllowlistedError ? 'NotAllowlistedError' : err instanceof Error ? err.name : 'error';
            res = { attempt: a, outcome: 'refused', code, message: err instanceof Error ? err.message : 'refused', dialed: carrier.dialed.length };
          }
          run.attempts.push(res);
          carrier.close();
        } else {
          const c = await newCase(`case-policy-${n}`, a.businessId);
          const r = await service.placeCall(c.id, a.simulatedHourIst === undefined ? {} : { simulatedHourIst: a.simulatedHourIst });
          if (r.ok) {
            await r.session.end('eval_policy_attempt');
            await r.finished;
            run.attempts.push({ attempt: a, outcome: 'allowed', message: 'call placed', dialed: dialAttempts - before });
          } else {
            run.attempts.push({ attempt: a, outcome: 'refused', code: r.code, message: r.message, dialed: dialAttempts - before });
          }
        }
        offset = 0;
      }
    }

    /* ---------------- the call (and S6 follow-up) ---------------- */
    if (sc.business !== undefined) {
      const kase = await newCase('case-1');
      const first = await service.placeCall(kase.id, sc.placeCall);
      if (!first.ok) throw new Error(`place_call refused: ${first.code}: ${first.message}`);
      run.calls.push(await driveCall(sc, first.session, first.finished, scheduler, carriers.at(-1), repo));

      if (sc.followup !== undefined) {
        const due = await jobs.list(kase.id);
        const job = due.find((j) => j.status === 'pending');
        if (job === undefined) throw new Error('no follow-up job was scheduled after the first call');
        offset = Math.max(offset, Date.parse(job.runAt) + 60_000 - base - scheduler.now());
        let followupDone: Promise<CallRun> | undefined;
        await jobs.tick(async (j) => {
          const r = await service.runFollowup(j, sc.placeCall);
          if (!r.ok) throw new Error(`follow-up refused: ${r.code}`);
          followupDone = driveCall(sc, r.session, r.finished, scheduler, carriers.at(-1), repo);
        });
        if (followupDone === undefined) throw new Error('follow-up job did not run');
        run.calls.push(await followupDone);
      }
      run.caseAfter = await repo.getCase(kase.id);
      run.jobs = await jobs.list();
    }
  } catch (err) {
    run.crashed = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } finally {
    run.llmRequests = recorder.llm?.requests.slice() ?? [];
    for (const c of carriers) c.close();
    repo.close();
  }
  return run;
}

/** Drive one call on sim time with the scripted user until it ends. */
async function driveCall(
  sc: Scenario,
  session: CallSession,
  finished: Promise<CallFinished>,
  scheduler: VirtualScheduler,
  carrier: SimCarrier | undefined,
  repo: ReturnType<typeof createSqliteRepo>,
): Promise<CallRun> {
  if (carrier === undefined) throw new Error('no carrier for call');
  const business = carrier.business;
  const pendingSeen: PendingSeen[] = [];
  const handled = new Set<string>();
  const work = new Set<Promise<unknown>>();
  let bridged = false;
  const track = (p: Promise<unknown>): void => {
    const q = p.catch(() => undefined).finally(() => work.delete(q));
    work.add(q);
  };
  const later = (ms: number, fn: () => Promise<unknown>): void => {
    scheduler.setTimer(() => track(fn()), ms);
  };

  const unsubscribe = session.onChange((s) => {
    const p = s.pendingQuestion;
    if (p !== undefined && !pendingSeen.some((x) => x.pending.id === p.id)) pendingSeen.push({ state: s.state, pending: p });
    if (s.state === 'HANDOFF_PENDING' && p?.kind === 'handoff' && !handled.has(p.id)) {
      handled.add(p.id);
      if (sc.user.onHandoff === 'accept') later(sc.user.respondAfterMs, () => session.acceptHandoff());
      if (sc.user.onHandoff === 'decline') later(sc.user.respondAfterMs, () => session.declineHandoff());
    }
    if (s.state === 'USER_ON_LINE' && !bridged) {
      bridged = true;
      const speak = sc.user.speakOnBridge;
      if (speak !== undefined) later(sc.user.speakAfterMs, () => carrier.userSay(speak));
      later(sc.user.leaveAfterMs, () => session.userLeave());
    }
    if (s.state !== 'USER_ON_LINE') bridged = false;
    if (p?.kind === 'question' && !handled.has(p.id)) {
      handled.add(p.id);
      const entry = Object.entries(sc.user.answers).find(([k]) => p.label.toLowerCase().includes(k.toLowerCase()));
      if (entry !== undefined) later(sc.user.respondAfterMs, () => session.answerPending(entry[1], p.id));
    }
  });

  const res = await scheduler.runUntilIdle({
    settle: async () => {
      await business.settled();
      await session.idle();
      while (work.size > 0) await Promise.all([...work]);
      await session.idle();
    },
    until: () => isTerminal(session.state),
    maxSimMs: MAX_SIM_MS,
  });
  let timedOut = false;
  if (!isTerminal(session.state)) {
    timedOut = true;
    await session.end('eval_timeout');
  }
  const fin = await finished;
  unsubscribe();
  void res;
  return {
    callId: session.callId,
    snapshot: fin.snapshot,
    finished: fin,
    storedEvents: await repo.listEvents(session.callId),
    sessionEvents: session.events(),
    sessionVerified: session.verify().ok,
    transcript: session.transcript(),
    spoken: carrier.spoken.slice(),
    report: business.report(),
    businessTranscript: business.transcript().slice(),
    pendingSeen,
    timedOut,
  };
}
