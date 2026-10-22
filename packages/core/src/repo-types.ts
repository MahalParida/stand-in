/**
 * Persistence interfaces (spec 2.1). Pure types plus RepoError: safe to import
 * from browser bundles. The SQLite implementation lives behind the
 * '@standin/core/sqlite' subpath; the DynamoDB one in packages/providers.
 */
import type { Job } from './interfaces.js';
import type { Call, CallEvent, Case } from './types.js';

export class RepoError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'chain_violation',
    message: string,
  ) {
    super(message);
    this.name = 'RepoError';
  }
}

export interface CaseRepo {
  createCase(c: Case): Promise<Case>;
  getCase(id: string): Promise<Case | undefined>;
  /** Replaces the stored case; throws RepoError('not_found') if absent. */
  updateCase(c: Case): Promise<Case>;
  listCases(): Promise<Case[]>;
  /** Per-case delete (spec 13 transcript privacy): removes the case, its calls and their events. */
  deleteCase(id: string): Promise<boolean>;
}

export interface CallRepo {
  createCall(c: Call): Promise<Call>;
  getCall(id: string): Promise<Call | undefined>;
  updateCall(c: Call): Promise<Call>;
  listCallsByCase(caseId: string): Promise<Call[]>;
  /** Calls to `businessId` with startedAt in [fromIso, toIso). Used for the daily cap. */
  countCallsForBusiness(businessId: string, fromIso: string, toIso: string): Promise<number>;
}

export interface EventRepo {
  /**
   * Append a sealed event. Rejects (RepoError 'chain_violation') unless
   * `event.prevHash` equals the current head of that call's chain.
   */
  appendEvent(event: CallEvent): Promise<CallEvent>;
  listEvents(callId: string): Promise<CallEvent[]>;
  /** Head hash of a call's chain, or undefined if no events yet. */
  headHash(callId: string): Promise<string | undefined>;
}

/** Durable job store backing the local Scheduler (implementation of the ticker in M5). */
export interface JobRepo {
  putJob(job: Job): Promise<Job>;
  getJob(id: string): Promise<Job | undefined>;
  /** Pending jobs with runAt <= nowIso, oldest first. */
  dueJobs(nowIso: string, limit?: number): Promise<Job[]>;
  listJobs(caseId?: string): Promise<Job[]>;
  setJobStatus(id: string, status: Job['status']): Promise<boolean>;
}

export interface Repo extends CaseRepo, CallRepo, EventRepo, JobRepo {
  close(): void;
}
