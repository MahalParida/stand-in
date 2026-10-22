/**
 * MCP round trips over a real Streamable HTTP server on an ephemeral port,
 * driven by the SDK Client (spec 10, M3 DoD).
 */
import { ElicitRequestSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { CALL_CARD_URI, MCP_APP_MIME, TOOL_NAMES, callTranscriptUri, caseUri } from '@standin/core';
import { afterEach, describe, expect, it } from 'vitest';
import { callOk, connectClient, pollStatus, startServer, toolErrorOf, type Started } from './test-helpers.js';

const OTP = '482913';
const NEVER_PATTERNS = [OTP, '4 8 2 9 1 3', 'four eight two nine one three'];

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

function expectNoNever(log: unknown[]): void {
  const text = JSON.stringify(log).toLowerCase();
  for (const p of NEVER_PATTERNS) expect(text).not.toContain(p);
}

const BASE_FACTS = [
  { key: 'account_number', label: 'BharatNet account number', value: 'BN7781234', approve: true },
  { key: 'otp', label: 'OTP sent to registered mobile', value: OTP },
];

describe('MCP round trip (initialize -> tools/list -> open_case -> place_call -> poll to ENDED)', () => {
  it('completes S1 and returns ticketId / dueBy / follow-up, with masked resources', async () => {
    const s = await server();
    const { client } = await connectClient(s.url);
    const updated: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updated.push(n.params.uri);
    });
    const log: unknown[] = [];

    expect(client.getServerVersion()?.name).toBe('stand-in');
    const tools = await client.listTools();
    log.push(tools);
    expect(tools.tools.map((t) => t.name).sort()).toEqual(Object.values(TOOL_NAMES).sort());
    const place = tools.tools.find((t) => t.name === 'place_call');
    expect(place?.outputSchema).toBeDefined();
    expect(place?._meta).toMatchObject({ ui: { resourceUri: CALL_CARD_URI }, 'ui/resourceUri': CALL_CARD_URI });

    const opened = await callOk(
      client,
      'open_case',
      { businessName: 'BharatNet', goal: 'My broadband has been down for three days, I want a refund', desiredOutcome: 'refund', facts: BASE_FACTS },
      log,
    );
    const kase = opened.case as { id: string; status: string; facts: { key: string; tier: string; value?: string }[] };
    expect(kase.status).toBe('ready');
    expect(opened.missingFacts).toEqual([]);
    const otp = kase.facts.find((f) => f.key === 'otp');
    expect(otp?.tier).toBe('never');
    expect(otp?.value).toBeUndefined();
    // The caller cannot pick tiers: the guard did.
    expect(kase.facts.find((f) => f.key === 'account_number')?.tier).toBe('confirm');

    const placed = await callOk(client, 'place_call', { caseId: kase.id }, log);
    expect(placed).toMatchObject({ caseId: kase.id, state: 'DIALING' });
    const callId = placed.callId as string;

    const seen = new Set<string>();
    const final = await pollStatus(client, callId, (st) => {
      seen.add(st.state as string);
      return false;
    }, log);
    expect(final.state).toBe('ENDED');
    expect(seen.has('HOLD')).toBe(true);
    expect(final.digitsPressed).toEqual(['3', '2']);
    expect(final.holdSeconds as number).toBeGreaterThan(60);
    const outcome = final.outcome as { ticketId: string; dueBy: string };
    expect(outcome.ticketId).toMatch(/^SR-\d{5}$/);
    expect(outcome.dueBy).toMatch(/\d{1,2} [A-Z][a-z]{2} \d{4}/);
    expect(final.followupScheduled).toBeDefined();
    expect(final.summary).toContain(outcome.ticketId);

    const got = await callOk(client, 'get_case', { caseId: kase.id }, log);
    expect((got.case as { status: string }).status).toBe('promised');
    expect((got.calls as { callId: string; state: string }[])[0]).toMatchObject({ callId, state: 'ENDED' });
    expect((got.followups as { ticketId?: string }[])[0]?.ticketId).toBe(outcome.ticketId);
    expect(got.summary).toContain(outcome.ticketId);

    const listed = await callOk(client, 'list_cases', {}, log);
    expect((listed.cases as unknown[]).length).toBe(1);

    // schedule_followup without `at` returns the job the call already scheduled.
    const job = await callOk(client, 'schedule_followup', { caseId: kase.id }, log);
    expect((job.job as { id: string }).id).toBe((final.followupScheduled as { jobId: string }).jobId);

    // Resources: case, transcript (masked), call card.
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(['standin://calls/{id}/transcript', 'standin://cases/{id}']);
    const res = await client.listResources();
    expect(res.resources.map((r) => r.uri)).toContain(CALL_CARD_URI);
    expect(res.resources.map((r) => r.uri)).toContain(caseUri(kase.id));
    const caseRes = await client.readResource({ uri: caseUri(kase.id) });
    const transcript = await client.readResource({ uri: callTranscriptUri(callId) });
    log.push(caseRes, transcript);
    const lines = (JSON.parse((transcript.contents[0] as { text: string }).text) as { lines: { speaker: string; text: string }[] }).lines;
    expect(lines.some((l) => l.speaker === 'ivr')).toBe(true);
    expect(lines.some((l) => l.speaker === 'agent' && l.text.includes(outcome.ticketId))).toBe(true);
    expect(lines.find((l) => l.speaker === 'standin' && !l.text.startsWith('['))?.text).toMatch(/AI assistant calling on behalf of/);
    const card = await client.readResource({ uri: CALL_CARD_URI });
    expect(card.contents[0]?.mimeType).toBe(MCP_APP_MIME);

    // resources/updated notifications reached this session.
    expect(updated).toContain(caseUri(kase.id));
    expect(updated).toContain(callTranscriptUri(callId));

    expectNoNever(log);
    await client.close();
  }, 30_000);

  it('returns missingFacts without elicitation, then update_case_fact makes the case ready', async () => {
    const s = await server();
    const { client } = await connectClient(s.url);
    const opened = await callOk(client, 'open_case', { businessName: 'Bharat Net', goal: 'internet is down', desiredOutcome: 'refund' });
    const kase = opened.case as { id: string; status: string };
    expect(kase.status).toBe('draft');
    expect(opened.missingFacts).toEqual([
      { key: 'account_number', label: 'BharatNet Broadband account number', prompt: "What's your BharatNet Broadband account number?" },
    ]);
    const blocked = await client.callTool({ name: 'place_call', arguments: { caseId: kase.id } });
    expect(blocked.isError).toBe(true);
    expect(toolErrorOf(blocked)).toMatchObject({ error: { code: 'case_not_ready' } });
    const upd = await callOk(client, 'update_case_fact', { caseId: kase.id, key: 'account_number', value: 'BN7781234', approve: true });
    expect(upd.missingFacts).toEqual([]);
    expect((upd.case as { status: string }).status).toBe('ready');
    await client.close();
  });

  it('elicits missing facts when the client supports elicitation', async () => {
    const s = await server();
    const { client } = await connectClient(s.url, { elicitation: true });
    const asked: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return { action: 'accept', content: { account_number: 'BN7781234' } };
    });
    const opened = await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'broadband down', desiredOutcome: 'refund' });
    expect(asked[0]).toMatch(/BharatNet Broadband account number/);
    expect(opened.missingFacts).toEqual([]);
    const kase = opened.case as { status: string; facts: { key: string; source: string; approved: boolean }[] };
    expect(kase.status).toBe('ready');
    expect(kase.facts).toContainEqual(expect.objectContaining({ key: 'account_number', source: 'elicited', approved: true }));
    await client.close();
  });

  it('falls back to missingFacts when the user declines the elicitation', async () => {
    const s = await server();
    const { client } = await connectClient(s.url, { elicitation: true });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
    const opened = await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'broadband down', desiredOutcome: 'refund' });
    expect((opened.missingFacts as unknown[]).length).toBe(1);
    expect((opened.case as { status: string }).status).toBe('draft');
    await client.close();
  });

  it('refuses unknown businesses and off-hours calls (S7) before dialling', async () => {
    const s = await server();
    const { client } = await connectClient(s.url);
    const unknown = await client.callTool({ name: 'open_case', arguments: { businessName: 'Acme Scam Support', goal: 'x', desiredOutcome: 'info' } });
    expect(unknown.isError).toBe(true);
    expect(toolErrorOf(unknown)).toMatchObject({ error: { code: 'not_allowlisted' } });
    const opened = await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'refund', desiredOutcome: 'refund', facts: BASE_FACTS });
    const id = (opened.case as { id: string }).id;
    const late = await client.callTool({ name: 'place_call', arguments: { caseId: id, simulatedHourIst: 23 } });
    expect(late.isError).toBe(true);
    expect(toolErrorOf(late)).toMatchObject({ error: { code: 'outside_calling_hours' } });
    const got = await callOk(client, 'get_case', { caseId: id });
    expect((got.case as { status: string; calls: unknown[] }).calls).toEqual([]);
    await client.close();
  });
});

