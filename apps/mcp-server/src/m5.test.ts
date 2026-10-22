/**
 * M5 over the real server: honest refusals (spec S5 / S7), per-case delete and
 * the 30-day transcript TTL (spec 13), the follow-up default (promise dueBy + 1
 * day) and the local ticker placing the S6 follow-up call.
 */
import { parseDueBy } from '@standin/call-agent';
import { FixedClock, callTranscriptUri, failureCopy } from '@standin/core';
import { createProviders } from '@standin/providers';
import { afterEach, describe, expect, it } from 'vitest';
import { StandinApp } from './standin-app.js';
import { callOk, connectClient, pollStatus, startServer, toolErrorOf, type Started } from './test-helpers.js';

const OTP = '482913';
const FACTS = [
  { key: 'account_number', label: 'BharatNet account number', value: 'BN7781234', approve: true },
  { key: 'otp', label: 'OTP sent to registered mobile', value: OTP },
];
const DAY = 86_400_000;

let started: Started[] = [];
afterEach(async () => {
  for (const s of started) await s.close();
  started = [];
});
async function server(env: Record<string, string> = {}): Promise<Started> {
  const s = await startServer(env);
  started.push(s);
  return s;
}

describe('place_call refusals are honest and specific', () => {
  it('outside calling hours and the daily cap each say what happened and that nothing was dialled', async () => {
    const s = await server({ STANDIN_DAILY_CALL_CAP: '1' });
    const { client } = await connectClient(s.url);
    const open = async (): Promise<string> =>
      ((await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'refund for outage', desiredOutcome: 'refund', facts: FACTS })).case as { id: string }).id;
    const late = toolErrorOf(await client.callTool({ name: 'place_call', arguments: { caseId: await open(), simulatedHourIst: 23 } }));
    expect(late.error).toEqual({ code: 'outside_calling_hours', message: failureCopy('outside_calling_hours', { businessName: 'BharatNet Broadband' }).message });
    expect(late.error.message).toMatch(/Nothing was dialled/);

    await callOk(client, 'place_call', { caseId: await open() });
    const capped = toolErrorOf(await client.callTool({ name: 'place_call', arguments: { caseId: await open() } }));
    expect(capped.error.code).toBe('daily_cap_reached');
    expect(capped.error.message).toBe(failureCopy('daily_cap_reached', { businessName: 'BharatNet Broadband' }).message);
    await client.close();
  });
});

describe('delete_case (spec 13: per-case delete)', () => {
  it('erases the case, its calls, transcripts and pending follow-up; refuses while the call is live', async () => {
    const s = await server();
    const { client } = await connectClient(s.url);
    const caseId = ((await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'refund for the outage', desiredOutcome: 'refund', facts: FACTS })).case as { id: string }).id;
    const placed = await callOk(client, 'place_call', { caseId });
    const callId = placed.callId as string;

    const busy = toolErrorOf(await client.callTool({ name: 'delete_case', arguments: { caseId } }));
    expect(busy.error.code).toBe('call_in_progress');

    const done = await pollStatus(client, callId, (st) => st.state === 'ENDED');
    expect(done.state).toBe('ENDED');
    expect(done.followupScheduled).toBeDefined();
    // Follow-up default: the promised date + 1 day.
    const dueBy = (done.outcome as { dueBy: string }).dueBy;
    const due = parseDueBy(dueBy);
    expect(Date.parse((done.followupScheduled as { runAt: string }).runAt)).toBe((due?.getTime() ?? 0) + DAY);
    expect((await s.providers.repo.listEvents(callId)).length).toBeGreaterThan(5);

    const out = await callOk(client, 'delete_case', { caseId });
    expect(out).toMatchObject({ caseId, deleted: true, callsDeleted: 1, followupsCancelled: 1 });
    expect(out.message).toMatch(/Deleted your case with BharatNet Broadband/);

    expect(await s.providers.repo.getCase(caseId)).toBeUndefined();
    expect(await s.providers.repo.listEvents(callId)).toEqual([]);
    expect((await s.providers.scheduler.list(caseId)).length).toBe(0);
    expect(toolErrorOf(await client.callTool({ name: 'get_case', arguments: { caseId } })).error.code).toBe('not_found');
    expect(toolErrorOf(await client.callTool({ name: 'call_status', arguments: { callId } })).error.code).toBe('not_found');
    await expect(client.readResource({ uri: callTranscriptUri(callId) })).rejects.toThrow();
    expect(toolErrorOf(await client.callTool({ name: 'delete_case', arguments: { caseId } })).error.code).toBe('not_found');
    await client.close();
  }, 30_000);
});

describe('transcript TTL (spec 13: 30 days)', () => {
  it('purges cases (and their transcripts) idle for 30 days; keeps recent ones and ones with a pending follow-up', async () => {
    const clock = new FixedClock('2026-10-22T08:30:00Z');
    const providers = createProviders({ STANDIN_MODE: 'offline', SQLITE_PATH: ':memory:' }, { clock });
    const app = new StandinApp({ providers, clock });
    try {
      const open = async (): Promise<string> =>
        (await app.openCase({ businessName: 'BharatNet', goal: 'refund', desiredOutcome: 'refund', facts: FACTS })).case.id;
      const old = await open();
      const withJob = await open();
      await providers.scheduler.schedule({ id: 'job-keep', kind: 'followup', caseId: withJob, runAt: '2026-12-30T00:00:00.000Z', payload: {} });
      clock.advance(31 * DAY);
      const fresh = await open();
      expect(await app.purgeExpired(30)).toEqual([old]);
      expect(await providers.repo.getCase(old)).toBeUndefined();
      expect(await providers.repo.getCase(withJob)).toBeDefined();
      expect(await providers.repo.getCase(fresh)).toBeDefined();
      // A case is kept until it is 30 full days old.
      clock.advance(29 * DAY);
      expect(await app.purgeExpired(30)).toEqual([]);
    } finally {
      await app.close();
      providers.close();
    }
  });
});

describe('follow-up ticker (S6) on the server', () => {
  it('a due job places the follow-up call, which quotes the SR id and asks for a supervisor', async () => {
    const s = await server({ FOLLOWUP_TICK_MS: '50' });
    const { client } = await connectClient(s.url);
    const caseId = ((await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'refund for the outage', desiredOutcome: 'refund', facts: FACTS })).case as { id: string }).id;
    const first = await pollStatus(client, (await callOk(client, 'place_call', { caseId })).callId as string, (st) => st.state === 'ENDED');
    const ticket = (first.outcome as { ticketId: string }).ticketId;
    // Make it due now (instead of dueBy + 1 day).
    await callOk(client, 'schedule_followup', { caseId, at: new Date(Date.now() - 1000).toISOString() });
    let calls: { callId: string }[] = [];
    const deadline = Date.now() + 10_000;
    while (calls.length < 2 && Date.now() < deadline) {
      calls = (await callOk(client, 'get_case', { caseId })).calls as { callId: string }[];
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls).toHaveLength(2);
    const second = await pollStatus(client, calls[1]?.callId ?? '', () => false, undefined, 30_000);
    expect(second.state).toBe('ENDED');
    const t = await client.readResource({ uri: callTranscriptUri(calls[1]?.callId ?? '') });
    const text = (t.contents[0] as { text: string }).text;
    expect(text).toContain(ticket);
    expect(text).toMatch(/supervisor/i);
    expect(text).not.toContain(OTP);
    await client.close();
  }, 45_000);
});
