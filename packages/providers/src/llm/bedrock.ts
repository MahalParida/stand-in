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
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import {
  ChatRequestSchema,
  ToolChatRequestSchema,
  type ChatMessage,
  type ChatRequest,
  type LlmProvider,
  type ToolChatCall,
  type ToolChatMessage,
  type ToolChatRequest,
  type ToolChatResult,
  type ToolChatSpec,
} from '@standin/core';
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

/* ------------------------------------------------------------------ */
/* Native tool use (Converse toolConfig / toolUse / toolResult)        */
/* ------------------------------------------------------------------ */

/** JSON value accepted by Converse `json` / `input` fields (smithy DocumentType). */
export type JsonDoc = null | boolean | number | string | JsonDoc[] | { [k: string]: JsonDoc };

/** unknown -> JSON document (drops undefined / functions / non-finite numbers). */
export function toJsonDoc(v: unknown, depth = 0): JsonDoc {
  if (depth > 64) return null;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map((x) => toJsonDoc(x, depth + 1));
  if (typeof v === 'object') {
    const out: { [k: string]: JsonDoc } = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined && typeof x !== 'function') out[k] = toJsonDoc(x, depth + 1);
    return out;
  }
  return null;
}

/** Converse toolUseId: [a-zA-Z0-9_-]{1,64}. Deterministic, so a call and its result still pair up. */
export function converseToolUseId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return clean.length > 0 ? clean : 'tool';
}

export function toConverseTools(tools: readonly ToolChatSpec[]): Tool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.name,
      ...(t.description.length > 0 ? { description: t.description } : {}),
      inputSchema: { json: toJsonDoc(t.inputSchema) },
    },
  }));
}

/**
 * Tool conversation -> Converse messages: assistant tool calls become toolUse
 * blocks, tool results become toolResult blocks in a user turn. Consecutive
 * same-role turns are merged (Converse needs strict alternation, user first).
 */
export function toConverseToolMessages(messages: readonly ToolChatMessage[]): Message[] {
  const turns: { role: 'user' | 'assistant'; content: ContentBlock[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: ContentBlock[]): void => {
    if (blocks.length === 0) return;
    const last = turns.at(-1);
    if (last !== undefined && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      push('user', [{ text: m.content.length > 0 ? m.content : '…' }]);
    } else if (m.role === 'assistant') {
      const blocks: ContentBlock[] = [];
      if (m.content.trim().length > 0) blocks.push({ text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ toolUse: { toolUseId: converseToolUseId(c.id), name: c.name, input: toJsonDoc(c.arguments) } });
      }
      push('assistant', blocks);
    } else {
      push('user', [
        {
          toolResult: {
            toolUseId: converseToolUseId(m.toolCallId),
            content: [{ text: m.content.length > 0 ? m.content : '{}' }],
            ...(m.isError === true ? { status: 'error' as const } : {}),
          },
        },
      ]);
    }
  }
  if (turns[0]?.role !== 'user') turns.unshift({ role: 'user', content: [{ text: LEAD_IN }] });
  return turns.map((t) => ({ role: t.role, content: t.content }));
}

const ConverseToolOutputSchema = z.object({
  output: z.object({
    message: z.object({
      content: z.array(
        z
          .object({
            text: z.string().optional(),
            toolUse: z
              .object({ toolUseId: z.string().min(1), name: z.string().min(1).max(64), input: z.unknown().optional() })
              .loose()
              .optional(),
          })
          .loose(),
      ),
    }),
  }),
});

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

  /** Native Converse tool use: the tools go in toolConfig, tool calls come back as toolUse blocks. */
  async chatWithTools(req: ToolChatRequest): Promise<ToolChatResult> {
    const r = ToolChatRequestSchema.parse(req);
    const inferenceConfig: { temperature?: number; maxTokens?: number } = {};
    if (r.temperature !== undefined) inferenceConfig.temperature = r.temperature;
    if (r.maxTokens !== undefined) inferenceConfig.maxTokens = r.maxTokens;
    const command = new ConverseCommand({
      modelId: this.modelId,
      messages: toConverseToolMessages(r.messages),
      ...(r.system.length > 0 ? { system: [{ text: r.system }] } : {}),
      toolConfig: { tools: toConverseTools(r.tools) },
      ...(Object.keys(inferenceConfig).length > 0 ? { inferenceConfig } : {}),
    });
    const out = await this.#send(command);
    const parsed = ConverseToolOutputSchema.safeParse(out);
    if (!parsed.success) throw new LlmProviderError(this.name, 'unexpected Converse output shape');
    const text: string[] = [];
    const toolCalls: ToolChatCall[] = [];
    for (const b of parsed.data.output.message.content) {
      if (b.text !== undefined) text.push(b.text);
      if (b.toolUse !== undefined) {
        const input = b.toolUse.input;
        const args = typeof input === 'object' && input !== null && !Array.isArray(input) ? (toJsonDoc(input) as { [k: string]: JsonDoc }) : {};
        toolCalls.push({ id: converseToolUseId(b.toolUse.toolUseId), name: b.toolUse.name, arguments: args });
      }
    }
    return { text: text.join('').trim(), toolCalls };
  }

  async #send(command: ConverseCommand): Promise<ConverseCommandOutput> {
    const t = timeoutSignal(this.timeoutMs);
    try {
      return await this.#client.send(command, { abortSignal: t.signal });
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

    const out = await this.#send(command);
    const parsed = ConverseOutputSchema.safeParse(out);
    if (!parsed.success) throw new LlmProviderError(this.name, 'unexpected Converse output shape');
    const text = parsed.data.output.message.content
      .map((b) => b.text ?? '')
      .join('');
    return r.json === true ? stripJsonFence(text) : text;
  }
}