describe('S2 otp-trap over MCP', () => {
  it('hits HANDOFF_PENDING ("Needs you"), the user joins and leaves, the call completes, no OTP anywhere', async () => {
    const s = await server();
    const { client } = await connectClient(s.url);
    const log: unknown[] = [];
    const opened = await callOk(
      client,
      'open_case',
      { businessName: 'BharatNet', goal: 'broadband down, want a refund; my OTP is 482913', desiredOutcome: 'refund', facts: BASE_FACTS, scenario: 'otp-trap' },
      log,
    );
    const caseId = (opened.case as { id: string; goal: string }).id;
    expect((opened.case as { goal: string }).goal).not.toContain(OTP);
    const callId = (await callOk(client, 'place_call', { caseId }, log)).callId as string;
    const pending = await pollStatus(client, callId, (st) => st.state === 'HANDOFF_PENDING', log);
    expect(pending.state).toBe('HANDOFF_PENDING');
    expect(pending.pendingQuestion).toMatchObject({ kind: 'handoff' });
    expect((pending.pendingQuestion as { label: string }).label).toMatch(/OTP/);
    expect(pending.summary).toMatch(/Join the call\?/);

    // send_to_call cannot answer a never-tier hand-off.
    const viaSend = await callOk(client, 'send_to_call', { callId, answer: OTP }, log);
    expect(viaSend.ok).toBe(false);

    const joined = await callOk(client, 'handoff_to_user', { callId, accept: true }, log);
    expect(joined).toMatchObject({ ok: true, state: 'USER_ON_LINE' });
    const final = await pollStatus(client, callId, () => false, log);
    expect(final.state).toBe('ENDED');
    expect((final.outcome as { ticketId: string }).ticketId).toMatch(/^SR-\d{5}$/);
    const transcript = await client.readResource({ uri: callTranscriptUri(callId) });
    log.push(transcript, await client.readResource({ uri: caseUri(caseId) }));
    const lines = (JSON.parse((transcript.contents[0] as { text: string }).text) as { lines: { speaker: string; text: string }[] }).lines;
    expect(lines.some((l) => l.text === '[account holder joined the call]')).toBe(true);
    expect(lines.some((l) => l.speaker === 'user')).toBe(true);
    expect(lines.some((l) => l.text === '[account holder left the call]')).toBe(true);
    expectNoNever(log);
    await client.close();
  }, 30_000);

  it('decline: the agent carries on and tells the business the user will verify later', async () => {
    const s = await server();
    const { client } = await connectClient(s.url);
    const opened = await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'refund', desiredOutcome: 'refund', facts: BASE_FACTS, scenario: 'otp-trap' });
    const callId = (await callOk(client, 'place_call', { caseId: (opened.case as { id: string }).id })).callId as string;
    await pollStatus(client, callId, (st) => st.state === 'HANDOFF_PENDING');
    const declined = await callOk(client, 'handoff_to_user', { callId, accept: false });
    expect(declined).toMatchObject({ ok: true, state: 'HUMAN' });
    // Nothing is pending any more; accept=true with a person on the line is now "Take over call".
    const again = await callOk(client, 'handoff_to_user', { callId, accept: true });
    expect(again.message).not.toMatch(/verify/i);
    if (again.ok === true) expect(again.state).toBe('USER_ON_LINE');
    const final = await pollStatus(client, callId, () => false);
    expect(['ENDED', 'FAILED']).toContain(final.state);
    await client.close();
  }, 30_000);
});

