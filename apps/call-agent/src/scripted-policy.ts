/**
 * Deterministic planner policy (no LLM). Used by `pnpm eval`, offline mode and
 * tests. It sees exactly what an LLM planner would see (PlannerContext, no
 * fact values) and answers with the same PlannerOutput schema.
 */
import { PlannerOutputSchema, type ChatRequest, type LlmProvider, type PlannerOutput } from '@standin/core';
import { INVALID_JSON_OUTPUT, ScriptedLlmProvider } from '@standin/providers';
import { z } from 'zod';
import { contextFromMessages, fallbackOutput, type PlanResult, type Planner, type PlannerContext } from './planner.js';
import { TICKET_RE, askedPhrase, chooseMenuOption, matchFact, parseMenu, parseOutcome } from './text-rules.js';

const MENU_KEYWORDS: Record<PlannerContext['desiredOutcome'], string[]> = {
  refund: ['refund', 'new refund', 'credit', 'request'],
  repair: ['technical', 'not working', 'internet', 'repair', 'technician', 'support'],
  cancel: ['cancel', 'disconnect', 'billing'],
  info: ['billing', 'status', 'information'],
  other: ['speak', 'executive', 'agent'],
};

const FOLLOWUP_KEYWORDS = ['existing', 'status', 'refund', 'complaint'];

const OUTCOME_WORDS: Record<PlannerContext['desiredOutcome'], string> = {
  refund: 'They would like a refund.',
  repair: 'They would like this repaired, with a technician visit if needed.',
  cancel: 'They would like to cancel the service.',
  info: 'They would like some information about this.',
  other: 'They would like help resolving this.',
};

