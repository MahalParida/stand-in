/**
 * Cost guards for the model-backed sim endpoints (spec 13: endpoint abuse).
 *
 * In the hosted judge demo (DEMO_EMBED_TOKEN=true) anyone can read the Bearer
 * token from /sim/config, so /sim/api/llm and /sim/api/tts are effectively
 * public. When they reach a real model (Bedrock / OpenAI) or Polly, each
 * request is bounded (history, tools, output tokens) and metered by a strict
 * per-IP bucket plus global hourly and daily (UTC day) budgets. Over a limit,
 * the LLM endpoint degrades to the scripted matcher and TTS to browser speech,
 * so the demo keeps working and nothing more is billed.
 */
import {
  MAX_TOOL_INPUT_SCHEMA_CHARS,
  TOOL_NAMES,
  type ChatRequest,
  type LlmMessage,
  type LlmProvider,
  type LlmToolSpec,
  type SimLlmRequest,
} from '@standin/core';

/** Fixed-window global budget (e.g. model calls per hour across all clients). */
export class WindowCap {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #start: number;
  #used = 0;

  constructor(opts: { max: number; windowMs: number; now?: () => number }) {
    if (!(opts.max >= 0) || !(opts.windowMs > 0)) throw new RangeError('WindowCap: max >= 0 and windowMs > 0 required');
    this.#max = opts.max;
    this.#windowMs = opts.windowMs;
    this.#now = opts.now ?? (() => Date.now());
    this.#start = this.#now();
  }

  #roll(): void {
    const now = this.#now();
    if (now - this.#start >= this.#windowMs) {
      this.#start = now;
      this.#used = 0;
    }
  }

  /** True when `units` more fit in this window (takes nothing). */
  canTake(units = 1): boolean {
    this.#roll();
    return this.#used + units <= this.#max;
  }

  /** Takes `units` (default 1); false, taking nothing, when they do not fit in this window's budget. */
  take(units = 1): boolean {
    if (!this.canTake(units)) return false;
    this.#used += units;
    return true;
  }

  get used(): number {
    return this.#used;
  }
}

/**
 * Process-wide budget per UTC calendar day (resets at 00:00 UTC). In-memory:
 * a redeploy/restart starts a fresh count, which the hourly cap still bounds.
 */
export class UtcDayCap {
  readonly #max: number;
  readonly #now: () => number;
  #day = '';
  #used = 0;

  constructor(opts: { max: number; now?: () => number }) {
    if (!(opts.max >= 0)) throw new RangeError('UtcDayCap: max >= 0 required');
    this.#max = opts.max;
    this.#now = opts.now ?? (() => Date.now());
  }

  #roll(): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#used = 0;
    }
  }

  canTake(units = 1): boolean {
    this.#roll();
    return this.#used + units <= this.#max;
  }

  take(units = 1): boolean {
    if (!this.canTake(units)) return false;
    this.#used += units;
    return true;
  }

  get used(): number {
    this.#roll();
    return this.#used;
  }

  /** The UTC day being counted (YYYY-MM-DD). */
  get day(): string {
    this.#roll();
    return this.#day;
  }
}

/** Which global budget refused a request, if any. */
export type BudgetVerdict = 'ok' | 'daily' | 'hourly';

/** A daily and an hourly budget metered in the same unit (requests, or characters for Polly). */
export interface BudgetPair {
  daily: UtcDayCap;
  hourly: WindowCap;
}

/**
 * Takes `units` from every pair, or from none (each pair's daily cap is
 * checked before its hourly cap). Lets one request be metered both per
 * request and per character.
 */
export function takeBudgets(pairs: readonly BudgetPair[], units: readonly number[]): BudgetVerdict {
  for (const [i, p] of pairs.entries()) {
    const n = units[i] ?? 1;
    if (!p.daily.canTake(n)) return 'daily';
    if (!p.hourly.canTake(n)) return 'hourly';
  }
  for (const [i, p] of pairs.entries()) {
    const n = units[i] ?? 1;
    p.daily.take(n);
    p.hourly.take(n);
  }
  return 'ok';
}

/** Takes `units` (default 1) from both budgets, or from neither (daily is checked first). */
export function takeBudget(daily: UtcDayCap, hourly: WindowCap, units = 1): BudgetVerdict {
  return takeBudgets([{ daily, hourly }], [units]);
}

