/**
 * Provider interfaces (spec section 2.1, 5.4). Implementations live in
 * packages/providers (offline + aws) and apps/call-agent (carriers).
 */
import { z } from 'zod';
import type { InboundFrame } from './types.js';

/* ------------------------------------------------------------------ */
/* Carrier (spec 5.4)                                                  */
/* ------------------------------------------------------------------ */

export interface Carrier {
  /** `number` must come from the business directory, never from conversation or the LLM. */
  dial(number: string, opts: { callId: string }): Promise<void>;
  /** `text` must already have passed the disclosure guard. */
  say(text: string, audio?: Uint8Array): Promise<void>;
  pressDigits(digits: string): Promise<void>;
  /** Hand-off: the user joins the line. */
  bridgeUser(): Promise<void>;
  unbridgeUser(): Promise<void>;
  hangup(): Promise<void>;
  on(event: 'frame', cb: (f: InboundFrame) => void): void;
}

/* ------------------------------------------------------------------ */
/* LLM                                                                 */
/* ------------------------------------------------------------------ */

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  /** Ask the provider for a single JSON object (caller still validates with zod). */
  json: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/* Native tool use (e.g. Bedrock Converse toolConfig / toolUse / toolResult). */

/** A tool the model may call; inputSchema is the tool's JSON Schema. */
export const ToolChatSpecSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(4000),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolChatSpec = z.infer<typeof ToolChatSpecSchema>;

export const ToolChatCallSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolChatCall = z.infer<typeof ToolChatCallSchema>;

export const ToolChatMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({ role: z.literal('assistant'), content: z.string(), toolCalls: z.array(ToolChatCallSchema).optional() }),
  /** The result of the assistant's tool call `toolCallId` (JSON text). */
  z.object({ role: z.literal('tool'), toolCallId: z.string().min(1).max(200), content: z.string(), isError: z.boolean().optional() }),
]);
export type ToolChatMessage = z.infer<typeof ToolChatMessageSchema>;

export const ToolChatRequestSchema = z.object({
  system: z.string(),
  messages: z.array(ToolChatMessageSchema).min(1),
  tools: z.array(ToolChatSpecSchema).min(1).max(64),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type ToolChatRequest = z.infer<typeof ToolChatRequestSchema>;

export interface ToolChatResult {
  /** Spoken text (may be empty when the model only calls tools). */
  text: string;
  toolCalls: ToolChatCall[];
}

export interface LlmProvider {
  readonly name: string;
  /**
   * Returns the assistant's text. Callers must never include `never`-tier
   * values in `messages` (facts are passed as {{fact:key}} references).
   */
  chat(req: ChatRequest): Promise<string>;
  /**
   * Optional native tool use (Bedrock Converse toolConfig). Providers without
   * it are driven through `chat` with a JSON tool-call protocol in the prompt.
   * Same rule: no `never`-tier values in the request.
   */
  chatWithTools?(req: ToolChatRequest): Promise<ToolChatResult>;
}

/* ------------------------------------------------------------------ */
/* TTS                                                                 */
/* ------------------------------------------------------------------ */

export const TtsVoiceRoleSchema = z.enum(['standin', 'ivr', 'agent']);
export type TtsVoiceRole = z.infer<typeof TtsVoiceRoleSchema>;

export const TtsRequestSchema = z.object({
  text: z.string().min(1).max(3000),
  voice: TtsVoiceRoleSchema.default('standin'),
  languageCode: z.string().default('en-IN'),
});
export type TtsRequest = z.input<typeof TtsRequestSchema>;

export interface TtsResult {
  /** Absent when the provider defers synthesis to the browser (offline mode). */
  audio?: Uint8Array;
  mimeType?: string;
}

export interface TtsProvider {
  readonly name: string;
  /** `text` must already have passed the disclosure guard. */
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

/* ------------------------------------------------------------------ */
/* Scheduler (follow-ups; implementation in M5)                         */
/* ------------------------------------------------------------------ */

export const JobKindSchema = z.enum(['followup']);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum(['pending', 'running', 'done', 'cancelled', 'failed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z.object({
  id: z.string().min(1),
  kind: JobKindSchema,
  caseId: z.string().min(1),
  runAt: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
  status: JobStatusSchema,
  attempts: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Job = z.infer<typeof JobSchema>;

export interface Scheduler {
  schedule(job: Pick<Job, 'id' | 'kind' | 'caseId' | 'runAt' | 'payload'>): Promise<Job>;
  cancel(jobId: string): Promise<boolean>;
  list(caseId?: string): Promise<Job[]>;
}

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock frozen at `iso` (or a Date), advanceable for deterministic tests. */
export class FixedClock implements Clock {
  #ms: number;
  constructor(at: string | Date) {
    this.#ms = typeof at === 'string' ? Date.parse(at) : at.getTime();
    if (Number.isNaN(this.#ms)) throw new RangeError(`FixedClock: invalid date ${String(at)}`);
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
  set(at: string | Date): void {
    const ms = typeof at === 'string' ? Date.parse(at) : at.getTime();
    if (Number.isNaN(ms)) throw new RangeError(`FixedClock: invalid date ${String(at)}`);
    this.#ms = ms;
  }
}
