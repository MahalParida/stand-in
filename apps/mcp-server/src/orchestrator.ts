/**
 * POST /sim/api/llm: the alexa-sim orchestrator's "model".
 *
 * Offline default: a deterministic scripted intent matcher. It reads the
 * conversation (user turns, assistant tool calls, tool results) and returns
 * the next tool calls and/or the spoken reply, so autoplay is reproducible.
 *
 * Bedrock: a native Converse tool-use loop (the MCP tools become toolSpecs,
 * tool calls come back as toolUse blocks, results go back as toolResult).
 * LocalLlm (and any text-only provider): the same contract through a JSON
 * tool-call protocol in the prompt.
 * Every message is masked (never-tier values + DLP patterns) before it is
 * sent; bad model output falls back to the scripted matcher.
 */
import {
  SimLlmResponseSchema,
  type CaseFact,
  type LlmProvider,
  type LlmToolCall,
  type SimLlmRequest,
  type SimLlmResponse,
  type ToolChatMessage,
  type ToolChatRequest,
} from '@standin/core';
import { stripJsonFence } from '@standin/providers';
import { z } from 'zod';
import { clip, fmtDate, maskText } from './views.js';

const FALLBACK_REPLY = "Sorry, I didn't catch that. Could you say it again?";

export interface DirectoryEntry {
  name: string;
  aliases: string[];
}

export interface OrchestratorContext {
  now: Date;
  businesses: DirectoryEntry[];
}

/* ------------------------------------------------------------------ */
/* Conversation reading                                                */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

interface ToolEvent {
  name: string;
  args: Json;
  result: Json | undefined;
  isError: boolean;
  errorMessage?: string;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function parseResult(content: string): { result: Json | undefined; isError: boolean; errorMessage?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { result: undefined, isError: true, errorMessage: clip(content, 300) || 'the tool failed' };
  }
  if (!isObj(parsed)) return { result: undefined, isError: true, errorMessage: 'the tool returned nothing useful' };
  const err = parsed.error;
  if (isObj(err)) return { result: parsed, isError: true, errorMessage: str(err.message) ?? str(err.code) ?? 'the tool failed' };
  // Tolerate a bare string error too: any `error` key means the tool failed.
  if (typeof err === 'string') return { result: parsed, isError: true, errorMessage: clip(err, 300) || 'the tool failed' };
  if (parsed.isError === true) {
    const sc = parsed.structuredContent;
    const m = isObj(sc) && isObj(sc.error) ? str(sc.error.message) : undefined;
    return { result: parsed, isError: true, errorMessage: m ?? 'the tool failed' };
  }
  if (isObj(parsed.structuredContent)) return { result: parsed.structuredContent, isError: false };
  return { result: parsed, isError: false };
}

/** Tool calls paired with their results, in order. */
function toolEvents(req: SimLlmRequest): ToolEvent[] {
  const byId = new Map<string, { name: string; args: Json }>();
  const out: ToolEvent[] = [];
  for (const m of req.messages) {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) byId.set(c.id, { name: c.name, args: c.arguments });
    if (m.role === 'tool' && m.toolCallId !== undefined) {
      const call = byId.get(m.toolCallId);
      if (call === undefined) continue;
      out.push({ ...call, ...parseResult(m.content) });
    }
  }
  return out;
}

interface CaseRef {
  id: string;
  businessName?: string;
  missing: { key: string; label: string; prompt: string }[];
  hasPromise: boolean;
  status?: string;
}

interface CallRef {
  callId: string;
  caseId?: string;
  state?: string;
  pending?: { kind: string; label: string };
}

