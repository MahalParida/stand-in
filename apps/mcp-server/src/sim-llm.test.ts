/**
 * /sim/api/llm: the alexa-sim orchestrator loop, run here the way the browser
 * runs it (LLM proxy -> tool calls executed over a real MCP client -> repeat).
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SimLlmResponseSchema, type LlmMessage, type LlmToolSpec, type SimLlmRequest } from '@standin/core';
import type { ChatRequest, LlmProvider } from '@standin/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BedrockProvider, type ConverseClient } from '@standin/providers';
import { buildLlmMessages, buildToolChatRequest, classifyUtterance, llmOrchestrator, scriptedOrchestrator } from './orchestrator.js';
import { connectClient, pollStatus, startServer, TOKEN, type Started } from './test-helpers.js';
// The browser's real tool-result encoding (alexa-sim), so both sides share one error contract.
import { toOutcome, toolResultForLlm } from '../../alexa-sim/src/lib/mcp.js';

let started: Started[] = [];
afterEach(async () => {
  for (const s of started) await s.close();
  started = [];
});

interface Host {
  url: string;
  client: Client;
  tools: LlmToolSpec[];
  messages: LlmMessage[];
  log: unknown[];
}

async function host(): Promise<Host> {
  const s = await startServer();
  started.push(s);
  const { client } = await connectClient(s.url);
  const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown> }));
  return { url: s.url, client, tools, messages: [], log: [] };
}

/** One user turn: loop LLM <-> MCP until the model only speaks. Returns what Alexa says. */
async function say(h: Host, text: string, hint?: SimLlmRequest['scenarioHint']): Promise<{ spoken: string[]; tools: string[] }> {
  h.messages.push({ role: 'user', content: text });
  const spoken: string[] = [];
  const tools: string[] = [];
  for (let i = 0; i < 8; i++) {
    const req: SimLlmRequest = { messages: h.messages, tools: h.tools, ...(hint !== undefined ? { scenarioHint: hint } : {}) };
    const r = await fetch(`${h.url}/sim/api/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(req),
    });
    expect(r.status).toBe(200);
    const body = SimLlmResponseSchema.parse(await r.json());
    h.log.push(body);
    if (body.text !== undefined) spoken.push(body.text);
    h.messages.push({ role: 'assistant', content: body.text ?? '', ...(body.toolCalls !== undefined ? { toolCalls: body.toolCalls } : {}) });
    if (body.toolCalls === undefined || body.toolCalls.length === 0) return { spoken, tools };
    for (const tc of body.toolCalls) {
      tools.push(tc.name);
      const res = await h.client.callTool({ name: tc.name, arguments: tc.arguments });
      h.log.push(res);
      h.messages.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify(res.structuredContent ?? { error: { code: 'error', message: 'failed' } }) });
    }
  }
  throw new Error('orchestrator did not settle');
}

describe('/sim/api/llm scripted orchestrator over MCP', () => {
  it('runs the S1 demo end to end: complaint -> account number -> call -> status question', async () => {
    const h = await host();
    const t1 = await say(h, 'My BharatNet broadband has been down for three days, sort it out');
    expect(t1.tools).toEqual(['open_case']);
    expect(t1.spoken.at(-1)).toMatch(/account number/i);

    const t2 = await say(h, "It's BN7781234");
    expect(t2.tools).toEqual(['update_case_fact', 'place_call']);
    expect(t2.spoken.join(' ')).toMatch(/calling BharatNet Broadband/);
    const placed = h.messages.filter((m) => m.role === 'tool').at(-1);
    const callId = (JSON.parse(placed?.content ?? '{}') as { callId: string }).callId;
    const final = await pollStatus(h.client, callId, () => false);
    expect(final.state).toBe('ENDED');

    const t3 = await say(h, 'What happened with my broadband complaint?');
    expect(t3.tools).toEqual(['get_case']);
    expect(t3.spoken.at(-1)).toMatch(/SR-\d{5}/);

    // A fresh conversation (e.g. the next day) finds the case through list_cases.
    const fresh: Host = { ...h, messages: [] };
    const t4 = await say(fresh, 'What happened with my broadband complaint?');
    expect(t4.tools).toEqual(['list_cases', 'get_case']);
    expect(t4.spoken.at(-1)).toMatch(/SR-\d{5}/);

    // "The technician never came" -> a follow-up call is scheduled right away and quotes the ticket.
    const t5 = await say(fresh, 'The refund never came, call them again');
    expect(t5.tools).toEqual(['schedule_followup']);
    expect(t5.spoken.at(-1)).toMatch(/again right now and quote ticket SR-\d{5}/);
    await h.client.close();
  }, 30_000);

  it('otp autoplay: "Join the call?" -> "yes" bridges the user', async () => {
    const h = await host();
    await say(h, 'My BharatNet broadband has been down for three days, sort it out. My account number is BN7781234.', 'otp');
    const placed = h.messages.filter((m) => m.role === 'tool').at(-1);
    const callId = (JSON.parse(placed?.content ?? '{}') as { callId: string }).callId;
    expect(callId).toMatch(/^call-/);
    await pollStatus(h.client, callId, (s) => s.state === 'HANDOFF_PENDING');
    const t = await say(h, "What's the status?");
    expect(t.tools).toEqual(['call_status']);
    expect(t.spoken.at(-1)).toMatch(/Join the call\?/);
    const j = await say(h, 'Yes, put me through');
    // The status turn above may already be stale: the matcher re-reads the live state first.
    expect(j.tools).toEqual(['call_status', 'handoff_to_user']);
    expect(j.spoken.at(-1)).toMatch(/Connecting you/);
    const final = await pollStatus(h.client, callId, () => false);
    expect(final.state).toBe('ENDED');
    await h.client.close();
  }, 30_000);

  it('otp by voice: "Yes, join the call." right after HANDOFF_PENDING (no status turn) bridges the user', async () => {
    const h = await host();
    await say(h, 'My BharatNet broadband has been down for three days, sort it out. My account number is BN7781234.', 'otp');
    const placed = h.messages.filter((m) => m.role === 'tool').at(-1);
    const callId = (JSON.parse(placed?.content ?? '{}') as { callId: string }).callId;
    // The host polls outside the conversation: the only call state in history is place_call's DIALING.
    await pollStatus(h.client, callId, (s) => s.state === 'HANDOFF_PENDING');
    const j = await say(h, 'Yes, join the call.');
    expect(j.tools).toEqual(['call_status', 'handoff_to_user']);
    expect(j.spoken.at(-1)).toMatch(/Connecting you/);
    const final = await pollStatus(h.client, callId, () => false);
    expect(final.state).toBe('ENDED');
    expect(JSON.stringify(h.log)).not.toContain('482913');
    await h.client.close();
  }, 30_000);

  it('otp by voice: "No" right after HANDOFF_PENDING declines the hand-off', async () => {
    const h = await host();
    await say(h, 'My BharatNet broadband has been down for three days, sort it out. My account number is BN7781234.', 'otp');
    const placed = h.messages.filter((m) => m.role === 'tool').at(-1);
    const callId = (JSON.parse(placed?.content ?? '{}') as { callId: string }).callId;
    await pollStatus(h.client, callId, (s) => s.state === 'HANDOFF_PENDING');
    const j = await say(h, 'No, not now');
    expect(j.tools).toEqual(['call_status', 'handoff_to_user']);
    expect(j.spoken.at(-1)).toMatch(/verify later/);
    await h.client.close();
  }, 30_000);

  it('S4 by voice: a mid-call fact answer ("It\'s RT99881") goes to send_to_call without a status turn', async () => {
    const h = await host();
    await say(h, 'My BharatNet internet is not working, I need a technician to repair it. My account number is BN7781234.');
    const placed = h.messages.filter((m) => m.role === 'tool').at(-1);
    const callId = (JSON.parse(placed?.content ?? '{}') as { callId: string }).callId;
    expect(callId).toMatch(/^call-/);
    const asked = await pollStatus(h.client, callId, (s) => s.pendingQuestion !== undefined);
    expect((asked.pendingQuestion as { kind: string }).kind).toBe('fact');
    const t = await say(h, "It's RT99881");
    expect(t.tools).toEqual(['call_status', 'send_to_call']);
    expect(t.spoken.at(-1)).toMatch(/passed that on/);
    const final = await pollStatus(h.client, callId, () => false);
    expect(final.state).toBe('ENDED');
    await h.client.close();
  }, 30_000);

  it('refund-by-order line opens a case with the order id', async () => {
    const h = await host();
    const t = await say(h, 'I got a refund problem with order OD12345');
    expect(t.tools).toEqual(['open_case']);
    const res = JSON.parse(h.messages.filter((m) => m.role === 'tool').at(-1)?.content ?? '{}') as { case: { facts: { key: string; value?: string }[] } };
    expect(res.case.facts).toContainEqual(expect.objectContaining({ key: 'order_id', value: 'OD12345' }));
    await h.client.close();
  });
});

describe('scripted matcher (pure)', () => {
  const ctx = { now: new Date('2026-10-22T08:30:00Z'), businesses: [{ name: 'BharatNet Broadband', aliases: ['BharatNet'] }] };
  const tools: LlmToolSpec[] = ['open_case', 'place_call', 'list_cases', 'get_case', 'call_status'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));

  it('classifies the demo utterances', () => {
    expect(classifyUtterance('My BharatNet broadband has been down for three days, sort it out').kind).toBe('broadband');
    expect(classifyUtterance('I got a refund problem with order OD12345')).toEqual({ kind: 'refund', orderId: 'OD12345' });
    expect(classifyUtterance('what happened with my broadband complaint?').kind).toBe('status');
    expect(classifyUtterance('The technician never came, call them again').kind).toBe('followup');
    expect(classifyUtterance('hang up').kind).toBe('end');
  });

  it('is deterministic (same request -> same response)', () => {
    const req: SimLlmRequest = { messages: [{ role: 'user', content: 'My BharatNet broadband has been down for three days, sort it out' }], tools };
    const a = scriptedOrchestrator(req, ctx);
    const b = scriptedOrchestrator(req, ctx);
    expect(a).toEqual(b);
    expect(a.toolCalls?.[0]?.name).toBe('open_case');
  });

  it('a reply during a call reads the live state first instead of falling through to HELP', () => {
    const all: LlmToolSpec[] = ['open_case', 'place_call', 'call_status', 'handoff_to_user', 'send_to_call'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
    const base: SimLlmRequest['messages'] = [
      { role: 'user', content: 'My BharatNet broadband has been down for three days, sort it out. My account number is BN7781234.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'open_case', arguments: {} }] },
      { role: 'tool', toolCallId: 't1', content: JSON.stringify({ case: { id: 'case-1', businessName: 'BharatNet Broadband', status: 'ready', promises: [] }, missingFacts: [] }) },
      { role: 'assistant', content: '', toolCalls: [{ id: 't2', name: 'place_call', arguments: { caseId: 'case-1' } }] },
      { role: 'tool', toolCallId: 't2', content: JSON.stringify({ callId: 'call-1', caseId: 'case-1', state: 'DIALING' }) },
      { role: 'assistant', content: "I'm on the line." },
      { role: 'user', content: 'Yes, join the call.' },
    ];
    const first = scriptedOrchestrator({ messages: base, tools: all }, ctx);
    expect(first.text).toBeUndefined();
    expect(first.toolCalls).toEqual([expect.objectContaining({ name: 'call_status', arguments: { callId: 'call-1' } })]);
    const id = first.toolCalls?.[0]?.id ?? 'x';
    const withStatus = (status: Record<string, unknown>): SimLlmRequest => ({
      messages: [...base, { role: 'assistant', content: '', toolCalls: first.toolCalls ?? [] }, { role: 'tool', toolCallId: id, content: JSON.stringify(status) }],
      tools: all,
    });
    const handoff = scriptedOrchestrator(
      withStatus({ callId: 'call-1', state: 'HANDOFF_PENDING', summary: 'BharatNet needs you. Join the call?', pendingQuestion: { id: 'q1', kind: 'handoff', label: 'OTP' } }),
      ctx,
    );
    expect(handoff.toolCalls).toEqual([expect.objectContaining({ name: 'handoff_to_user', arguments: { callId: 'call-1', accept: true } })]);
    // Nothing waiting: say where the call is, not the HELP text.
    const idle = scriptedOrchestrator(withStatus({ callId: 'call-1', state: 'HOLD', summary: 'On hold for 3 minutes.' }), ctx);
    expect(idle.text).toBe('On hold for 3 minutes.');
  });

  it('turns tool errors into an honest spoken reply', () => {
    const req: SimLlmRequest = {
      messages: [
        { role: 'user', content: 'call them' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'place_call', arguments: { caseId: 'c' } }] },
        { role: 'tool', toolCallId: 't1', content: JSON.stringify({ error: { code: 'outside_calling_hours', message: 'BharatNet takes calls 09:00-20:00' } }) },
      ],
      tools,
    };
    // A known refusal code gets the shared, specific copy (spec S5), whatever the message said.
    expect(scriptedOrchestrator(req, ctx).text).toMatch(/I didn't call BharatNet Broadband: I only place calls between 09:00 and 20:00 IST.*Nothing was dialled/);
  });

  it('reads tool errors exactly as the browser sends them (real toolResultForLlm/toOutcome)', () => {
    const asTool = (content: string): SimLlmRequest => ({
      messages: [
        { role: 'user', content: 'call them' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'place_call', arguments: { caseId: 'c' } }] },
        { role: 'tool', toolCallId: 't1', content },
      ],
      tools,
    });
    const denied = toolResultForLlm(
      toOutcome({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'outside_calling_hours', message: 'BharatNet takes calls 09:00-20:00 IST' } }) }] }),
    );
    const r = scriptedOrchestrator(asTool(denied), ctx);
    expect(r.text).toMatch(/only place calls between 09:00 and 20:00 IST/);
    expect(r.text).not.toMatch(/on the line/);
    // Non-ToolError failure text, and the legacy bare-string shape, are errors too.
    const plain = toolResultForLlm(toOutcome({ isError: true, content: [{ type: 'text', text: 'daily call cap reached' }] }));
    expect(scriptedOrchestrator(asTool(plain), ctx).text).toMatch(/couldn't do that: daily call cap reached/);
    const legacy = JSON.stringify({ error: 'case_not_ready: a call is already running' });
    expect(scriptedOrchestrator(asTool(legacy), ctx).text).toMatch(/couldn't do that: case_not_ready: a call is already running/);
    expect(scriptedOrchestrator(asTool(legacy), ctx).text).not.toMatch(/on the line/);
  });
});

describe('LLM-backed orchestrator (OpenAI / Bedrock path)', () => {
  const ctx = { now: new Date('2026-10-22T08:30:00Z'), businesses: [{ name: 'BharatNet Broadband', aliases: [] }] };
  const tools: LlmToolSpec[] = [{ name: 'open_case', description: 'Open a case', inputSchema: { type: 'object' } }];
  const never = [{ key: 'otp', label: 'OTP', value: '482913', tier: 'never' as const, approved: false, source: 'user' as const }];

  class FakeLlm implements LlmProvider {
    readonly name = 'fake';
    readonly seen: ChatRequest[] = [];
    constructor(readonly reply: string | Error) {}
    async chat(req: ChatRequest): Promise<string> {
      this.seen.push(req);
      if (this.reply instanceof Error) throw this.reply;
      return this.reply;
    }
  }

  it('masks never-tier values and secret-shaped text before anything reaches the model', async () => {
    const llm = new FakeLlm(JSON.stringify({ text: 'Okay', toolCalls: [{ name: 'open_case', arguments: { businessName: 'BharatNet' } }, { name: 'rm_rf', arguments: {} }] }));
    const req: SimLlmRequest = { messages: [{ role: 'user', content: 'My broadband is down, the OTP is 482913 and my card is 4111 1111 1111 1111' }], tools };
    const r = await llmOrchestrator(llm, req, { ...ctx, never });
    const sent = JSON.stringify(llm.seen);
    expect(sent).not.toContain('482913');
    expect(sent).not.toContain('4111 1111 1111 1111');
    expect(r.fallback).toBe(false);
    // Unknown tool names are dropped.
    expect(r.response.toolCalls?.map((c) => c.name)).toEqual(['open_case']);
    expect(buildLlmMessages(req, never)[0]?.role).toBe('system');
  });

  it('Bedrock runs a native Converse tool-use loop: MCP tools -> toolConfig.toolSpecs, toolUse -> tool calls (masked)', async () => {
    type Cmd = Parameters<ConverseClient['send']>[0];
    type Out = Awaited<ReturnType<ConverseClient['send']>>;
    const seen: Cmd[] = [];
    const client: ConverseClient = {
      async send(cmd: Cmd): Promise<Out> {
        seen.push(cmd);
        return {
          $metadata: {},
          output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'tooluse_1', name: 'open_case', input: { businessName: 'BharatNet' } } }] } },
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          metrics: { latencyMs: 1 },
        };
      },
    };
    const llm = new BedrockProvider({ region: 'ap-south-1', modelId: 'm', client });
    const req: SimLlmRequest = {
      messages: [
        { role: 'user', content: 'My broadband is down, the OTP is 482913' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc_1_1', name: 'open_case', arguments: { goal: 'otp 482913' } }] },
        { role: 'tool', toolCallId: 'tc_1_1', content: JSON.stringify({ error: { code: 'x', message: 'bad 482913' } }) },
      ],
      tools,
    };
    const r = await llm.chatWithTools(buildToolChatRequest(req, never));
    expect(r.toolCalls[0]?.name).toBe('open_case');
    const out = await llmOrchestrator(llm, req, { ...ctx, never });
    expect(out.fallback).toBe(false);
    expect(out.response.toolCalls).toEqual([{ id: 'tooluse_1', name: 'open_case', arguments: { businessName: 'BharatNet' } }]);
    const input = seen[0]?.input;
    expect(input?.toolConfig?.tools?.[0]).toEqual({ toolSpec: { name: 'open_case', description: 'Open a case', inputSchema: { json: { type: 'object' } } } });
    expect(input?.messages?.[2]?.content?.[0]).toMatchObject({ toolResult: { toolUseId: 'tc_1_1', status: 'error' } });
    expect(JSON.stringify(seen.map((c) => c.input))).not.toContain('482913');
  });

  it('falls back to the scripted matcher on garbage or provider errors', async () => {
    const req: SimLlmRequest = { messages: [{ role: 'user', content: 'My BharatNet broadband has been down for three days, sort it out' }], tools };
    for (const reply of ['not json at all', JSON.stringify({ toolCalls: 'nope' }), new Error('timeout')]) {
      const r = await llmOrchestrator(new FakeLlm(reply), req, { ...ctx, never });
      expect(r.fallback).toBe(true);
      expect(r.response.toolCalls?.[0]?.name).toBe('open_case');
    }
  });
});

describe('scripted orchestrator: delete my case (spec 13)', () => {
  const ctx = { now: new Date('2026-10-22T08:30:00Z'), businesses: [{ name: 'BharatNet Broadband', aliases: [] }] };
  const tools: LlmToolSpec[] = ['open_case', 'delete_case', 'get_case'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
  const opened = JSON.stringify({ case: { id: 'case-1', businessName: 'BharatNet Broadband', status: 'promised', promises: [] }, missingFacts: [] });

  it('asks delete_case for the open case, then reads back the server message', () => {
    const history: SimLlmRequest['messages'] = [
      { role: 'user', content: 'My BharatNet broadband is down' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'open_case', arguments: {} }] },
      { role: 'tool', toolCallId: 't1', content: opened },
      { role: 'assistant', content: 'Okay.' },
      { role: 'user', content: 'Please delete my BharatNet complaint and its transcripts' },
    ];
    const r = scriptedOrchestrator({ messages: history, tools }, ctx);
    expect(r.toolCalls?.[0]).toMatchObject({ name: 'delete_case', arguments: { caseId: 'case-1' } });
    const done = scriptedOrchestrator(
      {
        messages: [
          ...history,
          { role: 'assistant', content: '', toolCalls: [{ id: 't2', name: 'delete_case', arguments: { caseId: 'case-1' } }] },
          { role: 'tool', toolCallId: 't2', content: JSON.stringify({ caseId: 'case-1', deleted: true, callsDeleted: 1, followupsCancelled: 0, message: 'Deleted your case with BharatNet Broadband, 1 call transcript(s).' }) },
        ],
        tools,
      },
      ctx,
    );
    expect(done.text).toBe('Deleted your case with BharatNet Broadband, 1 call transcript(s).');
  });

  it('with no case in the conversation it says so instead of guessing', () => {
    const r = scriptedOrchestrator({ messages: [{ role: 'user', content: 'forget my case' }], tools }, ctx);
    expect(r.toolCalls).toBeUndefined();
    expect(r.text).toMatch(/don't have a case open/);
  });
});
