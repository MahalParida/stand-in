/**
 * EventBridge Scheduler adapter (spec 2.1, AWS path for follow-ups).
 *
 * schedule() creates a one-time schedule (`at(yyyy-mm-ddThh:mm:ss)`, UTC,
 * deleted after it fires) whose target is an injectable ARN + execution role
 * from env (SCHEDULER_TARGET_ARN / SCHEDULER_ROLE_ARN), and records the job in
 * the same JobRepo the local ticker uses, so get_case / list keep working.
 * The remote target (e.g. a Lambda that calls the server) runs the job via
 * runJob(). Selected only when STANDIN_MODE=aws AND SCHEDULER=eventbridge;
 * the single-container deploy has no Lambda target, so the default everywhere
 * is the local ticker.
 *
 * The schedule Input carries ids only ({jobId, caseId, kind}): never case
 * facts, ticket text or anything a user said.
 */
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { JobSchema, systemClock, type Clock, type Job, type JobRepo } from '@standin/core';
import { z } from 'zod';
import type { FollowupScheduler, JobHandler, ScheduleInput } from './index.js';

/** Minimal client shape; the SDK's SchedulerClient satisfies it. Injectable for tests. */
export interface SchedulerClientLike {
  send(command: CreateScheduleCommand | DeleteScheduleCommand): Promise<unknown>;
}

const ArnSchema = z.string().regex(/^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:.+$/, 'must be an ARN');

export const EventBridgeSchedulerOptionsSchema = z.object({
  region: z.string().min(1),
  targetArn: ArnSchema,
  roleArn: ArnSchema,
  groupName: z.string().regex(/^[0-9a-zA-Z-_.]{1,64}$/).default('default'),
  /** Prefix of every schedule name (names are prefix + job id, max 64 chars). */
  namePrefix: z.string().regex(/^[0-9a-zA-Z-_.]{1,20}$/).default('standin-'),
});
export type EventBridgeSchedulerOptions = z.input<typeof EventBridgeSchedulerOptionsSchema> & {
  repo: JobRepo;
  clock?: Clock;
  client?: SchedulerClientLike;
};

const ScheduleInputSchema = JobSchema.pick({ id: true, kind: true, caseId: true, runAt: true, payload: true });

export class SchedulerProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerProviderError';
  }
}

/** `at()` expression in UTC, second precision (EventBridge Scheduler one-time schedules). */
export function atExpression(runAtIso: string): string {
  const d = new Date(runAtIso);
  if (Number.isNaN(d.getTime())) throw new RangeError('invalid runAt');
  return `at(${d.toISOString().slice(0, 19)})`;
}

/** Schedule names allow [0-9a-zA-Z-_.]{1,64}: unsafe characters become '-', long ids keep their tail. */
export function scheduleName(prefix: string, jobId: string): string {
  const safe = jobId.replace(/[^0-9a-zA-Z-_.]/g, '-');
  const room = 64 - prefix.length;
  return `${prefix}${safe.length <= room ? safe : safe.slice(safe.length - room)}`;
}

export class EventBridgeScheduler implements FollowupScheduler {
  readonly kind = 'eventbridge' as const;
  readonly targetArn: string;
  readonly roleArn: string;
  readonly groupName: string;
  readonly #prefix: string;
  readonly #repo: JobRepo;
  readonly #clock: Clock;
  readonly #client: SchedulerClientLike;

  constructor(opts: EventBridgeSchedulerOptions) {
    const o = EventBridgeSchedulerOptionsSchema.parse({
      region: opts.region,
      targetArn: opts.targetArn,
      roleArn: opts.roleArn,
      groupName: opts.groupName,
      namePrefix: opts.namePrefix,
    });
    this.targetArn = o.targetArn;
    this.roleArn = o.roleArn;
    this.groupName = o.groupName;
    this.#prefix = o.namePrefix;
    this.#repo = opts.repo;
    this.#clock = opts.clock ?? systemClock;
    // Default credential chain (env, SSO/profile, container role). Never pass keys here.
    this.#client = opts.client ?? new SchedulerClient({ region: o.region });
  }

  /** Creates the remote one-time schedule, then records the job as pending. */
  async schedule(input: ScheduleInput): Promise<Job> {
    const i = ScheduleInputSchema.parse(input);
    const name = scheduleName(this.#prefix, i.id);
    try {
      await this.#client.send(
        new CreateScheduleCommand({
          Name: name,
          GroupName: this.groupName,
          ScheduleExpression: atExpression(i.runAt),
          ScheduleExpressionTimezone: 'UTC',
          FlexibleTimeWindow: { Mode: 'OFF' },
          ActionAfterCompletion: 'DELETE',
          Description: `Stand-In ${i.kind} for case ${i.caseId}`.slice(0, 512),
          Target: {
            Arn: this.targetArn,
            RoleArn: this.roleArn,
            // Ids only: the target looks the job up and runs it through runJob().
            Input: JSON.stringify({ jobId: i.id, caseId: i.caseId, kind: i.kind }),
            RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
          },
          ClientToken: name,
        }),
      );
    } catch (err) {
      // Error class only: SDK messages can echo request fields.
      throw new SchedulerProviderError(`CreateSchedule failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
    return this.#repo.putJob({ ...i, status: 'pending', attempts: 0, createdAt: this.#clock.now().toISOString() });
  }

  /** Deletes the remote schedule (an already-fired / missing one is fine) and marks the job cancelled. */
  async cancel(jobId: string): Promise<boolean> {
    const j = await this.#repo.getJob(jobId);
    if (j === undefined || j.status !== 'pending') return false;
    try {
      await this.#client.send(new DeleteScheduleCommand({ Name: scheduleName(this.#prefix, jobId), GroupName: this.groupName }));
    } catch (err) {
      if (!(err instanceof Error && err.name === 'ResourceNotFoundException')) {
        throw new SchedulerProviderError(`DeleteSchedule failed (${err instanceof Error ? err.name : 'unknown'})`);
      }
    }
    return this.#repo.setJobStatus(jobId, 'cancelled');
  }

  async list(caseId?: string): Promise<Job[]> {
    return this.#repo.listJobs(caseId);
  }

  /**
   * Runs one job delivered by the remote target: pending -> running -> done |
   * failed. Returns false when the job is unknown or no longer pending (a
   * duplicate delivery is a no-op).
   */
  async runJob(jobId: string, handler: JobHandler): Promise<boolean> {
    const job = await this.#repo.getJob(jobId);
    if (job === undefined || job.status !== 'pending') return false;
    const running = await this.#repo.putJob({ ...job, status: 'running', attempts: job.attempts + 1 });
    try {
      await handler(running);
      await this.#repo.setJobStatus(jobId, 'done');
    } catch {
      await this.#repo.setJobStatus(jobId, 'failed');
    }
    return true;
  }

  /** The remote schedule fires the job; there is no in-process ticker. */
  start(_handler: JobHandler, _intervalMs?: number): void {}

  stop(): void {}

  get running(): boolean {
    return false;
  }
}
