// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolErrorSchema, type LlmMessage, type LlmToolSpec, type SimLlmRequest, type SimLlmResponse } from '@standin/core';
import { runTurn, trimHistory } from './orchestrator.js';
import { toOutcome, toLlmToolSpecs, toolResultForLlm } from './mcp.js';
import { mergeLines } from './lines.js';
import { resolveToken, TOKEN_STORAGE_KEY, type StorageLike } from './config.js';

const tools: LlmToolSpec[] = toLlmToolSpecs([
  { name: 'open_case', description: 'Open a case', inputSchema: { type: 'object' } },
  { name: 'place_call', description: 'Place the call', inputSchema: { type: 'object' } },
]);

const result = (structuredContent: Record<string, unknown>): CallToolResult => ({ content: [], structuredContent });

describe('runTurn', () => {
  it('loops llm -> tool calls -> llm until text, feeding tool results back', async () => {
    const requests: SimLlmRequest[] = [];
    const replies: SimLlmResponse[] = [
      { toolCalls: [{ id: 't1', name: 'open_case', arguments: { businessName: 'BharatNet', goal: 'fix broadband', desiredOutcome: 'repair' } }] },
      { toolCalls: [{ id: 't2', name: 'place_call', arguments: { caseId: 'case-1' } }] },
      { text: "I'm calling BharatNet now." },
    ];
    const called: string[] = [];
    const r = await runTurn([], 'my broadband is down, OTP 482913', {
      tools,
      scenarioHint: 'happy',
      llm: async (req) => {
        requests.push(structuredClone(req));
        const next = replies.shift();
        if (next === undefined) throw new Error('no more');
        return next;
      },
      callTool: async (name) => {
        called.push(name);
        return toOutcome(result(name === 'place_call' ? { callId: 'call-1', caseId: 'case-1', state: 'DIALING' } : { ok: true }));
      },
    });
    expect(r.reply).toBe("I'm calling BharatNet now.");
    expect(called).toEqual(['open_case', 'place_call']);
    expect(r.toolCalls).toBe(2);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.scenarioHint).toBe('happy');
    // The user's secret never reaches the LLM proxy.
    expect(JSON.stringify(requests)).not.toContain('482913');
    const last = requests[2]?.messages ?? [];
    expect(last.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(last[4]).toMatchObject({ role: 'tool', toolCallId: 't2' });
    expect(JSON.parse(last[4]?.content ?? '{}')).toMatchObject({ callId: 'call-1' });
  });

  it('rejects unknown tools and invalid arguments without calling MCP', async () => {
    const replies: SimLlmResponse[] = [
      { toolCalls: [{ id: 'a', name: 'rm_rf', arguments: {} }, { id: 'b', name: 'place_call', arguments: { simulatedHourIst: 99 } }] },
      { text: 'ok' },
    ];
    let calls = 0;
    const r = await runTurn([], 'hi', {
      tools,
      llm: async () => replies.shift() ?? { text: 'x' },
      callTool: async () => {
        calls++;
        return toOutcome(result({}));
      },
    });
    expect(calls).toBe(0);
    // Every failure goes back to the LLM as the spec-7 ToolError object.
    const toolMsgs = r.history.filter((m) => m.role === 'tool').map((m) => ToolErrorSchema.parse(JSON.parse(m.content)));
    expect(toolMsgs[0]?.error).toMatchObject({ code: 'unknown_tool', message: expect.stringMatching(/unknown tool/) });
    expect(toolMsgs[1]?.error).toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/invalid arguments/) });
  });

  it('gives up with a fallback after maxSteps of tool calls', async () => {
    const r = await runTurn([], 'loop', {
      tools,
      maxSteps: 2,
      llm: async () => ({ toolCalls: [{ id: 'x', name: 'open_case', arguments: { businessName: 'B', goal: 'g', desiredOutcome: 'info' } }] }),
      callTool: async () => toOutcome(result({})),
    });
    expect(r.reply).toMatch(/couldn't finish/);
  });

  it('trims history at a user boundary', () => {
    const h: LlmMessage[] = [];
    for (let i = 0; i < 10; i++) {
      h.push({ role: 'user', content: `u${i}` }, { role: 'assistant', content: '', toolCalls: [{ id: `t${i}`, name: 'x', arguments: {} }] }, { role: 'tool', toolCallId: `t${i}`, content: '{}' });
    }
    const t = trimHistory(h, 8);
    expect(t[0]?.role).toBe('user');
    expect(t.length).toBeLessThanOrEqual(8);
  });
});

