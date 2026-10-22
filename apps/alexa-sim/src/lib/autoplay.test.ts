// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { CallState } from '@standin/core';
import {
  AUTOPLAY_SCRIPTS,
  AUTO_ANSWERS,
  AUTO_LEAVE_DELAY_MS,
  STORY_LINES,
  autoAnswerElicitation,
  evalCondition,
  handoffResponse,
  parseAutoplay,
  runAutoplay,
  type AutoplayWorld,
} from './autoplay.js';

/**
 * A fake host: virtual time, and a scripted "world" that reacts to what the
 * user says (a turn takes 2 s; the opening line places a call that lasts 10 s).
 */
function fakeHost(opts: { placesCallOn: string[]; confirmFirst?: boolean }) {
  let now = 0;
  let busyUntil = 0;
  let callStart: number | undefined;
  let callsStarted = 0;
  const callLen = 10_000;
  const said: Array<[number, string]> = [];
  const banners: Array<[number, string | null]> = [];
  let confirmed = opts.confirmFirst !== true;

  const world = (): AutoplayWorld => {
    const w: AutoplayWorld = { busy: now < busyUntil, callsStarted };
    if (callStart !== undefined) {
      const state: CallState = now - callStart >= callLen ? 'ENDED' : now - callStart > 3000 ? 'HOLD' : 'DIALING';
      w.callState = state;
    }
    return w;
  };
  return {
    said,
    banners,
    now: () => now,
    deps: {
      say: async (text: string) => {
        said.push([now, text]);
        busyUntil = now + 2000;
        if (opts.placesCallOn.includes(text)) {
          if (!confirmed) {
            confirmed = true;
            return;
          }
          // Call starts at the end of the turn.
          const start = now + 2000;
          callStart = start;
          callsStarted++;
        }
      },
      banner: (t: string | null) => banners.push([now, t]),
      sleep: async (ms: number) => {
        now += ms;
      },
      world,
    },
  };
}

describe('runAutoplay', () => {
  it('happy: opening line, waits for the call to finish, then asks what was promised', async () => {
    const h = fakeHost({ placesCallOn: [STORY_LINES.opening] });
    const r = await runAutoplay(AUTOPLAY_SCRIPTS.happy, h.deps);
    expect(r.completed).toBe(true);
    expect(h.said.map(([, t]) => t)).toEqual([STORY_LINES.opening, STORY_LINES.promise]);
    // "Yes, go ahead" is skipped when the call was already placed.
    expect(r.log).toContain(`skip ${STORY_LINES.goAhead}`);
    expect(r.log).toContain('reached call_finished');
    // The follow-up question comes only after the 10 s call ended.
    const [tOpen] = h.said[0] ?? [0];
    const [tPromise] = h.said[1] ?? [0];
    expect(tPromise - tOpen).toBeGreaterThanOrEqual(2000 + 10_000);
  });

  it('nudges with "go ahead" only when the first turn did not place the call', async () => {
    const h = fakeHost({ placesCallOn: [STORY_LINES.opening, STORY_LINES.goAhead], confirmFirst: true });
    await runAutoplay(AUTOPLAY_SCRIPTS.otp, h.deps);
    expect(h.said.map(([, t]) => t)).toEqual([STORY_LINES.opening, STORY_LINES.goAhead, STORY_LINES.promise]);
  });

  it('followup: two calls, "Two days later" banner between them, escalation line skipped when the follow-up call starts itself', async () => {
    const h = fakeHost({ placesCallOn: [STORY_LINES.opening, STORY_LINES.followup] });
    const r = await runAutoplay(AUTOPLAY_SCRIPTS.followup, h.deps);
    expect(r.completed).toBe(true);
    expect(h.said.map(([, t]) => t)).toEqual([STORY_LINES.opening, STORY_LINES.followup]);
    expect(h.banners.map(([, b]) => b)).toEqual(['Two days later…', null]);
    const tBanner = h.banners[0]?.[0] ?? 0;
    expect(tBanner).toBeGreaterThan(h.said[0]?.[0] ?? 0);
    expect(tBanner).toBeLessThan(h.said[1]?.[0] ?? 0);
    expect(r.log.filter((l) => l === 'reached call_finished')).toHaveLength(2);
  });

  it('followup: says the escalation line when asking alone did not start a call', async () => {
    const h = fakeHost({ placesCallOn: [STORY_LINES.opening, STORY_LINES.escalate] });
    await runAutoplay(AUTOPLAY_SCRIPTS.followup, h.deps);
    expect(h.said.map(([, t]) => t)).toEqual([STORY_LINES.opening, STORY_LINES.followup, STORY_LINES.escalate]);
  });

  it('never hangs: waits time out and the script moves on', async () => {
    const h = fakeHost({ placesCallOn: [] });
    const r = await runAutoplay(AUTOPLAY_SCRIPTS.happy, h.deps);
    expect(r.completed).toBe(true);
    expect(r.log).toContain('timeout new_call_started');
    expect(h.now()).toBeLessThan(10 * 60_000);
  });

  it('stops when aborted', async () => {
    const h = fakeHost({ placesCallOn: [STORY_LINES.opening] });
    const ac = new AbortController();
    const deps = { ...h.deps, say: async (t: string) => { await h.deps.say(t); ac.abort(); } };
    const r = await runAutoplay(AUTOPLAY_SCRIPTS.happy, deps, ac.signal);
    expect(r.completed).toBe(false);
    expect(h.said).toHaveLength(1);
  });
});

