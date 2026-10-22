/**
 * Amazon Bedrock Converse provider (spec 2.1; CLAUDE.md: must remain imported
 * and wired). Uses the default AWS credential chain only — no keys in code.
 * The client is injectable so tests never touch the network.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type Message,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { ChatRequestSchema, type ChatMessage, type ChatRequest, type LlmProvider } from '@standin/core';
import { z } from 'zod';
import { JSON_ONLY_INSTRUCTION, LlmProviderError, LlmTimeoutError, stripJsonFence, timeoutSignal } from './json.js';

/** The slice of BedrockRuntimeClient this provider uses (a real client satisfies it). */
export interface ConverseClient {
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

export const BedrockOptionsSchema = z.object({
  region: z.string().min(1),
  modelId: z.string().min(1),
  timeoutMs: z.number().int().positive().default(30_000),
});
export type BedrockOptions = z.input<typeof BedrockOptionsSchema> & { client?: ConverseClient };

const ConverseOutputSchema = z.object({
  output: z.object({
    message: z.object({
      role: z.string().optional(),
      content: z.array(z.object({ text: z.string().optional() }).loose()),
    }),
  }),
});

/** Placeholder turn when a conversation would otherwise start with the assistant. */
const LEAD_IN = 'Begin.';

/**
 * Converse requires system prompts out of band and strictly alternating
 * user/assistant turns starting with user. Consecutive same-role messages are
 * merged with a blank line.
 */
export function toConverseInput(
  messages: readonly ChatMessage[],
  json: boolean,
): { system: SystemContentBlock[]; messages: Message[] } {
  const system: SystemContentBlock[] = messages
    .filter((m) => m.role === 'system')
    .map((m) => ({ text: m.content }));
  if (json) system.push({ text: JSON_ONLY_INSTRUCTION });

  const turns: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const last = turns.at(-1);
    if (last !== undefined && last.role === m.role) last.text = `${last.text}\n\n${m.content}`;
    else turns.push({ role: m.role, text: m.content });
  }
  if (turns[0]?.role !== 'user') turns.unshift({ role: 'user', text: LEAD_IN });

  return {
    system,
    messages: turns.map((t) => ({ role: t.role, content: [{ text: t.text } satisfies ContentBlock] })),
  };
}

export class BedrockProvider implements LlmProvider {
  readonly name = 'bedrock';
  readonly modelId: string;
  readonly region: string;
  readonly timeoutMs: number;
  readonly #client: ConverseClient;

  constructor(opts: BedrockOptions) {
    const o = BedrockOptionsSchema.parse({ region: opts.region, modelId: opts.modelId, timeoutMs: opts.timeoutMs });
    this.modelId = o.modelId;
    this.region = o.region;
    this.timeoutMs = o.timeoutMs;
    // Default credential chain (env, SSO/profile, instance/Lambda role). Never pass keys here.
    this.#client = opts.client ?? new BedrockRuntimeClient({ region: o.region });
  }

  async chat(req: ChatRequest): Promise<string> {
    const r = ChatRequestSchema.parse(req);
    const { system, messages } = toConverseInput(r.messages, r.json === true);
    const inferenceConfig: { temperature?: number; maxTokens?: number } = {};
    if (r.temperature !== undefined) inferenceConfig.temperature = r.temperature;
    if (r.maxTokens !== undefined) inferenceConfig.maxTokens = r.maxTokens;

    const command = new ConverseCommand({
      modelId: this.modelId,
      messages,
      ...(system.length > 0 ? { system } : {}),
      ...(Object.keys(inferenceConfig).length > 0 ? { inferenceConfig } : {}),
    });

    const t = timeoutSignal(this.timeoutMs);
    let out: ConverseCommandOutput;
    try {
      out = await this.#client.send(command, { abortSignal: t.signal });
    } catch (err) {
      if (t.signal.aborted) throw new LlmTimeoutError(this.timeoutMs);
      const status =
        typeof err === 'object' && err !== null && '$metadata' in err
          ? z.object({ httpStatusCode: z.number().optional() }).safeParse(err.$metadata).data?.httpStatusCode
          : undefined;
      throw new LlmProviderError(this.name, `Converse failed (${err instanceof Error ? err.name : 'unknown'})`, status);
    } finally {
      t.clear();
    }

    const parsed = ConverseOutputSchema.safeParse(out);
    if (!parsed.success) throw new LlmProviderError(this.name, 'unexpected Converse output shape');
    const text = parsed.data.output.message.content
      .map((b) => b.text ?? '')
      .join('');
    return r.json === true ? stripJsonFence(text) : text;
  }
}
