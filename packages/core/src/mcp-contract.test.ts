import { describe, expect, it } from 'vitest';
import {
  CALL_CARD_URI,
  CallStatusOutputSchema,
  type CaseView,
  MCP_APP_MIME,
  OpenCaseInputSchema,
  OpenCaseOutputSchema,
  PlaceCallInputSchema,
  PlaceCallOutputSchema,
  PublicFactSchema,
  RESOURCE_TEMPLATES,
  ScheduleFollowupOutputSchema,
  SendToCallInputSchema,
  SimConfigSchema,
  SimLlmRequestSchema,
  SimLlmResponseSchema,
  SimTtsRequestSchema,
  SIM_TTS_MAX_CHARS,
  MAX_TOOL_INPUT_SCHEMA_CHARS,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  ToolErrorSchema,
  TranscriptResourceSchema,
  callTranscriptUri,
  caseUri,
} from './index.js';

const T = '2026-10-22T10:00:00.000Z';

const caseView: CaseView = {
  id: 'case-1',
  userName: 'Asha',
  businessId: 'bharatnet',
  businessName: 'BharatNet Broadband',
  goal: 'Broadband down for three days',
  desiredOutcome: 'refund',
  status: 'promised',
  facts: [
    { key: 'account_id', label: 'Account ID', tier: 'share', approved: true, source: 'user', value: 'BN-1234' },
    { key: 'otp', label: 'One-time password', tier: 'never', approved: false, source: 'call' },
  ],
  promises: [{ ticketId: 'SR-12345', what: 'refund for 3 days', dueBy: '2026-10-25', agentName: 'Ravi', callId: 'call-1' }],
  calls: ['call-1'],
  createdAt: T,
  updatedAt: T,
};

describe('mcp-contract names', () => {
  it('lists the ten section-7 tools plus delete_case (spec 13) with schemas', () => {
    const names = Object.values(TOOL_NAMES);
    expect(names).toHaveLength(11);
    expect(names).toContain('delete_case');
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([...names].sort());
  });

  it('builds resource URIs', () => {
    expect(RESOURCE_TEMPLATES.case).toBe('standin://cases/{id}');
    expect(caseUri('case-1')).toBe('standin://cases/case-1');
    expect(callTranscriptUri('call-1')).toBe('standin://calls/call-1/transcript');
    expect(CALL_CARD_URI).toBe('ui://standin/call-card');
    expect(MCP_APP_MIME).toBe('text/html;profile=mcp-app');
  });
});

describe('tool schemas', () => {
  it('parses open_case in/out', () => {
    const input = OpenCaseInputSchema.parse({ businessName: 'BharatNet', goal: 'internet down', desiredOutcome: 'repair' });
    expect(input.facts).toEqual([]);
    expect(
      OpenCaseOutputSchema.safeParse({ case: caseView, missingFacts: [{ key: 'account_id', label: 'Account ID', prompt: 'What is your account ID?' }] })
        .success,
    ).toBe(true);
  });

  it('rejects a never-tier fact that carries a value', () => {
    expect(PublicFactSchema.safeParse({ key: 'otp', label: 'OTP', tier: 'never', approved: false, source: 'call', value: '482913' }).success).toBe(
      false,
    );
  });

  it('validates place_call', () => {
    expect(PlaceCallInputSchema.safeParse({ caseId: 'case-1', simulatedHourIst: 23 }).success).toBe(true);
    expect(PlaceCallInputSchema.safeParse({ caseId: 'case-1', simulatedHourIst: 24 }).success).toBe(false);
    expect(PlaceCallOutputSchema.safeParse({ callId: 'call-1', caseId: 'case-1', state: 'DIALING' }).success).toBe(true);
    expect(PlaceCallOutputSchema.safeParse({ callId: 'call-1', caseId: 'case-1', state: 'HOLD' }).success).toBe(false);
  });

  it('parses a call_status needing the user', () => {
    const r = CallStatusOutputSchema.safeParse({
      callId: 'call-1',
      caseId: 'case-1',
      state: 'HANDOFF_PENDING',
      holdSeconds: 42,
      lastLines: [
        { speaker: 'ivr', text: 'Press 3 for billing', at: T },
        { speaker: 'standin', text: '[pressed 3]', at: T },
        { speaker: 'agent', text: 'Please read me the OTP', at: T },
      ],
      pendingQuestion: { id: 'q1', kind: 'handoff', label: 'One-time password', askedText: 'The agent needs the OTP sent to your phone.' },
      digitsPressed: ['3'],
      blockedCount: 0,
      injectionCount: 0,
      summary: 'Ravi needs the OTP; only you can share it.',
    });
    expect(r.success).toBe(true);
  });

  it('parses a finished call_status', () => {
    expect(
      CallStatusOutputSchema.safeParse({
        callId: 'call-1',
        caseId: 'case-1',
        state: 'ENDED',
        holdSeconds: 90,
        lastLines: [],
        outcome: { ticketId: 'SR-12345', what: 'refund', dueBy: '2026-10-25', agentName: 'Ravi' },
        digitsPressed: ['3'],
        blockedCount: 1,
        injectionCount: 1,
        followupScheduled: { jobId: 'job-1', runAt: '2026-10-26T09:00:00.000Z' },
        summary: 'Refund raised, ticket SR-12345, due 25 Oct.',
      }).success,
    ).toBe(true);
    expect(CallStatusOutputSchema.safeParse({ callId: 'c', caseId: 'k', state: 'RINGING' }).success).toBe(false);
  });

  it('validates send_to_call, schedule_followup and errors', () => {
    expect(SendToCallInputSchema.safeParse({ callId: 'call-1', answer: 'RTR-998877', approve: false }).success).toBe(true);
    expect(SendToCallInputSchema.safeParse({ callId: 'call-1', answer: '' }).success).toBe(false);
    expect(
      ScheduleFollowupOutputSchema.safeParse({ job: { id: 'job-1', kind: 'followup', caseId: 'case-1', runAt: T, status: 'pending', ticketId: 'SR-12345' } })
        .success,
    ).toBe(true);
    expect(ToolErrorSchema.safeParse({ error: { code: 'outside_calling_hours', message: 'It is 23:00 IST.' } }).success).toBe(true);
  });

  it('parses the transcript resource', () => {
    expect(TranscriptResourceSchema.safeParse({ callId: 'call-1', caseId: 'case-1', lines: [{ speaker: 'user', text: 'hi', at: T }] }).success).toBe(true);
  });
});

