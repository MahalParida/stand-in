/**
 * Local LLM via LocalLlm's OpenAI-compatible endpoint (offline fallback, spec 2.1).
 * POST {baseUrl}/chat/completions, JSON mode via response_format.
 * With `apiKey` + `dialect: 'openai'` the same adapter talks to the OpenAI API
 * (eval-only fast path; never selected by the server).
 */
import { ChatRequestSchema, type ChatRequest, type LlmProvider } from '@standin/core';
import { z } from 'zod';
import { LlmProviderError, LlmTimeoutError, stripJsonFence, timeoutSignal } from './json.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const LocalLlmOptionsSchema = z.object({
  baseUrl: z.url().default('http://localhost:11434/v1'),
  model: z.string().min(1).default('local-model'),
  timeoutMs: z.number().int().positive().default(60_000),
  /**
   * Thinking models (local-model etc.) spend max_tokens on hidden reasoning and can
   * return empty content. 'none' disables it, which the per-turn planner wants.
   */
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).default('none'),
  /** Sent as `Authorization: Bearer`; required by the OpenAI API, unused by LocalLlm. */
  apiKey: z.string().min(1).optional(),
  /**
   * 'localllm' sends reasoning_effort + max_tokens; 'openai' omits reasoning_effort
   * (rejected by non-reasoning models) and sends max_completion_tokens.
   */
  dialect: z.enum(['localllm', 'openai']).default('localllm'),
  /**
   * openai dialect only. Reasoning models (gpt-5 family) reject any temperature
   * but the default and spend output tokens on hidden reasoning: when set, send
   * reasoning_effort, omit temperature and add headroom to max_completion_tokens.
   * Leave unset for non-reasoning models.
   */
  openaiReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
});

/** Extra completion budget for hidden reasoning (openai reasoning models). */
export const OPENAI_REASONING_HEADROOM_TOKENS = 2000;
export type LocalLlmReasoningEffort = z.infer<typeof LocalLlmOptionsSchema>['reasoningEffort'];
export type LocalLlmOptions = z.input<typeof LocalLlmOptionsSchema> & { fetch?: FetchLike };

const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .min(1),
});

export class LocalLlmProvider implements LlmProvider {
  readonly name: 'localllm' | 'openai';
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly reasoningEffort: LocalLlmReasoningEffort;
  readonly #apiKey: string | undefined;
  readonly #openaiReasoning: 'minimal' | 'low' | 'medium' | 'high' | undefined;
  readonly #fetch: FetchLike;

  constructor(opts: LocalLlmOptions = {}) {
    const o = LocalLlmOptionsSchema.parse({
      baseUrl: opts.baseUrl,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      reasoningEffort: opts.reasoningEffort,
      apiKey: opts.apiKey,
      dialect: opts.dialect,
      openaiReasoningEffort: opts.openaiReasoningEffort,
    });
    this.#openaiReasoning = o.dialect === 'openai' ? o.openaiReasoningEffort : undefined;
    this.name = o.dialect;
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.model = o.model;
    this.timeoutMs = o.timeoutMs;
    this.reasoningEffort = o.reasoningEffort;
    this.#apiKey = o.apiKey;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async chat(req: ChatRequest): Promise<string> {
    const r = ChatRequestSchema.parse(req);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: r.messages,
      stream: false,
    };
    const reasoning = this.#openaiReasoning;
    if (this.name === 'localllm') body.reasoning_effort = this.reasoningEffort;
    if (reasoning !== undefined) body.reasoning_effort = reasoning;
    if (r.temperature !== undefined && reasoning === undefined) body.temperature = r.temperature;
    if (r.maxTokens !== undefined) {
      if (this.name === 'openai') {
        body.max_completion_tokens = r.maxTokens + (reasoning !== undefined ? OPENAI_REASONING_HEADROOM_TOKENS : 0);
      } else {
        body.max_tokens = r.maxTokens;
      }
    }
    if (r.seed !== undefined) body.seed = r.seed;
    if (r.json === true) body.response_format = { type: 'json_object' };

    const t = timeoutSignal(this.timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.#apiKey !== undefined ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: t.signal,
      });
    } catch (err) {
      t.clear();
      if (t.signal.aborted) throw new LlmTimeoutError(this.timeoutMs);
      throw new LlmProviderError(this.name, `request failed (${err instanceof Error ? err.name : 'unknown'})`);
    }

    try {
      if (!res.ok) throw new LlmProviderError(this.name, `HTTP ${res.status}`, res.status);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new LlmProviderError(this.name, 'response was not JSON');
      }
      const parsed = CompletionSchema.safeParse(json);
      if (!parsed.success) throw new LlmProviderError(this.name, 'unexpected response shape');
      const content = parsed.data.choices[0]?.message.content ?? '';
      return r.json === true ? stripJsonFence(content) : content;
    } catch (err) {
      if (t.signal.aborted && !(err instanceof LlmProviderError)) throw new LlmTimeoutError(this.timeoutMs);
      throw err;
    } finally {
      t.clear();
    }
  }
}