const AFFIRM = /\b(?:yes|yeah|yep|correct|right|that'?s right|confirmed|exactly)\b/i;
const ANYTHING_ELSE = /\banything else\b/i;
const HOW_CAN_I_HELP = /\bhow (?:may|can) i help\b|\bplease go ahead\b|\bplease tell me\b(?!\s+the)/i;
const STILL_THERE = /\b(?:are you still (?:there|on the line)|hello\?)/i;

function say(utterance: string, reason: string): PlannerOutput {
  return { action: 'say', utterance, reason };
}

function issueStatement(ctx: PlannerContext): string {
  const p = ctx.priorPromise;
  if (p?.ticketId !== undefined) {
    const due = p.dueBy === undefined ? '' : ` by ${p.dueBy}`;
    return (
      `I'm calling about service request ${p.ticketId}. ` +
      `${ctx.businessName} promised ${p.what}${due}, but it has not happened. ` +
      'Please escalate this to a supervisor.'
    );
  }
  return `I'm calling about this issue: ${ctx.goal.replace(/[.\s]+$/, '')}. ${OUTCOME_WORDS[ctx.desiredOutcome]}`;
}

function ivr(ctx: PlannerContext): PlannerOutput {
  const heard = ctx.heard;
  if (heard?.kind !== 'ivr_prompt') return { action: 'wait', reason: 'no menu to answer' };
  const options = parseMenu(heard.text);
  if (options.length === 0) return { action: 'wait', reason: 'announcement, not a menu' };
  const keywords = ctx.priorPromise !== undefined ? FOLLOWUP_KEYWORDS : MENU_KEYWORDS[ctx.desiredOutcome];
  const choice = chooseMenuOption(options, keywords);
  if (choice === undefined) return { action: 'wait', reason: 'no menu option fits the goal' };
  return { action: 'press', digits: choice.digit, reason: `menu option "${choice.label}"` };
}

function human(ctx: PlannerContext): PlannerOutput {
  const text = ctx.heard?.kind === 'speech' ? ctx.heard.text : '';
  if (text.length === 0) {
    return ctx.issueStated ? { action: 'wait', reason: 'nothing to answer' } : say(issueStatement(ctx), 'explain the issue');
  }

  const outcome = parseOutcome(text);
  if (outcome !== undefined) return { action: 'confirm_outcome', outcome, reason: 'business stated a ticket and date' };

  if (!ctx.issueStated && (HOW_CAN_I_HELP.test(text) || !text.includes('?'))) {
    return say(issueStatement(ctx), 'explain the issue');
  }

  if (ANYTHING_ELSE.test(text)) {
    return { action: 'end', utterance: "No, that's all. Thank you for your help. Goodbye.", reason: 'call complete' };
  }
  if (STILL_THERE.test(text)) return say("Yes, I'm still here.", 'answer a nudge');

  const phrase = askedPhrase(text);
  if (phrase !== undefined) {
    const fact = matchFact(phrase, ctx.facts);
    if (fact?.speakable === true) {
      return say(`Sure, the ${fact.label} is {{fact:${fact.key}}}.`, `answer with fact ${fact.key}`);
    }
    if (/\bproof|reference|complaint number\b/i.test(phrase) && ctx.priorPromise?.ticketId !== undefined) {
      return say(`Yes, the earlier service request number is ${ctx.priorPromise.ticketId}.`, 'quote prior ticket');
    }
    return {
      action: 'request_handoff',
      utterance: 'One moment, let me check that with the account holder.',
      reason: fact === undefined ? `unknown fact: ${phrase}` : `fact ${fact.key} is not speakable`,
    };
  }

  if (HOW_CAN_I_HELP.test(text)) return say(issueStatement(ctx), 'restate the issue');
  if (text.includes('?')) {
    return say(
      "I'm sorry, I don't have that information right now. The account holder will follow up on it.",
      'question without a known answer',
    );
  }
  return { action: 'wait', reason: 'statement, nothing to answer' };
}

function wrapUp(ctx: PlannerContext): PlannerOutput {
  const text = ctx.heard?.kind === 'speech' ? ctx.heard.text : '';
  const pending = ctx.pendingOutcome;
  const ticket = TICKET_RE.exec(text)?.[0];
  if (ticket !== undefined && pending !== undefined && ticket !== pending.ticketId) {
    const corrected = parseOutcome(text) ?? { ...pending, ticketId: ticket };
    return {
      action: 'confirm_outcome',
      outcome: { ...pending, ...corrected, what: pending.what, ticketId: ticket },
      reason: 'business corrected the ticket id',
    };
  }
  if (AFFIRM.test(text) || ANYTHING_ELSE.test(text)) {
    return { action: 'end', utterance: "No, that's all. Thank you for your help. Goodbye.", reason: 'read-back confirmed' };
  }
  return { action: 'wait', reason: 'waiting for read-back confirmation' };
}

/** The deterministic policy itself. Always returns a schema-valid PlannerOutput. */
export function scriptedPolicy(ctx: PlannerContext): PlannerOutput {
  let out: PlannerOutput;
  switch (ctx.state) {
    case 'IVR':
      out = ivr(ctx);
      break;
    case 'HUMAN':
      out = human(ctx);
      break;
    case 'WRAP_UP':
      out = wrapUp(ctx);
      break;
    default:
      out = { action: 'wait', reason: `nothing to do in ${ctx.state}` };
  }
  const r = PlannerOutputSchema.safeParse(out);
  return r.success ? r.data : fallbackOutput(ctx.state);
}

/** Default planner for eval/offline: the scripted policy, no LLM involved. */
export class ScriptedPlanner implements Planner {
  readonly name = 'scripted';
  async plan(ctx: PlannerContext): Promise<PlanResult> {
    return { output: scriptedPolicy(ctx) };
  }
}

/**
 * An LlmProvider that answers planner requests with the scripted policy, via
 * the real prompt -> JSON -> zod path. Lets LlmPlanner run deterministically
 * (and lets tests capture exactly what an LLM would have been sent).
 */
export function createPolicyLlm(name = 'scripted-policy'): ScriptedLlmProvider {
  return new ScriptedLlmProvider({
    name,
    script: (req: ChatRequest) => {
      const ctx = contextFromMessages(req.messages);
      if (ctx === undefined) return { kind: 'json', value: { action: 'wait', reason: 'no context' } };
      return { kind: 'json', value: scriptedPolicy(ctx) };
    },
  });
}

/* ------------------------------------------------------------------ */
/* Garbage injection (S8)                                              */
/* ------------------------------------------------------------------ */

export const GarbageKindSchema = z.enum(['invalid_json', 'schema', 'prose', 'throw']);
export type GarbageKind = z.infer<typeof GarbageKindSchema>;

export const GarbagePlanSchema = z.object({
  /** Only corrupt planner calls made in these states. */
  states: z.array(z.enum(['IVR', 'HUMAN', 'WRAP_UP'])).default(['HUMAN']),
  /** Corrupt this many calls (the first ones in those states). */
  count: z.number().int().min(0).max(100).default(2),
  kinds: z.array(GarbageKindSchema).min(1).default(['invalid_json', 'schema']),
});
export type GarbagePlan = z.infer<typeof GarbagePlanSchema>;

/** Wraps an LlmProvider and returns garbage for the first N planner calls in the chosen states. */
export class GarbageInjectingLlm implements LlmProvider {
  readonly name: string;
  readonly #inner: LlmProvider;
  readonly #plan: GarbagePlan;
  #injected = 0;

  constructor(inner: LlmProvider, plan: z.input<typeof GarbagePlanSchema> = {}) {
    this.#inner = inner;
    this.#plan = GarbagePlanSchema.parse(plan);
    this.name = `garbage(${inner.name})`;
  }

  get injected(): number {
    return this.#injected;
  }

  async chat(req: ChatRequest): Promise<string> {
    const ctx = contextFromMessages(req.messages);
    const state = ctx?.state;
    const eligible =
      state !== undefined && (this.#plan.states as readonly string[]).includes(state) && this.#injected < this.#plan.count;
    if (!eligible) return this.#inner.chat(req);
    const kind = this.#plan.kinds[this.#injected % this.#plan.kinds.length] ?? 'invalid_json';
    this.#injected++;
    switch (kind) {
      case 'invalid_json':
        return INVALID_JSON_OUTPUT;
      case 'schema':
        return JSON.stringify({ action: 'say', reason: 'missing utterance' });
      case 'prose':
        return 'Sure! I would tell them the account number right away.';
      case 'throw':
        throw new Error('injected provider failure');
    }
  }
}