describe('"Take over call" over MCP', () => {
  it('handoff_to_user(accept=true) while a person is on the line bridges the user; accept=false hands back; the call completes', async () => {
    const s = await server({ SIM_SPEED_TALK: '4', SIM_JOIN_SPEAK_MS: '400', SIM_JOIN_LEAVE_MS: '60000' });
    const { client } = await connectClient(s.url);
    const opened = await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'broadband down, want a refund', desiredOutcome: 'refund', facts: BASE_FACTS });
    const callId = (await callOk(client, 'place_call', { caseId: (opened.case as { id: string }).id })).callId as string;
    // Not possible yet in the phone menu / on hold: a clear message, no state change.
    const early = await callOk(client, 'handoff_to_user', { callId, accept: true });
    expect(early).toMatchObject({ ok: false });
    expect(early.message).toMatch(/once a person is on the line/);

    await pollStatus(client, callId, (st) => st.state === 'HUMAN');
    const took = await callOk(client, 'handoff_to_user', { callId, accept: true });
    expect(took).toMatchObject({ ok: true, state: 'USER_ON_LINE' });
    expect(took.message).toMatch(/taken over/);
    const on = await pollStatus(client, callId, (st) => (st.lastLines as { speaker: string }[]).some((l) => l.speaker === 'user'));
    expect(on.state).toBe('USER_ON_LINE');

    const back = await callOk(client, 'handoff_to_user', { callId, accept: false });
    expect(back).toMatchObject({ ok: true, state: 'HUMAN' });
    const final = await pollStatus(client, callId, () => false, undefined, 30_000);
    expect(final.state).toBe('ENDED');
    expect((final.outcome as { ticketId?: string } | undefined)?.ticketId).toMatch(/^SR-\d{5}$/);
    await client.close();
  }, 40_000);
});

