/**
 * Local follow-up scheduler (spec 2.1: sqlite `jobs` table + in-process ticker).
 * Interface-compatible stub; retries/backoff and the follow-up handler land in M5.
 *
 * Backed by any JobRepo: core's SqliteRepo, or InMemoryJobRepo below.
 */
import { JobSchema, systemClock, type Clock, type Job, type JobRepo, type Scheduler } from '@standin/core';
import { z } from 'zod';

const ScheduleInputSchema = JobSchema.pick({ id: true, kind: true, caseId: true, runAt: true, payload: true });
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

export type JobHandler = (job: Job) => Promise<void>;

/** In-memory JobRepo, for tests and for wiring without a database. */
export class InMemoryJobRepo implements JobRepo {
  readonly #jobs = new Map<string, Job>();

  async putJob(job: Job): Promise<Job> {
    const v = JobSchema.parse(job);
    this.#jobs.set(v.id, v);
    return v;
  }
  async getJob(id: string): Promise<Job | undefined> {
    return this.#jobs.get(id);
  }
  async dueJobs(nowIso: string, limit = 50): Promise<Job[]> {
    const now = Date.parse(nowIso);
    return this.#sorted()
      .filter((j) => j.status === 'pending' && Date.parse(j.runAt) <= now)
      .slice(0, limit);
  }
  async listJobs(caseId?: string): Promise<Job[]> {
    return this.#sorted().filter((j) => caseId === undefined || j.caseId === caseId);
  }
  async setJobStatus(id: string, status: Job['status']): Promise<boolean> {
    const j = this.#jobs.get(id);
    if (j === undefined) return false;
    this.#jobs.set(id, { ...j, status });
    return true;
  }
  #sorted(): Job[] {
    return [...this.#jobs.values()].sort(
      (a, b) => Date.parse(a.runAt) - Date.parse(b.runAt) || a.id.localeCompare(b.id),
    );
  }
}

export interface LocalSchedulerOptions {
  repo: JobRepo;
  clock?: Clock;
}

export class LocalScheduler implements Scheduler {
  readonly #repo: JobRepo;
  readonly #clock: Clock;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(opts: LocalSchedulerOptions) {
    this.#repo = opts.repo;
    this.#clock = opts.clock ?? systemClock;
  }

  async schedule(input: ScheduleInput): Promise<Job> {
    const i = ScheduleInputSchema.parse(input);
    return this.#repo.putJob({
      ...i,
      status: 'pending',
      attempts: 0,
      createdAt: this.#clock.now().toISOString(),
    });
  }

  /** Cancels a pending job. Returns false if absent or no longer pending. */
  async cancel(jobId: string): Promise<boolean> {
    const j = await this.#repo.getJob(jobId);
    if (j === undefined || j.status !== 'pending') return false;
    return this.#repo.setJobStatus(jobId, 'cancelled');
  }

  async list(caseId?: string): Promise<Job[]> {
    return this.#repo.listJobs(caseId);
  }

  /**
   * Runs every due job once: pending → running → done | failed.
   * Returns the ids processed. Re-entrant calls are ignored.
   */
  async tick(handler: JobHandler): Promise<string[]> {
    if (this.#ticking) return [];
    this.#ticking = true;
    try {
      const due = await this.#repo.dueJobs(this.#clock.now().toISOString());
      const done: string[] = [];
      for (const job of due) {
        const running = await this.#repo.putJob({ ...job, status: 'running', attempts: job.attempts + 1 });
        try {
          await handler(running);
          await this.#repo.setJobStatus(job.id, 'done');
        } catch {
          await this.#repo.setJobStatus(job.id, 'failed');
        }
        done.push(job.id);
      }
      return done;
    } finally {
      this.#ticking = false;
    }
  }

  /** Starts the in-process ticker. Idempotent. */
  start(handler: JobHandler, intervalMs = 5_000): void {
    if (this.#timer !== undefined) return;
    const ms = z.number().int().positive().parse(intervalMs);
    this.#timer = setInterval(() => {
      void this.tick(handler).catch(() => undefined);
    }, ms);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }
}
