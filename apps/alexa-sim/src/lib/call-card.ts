/**
 * Maps a call_status structuredContent to the 7 call-card states of spec §7
 * (Preparing -> Dialing -> Menu -> On hold -> Talking -> Needs you -> Done).
 * Used by the native React fallback card and by the device's ring overlay.
 */
import type { CallLine, CallStatusOutput, PendingQuestionView } from '@standin/core';

export const CARD_STAGES = ['preparing', 'dialing', 'menu', 'hold', 'talking', 'needs_you', 'done'] as const;
export type CardStage = (typeof CARD_STAGES)[number];

export const STAGE_LABEL: Record<CardStage, string> = {
  preparing: 'Preparing',
  dialing: 'Dialing',
  menu: 'Menu',
  hold: 'On hold',
  talking: 'Talking',
  needs_you: 'Needs you',
  done: 'Done',
};

export type CardAction = 'join' | 'decline' | 'answer' | 'leave' | 'end';

export interface CardView {
  stage: CardStage;
  /** Terminal failure (FAILED): rendered as Done with an error style. */
  failed: boolean;
  headline: string;
  detail?: string;
  digits: string[];
  holdSeconds: number;
  /** Last 4 masked lines. */
  lines: CallLine[];
  pendingQuestion?: PendingQuestionView;
  ticketId?: string;
  dueBy?: string;
  outcomeWhat?: string;
  followupScheduled: boolean;
  blockedCount: number;
  injectionCount: number;
  actions: CardAction[];
  active: boolean;
}

export interface CardContext {
  /** open_case returned and no required facts are missing. */
  caseReady?: boolean;
  businessName?: string;
}

const LAST_LINES = 4;

/** Pure mapping; `status` undefined means no call has been placed yet. */
export function mapCallStatus(status: CallStatusOutput | undefined, ctx: CardContext = {}): CardView {
  const business = ctx.businessName ?? 'the business';
  if (status === undefined) {
    return {
      stage: 'preparing',
      failed: false,
      headline: ctx.caseReady === true ? 'Case ready' : 'Preparing case',
      detail: ctx.caseReady === true ? `Ready to call ${business}` : 'Gathering the details',
      digits: [],
      holdSeconds: 0,
      lines: [],
      followupScheduled: false,
      blockedCount: 0,
      injectionCount: 0,
      actions: [],
      active: false,
    };
  }

  const base = {
    failed: false,
    digits: status.digitsPressed,
    holdSeconds: status.holdSeconds,
    lines: status.lastLines.slice(-LAST_LINES),
    followupScheduled: status.followupScheduled !== undefined,
    blockedCount: status.blockedCount,
    injectionCount: status.injectionCount,
    active: status.state !== 'ENDED' && status.state !== 'FAILED',
  };
  const withOutcome = (v: CardView): CardView => {
    if (status.outcome !== undefined) {
      v.outcomeWhat = status.outcome.what;
      if (status.outcome.ticketId !== undefined) v.ticketId = status.outcome.ticketId;
      if (status.outcome.dueBy !== undefined) v.dueBy = status.outcome.dueBy;
    }
    return v;
  };

  const pq = status.pendingQuestion;
  if (base.active && (status.state === 'HANDOFF_PENDING' || pq !== undefined)) {
    const handoff = status.state === 'HANDOFF_PENDING' || pq?.kind === 'handoff';
    const v: CardView = {
      ...base,
      stage: 'needs_you',
      headline: handoff ? `${business} needs to verify you` : `${business} is asking a question`,
      detail: pq?.askedText ?? status.summary,
      actions: handoff ? ['join', 'decline'] : ['answer', 'end'],
    };
    if (pq !== undefined) v.pendingQuestion = pq;
    return withOutcome(v);
  }

  switch (status.state) {
    case 'DIALING':
      return withOutcome({ ...base, stage: 'dialing', headline: `Calling ${business}`, detail: status.summary, actions: ['end'] });
    case 'IVR':
      return withOutcome({
        ...base,
        stage: 'menu',
        headline: 'Navigating the phone menu',
        detail: status.digitsPressed.length > 0 ? `Pressed ${status.digitsPressed.join(' → ')}` : status.summary,
        actions: ['end'],
      });
    case 'HOLD':
      return withOutcome({ ...base, stage: 'hold', headline: 'On hold — I\'ll wait', detail: status.summary, actions: ['end'] });
    case 'HUMAN':
      return withOutcome({ ...base, stage: 'talking', headline: 'Talking to an agent', detail: status.summary, actions: ['end'] });
    case 'USER_ON_LINE':
      return withOutcome({ ...base, stage: 'talking', headline: 'You\'re on the line', detail: status.summary, actions: ['leave'] });
    case 'WRAP_UP':
      return withOutcome({ ...base, stage: 'talking', headline: 'Reading back the details', detail: status.summary, actions: ['end'] });
    case 'ENDED':
      return withOutcome({
        ...base,
        stage: 'done',
        headline: status.outcome?.ticketId !== undefined ? `Done · ${status.outcome.ticketId}` : 'Call finished',
        detail: status.summary,
        actions: [],
      });
    case 'FAILED':
      return withOutcome({
        ...base,
        failed: true,
        stage: 'done',
        headline: 'Call could not be completed',
        detail: status.summary,
        actions: [],
      });
    case 'HANDOFF_PENDING':
      // Handled above; kept for exhaustiveness.
      return withOutcome({ ...base, stage: 'needs_you', headline: `${business} needs you`, detail: status.summary, actions: ['join', 'decline'] });
  }
}

