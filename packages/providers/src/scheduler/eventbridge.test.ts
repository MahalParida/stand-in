import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { FixedClock } from '@standin/core';
import { describe, expect, it } from 'vitest';
import { createProviders, createScheduler } from '../factory.js';
import { parseProvidersEnv, ProvidersConfigError } from '../env.js';
import { createSqliteRepo } from '../repo/index.js';
import { EventBridgeScheduler, SchedulerProviderError, atExpression, scheduleName, type SchedulerClientLike } from './eventbridge.js';
import { InMemoryJobRepo, LocalScheduler } from './index.js';

const TARGET = 'arn:aws:lambda:ap-south-1:123456789012:function:standin-followup';
const ROLE = 'arn:aws:iam::123456789012:role/standin-scheduler';
const T0 = '2026-10-22T08:30:00.000Z';

class FakeScheduler implements SchedulerClientLike {
  readonly commands: (CreateScheduleCommand | DeleteScheduleCommand)[] = [];
  constructor(private readonly fail?: (c: CreateScheduleCommand | DeleteScheduleCommand) => Error | undefined) {}
  async send(command: CreateScheduleCommand | DeleteScheduleCommand): Promise<unknown> {
    this.commands.push(command);
    const err = this.fail?.(command);
    if (err !== undefined) throw err;
    return command instanceof CreateScheduleCommand ? { ScheduleArn: 'arn:aws:scheduler:ap-south-1:123456789012:schedule/default/x' } : {};
  }
}

function make(client: SchedulerClientLike) {
  const repo = new InMemoryJobRepo();
  const s = new EventBridgeScheduler({ region: 'ap-south-1', targetArn: TARGET, roleArn: ROLE, repo, clock: new FixedClock(T0), client });
  return { repo, s };
}

