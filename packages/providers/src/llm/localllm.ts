/**
 * Local LLM via LocalLlm's OpenAI-compatible endpoint (offline fallback, spec 2.1).
 * POST {baseUrl}/chat/completions, JSON mode via response_format.
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
});
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
  readonly name = 'localllm';
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly reasoningEffort: LocalLlmReasoningEffort;
  readonly #fetch: FetchLike;

  constructor(opts: LocalLlmOptions = {}) {
    const o = LocalLlmOptionsSchema.parse({
      baseUrl: opts.baseUrl,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      reasoningEffort: opts.reasoningEffort,
    });
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.model = o.model;
    this.timeoutMs = o.timeoutMs;
    this.reasoningEffort = o.reasoningEffort;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async chat(req: ChatRequest): Promise<string> {
    const r = ChatRequestSchema.parse(req);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: r.messages,
      stream: false,
      reasoning_effort: this.reasoningEffort,
    };
    if (r.temperature !== undefined) body.temperature = r.temperature;
    if (r.maxTokens !== undefined) body.max_tokens = r.maxTokens;
    if (r.json === true) body.response_format = { type: 'json_object' };

    const t = timeoutSignal(this.timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
