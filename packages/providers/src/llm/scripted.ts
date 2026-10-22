/**
 * Deterministic LLM for tests, eval replays and `STANDIN_MODE=offline`.
 * Given either a queue of steps or a function of the request, returns canned
 * text. Can inject invalid JSON (scenario S8: bad planner output → safe fallback).
 */
import { ChatRequestSchema, type ChatRequest, type LlmProvider } from '@standin/core';

/** Deliberately unparseable planner output (S8). */
export const INVALID_JSON_OUTPUT = '{"action": "say", "utterance": ' as const;

export type ScriptStep =
  | string
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'invalid_json'; readonly text?: string }
  | { readonly kind: 'error'; readonly message: string };

export type ScriptFn = (req: ChatRequest, callIndex: number) => ScriptStep | Promise<ScriptStep>;

export interface ScriptedLlmOptions {
  /** Queue of steps consumed in order, or a function producing the step for each request. */
  script: readonly ScriptStep[] | ScriptFn;
  /** Used when the queue is exhausted. Without it, an exhausted queue throws. */
  fallback?: ScriptStep | ScriptFn;
  name?: string;
}

export class ScriptExhaustedError extends Error {
  constructor(callIndex: number) {
    super(`ScriptedLlmProvider: script exhausted at call ${callIndex}`);
    this.name = 'ScriptExhaustedError';
  }
}

export class ScriptedLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptedLlmError';
  }
}

function render(step: ScriptStep): string {
  if (typeof step === 'string') return step;
  switch (step.kind) {
    case 'text':
      return step.text;
    case 'json':
      return JSON.stringify(step.value);
    case 'invalid_json':
      return step.text ?? INVALID_JSON_OUTPUT;
    case 'error':
      throw new ScriptedLlmError(step.message);
  }
}

export class ScriptedLlmProvider implements LlmProvider {
  readonly name: string;
  readonly #queue: ScriptStep[];
  readonly #fn: ScriptFn | undefined;
  readonly #fallback: ScriptStep | ScriptFn | undefined;
  readonly #requests: ChatRequest[] = [];
  #calls = 0;

  constructor(opts: ScriptedLlmOptions) {
    this.name = opts.name ?? 'scripted';
    if (typeof opts.script === 'function') {
      this.#fn = opts.script;
      this.#queue = [];
    } else {
      this.#fn = undefined;
      this.#queue = [...opts.script];
    }
    this.#fallback = opts.fallback;
  }

  /** Requests seen so far (validated copies), for assertions in tests. */
  get requests(): readonly ChatRequest[] {
    return this.#requests;
  }

  /** Steps still queued (queue mode only). */
  get remaining(): number {
    return this.#queue.length;
  }

  /** Append steps to the queue. */
  push(...steps: ScriptStep[]): void {
    this.#queue.push(...steps);
  }

  /** Make the next `times` calls return invalid JSON (ahead of anything queued). */
  injectInvalidJson(times = 1): void {
    for (let i = 0; i < times; i++) this.#queue.unshift({ kind: 'invalid_json' });
  }

  async chat(req: ChatRequest): Promise<string> {
    const parsed = ChatRequestSchema.parse(req);
    const index = this.#calls++;
    this.#requests.push(parsed);

    const queued = this.#queue.shift();
    if (queued !== undefined) return render(queued);
    if (this.#fn !== undefined) return render(await this.#fn(parsed, index));
    if (this.#fallback !== undefined) {
      const fb = this.#fallback;
      return render(typeof fb === 'function' ? await fb(parsed, index) : fb);
    }
    throw new ScriptExhaustedError(index);
  }
}

/**
 * The default offline script: a safe, schema-shaped "wait" for JSON requests
 * and a neutral sentence otherwise. The call agent (M2) supplies its own script.
 */
export const defaultOfflineScript: ScriptFn = (req) =>
  req.json === true
    ? { kind: 'json', value: { action: 'wait', reason: 'scripted offline default' } }
    : { kind: 'text', text: 'Okay.' };
