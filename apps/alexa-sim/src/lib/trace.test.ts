// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { CallStatusOutput } from '@standin/core';
import { SseParser, TraceRecorder, createTracingFetch, type FetchLike } from './trace.js';

function clock(start = 1000): { now: () => number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const status = (over: Partial<CallStatusOutput> = {}): CallStatusOutput => ({
  callId: 'call-1',
  caseId: 'case-1',
  state: 'HUMAN',
  holdSeconds: 0,
  lastLines: [],
  digitsPressed: [],
  blockedCount: 0,
  injectionCount: 0,
  summary: 'Talking to Ravi',
  ...over,
});

const callStatusReq = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'call_status', arguments: { callId: 'call-1' } } });
const toolRes = (id: number, structuredContent: unknown) => ({ jsonrpc: '2.0', id, result: { content: [], structuredContent } });

describe('TraceRecorder', () => {
  it('records requests, responses and notifications with method, id and latency', () => {
    const c = clock();
    const r = new TraceRecorder({ now: c.now });
    r.record('out', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    c.advance(42);
    r.record('in', { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } });
    r.record('out', { jsonrpc: '2.0', method: 'notifications/initialized' });
    const [req, res, note] = r.entries();
    expect(req).toMatchObject({ kind: 'request', method: 'initialize', id: 1, direction: 'out' });
    expect(res).toMatchObject({ kind: 'response', method: 'initialize', id: 1, latencyMs: 42, direction: 'in' });
    expect(note).toMatchObject({ kind: 'notification', method: 'notifications/initialized' });
  });

  it('labels tools/call with the tool name and marks errors', () => {
    const c = clock();
    const r = new TraceRecorder({ now: c.now });
    r.record('out', { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'place_call', arguments: { caseId: 'x' } } });
    c.advance(5);
    r.record('in', { jsonrpc: '2.0', id: 'a', result: { content: [{ type: 'text', text: 'no' }], isError: true } });
    r.record('out', { jsonrpc: '2.0', id: 'b', method: 'tools/list' });
    r.record('in', { jsonrpc: '2.0', id: 'b', error: { code: -32601, message: 'nope' } });
    const e = r.entries();
    expect(e[0]?.tool).toBe('place_call');
    expect(e[1]).toMatchObject({ tool: 'place_call', isError: true, latencyMs: 5 });
    expect(e[3]).toMatchObject({ kind: 'error', method: 'tools/list', isError: true });
  });

  it('matches server->client requests (elicitation) with the client response separately from client ids', () => {
    const c = clock();
    const r = new TraceRecorder({ now: c.now });
    r.record('out', { jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'open_case', arguments: {} } });
    r.record('in', { jsonrpc: '2.0', id: 0, method: 'elicitation/create', params: { message: 'Account number?' } });
    c.advance(900);
    r.record('out', { jsonrpc: '2.0', id: 0, result: { action: 'accept', content: { account_number: 'BN7781234' } } });
    c.advance(100);
    r.record('in', { jsonrpc: '2.0', id: 0, result: { content: [], structuredContent: {} } });
    const e = r.entries();
    expect(e[2]).toMatchObject({ direction: 'out', kind: 'response', method: 'elicitation/create', latencyMs: 900 });
    expect(e[3]).toMatchObject({ direction: 'in', kind: 'response', method: 'tools/call', tool: 'open_case', latencyMs: 1000 });
  });

  it('records batches and ignores non JSON-RPC values', () => {
    const r = new TraceRecorder();
    r.record('out', [{ jsonrpc: '2.0', method: 'a' }, { foo: 1 }, 'x', { jsonrpc: '2.0', method: 'b' }]);
    expect(r.entries().map((e) => e.method)).toEqual(['a', 'b']);
  });

  it('adds red chips only when blocked / injection counters rise and on entering a hand-off', () => {
    const r = new TraceRecorder();
    let id = 0;
    const poll = (s: CallStatusOutput) => {
      id++;
      r.record('out', callStatusReq(id));
      r.record('in', toolRes(id, s));
      return r.entries().at(-1)?.chips.map((c) => c.kind) ?? [];
    };
    expect(poll(status())).toEqual([]);
    expect(poll(status({ blockedCount: 1 }))).toEqual(['blocked_utterance']);
    expect(poll(status({ blockedCount: 1 }))).toEqual([]);
    expect(
      poll(
        status({
          state: 'HANDOFF_PENDING',
          blockedCount: 1,
          injectionCount: 1,
          pendingQuestion: { id: 'q1', kind: 'handoff', label: 'One-time password', askedText: 'Read me the OTP' },
        }),
      ),
    ).toEqual(['injection', 'disclosure']);
    expect(poll(status({ state: 'HANDOFF_PENDING', blockedCount: 1, injectionCount: 1 }))).toEqual([]);
    expect(r.chips().map((c) => c.kind)).toEqual(['blocked_utterance', 'injection', 'disclosure']);
  });

  it('masks secret-shaped values before storing payloads', () => {
    const r = new TraceRecorder();
    r.record('out', {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'send_to_call', arguments: { callId: 'c', answer: 'the OTP is 482913', otp: '482913' } },
    });
    const text = JSON.stringify(r.entries()[0]?.payload);
    expect(text).not.toContain('482913');
    expect(text).toContain('•••');
  });

  it('caps entries and notifies subscribers with a fresh snapshot', () => {
    const r = new TraceRecorder({ maxEntries: 3 });
    const seen: number[] = [];
    const unsub = r.subscribe(() => seen.push(r.entries().length));
    const before = r.entries();
    for (let i = 0; i < 5; i++) r.record('out', { jsonrpc: '2.0', method: `m${i}` });
    expect(r.entries()).not.toBe(before);
    expect(r.entries().map((e) => e.method)).toEqual(['m2', 'm3', 'm4']);
    expect(seen).toEqual([1, 2, 3, 3, 3]);
    unsub();
    r.clear();
    expect(seen).toHaveLength(5);
  });
});