function readState(events: ToolEvent[]): { kase?: CaseRef; call?: CallRef; caseNames: Map<string, string> } {
  let kase: CaseRef | undefined;
  let call: CallRef | undefined;
  const caseNames = new Map<string, string>();
  for (const e of events) {
    if (e.isError || e.result === undefined) continue;
    const r = e.result;
    const c = r.case;
    if (isObj(c) && str(c.id) !== undefined) {
      const id = str(c.id) as string;
      const bn = str(c.businessName);
      if (bn !== undefined) caseNames.set(id, bn);
      const missingRaw = Array.isArray(r.missingFacts) ? r.missingFacts : undefined;
      const prev = kase?.id === id ? kase : undefined;
      kase = {
        id,
        ...(bn !== undefined ? { businessName: bn } : {}),
        missing:
          missingRaw === undefined
            ? (prev?.missing ?? [])
            : missingRaw.filter(isObj).map((m) => ({ key: str(m.key) ?? 'detail', label: str(m.label) ?? 'detail', prompt: str(m.prompt) ?? `What is the ${str(m.label) ?? 'detail'}?` })),
        hasPromise: Array.isArray(c.promises) && c.promises.length > 0,
        ...(str(c.status) !== undefined ? { status: str(c.status) as string } : {}),
      };
    }
    if (Array.isArray(r.cases)) {
      for (const x of r.cases) if (isObj(x) && str(x.id) !== undefined && str(x.businessName) !== undefined) caseNames.set(str(x.id) as string, str(x.businessName) as string);
    }
    const callId = str(r.callId);
    if (callId !== undefined) {
      const caseId = str(r.caseId) ?? (call?.callId === callId ? call.caseId : undefined);
      const pq = isObj(r.pendingQuestion) ? r.pendingQuestion : undefined;
      call = {
        callId,
        ...(caseId !== undefined ? { caseId } : {}),
        ...(str(r.state) !== undefined ? { state: str(r.state) as string } : {}),
        ...(pq !== undefined ? { pending: { kind: str(pq.kind) ?? 'fact', label: str(pq.label) ?? 'a detail' } } : {}),
      };
    }
  }
  return { ...(kase !== undefined ? { kase } : {}), ...(call !== undefined ? { call } : {}), caseNames };
}

/* ------------------------------------------------------------------ */
/* Intents                                                             */
/* ------------------------------------------------------------------ */

type Intent =
  | { kind: 'broadband' }
  | { kind: 'refund'; orderId?: string }
  | { kind: 'status' }
  | { kind: 'followup' }
  | { kind: 'end' }
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'other' };

const ACTIVE = new Set(['DIALING', 'IVR', 'HOLD', 'HUMAN', 'HANDOFF_PENDING', 'USER_ON_LINE', 'WRAP_UP']);

export function classifyUtterance(text: string): Intent {
  const u = text.toLowerCase();
  if (/\b(hang up|end (the )?call|stop the call|cancel the call)\b/.test(u)) return { kind: 'end' };
  if (/\b(never came|never showed|didn'?t come|did not come|not received|haven'?t received|still not|call (them|bharatnet)? ?again|follow[- ]?up|chase)\b/.test(u)) return { kind: 'followup' };
  if (/\b(what happened|status|any (news|update)|update on|how did it go|where are we)\b/.test(u)) return { kind: 'status' };
  const order = /\b(od\d{3,})\b/i.exec(text);
  if (/\brefund\b/.test(u) && (order !== null || /\border\b/.test(u))) return order?.[1] !== undefined ? { kind: 'refund', orderId: order[1].toUpperCase() } : { kind: 'refund' };
  if (/\b(broadband|internet|wi-?fi|connection)\b/.test(u) && /\b(down|not working|no internet|outage|dead|sort it out|fix|broken)\b/.test(u)) return { kind: 'broadband' };
  if (/^\s*(yes|yeah|yep|sure|ok(ay)?|join|put me through|connect me)\b/.test(u)) return { kind: 'yes' };
  if (/^\s*(no|nope|not now|decline|later)\b/.test(u)) return { kind: 'no' };
  return { kind: 'other' };
}

function extractAnswer(text: string): string {
  const t = text.trim().replace(/[.!?]+$/, '');
  const m = /(?:\bit'?s|\bis|\bit is)\s+(.+)$/i.exec(t);
  return clip((m?.[1] ?? t).trim(), 500) || t;
}

function extractAccount(text: string): string | undefined {
  const m = /\b([A-Z]{2}\d{4,})\b/i.exec(text);
  return m?.[1]?.toUpperCase();
}

function mentionedBusiness(text: string, businesses: DirectoryEntry[]): string | undefined {
  const u = text.toLowerCase();
  for (const b of businesses) {
    for (const n of [b.name, ...b.aliases]) if (n.length >= 3 && u.includes(n.toLowerCase())) return b.name;
  }
  return undefined;
}

/** Utterances that may answer the business mid-call (not a command of their own). */
function isReplyIntent(intent: Intent): boolean {
  return intent.kind === 'yes' || intent.kind === 'no' || intent.kind === 'other';
}

/** The answer last sent for this call (re-sent with approve=true when the user okays a personal detail). */
function lastSentAnswer(events: readonly ToolEvent[], callId: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.name === 'send_to_call' && e.args.callId === callId) return str(e.args.answer);
  }
  return undefined;
}

