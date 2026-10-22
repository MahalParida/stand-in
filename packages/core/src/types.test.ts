import { describe, expect, it } from 'vitest';
import { InboundFrameSchema, PlannerOutputSchema } from './index.js';

describe('PlannerOutputSchema (spec 5.2)', () => {
  it('accepts well-formed actions', () => {
    expect(PlannerOutputSchema.safeParse({ action: 'say', utterance: 'My order is {{fact:order_id}}', reason: 'asked' }).success).toBe(true);
    expect(PlannerOutputSchema.safeParse({ action: 'press', digits: '2', reason: 'billing' }).success).toBe(true);
    expect(PlannerOutputSchema.safeParse({ action: 'wait', reason: 'hold' }).success).toBe(true);
    expect(
      PlannerOutputSchema.safeParse({
        action: 'confirm_outcome',
        outcome: { ticketId: 'T1', what: 'refund' },
        reason: 'agent confirmed',
      }).success,
    ).toBe(true);
  });

  it('requires the field each action needs', () => {
    expect(PlannerOutputSchema.safeParse({ action: 'say', reason: 'x' }).success).toBe(false);
    expect(PlannerOutputSchema.safeParse({ action: 'press', reason: 'x' }).success).toBe(false);
    expect(PlannerOutputSchema.safeParse({ action: 'press', digits: '1; rm', reason: 'x' }).success).toBe(false);
    expect(PlannerOutputSchema.safeParse({ action: 'confirm_outcome', reason: 'x' }).success).toBe(false);
    expect(PlannerOutputSchema.safeParse({ action: 'dial', reason: 'x' }).success).toBe(false);
    expect(PlannerOutputSchema.safeParse({ action: 'wait' }).success).toBe(false);
  });
});

describe('InboundFrameSchema', () => {
  it('accepts sim frames with optional audio', () => {
    expect(InboundFrameSchema.safeParse({ kind: 'ivr_prompt', text: 'Press 1', speaker: 'ivr' }).success).toBe(true);
    expect(InboundFrameSchema.safeParse({ kind: 'hold', text: '', audio: new Uint8Array([1, 2]) }).success).toBe(true);
    expect(InboundFrameSchema.safeParse({ kind: 'hangup', text: '' }).success).toBe(true);
    expect(InboundFrameSchema.safeParse({ kind: 'speech', text: 'hi', speaker: 'user' }).success).toBe(false);
  });
});