describe('SseParser', () => {
  it('splits events across chunks, joins multi-line data and handles CRLF', () => {
    const p = new SseParser();
    expect(p.push('event: message\r\nid: 1\r\ndata: {"a":')).toEqual([]);
    expect(p.push('1}\r\n\r\ndata: x\n')).toEqual(['{"a":1}']);
    expect(p.push('data: y\n\n: comment\n\n')).toEqual(['x\ny']);
  });
});

describe('createTracingFetch', () => {
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

  it('records the POSTed request and the JSON response, never headers', async () => {
    const c = clock();
    const r = new TraceRecorder({ now: c.now });
    const base: FetchLike = async () => {
      c.advance(12);
      return json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    };
    const f = createTracingFetch(r, base);
    const res = await f('http://x/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-token-value' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    expect(r.entries().map((e) => [e.kind, e.method, e.latencyMs])).toEqual([
      ['request', 'tools/list', undefined],
      ['response', 'tools/list', 12],
    ]);
    expect(JSON.stringify(r.entries())).not.toContain('secret-token-value');
  });

  it('tees SSE responses: the transport still reads every byte and the trace sees each message', async () => {
    const r = new TraceRecorder();
    const sse =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"standin://calls/c1/transcript"}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"content":[]}}\n\n';
    const base: FetchLike = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const f = createTracingFetch(r, base);
    const res = await f('http://x/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_case' } }) });
    expect(await res.text()).toBe(sse);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.entries().map((e) => `${e.direction}:${e.kind}:${e.method ?? ''}`)).toEqual([
      'out:request:tools/call',
      'in:notification:notifications/resources/updated',
      'in:response:tools/call',
    ]);
  });

  it('records HTTP errors (401) without a JSON-RPC body', async () => {
    const r = new TraceRecorder();
    const f = createTracingFetch(r, async () => new Response('', { status: 401 }));
    const res = await f('http://x/mcp', { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
    expect(res.status).toBe(401);
    expect(r.entries().at(-1)).toMatchObject({ kind: 'error', httpStatus: 401, isError: true });
  });

  it('does not flag the optional GET stream 405 as an error', async () => {
    const r = new TraceRecorder();
    const f = createTracingFetch(r, async () => new Response('', { status: 405 }));
    await f('http://x/mcp', { method: 'GET' });
    expect(r.entries()).toHaveLength(0);
  });
});