/** Next tool call for a user reply, given the (fresh) state of a live call; undefined = nothing to answer. */
function replyToLiveCall(
  live: CallRef,
  intent: Intent,
  userText: string,
  events: readonly ToolEvent[],
  call: (name: string, args: Json) => LlmToolCall,
): LlmToolCall | undefined {
  if (live.state === 'HANDOFF_PENDING' || live.pending?.kind === 'handoff') {
    if (intent.kind === 'yes') return call('handoff_to_user', { callId: live.callId, accept: true });
    if (intent.kind === 'no') return call('handoff_to_user', { callId: live.callId, accept: false });
    return undefined;
  }
  const p = live.pending;
  if (p === undefined) return undefined;
  if (p.kind === 'confirm') {
    if (intent.kind === 'no') return undefined;
    const prev = lastSentAnswer(events, live.callId);
    if (intent.kind === 'yes') return prev === undefined ? undefined : call('send_to_call', { callId: live.callId, answer: prev, approve: true });
    return call('send_to_call', { callId: live.callId, answer: extractAnswer(userText) });
  }
  if (p.kind === 'fact' && intent.kind === 'other') {
    const value = (/account/i.test(p.label) ? extractAccount(userText) : undefined) ?? extractAnswer(userText);
    return call('send_to_call', { callId: live.callId, answer: value });
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Scripted matcher                                                    */
/* ------------------------------------------------------------------ */

const HELP =
  "I can call a business for you: I'll get through the phone menu, wait on hold, explain the problem and get a ticket number. Try: \"My BharatNet broadband has been down for three days, sort it out.\"";

function lastUserText(req: SimLlmRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role === 'user') return m.content;
  }
  return '';
}