describe('EventBridgeScheduler', () => {
  it('a real SchedulerClient satisfies the injectable client shape', () => {
    const c: SchedulerClientLike = new SchedulerClient({ region: 'ap-south-1' });
    expect(c).toBeDefined();
  });

  it('CreateSchedule uses a one-time at() expression in UTC, the env target + role, and ids-only input', async () => {
    const fake = new FakeScheduler();
    const { s } = make(fake);
    const job = await s.schedule({
      id: 'job-1',
      kind: 'followup',
      caseId: 'case-9',
      runAt: '2026-10-30T04:30:00.000Z',
      payload: { ticketId: 'SR-48213', callId: 'call-1' },
    });
    expect(job).toMatchObject({ id: 'job-1', status: 'pending', attempts: 0, createdAt: T0 });
    const cmd = fake.commands[0];
    expect(cmd).toBeInstanceOf(CreateScheduleCommand);
    const input = (cmd as CreateScheduleCommand).input;
    expect(input).toMatchObject({
      Name: 'standin-job-1',
      GroupName: 'default',
      ScheduleExpression: 'at(2026-10-30T04:30:00)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: { Arn: TARGET, RoleArn: ROLE },
    });
    expect(JSON.parse(input.Target?.Input ?? '{}')).toEqual({ jobId: 'job-1', caseId: 'case-9', kind: 'followup' });
    expect(input.Target?.Input).not.toContain('SR-48213');
    expect((await s.list('case-9')).map((j) => j.id)).toEqual(['job-1']);
  });

  it('records nothing when CreateSchedule fails, and the error carries only the class name', async () => {
    const fake = new FakeScheduler(() => Object.assign(new Error('Target arn:aws:lambda... SR-48213 denied'), { name: 'AccessDeniedException' }));
    const { s } = make(fake);
    const err = await s
      .schedule({ id: 'job-2', kind: 'followup', caseId: 'c', runAt: '2026-10-30T04:30:00.000Z', payload: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchedulerProviderError);
    expect((err as Error).message).toBe('CreateSchedule failed (AccessDeniedException)');
    expect(await s.list()).toEqual([]);
  });

  it('cancel deletes the remote schedule (missing is fine) and marks the job cancelled', async () => {
    const fake = new FakeScheduler((c) =>
      c instanceof DeleteScheduleCommand && c.input.Name === 'standin-gone' ? Object.assign(new Error('x'), { name: 'ResourceNotFoundException' }) : undefined,
    );
    const { s } = make(fake);
    await s.schedule({ id: 'a', kind: 'followup', caseId: 'c', runAt: '2026-10-30T04:30:00.000Z', payload: {} });
    await s.schedule({ id: 'gone', kind: 'followup', caseId: 'c', runAt: '2026-10-30T04:30:00.000Z', payload: {} });
    expect(await s.cancel('a')).toBe(true);
    expect(await s.cancel('gone')).toBe(true);
    expect(await s.cancel('a')).toBe(false);
    expect(await s.cancel('missing')).toBe(false);
    const deletes = fake.commands.filter((c): c is DeleteScheduleCommand => c instanceof DeleteScheduleCommand);
    expect(deletes.map((d) => d.input.Name)).toEqual(['standin-a', 'standin-gone']);
    expect((await s.list()).map((j) => j.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('runJob runs a delivered job once (duplicate deliveries are no-ops); start() starts no ticker', async () => {
    const { s } = make(new FakeScheduler());
    await s.schedule({ id: 'j', kind: 'followup', caseId: 'c', runAt: '2026-10-30T04:30:00.000Z', payload: {} });
    s.start(async () => undefined, 10);
    expect(s.running).toBe(false);
    const seen: string[] = [];
    expect(await s.runJob('j', async (job) => void seen.push(`${job.id}:${job.status}:${job.attempts}`))).toBe(true);
    expect(await s.runJob('j', async () => void seen.push('again'))).toBe(false);
    expect(seen).toEqual(['j:running:1']);
    expect((await s.list())[0]?.status).toBe('done');
  });

  it('builds valid schedule names and at() expressions', () => {
    expect(atExpression('2026-10-30T10:00:00+05:30')).toBe('at(2026-10-30T04:30:00)');
    expect(() => atExpression('nope')).toThrow(RangeError);
    const long = scheduleName('standin-', `job-${'x'.repeat(40)}-${'0123456789abcdef'.repeat(2)}/y`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^standin-[0-9a-zA-Z-_.]+$/);
    expect(long.endsWith('-y')).toBe(true);
  });

  it('rejects non-ARN targets', () => {
    expect(() => new EventBridgeScheduler({ region: 'ap-south-1', targetArn: 'http://evil', roleArn: ROLE, repo: new InMemoryJobRepo() })).toThrow();
  });
});

describe('scheduler selection', () => {
  const aws = { STANDIN_MODE: 'aws', AWS_REGION: 'ap-south-1', BEDROCK_MODEL_ID: 'm' };

  it('defaults to the local ticker in every mode', () => {
    const repo = createSqliteRepo();
    expect(createScheduler(parseProvidersEnv({}), repo)).toBeInstanceOf(LocalScheduler);
    expect(createScheduler(parseProvidersEnv(aws), repo)).toBeInstanceOf(LocalScheduler);
    // SCHEDULER=eventbridge is ignored offline (no ARNs needed either).
    expect(createScheduler(parseProvidersEnv({ SCHEDULER: 'eventbridge' }), repo)).toBeInstanceOf(LocalScheduler);
    repo.close();
  });

  it('uses EventBridge only with STANDIN_MODE=aws AND SCHEDULER=eventbridge, and then requires both ARNs', () => {
    try {
      parseProvidersEnv({ ...aws, SCHEDULER: 'eventbridge' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProvidersConfigError);
      expect((e as ProvidersConfigError).variables.sort()).toEqual(['SCHEDULER_ROLE_ARN', 'SCHEDULER_TARGET_ARN']);
    }
    const fake = new FakeScheduler();
    const p = createProviders({ ...aws, SCHEDULER: 'eventbridge', SCHEDULER_TARGET_ARN: TARGET, SCHEDULER_ROLE_ARN: ROLE }, { schedulerClient: fake });
    expect(p.scheduler).toBeInstanceOf(EventBridgeScheduler);
    expect(p.scheduler.kind).toBe('eventbridge');
    p.close();
  });
});
