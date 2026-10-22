import { FixedClock, type JobRepo } from '@standin/core';
import { describe, expect, it } from 'vitest';
import { createSqliteRepo } from '../repo/index.js';
import { InMemoryJobRepo, LocalScheduler } from './index.js';

const T0 = '2026-11-12T10:00:00.000Z';

const repos: [string, () => JobRepo & { close?: () => void }][] = [
  ['in-memory', () => new InMemoryJobRepo()],
  ['sqlite', () => createSqliteRepo()],
];

describe.each(repos)('LocalScheduler (%s)', (_name, makeRepo) => {
  it('schedules, lists, cancels', async () => {
    const repo = makeRepo();
    const s = new LocalScheduler({ repo, clock: new FixedClock(T0) });
    const job = await s.schedule({
      id: 'j1',
      kind: 'followup',
      caseId: 'c1',
      runAt: '2026-11-12T11:00:00.000Z',
      payload: { note: 'check ticket' },
    });
    expect(job).toMatchObject({ status: 'pending', attempts: 0, createdAt: T0 });
    expect((await s.list('c1')).map((j) => j.id)).toEqual(['j1']);
    expect(await s.list('other')).toEqual([]);
    expect(await s.cancel('j1')).toBe(true);
    expect(await s.cancel('j1')).toBe(false);
    expect(await s.cancel('missing')).toBe(false);
    repo.close?.();
  });

  it('tick runs only due jobs and records the outcome', async () => {
    const repo = makeRepo();
    const clock = new FixedClock(T0);
    const s = new LocalScheduler({ repo, clock });
    await s.schedule({ id: 'a', kind: 'followup', caseId: 'c', runAt: '2026-11-12T10:30:00.000Z', payload: {} });
    await s.schedule({ id: 'b', kind: 'followup', caseId: 'c', runAt: '2026-11-12T10:31:00.000Z', payload: {} });
    await s.schedule({ id: 'later', kind: 'followup', caseId: 'c', runAt: '2026-11-13T10:00:00.000Z', payload: {} });

    expect(await s.tick(async () => undefined)).toEqual([]);
    clock.advance(60 * 60 * 1000);
    const seen: string[] = [];
    const ran = await s.tick(async (j) => {
      seen.push(j.id);
      expect(j.status).toBe('running');
      expect(j.attempts).toBe(1);
      if (j.id === 'b') throw new Error('handler failed');
    });
    expect(ran).toEqual(['a', 'b']);
    expect(seen).toEqual(['a', 'b']);
    const byId = Object.fromEntries((await s.list()).map((j) => [j.id, j.status]));
    expect(byId).toEqual({ a: 'done', b: 'failed', later: 'pending' });
    repo.close?.();
  });

  it('rejects invalid input with zod', async () => {
    const repo = makeRepo();
    const s = new LocalScheduler({ repo });
    await expect(
      s.schedule({ id: '', kind: 'followup', caseId: 'c', runAt: 'tomorrow', payload: {} }),
    ).rejects.toThrow();
    repo.close?.();
  });
});

describe('LocalScheduler ticker', () => {
  it('start/stop is idempotent', () => {
    const s = new LocalScheduler({ repo: new InMemoryJobRepo() });
    s.start(async () => undefined, 1000);
    s.start(async () => undefined, 1000);
    expect(s.running).toBe(true);
    s.stop();
    expect(s.running).toBe(false);
  });
});