export function scriptedOrchestrator(req: SimLlmRequest, ctx: OrchestratorContext): SimLlmResponse {
  const tools = new Set(req.tools.map((t) => t.name));
  let n = 0;
  const call = (name: string, args: Json): LlmToolCall => ({ id: `tc_${req.messages.length}_${++n}`, name, arguments: args });
  const respond = (text: string | undefined, calls: LlmToolCall[] = []): SimLlmResponse => {
    const usable = calls.filter((c) => tools.size === 0 || tools.has(c.name));
    const r: SimLlmResponse = {};
    if (text !== undefined && text.length > 0) r.text = clip(text, 4000);
    if (usable.length > 0) r.toolCalls = usable;
    if (r.text === undefined && r.toolCalls === undefined) r.text = FALLBACK_REPLY;
    return SimLlmResponseSchema.parse(r);
  };

  const events = toolEvents(req);
  const state = readState(events);
  const userText = lastUserText(req);
  const intent = classifyUtterance(userText);
  const defaultBusiness = ctx.businesses[0]?.name ?? 'BharatNet Broadband';
  const last = req.messages.at(-1);

  /* ---------- after a tool result ---------- */
  if (last?.role === 'tool') {
    const ev = events.at(-1);
    if (ev === undefined) return respond(FALLBACK_REPLY);
    if (ev.isError) return respond(`Sorry, I couldn't do that: ${ev.errorMessage ?? 'something went wrong'}.`);
    const r = ev.result ?? {};
    const biz = (id: string | undefined): string => (id !== undefined ? state.caseNames.get(id) : undefined) ?? state.kase?.businessName ?? defaultBusiness;
    switch (ev.name) {
      case 'open_case':
      case 'update_case_fact': {
        const k = state.kase;
        if (k === undefined) return respond(FALLBACK_REPLY);
        const first = k.missing[0];
        if (first !== undefined) {
          return respond(ev.name === 'open_case' ? `Okay, I've started a case with ${k.businessName ?? defaultBusiness}. ${first.prompt}` : `Thanks. ${first.prompt}`);
        }
        return respond(`Got it. I'm calling ${k.businessName ?? defaultBusiness} now. I'll handle the menu and the hold, and I'll only interrupt you if they need you.`, [
          call('place_call', { caseId: k.id }),
        ]);
      }
      case 'place_call':
        return respond(`I'm on the line with ${biz(str(r.caseId))}. Carry on with your day; I'll tell you when it's sorted or if they need you.`);
      case 'call_status': {
        // A refresh we issued for a reply ("yes", "no", "It's BN7781234"): act on the live state.
        const live = state.call;
        if (isReplyIntent(intent) && live !== undefined && live.callId === str(r.callId)) {
          const next = replyToLiveCall(live, intent, userText, events, call);
          if (next !== undefined) return respond(undefined, [next]);
        }
        return respond(str(r.summary) ?? FALLBACK_REPLY);
      }
      case 'end_call':
        return respond(str(r.summary) ?? FALLBACK_REPLY);
      case 'send_to_call':
        if (r.confirmRequired === true) return respond("That's a personal detail. Is it okay to share it with them?");
        return respond(r.ok === true ? "Thanks, I've passed that on." : (str(r.message) ?? FALLBACK_REPLY));
      case 'handoff_to_user':
        if (r.ok !== true) return respond(str(r.message) ?? FALLBACK_REPLY);
        return respond(ev.args.accept === true ? "Connecting you now. They'll ask you to read the code from your phone. I'll take over again once you're done." : "Okay, I've told them you'll verify later. I'll carry on.");
      case 'list_cases': {
        const cases = Array.isArray(r.cases) ? r.cases.filter(isObj) : [];
        if (cases.length === 0) return respond("You don't have any cases with Stand-In yet.");
        const named = mentionedBusiness(userText, ctx.businesses);
        const pick =
          (intent.kind === 'followup' ? cases.find((c) => Array.isArray(c.promises) && c.promises.length > 0) : undefined) ??
          cases.find((c) => named !== undefined && c.businessName === named) ??
          cases[0];
        const id = str(pick?.id);
        if (id === undefined) return respond(FALLBACK_REPLY);
        if (intent.kind === 'followup') return respond(undefined, [call('schedule_followup', { caseId: id, at: new Date(ctx.now.getTime() + 3000).toISOString() })]);
        return respond(undefined, [call('get_case', { caseId: id })]);
      }
      case 'get_case':
        return respond(str(r.summary) ?? FALLBACK_REPLY);
      case 'schedule_followup': {
        const job = isObj(r.job) ? r.job : {};
        const runAt = Date.parse(str(job.runAt) ?? '');
        const when = Number.isNaN(runAt) || runAt - ctx.now.getTime() < 60_000 ? 'right now' : `on ${fmtDate(new Date(runAt).toISOString())}`;
        const ticket = str(job.ticketId);
        return respond(`Okay. I'll call ${biz(str(job.caseId))} again ${when}${ticket !== undefined ? ` and quote ticket ${ticket}` : ''}.`);
      }
      default:
        return respond(FALLBACK_REPLY);
    }
  }

  /* ---------- after a user turn ---------- */
  const activeCall = state.call !== undefined && state.call.state !== undefined && ACTIVE.has(state.call.state) ? state.call : undefined;

  if (intent.kind === 'end' && activeCall !== undefined) return respond('Okay, hanging up.', [call('end_call', { callId: activeCall.callId })]);

  const k = state.kase;
  const awaitingFact = k !== undefined && k.missing.length > 0 && (state.call === undefined || state.call.caseId !== k.id);

  if (activeCall !== undefined && isReplyIntent(intent) && !awaitingFact) {
    // The host polls call_status outside this conversation, so the call state in
    // the history (often just place_call's DIALING) is stale. A reply may be
    // answering the business ("Join the call?" -> "yes", a pending fact): read
    // the live state first, then act on it (see the call_status branch above).
    if (tools.size === 0 || tools.has('call_status')) return respond(undefined, [call('call_status', { callId: activeCall.callId })]);
    const next = replyToLiveCall(activeCall, intent, userText, events, call);
    if (next !== undefined) return respond(undefined, [next]);
  }
  if (awaitingFact && k !== undefined && (intent.kind === 'other' || intent.kind === 'yes')) {
    const first = k.missing[0];
    if (first !== undefined) {
      const value = (first.key.includes('account') ? extractAccount(userText) : undefined) ?? extractAnswer(userText);
      // The user answered our question for this call: approval to share it on this case.
      return respond(undefined, [call('update_case_fact', { caseId: k.id, key: first.key, label: first.label, value, approve: true })]);
    }
  }

  switch (intent.kind) {
    case 'broadband': {
      const facts: Json[] = [];
      const acct = extractAccount(userText);
      if (acct !== undefined) facts.push({ key: 'account_number', value: acct, approve: true });
      const args: Json = {
        businessName: mentionedBusiness(userText, ctx.businesses) ?? defaultBusiness,
        goal: 'broadband has been down for three days; get it fixed and a refund or credit for the outage',
        desiredOutcome: /\b(technician|repair)\b/i.test(userText) ? 'repair' : 'refund',
        facts,
      };
      if (req.scenarioHint === 'otp') args.scenario = 'otp-trap';
      else if (req.scenarioHint === 'happy' || req.scenarioHint === 'followup') args.scenario = 'happy-refund';
      return respond(undefined, [call('open_case', args)]);
    }
    case 'refund': {
      const facts: Json[] = [];
      if (intent.orderId !== undefined) facts.push({ key: 'order_id', label: 'Order ID', value: intent.orderId });
      const acct = extractAccount(userText.replace(/\bOD\d+\b/gi, ''));
      if (acct !== undefined) facts.push({ key: 'account_number', value: acct, approve: true });
      return respond(undefined, [
        call('open_case', {
          businessName: mentionedBusiness(userText, ctx.businesses) ?? defaultBusiness,
          goal: `get the refund for order ${intent.orderId ?? '(order id to be confirmed)'} processed`,
          desiredOutcome: 'refund',
          facts,
        }),
      ]);
    }
    case 'status': {
      // "How's the call going?" -> the live call; "what happened with my complaint?" -> the case.
      const aboutCall = /\b(call|status|on hold|still)\b/i.test(userText) && !/\b(complaint|case)\b/i.test(userText);
      if (activeCall !== undefined && aboutCall) return respond(undefined, [call('call_status', { callId: activeCall.callId })]);
      const named = mentionedBusiness(userText, ctx.businesses);
      if (k !== undefined && (named === undefined || named === k.businessName)) return respond(undefined, [call('get_case', { caseId: k.id })]);
      return respond(undefined, [call('list_cases', { limit: 5 })]);
    }
    case 'followup':
      if (k !== undefined && k.hasPromise) return respond(undefined, [call('schedule_followup', { caseId: k.id, at: new Date(ctx.now.getTime() + 3000).toISOString() })]);
      return respond(undefined, [call('list_cases', { limit: 5 })]);
    case 'end':
      return respond("There's no call in progress.");
    default:
      return respond(HELP);
  }
}

