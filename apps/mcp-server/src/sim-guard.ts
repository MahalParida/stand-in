/**
 * Cost guards for the model-backed sim endpoints (spec 13: endpoint abuse).
 *
 * In the hosted judge demo (DEMO_EMBED_TOKEN=true) anyone can read the Bearer
 * token from /sim/config, so /sim/api/llm and /sim/api/tts are effectively
 * public. When they reach a real model (Bedrock / LocalLlm) or Polly, each
 * request is bounded (history, tools) and metered by a strict per-IP bucket
 * plus a global hourly budget. Over a limit, the LLM endpoint degrades to the
 * scripted matcher and TTS to browser speech, so the demo keeps working and
 * nothing more is billed.
 */
import { TOOL_NAMES, type LlmMessage, type SimLlmRequest } from '@standin/core';

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

  /** Takes one unit; false when this window's budget is spent. */
  take(): boolean {
    const now = this.#now();
    if (now - this.#start >= this.#windowMs) {
      this.#start = now;
      this.#used = 0;
    }
    if (this.#used >= this.#max) return false;
    this.#used++;
    return true;
  }

  get used(): number {
    return this.#used;
  }
}

const KNOWN_TOOLS = new Set<string>(Object.values(TOOL_NAMES));

/** Max messages forwarded to a real model per request (the tail, cut at a user turn). */
export const MAX_MODEL_MESSAGES = 40;
/** Max total message text forwarded to a real model per request. */
export const MAX_MODEL_CHARS = 64_000;
const MAX_TOOL_DESCRIPTION = 1000;

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
 * intact) and only Stand-In's
 * own tools. Returns undefined when nothing usable is left (no Stand-In tool).
 */
export function boundModelRequest(req: SimLlmRequest, maxMessages = MAX_MODEL_MESSAGES, maxChars = MAX_MODEL_CHARS): SimLlmRequest | undefined {
  const tools = req.tools
    .filter((t) => KNOWN_TOOLS.has(t.name))
    .filter((t, i, all) => all.findIndex((x) => x.name === t.name) === i)
    .map((t) => ({ ...t, description: t.description.slice(0, MAX_TOOL_DESCRIPTION) }));
  if (tools.length === 0) return undefined;
  const messages = trimToUserTurn(req.messages, maxMessages, maxChars);
  if (messages.length === 0) return undefined;
  return { ...req, messages, tools };
}
