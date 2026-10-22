import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLog, RepoError, sealEvent, verifyChain, type Call, type Case, type Job } from './index.js';
import { SqliteRepo } from './sqlite.js';

const NOW = '2026-10-22T06:00:00.000Z';

const sampleCase = (over: Partial<Case> = {}): Case => ({
  id: 'case-1',
  userName: 'Asha',
  businessId: 'bharatnet-broadband',
  goal: 'Get refund of ₹2,499 for order OD12345',
  desiredOutcome: 'refund',
  facts: [
    { key: 'order_id', label: 'Order ID', value: 'OD12345', tier: 'share', approved: true, source: 'user' },
    { key: 'email', label: 'Email', value: 'asha@example.invalid', tier: 'confirm', approved: false, source: 'user' },
  ],
  status: 'ready',
  promises: [],
  calls: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const sampleCall = (over: Partial<Call> = {}): Call => ({
  id: 'call-1',
  caseId: 'case-1',
  businessId: 'bharatnet-broadband',
  state: 'DIALING',
  startedAt: NOW,
  ...over,
});

describe('SqliteRepo (in-memory)', () => {
  let repo: SqliteRepo;
  beforeEach(() => {
    repo = new SqliteRepo();
  });
  afterEach(() => repo.close());

  it('round-trips a case', async () => {
    const c = sampleCase();
    await repo.createCase(c);
    expect(await repo.getCase('case-1')).toEqual(c);
    expect(await repo.getCase('missing')).toBeUndefined();

    const updated = {
      ...c,
      status: 'promised' as const,
      promises: [{ ticketId: 'TKT-1', what: 'refund', dueBy: '2026-10-29', callId: 'call-1' }],
      calls: ['call-1'],
      updatedAt: '2026-10-22T07:00:00.000Z',
    };
    await repo.updateCase(updated);
    expect(await repo.getCase('case-1')).toEqual(updated);
    expect(await repo.listCases()).toEqual([updated]);
  });

  it('rejects duplicate, missing and invalid cases', async () => {
    await repo.createCase(sampleCase());
    await expect(repo.createCase(sampleCase())).rejects.toBeInstanceOf(RepoError);
    await expect(repo.updateCase(sampleCase({ id: 'nope' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(repo.createCase(sampleCase({ id: 'case-2', status: 'bogus' as Case['status'] }))).rejects.toThrow();
  });

  it('round-trips calls and counts per business per window', async () => {
    await repo.createCall(sampleCall());
    await repo.createCall(sampleCall({ id: 'call-2', startedAt: '2026-10-22T08:00:00.000Z' }));
    await repo.createCall(sampleCall({ id: 'call-3', startedAt: '2026-10-21T08:00:00.000Z' }));
    await repo.createCall(sampleCall({ id: 'call-4', businessId: 'other-biz' }));

    const ended = sampleCall({
      state: 'ENDED',
      endedAt: '2026-10-22T06:10:00.000Z',
      outcome: { ticketId: 'TKT-1', what: 'refund' },
    });
    await repo.updateCall(ended);
    expect(await repo.getCall('call-1')).toEqual(ended);
    expect((await repo.listCallsByCase('case-1')).map((c) => c.id)).toEqual(['call-3', 'call-1', 'call-4', 'call-2']);
    expect(
      await repo.countCallsForBusiness('bharatnet-broadband', '2026-10-21T18:30:00.000Z', '2026-10-22T18:30:00.000Z'),
    ).toBe(2);
  });

  it('appends and lists a verified event chain', async () => {
    const log = new EventLog('call-1');
    log.append({ id: 'e1', at: NOW, type: 'state', data: { from: 'DIALING', to: 'IVR' } });
    log.append({ id: 'e2', at: NOW, type: 'heard', data: { text: 'Press 1 for billing', speaker: 'ivr' } });
    log.append({ id: 'e3', at: NOW, type: 'dtmf', data: { digits: '1' } });
    for (const e of log.list()) await repo.appendEvent(e);

    const stored = await repo.listEvents('call-1');
    expect(stored).toEqual(log.list());
    expect(verifyChain(stored).ok).toBe(true);
    expect(await repo.headHash('call-1')).toBe(log.head);
    expect(await repo.headHash('call-x')).toBeUndefined();
  });

  it('refuses events that do not extend the head, or whose hash is wrong', async () => {
    const log = new EventLog('call-1');
    const e1 = log.append({ id: 'e1', at: NOW, type: 'said', data: { text: 'hello' } });
    const e2 = log.append({ id: 'e2', at: NOW, type: 'said', data: { text: 'bye' } });
    await expect(repo.appendEvent(e2)).rejects.toMatchObject({ code: 'chain_violation' });
    await expect(repo.appendEvent({ ...e1, data: { text: 'forged' } })).rejects.toMatchObject({
      code: 'chain_violation',
    });
    await repo.appendEvent(e1);
    // A fork from the same parent is rejected once e2 is in.
    await repo.appendEvent(e2);
    const fork = sealEvent(e1.hash, { id: 'e2b', callId: 'call-1', at: NOW, type: 'said', data: { text: 'fork' } });
    await expect(repo.appendEvent(fork)).rejects.toMatchObject({ code: 'chain_violation' });
  });

  it('events table is append-only at the SQL level', async () => {
    const log = new EventLog('call-1');
    await repo.appendEvent(log.append({ id: 'e1', at: NOW, type: 'said', data: { text: 'hi' } }));
    expect(() => repo.db.prepare("UPDATE events SET data_json = '{}'").run()).toThrow(/append-only/);
  });

  it('deleteCase removes the case, its calls, events and jobs', async () => {
    await repo.createCase(sampleCase());
    await repo.createCall(sampleCall());
    await repo.appendEvent(new EventLog('call-1').append({ id: 'e1', at: NOW, type: 'said', data: {} }));
    expect(await repo.deleteCase('case-1')).toBe(true);
    expect(await repo.getCase('case-1')).toBeUndefined();
    expect(await repo.getCall('call-1')).toBeUndefined();
    expect(await repo.listEvents('call-1')).toEqual([]);
    expect(await repo.deleteCase('case-1')).toBe(false);
  });

  it('round-trips jobs and returns due ones', async () => {
    const job = (id: string, runAt: string): Job => ({
      id,
      kind: 'followup',
      caseId: 'case-1',
      runAt,
      payload: { reason: 'refund not received' },
      status: 'pending',
      attempts: 0,
      createdAt: NOW,
    });
    await repo.putJob(job('j1', '2026-10-25T05:00:00.000Z'));
    await repo.putJob(job('j2', '2026-10-30T05:00:00.000Z'));
    expect(await repo.getJob('j1')).toEqual(job('j1', '2026-10-25T05:00:00.000Z'));
    expect((await repo.dueJobs('2026-10-26T00:00:00.000Z')).map((j) => j.id)).toEqual(['j1']);
    expect(await repo.setJobStatus('j1', 'done')).toBe(true);
    expect(await repo.dueJobs('2026-10-26T00:00:00.000Z')).toEqual([]);
    expect(await repo.listJobs('case-1')).toHaveLength(2);
    expect(await repo.setJobStatus('missing', 'done')).toBe(false);
  });
});