describe('S4 unknown-fact over MCP', () => {
  it('surfaces pendingQuestion via call_status; the answer flows in via send_to_call', async () => {
    const s = await server();
    const { client } = await connectClient(s.url);
    const log: unknown[] = [];
    const opened = await callOk(
      client,
      'open_case',
      { businessName: 'BharatNet', goal: 'internet not working for three days, need a technician', desiredOutcome: 'repair', facts: BASE_FACTS },
      log,
    );
    const callId = (await callOk(client, 'place_call', { caseId: (opened.case as { id: string }).id }, log)).callId as string;
    const asked = await pollStatus(client, callId, (st) => st.pendingQuestion !== undefined, log);
    expect(asked.state).toBe('HUMAN');
    const q = asked.pendingQuestion as { kind: string; label: string; factKey: string };
    expect(q.kind).toBe('fact');
    expect(q.label.toLowerCase()).toContain('router serial');
    expect(asked.summary).toMatch(/router serial/i);

    const sent = await callOk(client, 'send_to_call', { callId, answer: 'RT99881' }, log);
    expect(sent).toMatchObject({ ok: true });
    const final = await pollStatus(client, callId, () => false, log);
    expect(final.state).toBe('ENDED');
    expect((final.outcome as { what: string }).what).toMatch(/technician/);
    const transcript = await client.readResource({ uri: callTranscriptUri(callId) });
    const lines = (JSON.parse((transcript.contents[0] as { text: string }).text) as { lines: { speaker: string; text: string }[] }).lines;
    expect(lines.some((l) => l.speaker === 'standin' && l.text.includes('RT99881'))).toBe(true);
    // The answer became a case fact (tier by the guard).
    const got = await callOk(client, 'get_case', { caseId: (opened.case as { id: string }).id }, log);
    expect((got.case as { facts: { value?: string; source: string }[] }).facts).toContainEqual(expect.objectContaining({ value: 'RT99881', source: 'call' }));
    expectNoNever(log);
    await client.close();
  }, 30_000);

  it('end_call hangs up a live call and reports the final state', async () => {
    const s = await server({ SIM_SPEED_HOLD: '1' });
    const { client } = await connectClient(s.url);
    const opened = await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'refund', desiredOutcome: 'refund', facts: BASE_FACTS });
    const callId = (await callOk(client, 'place_call', { caseId: (opened.case as { id: string }).id })).callId as string;
    await pollStatus(client, callId, (st) => st.state === 'HOLD');
    const ended = await callOk(client, 'end_call', { callId });
    expect(['ENDED', 'FAILED']).toContain(ended.state);
    expect(typeof ended.summary).toBe('string');
    await client.close();
  }, 30_000);
});

