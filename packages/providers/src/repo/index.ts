/**
 * Repo adapters (spec 2.1). Offline: core's SqliteRepo. AWS: DynamoRepo is an
 * M6 stretch — it compiles and satisfies Repo, but every method throws.
 */
import type { Call, CallEvent, Case, Job, Repo } from '@standin/core';
import { SqliteRepo, type SqliteRepoOptions } from '@standin/core/sqlite';
import { z } from 'zod';

export { SqliteRepo, type SqliteRepoOptions };

export const SqliteRepoConfigSchema = z.object({
  /** File path, or ':memory:' (default; used by tests). */
  path: z.string().min(1).default(':memory:'),
});
export type SqliteRepoConfig = z.input<typeof SqliteRepoConfigSchema>;

export function createSqliteRepo(config: SqliteRepoConfig = {}): SqliteRepo {
  const c = SqliteRepoConfigSchema.parse(config);
  return new SqliteRepo({ filename: c.path });
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what}: not implemented (M6 stretch)`);
    this.name = 'NotImplementedError';
  }
}

export const DynamoRepoConfigSchema = z.object({
  region: z.string().min(1),
  table: z.string().min(1).default('standin'),
});
export type DynamoRepoConfig = z.input<typeof DynamoRepoConfigSchema>;

/** DynamoDB single-table repo — stub until M6. */
export class DynamoRepo implements Repo {
  readonly region: string;
  readonly table: string;

  constructor(config: DynamoRepoConfig) {
    const c = DynamoRepoConfigSchema.parse(config);
    this.region = c.region;
    this.table = c.table;
  }

  #ni(method: string): never {
    throw new NotImplementedError(`DynamoRepo.${method}`);
  }

  close(): void {}

  async createCase(_c: Case): Promise<Case> {
    return this.#ni('createCase');
  }
  async getCase(_id: string): Promise<Case | undefined> {
    return this.#ni('getCase');
  }
  async updateCase(_c: Case): Promise<Case> {
    return this.#ni('updateCase');
  }
  async listCases(): Promise<Case[]> {
    return this.#ni('listCases');
  }
  async deleteCase(_id: string): Promise<boolean> {
    return this.#ni('deleteCase');
  }
  async createCall(_c: Call): Promise<Call> {
    return this.#ni('createCall');
  }
  async getCall(_id: string): Promise<Call | undefined> {
    return this.#ni('getCall');
  }
  async updateCall(_c: Call): Promise<Call> {
    return this.#ni('updateCall');
  }
  async listCallsByCase(_caseId: string): Promise<Call[]> {
    return this.#ni('listCallsByCase');
  }
  async countCallsForBusiness(_businessId: string, _fromIso: string, _toIso: string): Promise<number> {
    return this.#ni('countCallsForBusiness');
  }
  async appendEvent(_event: CallEvent): Promise<CallEvent> {
    return this.#ni('appendEvent');
  }
  async listEvents(_callId: string): Promise<CallEvent[]> {
    return this.#ni('listEvents');
  }
  async headHash(_callId: string): Promise<string | undefined> {
    return this.#ni('headHash');
  }
  async putJob(_job: Job): Promise<Job> {
    return this.#ni('putJob');
  }
  async getJob(_id: string): Promise<Job | undefined> {
    return this.#ni('getJob');
  }
  async dueJobs(_nowIso: string, _limit?: number): Promise<Job[]> {
    return this.#ni('dueJobs');
  }
  async listJobs(_caseId?: string): Promise<Job[]> {
    return this.#ni('listJobs');
  }
  async setJobStatus(_id: string, _status: Job['status']): Promise<boolean> {
    return this.#ni('setJobStatus');
  }
}