/* ------------------------------------------------------------------ */
/* LLM-backed orchestrator (LocalLlm / Bedrock)                          */
/* ------------------------------------------------------------------ */

const LlmReplySchema = z.object({
  text: z.string().max(4000).optional(),
  toolCalls: z
    .array(z.object({ name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()).default({}) }))
    .max(8)
    .optional(),
});

/** Shared by the native tool-use route (Bedrock Converse) and the JSON-prompt route. */
export const ORCHESTRATOR_RULES = `You are Alexa+ with the Stand-In add-on. Stand-In places customer-care phone calls for the user, waits on hold, explains the issue, and records the ticket number and promise.
Rules:
- Use the tools. Typical flow: open_case -> (ask the user for missingFacts, then update_case_fact) -> place_call -> call_status.
- The device tracks the live call separately, so the call state in this conversation may be stale: when a call is active and the user replies (yes, no, a detail), call call_status first and act on what it returns.
- When call_status shows pendingQuestion kind "fact", ask the user and pass their answer with send_to_call. Kind "handoff" (OTP, PIN) means only the user may answer: ask "Join the call?" and use handoff_to_user.
- Never ask the user to tell you an OTP, PIN, password or card number.
- Keep spoken replies to one or two short sentences.`;

export const ORCHESTRATOR_SYSTEM_PROMPT = `${ORCHESTRATOR_RULES}
Reply with ONLY a JSON object: {"text": "<what to say to the user, optional>", "toolCalls": [{"name": "<tool>", "arguments": {...}}]}. Omit toolCalls when you only speak.`;

function renderTools(req: SimLlmRequest): string {
  return req.tools.map((t) => `- ${t.name}: ${clip(t.description, 600)}\n  input: ${clip(JSON.stringify(t.inputSchema), 2000)}`).join('\n');
}