/** "38:12" / "1:02:09". */
export function formatHold(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/**
 * The hold counter "races" for the video: the server's holdSeconds (sim time)
 * is scaled, and between 1 s polls it keeps counting from the last poll so
 * the display moves smoothly. Never runs backwards.
 */
export function racingHoldSeconds(holdSeconds: number, msSincePoll: number, scale: number, onHold: boolean): number {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const extra = onHold ? Math.min(Math.max(0, msSincePoll), 1500) / 1000 : 0;
  return (holdSeconds + extra) * k;
}

/** Default race factor: ~6 s of compressed sim hold reads as "38:12 on hold". */
export const RACE_SCALE = 382;

/**
 * 'auto' hold scale: if the server's holdSeconds already advances much faster
 * than wall time (sim clock), show it as-is; otherwise race it by RACE_SCALE.
 * Returns undefined until there is enough evidence (>= 1.5 s of hold observed).
 */
export function autoHoldScale(first: { holdSeconds: number; atMs: number }, latest: { holdSeconds: number; atMs: number }): number | undefined {
  const realS = (latest.atMs - first.atMs) / 1000;
  if (realS < 1.5) return undefined;
  const rate = (latest.holdSeconds - first.holdSeconds) / realS;
  return rate >= 5 ? 1 : RACE_SCALE;
}

/** Stage index for the progress strip. */
export function stageIndex(stage: CardStage): number {
  return CARD_STAGES.indexOf(stage);
}

/**
 * "Take over call": joins while a person is on the line (HUMAN) or answers a
 * hand-off (HANDOFF_PENDING); on the line it becomes "Hand back". During the
 * phone menu / hold there is nobody to talk to yet, so it is disabled.
 */
export function takeoverButton(state: string | undefined): { label: string; title: string; action?: 'join' | 'leave' } {
  if (state === 'HUMAN' || state === 'HANDOFF_PENDING') return { label: 'Take over call', title: 'Join the call and talk to the agent yourself', action: 'join' };
  if (state === 'USER_ON_LINE') return { label: 'Hand back', title: 'Leave the line; Stand-In carries on', action: 'leave' };
  return { label: 'Take over call', title: 'Available once a person is on the line' };
}
