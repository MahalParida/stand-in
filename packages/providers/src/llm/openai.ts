/**
 * Real LLM via an OpenAI-compatible chat completions endpoint (local dev/eval
 * only; never selected in STANDIN_MODE=aws, which always uses Bedrock).
 * POST {baseUrl}/chat/completions, JSON mode via response_format.
 */
import { ChatRequestSchema, type ChatRequest, type LlmProvider } from '@standin/core';
import { z } from 'zod';
import { LlmProviderError, LlmTimeoutError, stripJsonFence, timeoutSignal } from './json.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const OpenAiReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high']);
export type OpenAiReasoningEffort = z.infer<typeof OpenAiReasoningEffortSchema>;

export const OpenAiOptionsSchema = z.object({
  baseUrl: z.url().default('https://api.openai.com/v1'),
  model: z.string().min(1),
  /** Sent as `Authorization: Bearer`; never echoed in errors. */
  apiKey: z.string().min(1),
  timeoutMs: z.number().int().positive().default(60_000),
  /**
   * Reasoning models (gpt-5 family) reject any temperature but the default and
   * spend output tokens on hidden reasoning: when set, send reasoning_effort,
   * omit temperature and add headroom to max_completion_tokens. Leave unset for
   * non-reasoning models (they reject reasoning_effort).
   */
  openaiReasoningEffort: OpenAiReasoningEffortSchema.optional(),
});

/** Extra completion budget for hidden reasoning (reasoning models). */
export const OPENAI_REASONING_HEADROOM_TOKENS = 2000;
export type OpenAiOptions = z.input<typeof OpenAiOptionsSchema> & { fetch?: FetchLike };

const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .min(1),
});

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly #apiKey: string;
  readonly #reasoning: OpenAiReasoningEffort | undefined;
  readonly #fetch: FetchLike;

  constructor(opts: OpenAiOptions) {
    const o = OpenAiOptionsSchema.parse({
      baseUrl: opts.baseUrl,
      model: opts.model,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      openaiReasoningEffort: opts.openaiReasoningEffort,
    });
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.model = o.model;
    this.timeoutMs = o.timeoutMs;
    this.#apiKey = o.apiKey;
    this.#reasoning = o.openaiReasoningEffort;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async chat(req: ChatRequest): Promise<string> {
    const r = ChatRequestSchema.parse(req);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: r.messages,
      stream: false,
    };
    const reasoning = this.#reasoning;
    if (reasoning !== undefined) body.reasoning_effort = reasoning;
    if (r.temperature !== undefined && reasoning === undefined) body.temperature = r.temperature;
    if (r.maxTokens !== undefined) {
      body.max_completion_tokens = r.maxTokens + (reasoning !== undefined ? OPENAI_REASONING_HEADROOM_TOKENS : 0);
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
          authorization: `Bearer ${this.#apiKey}`,
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
