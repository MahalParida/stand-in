/**
 * Server-side views: everything here may reach a host, an LLM, the trace
 * panel or TTS, so never-tier values are dropped or masked on the way out.
 */
import type { CallSessionSnapshot, PendingQuestion } from '@standin/call-agent';
import {
  CaseViewSchema,
  type Business,
  type CallEvent,
  type CallLine,
  type CallState,
  type Case,
  type CaseFact,
  type CaseView,
  type FailureReason,
  type FollowupJobView,
  type Job,
  type LineSpeaker,
  type Outcome,
  type PendingQuestionView,
} from '@standin/core';
import { mask, type FactInput } from '@standin/disclosure-guard';
import { z } from 'zod';

const MAX_MASK_INPUT = 20_000;

/** Never-tier facts in the guard's shape (for mask / scanOutbound). */
export function guardFacts(facts: readonly CaseFact[]): FactInput[] {
  return facts.map((f) => ({ key: f.key, label: f.label, value: f.value, tier: f.tier, approved: f.approved }));
}

/**
 * Masks never-tier values and DLP pattern hits (OTP-near-keyword, card,
 * Aadhaar, ...). Fails closed: if the guard rejects its input, nothing of the
 * text is returned.
 */
export function maskText(text: string, facts: readonly CaseFact[] | readonly FactInput[]): string {
  if (text.length === 0) return text;
  try {
    const f: FactInput[] = facts.map((x) => ({ key: x.key, label: x.label, value: x.value, tier: x.tier, approved: x.approved ?? false }));
    return mask(text.slice(0, MAX_MASK_INPUT), f);
  } catch {
    return '•••';
  }
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function caseView(kase: Case, business: Business | undefined): CaseView {
  const facts = kase.facts.map((f) => {
    const base = { key: f.key, label: f.label, tier: f.tier, approved: f.approved, source: f.source };
    return f.tier === 'never' ? base : { ...base, value: maskText(f.value, kase.facts) };
  });
  return CaseViewSchema.parse({
    id: kase.id,
    userName: kase.userName,
    businessId: kase.businessId,
    businessName: business?.name ?? kase.businessId,
    goal: clip(maskText(kase.goal, kase.facts), 2000),
    desiredOutcome: kase.desiredOutcome,
    status: kase.status,
    facts,
    promises: kase.promises.map((p) => ({ ...p, what: maskText(p.what, kase.facts) })),
    calls: kase.calls,
    createdAt: kase.createdAt,
    updatedAt: kase.updatedAt,
  });
}

/* ------------------------------------------------------------------ */
/* Transcript lines from the (masked, hash-chained) event log          */
/* ------------------------------------------------------------------ */

const HeardDataSchema = z.object({
  kind: z.enum(['ivr_prompt', 'hold', 'speech', 'hangup']),
  speaker: z.enum(['ivr', 'agent', 'system']).optional(),
  text: z.string(),
});
const SaidDataSchema = z.object({ text: z.string() });
const DtmfDataSchema = z.object({ digits: z.string() });
const HandoffDataSchema = z.object({ kind: z.string(), status: z.string() });
const StateDataSchema = z.object({ to: z.string(), from: z.string().optional() });
const DisclosureDataSchema = z.object({ injection: z.boolean().optional() });

export interface EventDigest {
  lines: CallLine[];
  digitsPressed: string[];
  blockedCount: number;
  injectionCount: number;
  holdSeconds: number;
}

function heardSpeaker(d: z.infer<typeof HeardDataSchema>): LineSpeaker {
  if (d.speaker !== undefined) return d.speaker;
  if (d.kind === 'hangup') return 'system';
  if (d.kind === 'speech') return 'agent';
  return 'ivr';
}

/** Lines, digits and counters from call events. Every text is masked again (defence in depth). */
export function digestEvents(events: readonly CallEvent[], facts: readonly CaseFact[], extraLines: readonly CallLine[] = []): EventDigest {
  const lines: CallLine[] = [];
  const digitsPressed: string[] = [];
  let blockedCount = 0;
  let injectionCount = 0;
  let holdMs = 0;
  let holdSince: number | undefined;
  for (const e of events) {
    const at = e.at;
    switch (e.type) {
      case 'heard': {
        const d = HeardDataSchema.safeParse(e.data);
        if (d.success && d.data.text.trim().length > 0) {
          lines.push({ speaker: heardSpeaker(d.data), text: clip(maskText(d.data.text, facts), 4000), at });
        }
        break;
      }
      case 'said': {
        const d = SaidDataSchema.safeParse(e.data);
        if (d.success) lines.push({ speaker: 'standin', text: clip(maskText(d.data.text, facts), 4000), at });
        break;
      }
      case 'dtmf': {
        const d = DtmfDataSchema.safeParse(e.data);
        if (d.success && /^[0-9*#]{1,32}$/.test(d.data.digits)) {
          digitsPressed.push(d.data.digits);
          lines.push({ speaker: 'standin', text: `[pressed ${d.data.digits}]`, at });
        }
        break;
      }
      case 'handoff': {
        const d = HandoffDataSchema.safeParse(e.data);
        if (d.success && d.data.kind === 'handoff' && d.data.status === 'user_joined') {
          lines.push({ speaker: 'system', text: '[account holder joined the call]', at });
        } else if (d.success && d.data.kind === 'handoff' && d.data.status === 'user_left') {
          lines.push({ speaker: 'system', text: '[account holder left the call]', at });
        }
        break;
      }
      case 'blocked_utterance':
        blockedCount++;
        break;
      case 'disclosure_request': {
        const d = DisclosureDataSchema.safeParse(e.data);
        if (d.success && d.data.injection === true) injectionCount++;
        break;
      }
      case 'state': {
        const d = StateDataSchema.safeParse(e.data);
        if (!d.success) break;
        const t = Date.parse(at);
        if (holdSince !== undefined) {
          holdMs += Math.max(0, t - holdSince);
          holdSince = undefined;
        }
        if (d.data.to === 'HOLD') holdSince = t;
        break;
      }
      default:
        break;
    }
  }
  const merged = extraLines.length === 0 ? lines : [...lines, ...extraLines].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { lines: merged, digitsPressed, blockedCount, injectionCount, holdSeconds: Math.floor(holdMs / 1000) };
}

/* ------------------------------------------------------------------ */
/* Pending question / summaries                                        */
/* ------------------------------------------------------------------ */

const HANDOFF_LABEL: Record<string, string> = {
  otp: 'One-time password (OTP)',
  pin: 'PIN',
  password: 'Password',
  cvv: 'Card CVV',
  card: 'Card number',
  aadhaar: 'Aadhaar number',
  remote_access: 'Remote access to your device',
  payment: 'A payment',
  upi: 'A UPI payment',
  unknown: 'A security check',
};

export function pendingView(p: PendingQuestion | undefined, facts: readonly CaseFact[], confirmIds: ReadonlySet<string>): PendingQuestionView | undefined {
  if (p === undefined) return undefined;
  if (p.kind === 'handoff') {
    return {
      id: p.id,
      kind: 'handoff',
      label: HANDOFF_LABEL[p.what] ?? 'A security check',
      askedText: clip(maskText(p.prompt, facts), 2000) || 'The business needs to verify the account holder.',
    };
  }
  const label = clip(maskText(p.label, facts), 200);
  return {
    id: p.id,
    kind: confirmIds.has(p.id) ? 'confirm' : 'fact',
    factKey: p.factKey,
    label: label.length > 0 ? label.charAt(0).toUpperCase() + label.slice(1) : 'A detail',
    askedText: clip(maskText(p.prompt, facts), 2000) || 'The business asked for a detail.',
  };
}

const FAILURE_TEXT: Record<FailureReason, string> = {
  ivr_dead_end: "the phone menu kept looping and I couldn't reach a person",
  max_duration: 'the call ran past the time limit',
  remote_hangup: 'the business hung up',
  dial_failed: "the call couldn't be connected",
  carrier_error: 'the phone line failed',
  error: 'something went wrong on the call',
  server_restart: 'the Stand-In server restarted mid-call, so the call was dropped',
};

export function outcomeSentence(o: Outcome): string {
  const parts = [o.what];
  if (o.ticketId !== undefined) parts.push(`ticket ${o.ticketId}`);
  if (o.dueBy !== undefined) parts.push(`due by ${o.dueBy}`);
  return parts.join(', ');
}

function fmtHold(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m} min ${sec} s` : `${sec} s`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export interface CallSummaryInput {
  businessName: string;
  state: CallState;
  holdSeconds: number;
  digitsPressed: readonly string[];
  pending?: PendingQuestionView;
  outcome?: Outcome;
  failureReason?: FailureReason;
  failureMessage?: string;
  followupRunAt?: string;
}

/** One honest, speakable sentence for the state of a call. */
export function callSummary(i: CallSummaryInput, facts: readonly CaseFact[]): string {
  const b = i.businessName;
  let s: string;
  switch (i.state) {
    case 'DIALING':
      s = `Dialling ${b}.`;
      break;
    case 'IVR':
      s = i.digitsPressed.length > 0 ? `In ${b}'s phone menu (pressed ${i.digitsPressed.join(', ')}).` : `In ${b}'s phone menu.`;
      break;
    case 'HOLD':
      s = `On hold with ${b} for ${fmtHold(i.holdSeconds)}.`;
      break;
    case 'HUMAN':
      s =
        i.pending?.kind === 'fact' || i.pending?.kind === 'confirm'
          ? `${b} is asking for the ${i.pending.label.toLowerCase()}. Do you have it?`
          : `Talking to an agent at ${b}.`;
      break;
    case 'HANDOFF_PENDING':
      s = `${b} needs to verify you (${(i.pending?.label ?? 'a security check').toLowerCase()}). I can't share that, so only you can answer. Join the call?`;
      break;
    case 'USER_ON_LINE':
      s = `You're on the line with ${b}.`;
      break;
    case 'WRAP_UP':
      s = i.outcome !== undefined ? `Confirming with ${b}: ${outcomeSentence(i.outcome)}.` : `Wrapping up with ${b}.`;
      break;
    case 'ENDED':
      if (i.outcome !== undefined) {
        s = `Done. ${b} committed to ${outcomeSentence(i.outcome)}.`;
        if (i.followupRunAt !== undefined) s += ` I'll follow up on ${fmtDate(i.followupRunAt)} if it doesn't happen.`;
      } else {
        s = `The call with ${b} ended without a commitment.`;
      }
      break;
    case 'FAILED':
      s = i.failureMessage ?? `The call to ${b} failed: ${FAILURE_TEXT[i.failureReason ?? 'error']}.`;
      break;
  }
  return clip(maskText(s, facts), 1000);
}

export function jobView(j: Job): FollowupJobView {
  const t = j.payload.ticketId;
  return {
    id: j.id,
    kind: 'followup',
    caseId: j.caseId,
    runAt: j.runAt,
    status: j.status,
    ...(typeof t === 'string' && t.length > 0 && t.length <= 200 ? { ticketId: t } : {}),
  };
}

export type { CallSessionSnapshot };
