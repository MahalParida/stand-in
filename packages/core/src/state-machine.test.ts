import { describe, expect, it } from 'vitest';
import {
  CallStateSchema,
  HANDOFF_DECLINED_UTTERANCE,
  createCallSnapshot,
  runInputs,
  transition,
  type CallEffect,
  type CallInput,
  type CallSnapshot,
  type CallState,
  type TransitionResult,
} from './index.js';

const T0 = 1_760_000_000_000;
const SEC = 1000;

function ok(r: TransitionResult): { snapshot: CallSnapshot; effects: CallEffect[] } {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

/** Drive a fresh call into `state` (at T0 + few seconds). */
function reach(state: CallState): CallSnapshot {
  const s0 = createCallSnapshot('call-1', T0);
  const paths: Record<CallState, CallInput[]> = {
    DIALING: [],
    IVR: [{ type: 'connected', at: T0 + 1 }],
    HOLD: [
      { type: 'connected', at: T0 + 1 },
      { type: 'hold_detected', at: T0 + 2 },
    ],
    HUMAN: [
      { type: 'connected', at: T0 + 1 },
      { type: 'hold_detected', at: T0 + 2 },
      { type: 'human_detected', at: T0 + 3 },
    ],
    HANDOFF_PENDING: [
      { type: 'connected', at: T0 + 1 },
      { type: 'hold_detected', at: T0 + 2 },
      { type: 'human_detected', at: T0 + 3 },
      { type: 'disclosure_request', at: T0 + 4, tier: 'never', factKey: 'otp' },
    ],
    USER_ON_LINE: [
      { type: 'connected', at: T0 + 1 },
      { type: 'hold_detected', at: T0 + 2 },
      { type: 'human_detected', at: T0 + 3 },
      { type: 'disclosure_request', at: T0 + 4, tier: 'never' },
      { type: 'user_accepts', at: T0 + 5 },
    ],
    WRAP_UP: [
      { type: 'connected', at: T0 + 1 },
      { type: 'human_detected', at: T0 + 2 },
      { type: 'outcome_detected', at: T0 + 3, outcome: { ticketId: 'TKT-1', what: 'refund', dueBy: '5 days' } },
    ],
    ENDED: [
      { type: 'connected', at: T0 + 1 },
      { type: 'end', at: T0 + 2 },
    ],
    FAILED: [{ type: 'error', at: T0 + 1, reason: 'dial_failed' }],
  };
  const r = runInputs(s0, paths[state]);
  if (r.error) throw new Error(r.error.message);
  expect(r.snapshot.state).toBe(state);
  return r.snapshot;
}

const types = (effects: CallEffect[]): string[] => effects.map((e) => e.type);

describe('state machine: happy-path edges (spec 5.1)', () => {
  it('DIALING --connected--> IVR', () => {
    const r = ok(transition(reach('DIALING'), { type: 'connected', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('IVR');
    expect(r.effects[0]).toEqual({ type: 'state_changed', from: 'DIALING', to: 'IVR' });
  });

  it('IVR --menu_prompt--> IVR asks the planner', () => {
    const r = ok(transition(reach('IVR'), { type: 'menu_prompt', at: T0 + 10, text: 'Press 1 for billing' }));
    expect(r.snapshot.state).toBe('IVR');
    expect(r.effects).toEqual([{ type: 'request_plan' }]);
  });

  it('IVR --dtmf--> IVR presses digits', () => {
    const r = ok(transition(reach('IVR'), { type: 'dtmf', at: T0 + 10, digits: '2' }));
    expect(r.snapshot.state).toBe('IVR');
    expect(r.effects).toEqual([{ type: 'press_digits', digits: '2' }]);
  });

  it('IVR --hold_detected--> HOLD', () => {
    expect(ok(transition(reach('IVR'), { type: 'hold_detected', at: T0 + 10 })).snapshot.state).toBe('HOLD');
  });

  it('IVR --human_detected--> HUMAN (direct routing)', () => {
    expect(ok(transition(reach('IVR'), { type: 'human_detected', at: T0 + 10 })).snapshot.state).toBe('HUMAN');
  });

  it('HOLD --human_detected--> HUMAN and requests a plan', () => {
    const r = ok(transition(reach('HOLD'), { type: 'human_detected', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('HUMAN');
    expect(types(r.effects)).toEqual(['state_changed', 'request_plan']);
  });

  it('HOLD --hold_detected--> HOLD (no state change)', () => {
    const r = ok(transition(reach('HOLD'), { type: 'hold_detected', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('HOLD');
    expect(r.effects).toEqual([]);
  });

  it('HUMAN --hold_detected--> HOLD', () => {
    expect(ok(transition(reach('HUMAN'), { type: 'hold_detected', at: T0 + 10 })).snapshot.state).toBe('HOLD');
  });

  it('HUMAN --disclosure_request(never)--> HANDOFF_PENDING with 60s timer', () => {
    const r = ok(
      transition(reach('HUMAN'), { type: 'disclosure_request', at: T0 + 10, tier: 'never', factKey: 'otp' }),
    );
    expect(r.snapshot.state).toBe('HANDOFF_PENDING');
    expect(r.snapshot.handoffStartedAt).toBe(T0 + 10);
    expect(r.snapshot.handoffFactKey).toBe('otp');
    expect(r.effects).toContainEqual({ type: 'request_handoff', factKey: 'otp' });
    expect(r.effects).toContainEqual({ type: 'start_timer', name: 'handoff', ms: 60_000 });
  });

  it.each(['share', 'confirm'] as const)('HUMAN --disclosure_request(%s)--> HUMAN asks approval', (tier) => {
    const r = ok(transition(reach('HUMAN'), { type: 'disclosure_request', at: T0 + 10, tier, factKey: 'email' }));
    expect(r.snapshot.state).toBe('HUMAN');
    expect(r.effects).toEqual([{ type: 'request_disclosure_approval', tier, factKey: 'email' }]);
  });

  it('HANDOFF_PENDING --user_accepts--> USER_ON_LINE bridges the user', () => {
    const r = ok(transition(reach('HANDOFF_PENDING'), { type: 'user_accepts', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('USER_ON_LINE');
    expect(r.snapshot.handoffStartedAt).toBeUndefined();
    expect(types(r.effects)).toEqual(['state_changed', 'cancel_timer', 'bridge_user']);
  });

  it('USER_ON_LINE --user_leaves--> HUMAN unbridges', () => {
    const r = ok(transition(reach('USER_ON_LINE'), { type: 'user_leaves', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('HUMAN');
    expect(types(r.effects)).toEqual(['state_changed', 'unbridge_user', 'request_plan']);
  });

  it('HANDOFF_PENDING --user_declines--> HUMAN and says they will call back', () => {
    const r = ok(transition(reach('HANDOFF_PENDING'), { type: 'user_declines', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('HUMAN');
    expect(r.effects).toContainEqual({ type: 'say', text: HANDOFF_DECLINED_UTTERANCE });
    expect(r.effects).toContainEqual({ type: 'cancel_timer', name: 'handoff' });
  });

  it('HANDOFF_PENDING --tick after 60s--> HUMAN (timeout)', () => {
    const s = reach('HANDOFF_PENDING'); // entered at T0+4
    const early = ok(transition(s, { type: 'tick', at: T0 + 4 + 59 * SEC }));
    expect(early.snapshot.state).toBe('HANDOFF_PENDING');
    const r = ok(transition(early.snapshot, { type: 'tick', at: T0 + 4 + 60 * SEC }));
    expect(r.snapshot.state).toBe('HUMAN');
    expect(r.effects[0]).toEqual({ type: 'state_changed', from: 'HANDOFF_PENDING', to: 'HUMAN', reason: 'handoff_timeout' });
    expect(r.effects).toContainEqual({ type: 'say', text: HANDOFF_DECLINED_UTTERANCE });
  });

  it('a late user_accepts after the 60s timeout resolves as timeout, not a bridge', () => {
    const r = ok(transition(reach('HANDOFF_PENDING'), { type: 'user_accepts', at: T0 + 4 + 61 * SEC }));
    expect(r.snapshot.state).toBe('HUMAN');
    expect(types(r.effects)).not.toContain('bridge_user');
  });

  it('HUMAN --outcome_detected--> WRAP_UP reads back', () => {
    const outcome = { ticketId: 'TKT-9', what: 'refund ₹2,499', dueBy: '7 days' };
    const r = ok(transition(reach('HUMAN'), { type: 'outcome_detected', at: T0 + 10, outcome }));
    expect(r.snapshot.state).toBe('WRAP_UP');
    expect(r.snapshot.pendingOutcome).toEqual(outcome);
    expect(r.effects).toContainEqual({ type: 'read_back_outcome', outcome });
  });

  it('WRAP_UP --outcome_confirmed--> ENDED records outcome and hangs up', () => {
    const r = ok(transition(reach('WRAP_UP'), { type: 'outcome_confirmed', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('ENDED');
    expect(r.snapshot.outcome?.ticketId).toBe('TKT-1');
    expect(r.snapshot.pendingOutcome).toBeUndefined();
    expect(types(r.effects)).toEqual(['state_changed', 'record_outcome', 'hangup']);
  });

  it('WRAP_UP --outcome_rejected--> HUMAN', () => {
    const r = ok(transition(reach('WRAP_UP'), { type: 'outcome_rejected', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('HUMAN');
    expect(r.snapshot.pendingOutcome).toBeUndefined();
  });

  it('WRAP_UP --outcome_detected--> WRAP_UP updates the pending outcome', () => {
    const outcome = { ticketId: 'TKT-2', what: 'refund' };
    const r = ok(transition(reach('WRAP_UP'), { type: 'outcome_detected', at: T0 + 10, outcome }));
    expect(r.snapshot.state).toBe('WRAP_UP');
    expect(r.snapshot.pendingOutcome).toEqual(outcome);
  });

  it('WRAP_UP --remote_hangup--> ENDED keeps the outcome', () => {
    const r = ok(transition(reach('WRAP_UP'), { type: 'remote_hangup', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('ENDED');
    expect(r.snapshot.outcome?.ticketId).toBe('TKT-1');
  });
});

describe('state machine: failure edges', () => {
  const live: CallState[] = ['DIALING', 'IVR', 'HOLD', 'HUMAN', 'HANDOFF_PENDING', 'USER_ON_LINE', 'WRAP_UP'];

  it.each(live)('%s --error--> FAILED', (state) => {
    const r = ok(transition(reach(state), { type: 'error', at: T0 + 10, reason: 'carrier_error', detail: 'socket' }));
    expect(r.snapshot.state).toBe('FAILED');
    expect(r.snapshot.failureReason).toBe('carrier_error');
    expect(r.snapshot.failureDetail).toBe('socket');
    expect(types(r.effects)).toContain('hangup');
  });

  it.each(live)('%s --max duration--> FAILED(max_duration)', (state) => {
    const r = ok(transition(reach(state), { type: 'tick', at: T0 + 25 * 60 * SEC }));
    expect(r.snapshot.state).toBe('FAILED');
    expect(r.snapshot.failureReason).toBe('max_duration');
  });

  it('max duration also fires on a non-tick input and is configurable', () => {
    const s = runInputs(createCallSnapshot('c', T0, { maxDurationMs: 5 * SEC }), [{ type: 'connected', at: T0 + 1 }]);
    const r = ok(transition(s.snapshot, { type: 'dtmf', at: T0 + 5 * SEC, digits: '1' }));
    expect(r.snapshot.failureReason).toBe('max_duration');
    expect(types(r.effects)).not.toContain('press_digits');
  });

  it('just under max duration is still fine', () => {
    const r = ok(transition(reach('HUMAN'), { type: 'tick', at: T0 + 25 * 60 * SEC - 1 }));
    expect(r.snapshot.state).toBe('HUMAN');
  });

  it.each(live.filter((s) => s !== 'WRAP_UP'))('%s --remote_hangup--> FAILED(remote_hangup)', (state) => {
    const r = ok(transition(reach(state), { type: 'remote_hangup', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('FAILED');
    expect(r.snapshot.failureReason).toBe('remote_hangup');
    expect(types(r.effects)).not.toContain('hangup');
  });

  it.each(live)('%s --end--> ENDED', (state) => {
    const r = ok(transition(reach(state), { type: 'end', at: T0 + 10 }));
    expect(r.snapshot.state).toBe('ENDED');
    expect(types(r.effects)).toContain('hangup');
  });

  it('USER_ON_LINE failure unbridges the user', () => {
    const r = ok(transition(reach('USER_ON_LINE'), { type: 'error', at: T0 + 10 }));
    expect(types(r.effects)).toContain('unbridge_user');
    expect(r.snapshot.failureReason).toBe('error');
  });

  it('three IVR loops -> FAILED(ivr_dead_end)', () => {
    const menu = 'Press 1 for billing. Press 2 for support.';
    const r = runInputs(reach('IVR'), [
      { type: 'menu_prompt', at: T0 + 10, text: menu },
      { type: 'dtmf', at: T0 + 11, digits: '9' },
      { type: 'menu_prompt', at: T0 + 12, text: menu }, // loop 1
      { type: 'dtmf', at: T0 + 13, digits: '9' },
      { type: 'menu_prompt', at: T0 + 14, text: '  press 1 for BILLING, press 2 for support ' }, // loop 2 (normalised)
      { type: 'dtmf', at: T0 + 15, digits: '9' },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.snapshot.state).toBe('IVR');
    expect(r.snapshot.ivrLoops).toBe(2);
    const last = ok(transition(r.snapshot, { type: 'menu_prompt', at: T0 + 16, text: menu })); // loop 3
    expect(last.snapshot.state).toBe('FAILED');
    expect(last.snapshot.failureReason).toBe('ivr_dead_end');
  });

  it('repeated announcements (isMenu: false) are not loops; only menu revisits count', () => {
    const menu = 'For billing, press 1. To repeat this menu, press 9.';
    const busy = 'All our executives are busy right now. Returning to the main menu.';
    const r = runInputs(reach('IVR'), [
      { type: 'menu_prompt', at: T0 + 10, text: 'Welcome.', isMenu: false },
      { type: 'menu_prompt', at: T0 + 11, text: menu },
      { type: 'dtmf', at: T0 + 12, digits: '1' },
      { type: 'menu_prompt', at: T0 + 13, text: busy, isMenu: false },
      { type: 'menu_prompt', at: T0 + 14, text: menu }, // loop 1
      { type: 'dtmf', at: T0 + 15, digits: '1' },
      { type: 'menu_prompt', at: T0 + 16, text: busy, isMenu: false },
      { type: 'menu_prompt', at: T0 + 17, text: busy, isMenu: false },
      { type: 'menu_prompt', at: T0 + 18, text: menu }, // loop 2
    ]);
    expect(r.error).toBeUndefined();
    expect(r.snapshot.state).toBe('IVR');
    expect(r.snapshot.ivrLoops).toBe(2);
    expect(r.effects.filter((e) => e.type === 'request_plan')).toHaveLength(3);
    const last = ok(transition(r.snapshot, { type: 'menu_prompt', at: T0 + 19, text: menu })); // loop 3
    expect(last.snapshot).toMatchObject({ state: 'FAILED', failureReason: 'ivr_dead_end', ivrLoops: 3 });
  });

  it('distinct IVR menus do not count as loops', () => {
    const r = runInputs(reach('IVR'), [
      { type: 'menu_prompt', at: T0 + 10, text: 'Main menu' },
      { type: 'menu_prompt', at: T0 + 11, text: 'Billing menu' },
      { type: 'menu_prompt', at: T0 + 12, text: 'Refunds menu' },
      { type: 'menu_prompt', at: T0 + 13, text: 'Refund status menu' },
    ]);
    expect(r.snapshot.state).toBe('IVR');
    expect(r.snapshot.ivrLoops).toBe(0);
  });
});

describe('state machine: invalid transitions return errors, never throw', () => {
  const allInputs = (at: number): CallInput[] => [
    { type: 'connected', at },
    { type: 'menu_prompt', at, text: 'menu' },
    { type: 'dtmf', at, digits: '1' },
    { type: 'hold_detected', at },
    { type: 'human_detected', at },
    { type: 'disclosure_request', at, tier: 'never' },
    { type: 'user_accepts', at },
    { type: 'user_declines', at },
    { type: 'user_leaves', at },
    { type: 'outcome_detected', at, outcome: { what: 'x' } },
    { type: 'outcome_confirmed', at },
    { type: 'outcome_rejected', at },
  ];
  const valid: Record<CallState, string[]> = {
    DIALING: ['connected'],
    IVR: ['menu_prompt', 'dtmf', 'hold_detected', 'human_detected'],
    HOLD: ['human_detected', 'hold_detected'],
    HUMAN: ['disclosure_request', 'hold_detected', 'outcome_detected'],
    HANDOFF_PENDING: ['user_accepts', 'user_declines'],
    USER_ON_LINE: ['user_leaves'],
    WRAP_UP: ['outcome_confirmed', 'outcome_rejected', 'outcome_detected'],
    ENDED: [],
    FAILED: [],
  };

  for (const state of CallStateSchema.options) {
    for (const input of allInputs(T0 + 10)) {
      const expected = valid[state].includes(input.type);
      it(`${state} + ${input.type} -> ${expected ? 'ok' : 'error'}`, () => {
        const r = transition(reach(state), input);
        expect(r.ok).toBe(expected);
        if (!r.ok) {
          expect(r.error.state).toBe(state);
          expect(r.error.input).toBe(input.type);
          expect(['invalid_transition', 'terminal_state']).toContain(r.error.code);
        }
      });
    }
  }

  it.each(['ENDED', 'FAILED'] as const)('%s rejects even tick/error/end', (state) => {
    for (const type of ['tick', 'error', 'end', 'remote_hangup'] as const) {
      const r = transition(reach(state), { type, at: T0 + 10 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('terminal_state');
    }
  });

  it('rejects malformed input without throwing', () => {
    const s = reach('IVR');
    for (const bad of [null, 42, 'connected', {}, { type: 'nope', at: 1 }, { type: 'dtmf', at: T0 + 9, digits: 'abc' }]) {
      const r = transition(s, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_input');
    }
  });

  it('rejects inputs whose time goes backwards', () => {
    const r = transition(reach('HUMAN'), { type: 'tick', at: T0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('clock_went_backwards');
  });

  it('is pure: the input snapshot is not mutated', () => {
    const s = reach('WRAP_UP');
    const before = structuredClone(s);
    transition(s, { type: 'outcome_confirmed', at: T0 + 10 });
    transition(s, { type: 'error', at: T0 + 10 });
    expect(s).toEqual(before);
  });
});