describe('conditions', () => {
  it('evaluates against the world and the take mark', () => {
    const w: AutoplayWorld = { busy: false, callsStarted: 1, callState: 'HOLD' };
    expect(evalCondition('idle', w, 0)).toBe(true);
    expect(evalCondition('call_active', w, 0)).toBe(true);
    expect(evalCondition('call_finished', w, 0)).toBe(false);
    expect(evalCondition('new_call_started', w, 0)).toBe(true);
    expect(evalCondition('new_call_started', w, 1)).toBe(false);
    expect(evalCondition('no_new_call', w, 1)).toBe(true);
    expect(evalCondition('call_finished', { ...w, callState: 'FAILED' }, 0)).toBe(true);
  });
});

describe('auto-responders', () => {
  it('joins the hand-off after the ring and leaves ~3 s after joining, only on transitions', () => {
    expect(handoffResponse('HUMAN', 'HANDOFF_PENDING')).toEqual({ action: 'join', delayMs: 2000 });
    expect(handoffResponse('HANDOFF_PENDING', 'USER_ON_LINE')).toEqual({ action: 'leave', delayMs: AUTO_LEAVE_DELAY_MS });
    expect(handoffResponse('HANDOFF_PENDING', 'HANDOFF_PENDING')).toBeNull();
    expect(handoffResponse('USER_ON_LINE', 'HUMAN')).toBeNull();
    expect(handoffResponse(undefined, undefined)).toBeNull();
  });

  it('answers the account-number elicitation with the demo account', () => {
    expect(autoAnswerElicitation({ account_number: { type: 'string', title: 'BharatNet account number' } })).toEqual({
      account_number: AUTO_ANSWERS.account,
    });
    expect(
      autoAnswerElicitation({
        approve: { type: 'boolean', title: 'Share it?' },
        outcome: { type: 'string', enum: ['refund', 'repair'] },
        name: { type: 'string', title: 'Your name' },
      }),
    ).toEqual({ approve: true, outcome: 'refund', name: AUTO_ANSWERS.name });
  });

  it('declines (null) any form that asks for a secret', () => {
    expect(autoAnswerElicitation({ otp: { type: 'string', title: 'OTP' } })).toBeNull();
    expect(autoAnswerElicitation({ x: { type: 'string', title: 'Card number' } })).toBeNull();
  });

  it('parses ?autoplay=', () => {
    expect(parseAutoplay('?autoplay=otp')).toBe('otp');
    expect(parseAutoplay('?autoplay=nope')).toBeUndefined();
    expect(parseAutoplay('')).toBeUndefined();
  });
});
