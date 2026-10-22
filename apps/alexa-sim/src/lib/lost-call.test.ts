import { CallStatusOutputSchema } from '@standin/core';
import { describe, expect, it } from 'vitest';
import { toOutcome } from './mcp.js';
import { isCallLost, lostCallStatus, MAX_POLL_TOOL_ERRORS } from './lost-call.js';

const notFound = toOutcome({ content: [{ type: 'text', text: JSON.stringify({ error: { code: 'not_found', message: 'call call-1 not found' } }) }], isError: true });
const internal = toOutcome({ content: [{ type: 'text', text: JSON.stringify({ error: { code: 'internal_error', message: 'internal error (Error)' } }) }], isError: true });
const ok = toOutcome({ content: [], structuredContent: { state: 'HOLD' } });

describe('lost call detection (server restarted mid-call)', () => {
  it('a not_found call_status ends polling at once; other tool errors only after a streak', () => {
    expect(isCallLost(notFound, 1)).toBe(true);
    expect(isCallLost(internal, 1)).toBe(false);
    expect(isCallLost(internal, MAX_POLL_TOOL_ERRORS)).toBe(true);
    expect(isCallLost(ok, 99)).toBe(false);
  });

  it('builds a valid terminal FAILED status that keeps what the card showed', () => {
    const prev = CallStatusOutputSchema.parse({
      callId: 'call-1',
      caseId: 'case-1',
      state: 'HOLD',
      holdSeconds: 42,
      lastLines: [{ speaker: 'ivr', text: 'Please hold', at: '2026-10-22T09:00:00.000Z' }],
      digitsPressed: ['2'],
      blockedCount: 0,
      injectionCount: 0,
      summary: 'On hold.',
    });
    const s = CallStatusOutputSchema.parse(lostCallStatus('call-1', 'case-1', prev));
    expect(s).toMatchObject({ state: 'FAILED', failureReason: 'server_restart', holdSeconds: 42, digitsPressed: ['2'] });
    expect(s.summary).toMatch(/restarted.*try again/);
    expect(CallStatusOutputSchema.safeParse(lostCallStatus('call-2', 'case-2', undefined)).success).toBe(true);
  });
});
