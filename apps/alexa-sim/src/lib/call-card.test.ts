// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { CallStatusOutputSchema, failureCopy, type CallState, type CallStatusOutput } from '@standin/core';
import { CARD_STAGES, RACE_SCALE, autoHoldScale, formatHold, mapCallStatus, racingHoldSeconds, takeoverButton } from './call-card.js';

const at = '2026-10-22T09:00:00.000Z';

function status(state: CallState, over: Partial<CallStatusOutput> = {}): CallStatusOutput {
  // Validate fixtures against the shared contract so the tests track it.
  return CallStatusOutputSchema.parse({
    callId: 'call-1',
    caseId: 'case-1',
    state,
    holdSeconds: 0,
    lastLines: [],
    digitsPressed: [],
    blockedCount: 0,
    injectionCount: 0,
    summary: `state ${state}`,
    ...over,
  });
}

describe('mapCallStatus', () => {
  it('maps every call state onto the 7 card stages', () => {
    const expected: Record<CallState, string> = {
      DIALING: 'dialing',
      IVR: 'menu',
      HOLD: 'hold',
      HUMAN: 'talking',
      HANDOFF_PENDING: 'needs_you',
      USER_ON_LINE: 'talking',
      WRAP_UP: 'talking',
      ENDED: 'done',
      FAILED: 'done',
    };
    for (const [state, stage] of Object.entries(expected) as Array<[CallState, string]>) {
      expect(mapCallStatus(status(state)).stage, state).toBe(stage);
    }
    expect(CARD_STAGES).toHaveLength(7);
  });

  it('is Preparing before any call, with "Case ready" once the case is ready', () => {
    expect(mapCallStatus(undefined)).toMatchObject({ stage: 'preparing', headline: 'Preparing case', active: false });
    expect(mapCallStatus(undefined, { caseReady: true, businessName: 'BharatNet Broadband' })).toMatchObject({
      stage: 'preparing',
      headline: 'Case ready',
      detail: 'Ready to call BharatNet Broadband',
    });
  });

  it('shows digits pressed in the menu and the hold seconds on hold', () => {
    const menu = mapCallStatus(status('IVR', { digitsPressed: ['2'] }));
    expect(menu.digits).toEqual(['2']);
    expect(menu.detail).toBe('Pressed 2');
    expect(mapCallStatus(status('HOLD', { holdSeconds: 95 })).holdSeconds).toBe(95);
  });

  it('keeps only the last 4 transcript lines while talking', () => {
    const lines = Array.from({ length: 6 }, (_, i) => ({ speaker: 'agent' as const, text: `line ${i}`, at }));
    const v = mapCallStatus(status('HUMAN', { lastLines: lines }));
    expect(v.lines.map((l) => l.text)).toEqual(['line 2', 'line 3', 'line 4', 'line 5']);
  });

  it('HANDOFF_PENDING is "Needs you" with Join / Decline', () => {
    const v = mapCallStatus(
      status('HANDOFF_PENDING', { pendingQuestion: { id: 'q', kind: 'handoff', label: 'One-time password', askedText: 'I need the OTP we sent.' } }),
      { businessName: 'BharatNet Broadband' },
    );
    expect(v).toMatchObject({ stage: 'needs_you', headline: 'BharatNet Broadband needs to verify you', detail: 'I need the OTP we sent.' });
    expect(v.actions).toEqual(['join', 'decline']);
  });

  it('a mid-call fact question (S4) while talking is "Needs you" with Answer', () => {
    const v = mapCallStatus(
      status('HUMAN', { pendingQuestion: { id: 'q', kind: 'fact', factKey: 'router_serial', label: 'Router serial number', askedText: 'What is the router serial?' } }),
    );
    expect(v.stage).toBe('needs_you');
    expect(v.actions).toEqual(['answer', 'end']);
  });

  it('the user on the line can leave', () => {
    expect(mapCallStatus(status('USER_ON_LINE')).actions).toEqual(['leave']);
  });

  it('Done carries ticket, promise, due date and follow-up', () => {
    const v = mapCallStatus(
      status('ENDED', {
        outcome: { ticketId: 'SR-48211', what: 'Technician tomorrow 10–12, ₹300 credit', dueBy: '2026-10-23', agentName: 'Ravi' },
        followupScheduled: { jobId: 'job-1', runAt: '2026-10-24T09:00:00.000Z' },
      }),
    );
    expect(v).toMatchObject({
      stage: 'done',
      failed: false,
      active: false,
      ticketId: 'SR-48211',
      dueBy: '2026-10-23',
      outcomeWhat: 'Technician tomorrow 10–12, ₹300 credit',
      followupScheduled: true,
      headline: 'Done · SR-48211',
      actions: [],
    });
  });

  it('FAILED is a failed Done with the honest summary and no pending prompt', () => {
    const v = mapCallStatus(
      status('FAILED', {
        failureReason: 'ivr_dead_end',
        summary: 'The phone menu kept looping, so I hung up.',
        pendingQuestion: { id: 'q', kind: 'handoff', label: 'OTP', askedText: 'x' },
      }),
    );
    expect(v).toMatchObject({ stage: 'done', failed: true, detail: 'The phone menu kept looping, so I hung up.', active: false });
    expect(v.headline).toBe('Stuck in the phone menu');
  });

  it('every FAILED reason gets its own headline (server_restart, carrier_error, ...)', () => {
    expect(mapCallStatus(status('FAILED', { failureReason: 'server_restart', summary: 's' })).headline).toBe(failureCopy('server_restart').headline);
    expect(mapCallStatus(status('FAILED', { failureReason: 'carrier_error', summary: 's' })).headline).toBe('Phone line failed');
    expect(mapCallStatus(status('FAILED', { summary: 's' })).headline).toBe(failureCopy('error').headline);
  });

  it('a refused place_call (no call) renders an honest "Not called" card, not "Case ready"', () => {
    for (const reason of ['outside_calling_hours', 'not_allowlisted', 'daily_cap_reached', 'call_setup_failed'] as const) {
      const message = failureCopy(reason, { businessName: 'BharatNet Broadband' }).message;
      const v = mapCallStatus(undefined, { caseReady: true, businessName: 'BharatNet Broadband', refusal: { reason, message } });
      expect(v).toMatchObject({ stage: 'done', failed: true, badge: 'Not called', headline: failureCopy(reason).headline, detail: message, active: false, actions: [] });
    }
  });

  it('passes the guard counters through', () => {
    expect(mapCallStatus(status('HUMAN', { blockedCount: 2, injectionCount: 1 }))).toMatchObject({ blockedCount: 2, injectionCount: 1 });
  });
});