describe('S6 follow-up over MCP', () => {
  it('schedule_followup(at=now) -> the ticker calls again, quotes the ticket and gets an escalation', async () => {
    const s = await server({ FOLLOWUP_TICK_MS: '100' });
    const { client } = await connectClient(s.url);
    const log: unknown[] = [];
    const opened = await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'refund for outage', desiredOutcome: 'refund', facts: BASE_FACTS }, log);
    const caseId = (opened.case as { id: string }).id;
    const first = await pollStatus(client, (await callOk(client, 'place_call', { caseId }, log)).callId as string, () => false, log);
    const ticket = (first.outcome as { ticketId: string }).ticketId;
    const job = await callOk(client, 'schedule_followup', { caseId, at: new Date().toISOString() }, log);
    expect(job.job).toMatchObject({ caseId, status: 'pending', ticketId: ticket });

    let calls: { callId: string; state: string }[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      calls = (await callOk(client, 'get_case', { caseId }, log)).calls as { callId: string; state: string }[];
      if (calls.length === 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls).toHaveLength(2);
    const second = await pollStatus(client, calls[1]?.callId ?? '', () => false, log);
    expect(second.state).toBe('ENDED');
    const transcript = await client.readResource({ uri: callTranscriptUri(calls[1]?.callId ?? '') });
    expect((transcript.contents[0] as { text: string }).text).toContain(ticket);
    const got = await callOk(client, 'get_case', { caseId }, log);
    expect((got.case as { status: string }).status).toBe('escalated');
    expect(got.summary).toMatch(/escalated/);
    expectNoNever(log);
    await client.close();
  }, 40_000);
});

describe('STANDIN_DAILY_CALL_CAP', () => {
  it('overrides the directory cap: the call over the cap is refused before dialling', async () => {
    const s = await server({ STANDIN_DAILY_CALL_CAP: '1' });
    const { client } = await connectClient(s.url);
    const open = async (): Promise<string> =>
      ((await callOk(client, 'open_case', { businessName: 'BharatNet', goal: 'refund for outage', desiredOutcome: 'refund', facts: BASE_FACTS })).case as { id: string }).id;
    const first = await callOk(client, 'place_call', { caseId: await open() });
    expect(first.state).toBe('DIALING');
    const refused = await client.callTool({ name: 'place_call', arguments: { caseId: await open() } });
    expect(refused.isError).toBe(true);
    expect(toolErrorOf(refused)).toMatchObject({ error: { code: 'daily_cap_reached' } });
    await client.close();
  });
});
