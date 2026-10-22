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

export interface LlmProvider {
  readonly name: string;
  /**
   * Returns the assistant's text. Callers must never include `never`-tier
   * values in `messages` (facts are passed as {{fact:key}} references).
   */
  chat(req: ChatRequest): Promise<string>;
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