describe('hold timer', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatHold(0)).toBe('0:00');
    expect(formatHold(2292)).toBe('38:12');
    expect(formatHold(3729)).toBe('1:02:09');
    expect(formatHold(-5)).toBe('0:00');
  });

  it('races holdSeconds by the scale and keeps counting between polls', () => {
    expect(racingHoldSeconds(6, 0, RACE_SCALE, true)).toBe(6 * RACE_SCALE);
    expect(formatHold(racingHoldSeconds(6, 0, RACE_SCALE, true))).toBe('38:12');
    expect(racingHoldSeconds(6, 500, 1, true)).toBeCloseTo(6.5);
    expect(racingHoldSeconds(6, 60_000, 1, true)).toBeCloseTo(7.5); // capped extrapolation
    expect(racingHoldSeconds(6, 500, 1, false)).toBe(6);
  });

  it('auto scale: races real-time holds, leaves sim-clock holds alone', () => {
    expect(autoHoldScale({ holdSeconds: 0, atMs: 0 }, { holdSeconds: 1, atMs: 1000 })).toBeUndefined();
    expect(autoHoldScale({ holdSeconds: 0, atMs: 0 }, { holdSeconds: 2, atMs: 2000 })).toBe(RACE_SCALE);
    expect(autoHoldScale({ holdSeconds: 0, atMs: 0 }, { holdSeconds: 120, atMs: 2000 })).toBe(1);
  });
});

describe('takeoverButton', () => {
  it('is live while a person is on the line or a hand-off waits, "Hand back" on the line, disabled in menu/hold', () => {
    expect(takeoverButton('HUMAN')).toMatchObject({ label: 'Take over call', action: 'join' });
    expect(takeoverButton('HANDOFF_PENDING')).toMatchObject({ action: 'join' });
    expect(takeoverButton('USER_ON_LINE')).toMatchObject({ label: 'Hand back', action: 'leave' });
    for (const st of ['DIALING', 'IVR', 'HOLD', 'WRAP_UP', undefined]) expect(takeoverButton(st).action).toBeUndefined();
  });
});