describe('tool outcomes', () => {
  it('surfaces the contract error payload', () => {
    const o = toOutcome({ content: [{ type: 'text', text: 'denied' }], structuredContent: { error: { code: 'off_hours', message: 'Outside calling hours' } }, isError: true });
    expect(o).toMatchObject({ ok: false, error: 'off_hours: Outside calling hours' });
  });
  it('reads a ToolError sent only as text (no structuredContent, as the server sends it)', () => {
    const o = toOutcome({ content: [{ type: 'text', text: JSON.stringify({ error: { code: 'outside_calling_hours', message: 'It is 23:00 IST.' } }) }], isError: true });
    expect(o).toMatchObject({ ok: false, errorCode: 'outside_calling_hours', error: 'outside_calling_hours: It is 23:00 IST.' });
    expect(o.structured).toEqual({ error: { code: 'outside_calling_hours', message: 'It is 23:00 IST.' } });
  });
  it('sends a failed tool to the LLM as the ToolError object, not a string', () => {
    const text = toOutcome({ content: [{ type: 'text', text: JSON.stringify({ error: { code: 'outside_calling_hours', message: 'BharatNet takes calls 09:00-20:00 IST' } }) }], isError: true });
    expect(JSON.parse(toolResultForLlm(text))).toEqual({ error: { code: 'outside_calling_hours', message: 'BharatNet takes calls 09:00-20:00 IST' } });
    const plain = toOutcome({ content: [{ type: 'text', text: 'boom' }], isError: true });
    expect(ToolErrorSchema.parse(JSON.parse(toolResultForLlm(plain)))).toEqual({ error: { code: 'tool_error', message: 'boom' } });
  });
});

describe('mergeLines', () => {
  const at = '2026-10-22T09:00:00.000Z';
  it('appends unseen lines, masks secrets and flags gaps', () => {
    const a = mergeLines([], [{ speaker: 'ivr', text: 'Welcome', at }]);
    expect(a.added).toHaveLength(1);
    const b = mergeLines(a.lines, [
      { speaker: 'ivr', text: 'Welcome', at },
      { speaker: 'agent', text: 'Read me the OTP 482913', at },
    ]);
    expect(b.added).toHaveLength(1);
    expect(b.lines[1]?.text).not.toContain('482913');
    expect(b.gap).toBe(false);
    const c = mergeLines(b.lines, [
      { speaker: 'agent', text: 'x', at: '2026-10-22T09:01:00.000Z' },
      { speaker: 'agent', text: 'y', at: '2026-10-22T09:01:01.000Z' },
      { speaker: 'agent', text: 'z', at: '2026-10-22T09:01:02.000Z' },
    ]);
    expect(c.gap).toBe(true);
  });
});

describe('resolveToken', () => {
  const mem = (): StorageLike & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };
  it('prefers ?token=, then the demo token, then sessionStorage', () => {
    const s = mem();
    expect(resolveToken({ demoToken: 'demo' }, '?token=url', s)).toEqual({ token: 'url', source: 'url' });
    expect(s.data.get(TOKEN_STORAGE_KEY)).toBe('url');
    expect(resolveToken({ demoToken: 'demo' }, '', s)).toEqual({ token: 'demo', source: 'demo' });
    expect(resolveToken({}, '', s)).toEqual({ token: 'url', source: 'session' });
    expect(resolveToken({}, '', mem())).toBeUndefined();
  });
});