/** Builds the masked chat for an LlmProvider. Exported for tests. */
export function buildLlmMessages(req: SimLlmRequest, never: readonly CaseFact[]): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const m = (s: string): string => maskText(s, never);
  const names = new Map<string, string>();
  const out: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: `${ORCHESTRATOR_SYSTEM_PROMPT}\n\nTools:\n${m(renderTools(req))}` },
  ];
  for (const msg of req.messages) {
    if (msg.role === 'user') out.push({ role: 'user', content: m(msg.content) });
    else if (msg.role === 'assistant') {
      for (const c of msg.toolCalls ?? []) names.set(c.id, c.name);
      const body: Json = {};
      if (msg.content.length > 0) body.text = msg.content;
      if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) body.toolCalls = msg.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments }));
      out.push({ role: 'assistant', content: m(JSON.stringify(body)) });
    } else {
      out.push({ role: 'user', content: m(`TOOL_RESULT ${names.get(msg.toolCallId ?? '') ?? 'tool'}: ${clip(msg.content, 8000)}`) });
    }
  }
  return out;
}

/** Masks a JSON value's strings (tool arguments / schemas) before they reach the model. */
function maskDeepJson(v: unknown, never: readonly CaseFact[], depth = 0): unknown {
  if (depth > 32) return null;
  if (typeof v === 'string') return maskText(v, never);
  if (Array.isArray(v)) return v.map((x) => maskDeepJson(x, never, depth + 1));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeepJson(x, never, depth + 1)]));
  return v;
}

/** Builds the masked native tool-use request (Bedrock Converse toolConfig). Exported for tests. */
export function buildToolChatRequest(req: SimLlmRequest, never: readonly CaseFact[]): ToolChatRequest {
  const m = (s: string): string => maskText(s, never);
  const messages: ToolChatMessage[] = req.messages.map((msg): ToolChatMessage => {
    if (msg.role === 'user') return { role: 'user', content: m(msg.content) };
    if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: m(msg.content),
        ...(msg.toolCalls !== undefined && msg.toolCalls.length > 0
          ? { toolCalls: msg.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: maskDeepJson(c.arguments, never) as Record<string, unknown> })) }
          : {}),
      };
    }
    const parsed = parseResult(msg.content);
    return { role: 'tool', toolCallId: msg.toolCallId ?? 'tool', content: m(clip(msg.content, 8000)), ...(parsed.isError ? { isError: true } : {}) };
  });
  return {
    system: ORCHESTRATOR_RULES,
    messages,
    tools: req.tools.map((t) => ({ name: t.name, description: m(clip(t.description, 4000)), inputSchema: maskDeepJson(t.inputSchema, never) as Record<string, unknown> })),
    temperature: 0,
    maxTokens: 800,
  };
}

export async function llmOrchestrator(
  llm: LlmProvider,
  req: SimLlmRequest,
  ctx: OrchestratorContext & { never: readonly CaseFact[] },
): Promise<{ response: SimLlmResponse; fallback: boolean }> {
  const fallback = (): { response: SimLlmResponse; fallback: boolean } => ({ response: scriptedOrchestrator(req, ctx), fallback: true });
  const allowedNames = new Set(req.tools.map((t) => t.name));

  // Native tool use (Bedrock Converse toolConfig): the MCP tools go to the model as toolSpecs.
  if (llm.chatWithTools !== undefined && req.tools.length > 0) {
    try {
      const r = await llm.chatWithTools(buildToolChatRequest(req, ctx.never));
      const out: SimLlmResponse = {};
      const text = r.text.trim();
      if (text.length > 0) out.text = maskText(clip(text, 4000), ctx.never);
      const calls = r.toolCalls.filter((c) => allowedNames.has(c.name)).slice(0, 8);
      if (calls.length > 0) out.toolCalls = calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
      const v = SimLlmResponseSchema.safeParse(out);
      return v.success ? { response: v.data, fallback: false } : fallback();
    } catch {
      return fallback();
    }
  }
  let raw: string;
  try {
    raw = await llm.chat({ messages: buildLlmMessages(req, ctx.never), json: true, temperature: 0, maxTokens: 800 });
  } catch {
    return fallback();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    return fallback();
  }
  const r = LlmReplySchema.safeParse(parsed);
  if (!r.success) return fallback();
  const calls = (r.data.toolCalls ?? []).filter((c) => allowedNames.has(c.name));
  const out: SimLlmResponse = {};
  if (r.data.text !== undefined && r.data.text.trim().length > 0) out.text = maskText(r.data.text.trim(), ctx.never);
  if (calls.length > 0) out.toolCalls = calls.map((c, i) => ({ id: `llm_${req.messages.length}_${i + 1}`, name: c.name, arguments: c.arguments }));
  const v = SimLlmResponseSchema.safeParse(out);
  return v.success ? { response: v.data, fallback: false } : fallback();
}