/**
 * Meters the call planner's model (Bedrock on the hosted demo) against the
 * same global LLM budget as /sim/api/llm, so calls placed through /mcp cannot
 * spend past the caps. Once a cap is reached it answers from `fallback` (the
 * deterministic scripted policy) instead, so calls keep working at no cost.
 */
export class BudgetedLlm implements LlmProvider {
  readonly name: string;
  constructor(
    readonly primary: LlmProvider,
    readonly budget: BudgetPair,
    readonly fallback: LlmProvider,
  ) {
    this.name = `budgeted(${primary.name})`;
  }

  chat(req: ChatRequest): Promise<string> {
    return takeBudget(this.budget.daily, this.budget.hourly) === 'ok' ? this.primary.chat(req) : this.fallback.chat(req);
  }
}

/** Response header naming the spent budget; the sim page shows a "demo budget reached" note when it sees it. */
export const BUDGET_HEADER = 'x-standin-budget';

const KNOWN_TOOLS = new Set<string>(Object.values(TOOL_NAMES));

/** Max messages forwarded to a real model per request (the tail, cut at a user turn). */
export const MAX_MODEL_MESSAGES = 40;
/** Max total message text forwarded to a real model per request. */
export const MAX_MODEL_CHARS = 64_000;
const MAX_TOOL_DESCRIPTION = 1000;
/**
 * Max total size of the tool specs forwarded per request (names, clipped
 * descriptions and input schemas). Stand-In's 11 tools come to about 6k.
 */
export const MAX_MODEL_TOOL_CHARS = 24_000;

const toolSize = (t: LlmToolSpec): number => t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;

const size = (m: LlmMessage): number => m.content.length + (m.toolCalls === undefined ? 0 : JSON.stringify(m.toolCalls).length);

/** The longest tail within `max` messages and `maxChars`, starting at a user turn (tool pairs stay intact). */
function trimToUserTurn(messages: readonly LlmMessage[], max: number, maxChars: number): LlmMessage[] {
  let start = Math.max(0, messages.length - max);
  let total = 0;
  for (let i = messages.length - 1; i >= start; i--) {
    const m = messages[i];
    if (m === undefined) break;
    total += size(m);
    if (total > maxChars) {
      start = i + 1;
      break;
    }
  }
  const tail = messages.slice(start);
  const firstUser = tail.findIndex((m) => m.role === 'user');
  if (firstUser >= 0) return tail.slice(firstUser);
  // No user turn fits: keep just the last user message, clipped.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return lastUser === undefined ? [] : [{ ...lastUser, content: lastUser.content.slice(0, maxChars) }];
}

/**
 * Bounds a request bound for a real model: the last MAX_MODEL_MESSAGES
 * messages within MAX_MODEL_CHARS (cut at a user turn so tool pairs stay
 * intact) and only Stand-In's own tools, each inputSchema within
 * MAX_TOOL_INPUT_SCHEMA_CHARS and all specs within MAX_MODEL_TOOL_CHARS.
 * Returns undefined when nothing usable is left (no Stand-In tool) or the
 * tool payload is over its bound.
 */
export function boundModelRequest(req: SimLlmRequest, maxMessages = MAX_MODEL_MESSAGES, maxChars = MAX_MODEL_CHARS): SimLlmRequest | undefined {
  const tools = req.tools
    .filter((t) => KNOWN_TOOLS.has(t.name))
    // Defence in depth: SimLlmRequestSchema already refuses larger schemas.
    .filter((t) => JSON.stringify(t.inputSchema).length <= MAX_TOOL_INPUT_SCHEMA_CHARS)
    .filter((t, i, all) => all.findIndex((x) => x.name === t.name) === i)
    .map((t) => ({ ...t, description: t.description.slice(0, MAX_TOOL_DESCRIPTION) }));
  if (tools.length === 0) return undefined;
  if (tools.reduce((n, t) => n + toolSize(t), 0) > MAX_MODEL_TOOL_CHARS) return undefined;
  const messages = trimToUserTurn(req.messages, maxMessages, maxChars);
  if (messages.length === 0) return undefined;
  return { ...req, messages, tools };
}