describe('sim host API', () => {
  it('parses an LLM round trip', () => {
    const req = SimLlmRequestSchema.safeParse({
      messages: [
        { role: 'user', content: 'My BharatNet broadband has been down for three days, sort it out' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'open_case', arguments: { businessName: 'BharatNet' } }] },
        { role: 'tool', content: '{"case":{}}', toolCallId: 't1' },
      ],
      tools: [{ name: 'open_case', description: 'Open a case', inputSchema: { type: 'object' } }],
      scenarioHint: 'happy',
    });
    expect(req.success).toBe(true);
    expect(SimLlmResponseSchema.safeParse({ toolCalls: [{ id: 't2', name: 'place_call', arguments: { caseId: 'case-1' } }] }).success).toBe(true);
    expect(SimLlmResponseSchema.safeParse({ text: 'Calling BharatNet now.' }).success).toBe(true);
    expect(SimLlmResponseSchema.safeParse({}).success).toBe(false);
  });

  it('refuses an oversized tool inputSchema (a public caller must not inflate billed tool specs)', () => {
    const msg = [{ role: 'user', content: 'hi' }];
    const ok = { name: 'open_case', description: 'x', inputSchema: { type: 'object' } };
    expect(SimLlmRequestSchema.safeParse({ messages: msg, tools: [ok] }).success).toBe(true);
    const huge = { ...ok, inputSchema: { type: 'object', description: 'x'.repeat(1_000_000) } };
    expect(SimLlmRequestSchema.safeParse({ messages: msg, tools: [huge] }).success).toBe(false);
    const edge = { ...ok, inputSchema: { d: 'x'.repeat(MAX_TOOL_INPUT_SCHEMA_CHARS - 8) } };
    expect(JSON.stringify(edge.inputSchema).length).toBe(MAX_TOOL_INPUT_SCHEMA_CHARS);
    expect(SimLlmRequestSchema.safeParse({ messages: msg, tools: [edge] }).success).toBe(true);
  });

  it('enforces tool message pairing', () => {
    expect(SimLlmRequestSchema.safeParse({ messages: [{ role: 'tool', content: 'x' }], tools: [] }).success).toBe(false);
    expect(SimLlmRequestSchema.safeParse({ messages: [{ role: 'user', content: 'x', toolCallId: 't' }], tools: [] }).success).toBe(false);
  });

  it('parses tts and config', () => {
    expect(SimTtsRequestSchema.safeParse({ text: 'Hello', voice: 'standin' }).success).toBe(true);
    expect(SimTtsRequestSchema.safeParse({ text: 'Okay', voice: 'alexa' }).success).toBe(true);
    expect(SimTtsRequestSchema.safeParse({ text: 'Okay', voice: 'robot' }).success).toBe(false);
    expect(SimTtsRequestSchema.safeParse({ text: '', voice: 'standin' }).success).toBe(false);
    expect(SimTtsRequestSchema.safeParse({ text: 'a'.repeat(SIM_TTS_MAX_CHARS), voice: 'standin' }).success).toBe(true);
    expect(SimTtsRequestSchema.safeParse({ text: 'a'.repeat(SIM_TTS_MAX_CHARS + 1), voice: 'standin' }).success).toBe(false);
    expect(SimConfigSchema.safeParse({ mode: 'offline', llm: 'scripted', tts: 'browser' }).success).toBe(true);
    expect(SimConfigSchema.safeParse({ mode: 'aws', llm: 'bedrock', tts: 'polly', demoToken: 'tok' }).success).toBe(true);
    expect(SimConfigSchema.safeParse({ mode: 'cloud', llm: 'scripted', tts: 'browser' }).success).toBe(false);
  });
});
