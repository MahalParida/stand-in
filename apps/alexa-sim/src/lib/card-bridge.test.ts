// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { CallStatusOutput } from '@standin/core';
import { CardHost, MCP_APPS_PROTOCOL_VERSION } from './card-bridge.js';
import { toOutcome } from './mcp.js';
import { autoAnswerPending } from './autoplay.js';

const status: CallStatusOutput = {
  callId: 'call-1',
  caseId: 'case-1',
  state: 'HOLD',
  holdSeconds: 12,
  lastLines: [],
  digitsPressed: ['2'],
  blockedCount: 0,
  injectionCount: 0,
  summary: 'On hold',
};

function setup() {
  const posted: Array<Record<string, unknown>> = [];
  const calls: Array<[string, Record<string, unknown>]> = [];
  let initialised = 0;
  const heights: number[] = [];
  const host = new CardHost({
    session: {
      callTool: async (name, args) => {
        calls.push([name, args]);
        return toOutcome({ content: [], structuredContent: { ...status, state: 'USER_ON_LINE' } });
      },
      readResource: async (uri) => ({ contents: [{ uri, text: '{}' }] }),
    },
    post: (m) => posted.push(m as Record<string, unknown>),
    theme: 'dark',
    callId: 'call-1',
    onInitialized: () => initialised++,
    onSize: (h) => heights.push(h),
  });
  return { host, posted, calls, heights, initialised: () => initialised };
}

describe('CardHost (MCP Apps postMessage bridge)', () => {
  it('answers ui/initialize, then sends tool-input and the queued status once initialised', async () => {
    const t = setup();
    t.host.pushStatus(status);
    expect(t.posted).toHaveLength(0);
    await t.host.handle({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: MCP_APPS_PROTOCOL_VERSION } });
    expect(t.posted[0]).toMatchObject({ id: 1, result: { protocolVersion: MCP_APPS_PROTOCOL_VERSION, hostContext: { theme: 'dark' } } });
    await t.host.handle({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    expect(t.initialised()).toBe(1);
    expect(t.posted.slice(1).map((m) => m.method)).toEqual(['ui/notifications/tool-input', 'ui/notifications/tool-result']);
    expect(t.posted[2]).toMatchObject({ params: { structuredContent: { callId: 'call-1', state: 'HOLD' } } });
    t.host.pushStatus({ ...status, holdSeconds: 13 });
    expect(t.posted).toHaveLength(4);
  });

  it('forwards the open_case / update_case_fact result before any call, so the card leaves "Waiting for the case"', async () => {
    const t = setup();
    const caseResult = { content: [{ type: 'text' as const, text: 'Case opened' }], structuredContent: { case: { id: 'case-1', status: 'draft' }, missingFacts: [{ key: 'account_number', label: 'Account number' }] } };
    t.host.pushCaseResult(caseResult);
    expect(t.posted).toHaveLength(0);
    await t.host.handle({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    const results = t.posted.filter((m) => m.method === 'ui/notifications/tool-result');
    expect(results[0]).toMatchObject({ params: { structuredContent: { case: { id: 'case-1' }, missingFacts: [{ key: 'account_number' }] } } });
    t.host.pushCaseResult({ content: [{ type: 'text', text: 'ready' }], structuredContent: { case: { id: 'case-1', status: 'ready' }, missingFacts: [] } });
    expect(t.posted.at(-1)).toMatchObject({ method: 'ui/notifications/tool-result', params: { structuredContent: { case: { status: 'ready' }, missingFacts: [] } } });
  });

  it('bridges allowed tools/call to MCP and refuses others', async () => {
    const t = setup();
    await t.host.handle({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'handoff_to_user', arguments: { callId: 'call-1', accept: true } } });
    expect(t.calls).toEqual([['handoff_to_user', { callId: 'call-1', accept: true }]]);
    expect(t.posted[0]).toMatchObject({ id: 'a', result: { structuredContent: { state: 'USER_ON_LINE' } } });
    await t.host.handle({ jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'open_case', arguments: {} } });
    expect(t.calls).toHaveLength(1);
    expect(t.posted[1]).toMatchObject({ id: 'b', result: { isError: true } });
  });

  it('reports size changes and rejects unsupported methods', async () => {
    const t = setup();
    await t.host.handle({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 280 } });
    expect(t.heights).toEqual([280]);
    await t.host.handle({ jsonrpc: '2.0', id: 7, method: 'ui/open-link', params: { url: 'https://example.com' } });
    expect(t.posted[0]).toMatchObject({ id: 7, error: { code: -32601 } });
    await t.host.handle('garbage');
    expect(t.posted).toHaveLength(1);
  });
});

describe('autoAnswerPending', () => {
  it('answers only the account number, never a hand-off or a secret', () => {
    expect(autoAnswerPending({ kind: 'fact', factKey: 'account_number', label: 'Registered account number' })).toEqual({ answer: 'BN7781234', approve: false });
    expect(autoAnswerPending({ kind: 'confirm', factKey: 'account_number', label: 'Account number' })).toEqual({ answer: 'BN7781234', approve: true });
    expect(autoAnswerPending({ kind: 'handoff', label: 'Account OTP' })).toBeNull();
    expect(autoAnswerPending({ kind: 'fact', factKey: 'router_serial', label: 'Router serial number' })).toBeNull();
    expect(autoAnswerPending({ kind: 'fact', label: 'Account PIN' })).toBeNull();
  });
});
