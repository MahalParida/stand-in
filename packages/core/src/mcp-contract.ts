/**
 * Shared MCP / sim-host contract (spec sections 7 and 8).
 *
 * Source of truth for BOTH apps/mcp-server (producer) and apps/alexa-sim
 * (consumer). Browser-safe: zod and local modules only, no node imports.
 *
 * Disclosure rule: every shape here may reach the LLM, the trace panel or TTS,
 * so none of them may carry a never-tier value. Case views drop never-tier fact
 * values (enforced by {@link PublicFactSchema}); transcript lines, prompts and
 * summaries must be the masked text produced by call-agent.
 */
import { z } from 'zod';
import { JobStatusSchema, TtsVoiceRoleSchema } from './interfaces.js';
import {
  CallStateSchema,
  CasePromiseSchema,
  CaseStatusSchema,
  DesiredOutcomeSchema,
  FactKeySchema,
  FactSourceSchema,
  FailureReasonSchema,
  IsoDateTimeSchema,
  OutcomeSchema,
  TierSchema,
} from './types.js';

const Id = z.string().min(1).max(200);
const ShortText = z.string().min(1).max(500);
const LongText = z.string().max(4000);

/* ------------------------------------------------------------------ */
/* Names, URIs, MIME types                                             */
/* ------------------------------------------------------------------ */

export const TOOL_NAMES = {
  openCase: 'open_case',
  updateCaseFact: 'update_case_fact',
  placeCall: 'place_call',
  callStatus: 'call_status',
  sendToCall: 'send_to_call',
  handoffToUser: 'handoff_to_user',
  endCall: 'end_call',
  getCase: 'get_case',
  listCases: 'list_cases',
  scheduleFollowup: 'schedule_followup',
  deleteCase: 'delete_case',
} as const;
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
export const ToolNameSchema = z.enum(Object.values(TOOL_NAMES) as [ToolName, ...ToolName[]]);

/** RFC 6570 templates as registered with the MCP server. */
export const RESOURCE_TEMPLATES = {
  case: 'standin://cases/{id}',
  callTranscript: 'standin://calls/{id}/transcript',
} as const;
export const CALL_CARD_URI = 'ui://standin/call-card' as const;
/** MIME type of the MCP Apps call card resource. */
export const MCP_APP_MIME = 'text/html;profile=mcp-app' as const;
/** MIME type of the JSON resources (case, transcript). */
export const JSON_MIME = 'application/json' as const;

export const caseUri = (id: string): string => `standin://cases/${encodeURIComponent(id)}`;
export const callTranscriptUri = (callId: string): string => `standin://calls/${encodeURIComponent(callId)}/transcript`;

/* ------------------------------------------------------------------ */
/* Shared views                                                        */
/* ------------------------------------------------------------------ */

/** A case fact as shown to hosts/LLMs: never-tier facts carry no value. */
export const PublicFactSchema = z
  .object({
    key: FactKeySchema,
    label: z.string().min(1).max(200),
    tier: TierSchema,
    approved: z.boolean(),
    source: FactSourceSchema,
    /** Absent for never-tier facts. */
    value: z.string().max(2000).optional(),
  })
  .refine((f) => f.tier !== 'never' || f.value === undefined, {
    path: ['value'],
    message: 'never-tier fact values must not leave the server',
  });
export type PublicFact = z.infer<typeof PublicFactSchema>;

/** Case as returned by tools/resources. `goal` is masked (never-tier values replaced). */
export const CaseViewSchema = z.object({
  id: Id,
  userName: z.string().min(1).max(200),
  businessId: Id,
  businessName: z.string().min(1).max(200),
  goal: z.string().min(1).max(2000),
  desiredOutcome: DesiredOutcomeSchema,
  status: CaseStatusSchema,
  facts: z.array(PublicFactSchema),
  promises: z.array(CasePromiseSchema),
  calls: z.array(Id),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CaseView = z.infer<typeof CaseViewSchema>;

/** A required fact the case still lacks (fallback when elicitation is unavailable). */
export const MissingFactSchema = z.object({
  key: FactKeySchema,
  label: z.string().min(1).max(200),
  /** Question to put to the user. */
  prompt: ShortText,
});
export type MissingFact = z.infer<typeof MissingFactSchema>;

export const FollowupJobViewSchema = z.object({
  id: Id,
  kind: z.literal('followup'),
  caseId: Id,
  runAt: IsoDateTimeSchema,
  status: JobStatusSchema,
  ticketId: z.string().min(1).max(200).optional(),
});
export type FollowupJobView = z.infer<typeof FollowupJobViewSchema>;

/**
 * Transcript speaker. call-agent records 'business'; the server maps it to
 * 'ivr' (DIALING/IVR/HOLD) or 'agent' (a human), and the bridged account
 * holder's speech to 'user'.
 */
export const LineSpeakerSchema = z.enum(['standin', 'ivr', 'agent', 'user', 'system']);
export type LineSpeaker = z.infer<typeof LineSpeakerSchema>;

/** One masked transcript line. */
export const CallLineSchema = z.object({
  speaker: LineSpeakerSchema,
  text: z.string().max(4000),
  at: IsoDateTimeSchema,
});
export type CallLine = z.infer<typeof CallLineSchema>;

/**
 * What the call needs from the user.
 * fact    - the business asked for an unknown detail (S4): answer via send_to_call.
 * confirm - the answer is a personal (confirm-tier) detail: resend with approve=true.
 * handoff - only the account holder may answer (OTP, S2): handoff_to_user.
 */
export const PendingQuestionViewSchema = z.object({
  /** call-agent PendingQuestion.id. */
  id: Id,
  kind: z.enum(['fact', 'handoff', 'confirm']),
  /** Set for 'fact' / 'confirm'. */
  factKey: FactKeySchema.optional(),
  /** Short user-facing label ("Router serial number", "One-time password"). */
  label: z.string().min(1).max(200),
  /** Masked text the business said / the prompt to read to the user. */
  askedText: z.string().min(1).max(2000),
});
export type PendingQuestionView = z.infer<typeof PendingQuestionViewSchema>;

/** Error payload of a tool result with `isError: true`. */
export const ToolErrorSchema = z.object({
  error: z.object({
    /** e.g. a call-agent PlaceCallDenyCode, 'not_found', 'invalid_input'. */
    code: z.string().min(1).max(64),
    message: ShortText,
  }),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

/* ------------------------------------------------------------------ */
/* Tool inputs / structuredContent outputs                             */
/* ------------------------------------------------------------------ */

const CallIdInput = { callId: Id };
const CaseIdInput = { caseId: Id };

// open_case
export const OpenCaseFactInputSchema = z.object({
  key: FactKeySchema,
  label: z.string().min(1).max(200).optional(),
  value: z.string().min(1).max(2000),
  /** User approved sharing a confirm-tier value on this case. Tier itself is assigned by the guard. */
  approve: z.boolean().optional(),
});
export type OpenCaseFactInput = z.infer<typeof OpenCaseFactInputSchema>;

export const OpenCaseInputSchema = z.object({
  businessName: z.string().min(1).max(200),
  goal: z.string().min(1).max(2000),
  desiredOutcome: DesiredOutcomeSchema,
  facts: z.array(OpenCaseFactInputSchema).max(50).default([]),
  userName: z.string().min(1).max(200).optional(),
});
export type OpenCaseInput = z.infer<typeof OpenCaseInputSchema>;
export const OpenCaseOutputSchema = z.object({
  case: CaseViewSchema,
  missingFacts: z.array(MissingFactSchema),
});
export type OpenCaseOutput = z.infer<typeof OpenCaseOutputSchema>;

// update_case_fact
export const UpdateCaseFactInputSchema = z.object({
  ...CaseIdInput,
  key: FactKeySchema,
  value: z.string().min(1).max(2000),
  label: z.string().min(1).max(200).optional(),
  approve: z.boolean().optional(),
});
export type UpdateCaseFactInput = z.infer<typeof UpdateCaseFactInputSchema>;
export const UpdateCaseFactOutputSchema = z.object({
  case: CaseViewSchema,
  missingFacts: z.array(MissingFactSchema),
});
export type UpdateCaseFactOutput = z.infer<typeof UpdateCaseFactOutputSchema>;

// place_call
export const PlaceCallInputSchema = z.object({
  ...CaseIdInput,
  /** Defaults to 14 server-side; only S7 passes 23. */
  simulatedHourIst: z.number().int().min(0).max(23).optional(),
});
export type PlaceCallInput = z.infer<typeof PlaceCallInputSchema>;
export const PlaceCallOutputSchema = z.object({
  callId: Id,
  caseId: Id,
  state: z.literal('DIALING'),
});
export type PlaceCallOutput = z.infer<typeof PlaceCallOutputSchema>;

// call_status
export const CallStatusInputSchema = z.object(CallIdInput);
export type CallStatusInput = z.infer<typeof CallStatusInputSchema>;
export const CallStatusOutputSchema = z.object({
  callId: Id,
  caseId: Id,
  state: CallStateSchema,
  holdSeconds: z.number().int().nonnegative(),
  /** Last few masked lines (card shows 4). */
  lastLines: z.array(CallLineSchema),
  pendingQuestion: PendingQuestionViewSchema.optional(),
  outcome: OutcomeSchema.optional(),
  /** DTMF digits pressed so far, in order (e.g. ["3"]). */
  digitsPressed: z.array(z.string().regex(/^[0-9*#]{1,32}$/)),
  /** Outbound utterances the disclosure guard blocked. */
  blockedCount: z.number().int().nonnegative(),
  /** Callee prompt-injection attempts detected. */
  injectionCount: z.number().int().nonnegative(),
  failureReason: FailureReasonSchema.optional(),
  followupScheduled: z.object({ jobId: Id, runAt: IsoDateTimeSchema }).optional(),
  /** One honest, speakable sentence (includes the failure message when FAILED). */
  summary: z.string().min(1).max(1000),
});
export type CallStatusOutput = z.infer<typeof CallStatusOutputSchema>;

// send_to_call
export const SendToCallInputSchema = z.object({
  ...CallIdInput,
  answer: z.string().min(1).max(500),
  /** Explicit approval to share a confirm-tier answer. */
  approve: z.boolean().optional(),
});
export type SendToCallInput = z.infer<typeof SendToCallInputSchema>;
export const SendToCallOutputSchema = z.object({
  callId: Id,
  /** True when the answer was accepted (relayed, or refused to the business if secret). */
  ok: z.boolean(),
  state: CallStateSchema,
  /** Answer is a personal detail: ask the user, then resend with approve=true. */
  confirmRequired: z.boolean().optional(),
  message: ShortText.optional(),
});
export type SendToCallOutput = z.infer<typeof SendToCallOutputSchema>;

// handoff_to_user
export const HandoffToUserInputSchema = z.object({ ...CallIdInput, accept: z.boolean() });
export type HandoffToUserInput = z.infer<typeof HandoffToUserInputSchema>;
export const HandoffToUserOutputSchema = z.object({
  callId: Id,
  ok: z.boolean(),
  state: CallStateSchema,
  message: ShortText.optional(),
});
export type HandoffToUserOutput = z.infer<typeof HandoffToUserOutputSchema>;

// end_call
export const EndCallInputSchema = z.object(CallIdInput);
export type EndCallInput = z.infer<typeof EndCallInputSchema>;
export const EndCallOutputSchema = z.object({
  callId: Id,
  state: CallStateSchema,
  outcome: OutcomeSchema.optional(),
  failureReason: FailureReasonSchema.optional(),
  summary: z.string().min(1).max(1000),
});
export type EndCallOutput = z.infer<typeof EndCallOutputSchema>;

// get_case
export const CallSummarySchema = z.object({
  callId: Id,
  state: CallStateSchema,
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
  outcome: OutcomeSchema.optional(),
  failureReason: FailureReasonSchema.optional(),
});
export type CallSummary = z.infer<typeof CallSummarySchema>;
export const GetCaseInputSchema = z.object(CaseIdInput);
export type GetCaseInput = z.infer<typeof GetCaseInputSchema>;
export const GetCaseOutputSchema = z.object({
  case: CaseViewSchema,
  calls: z.array(CallSummarySchema),
  followups: z.array(FollowupJobViewSchema),
  summary: z.string().min(1).max(1000),
});
export type GetCaseOutput = z.infer<typeof GetCaseOutputSchema>;

// list_cases
export const ListCasesInputSchema = z.object({
  status: CaseStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListCasesInput = z.infer<typeof ListCasesInputSchema>;
export const ListCasesOutputSchema = z.object({ cases: z.array(CaseViewSchema) });
export type ListCasesOutput = z.infer<typeof ListCasesOutputSchema>;

// schedule_followup
export const ScheduleFollowupInputSchema = z.object({
  ...CaseIdInput,
  /** Default: latest promise dueBy + 1 day. */
  at: IsoDateTimeSchema.optional(),
});
export type ScheduleFollowupInput = z.infer<typeof ScheduleFollowupInputSchema>;
export const ScheduleFollowupOutputSchema = z.object({ job: FollowupJobViewSchema });
export type ScheduleFollowupOutput = z.infer<typeof ScheduleFollowupOutputSchema>;

// delete_case (spec 13: per-case delete)
export const DeleteCaseInputSchema = z.object(CaseIdInput);
export type DeleteCaseInput = z.infer<typeof DeleteCaseInputSchema>;
export const DeleteCaseOutputSchema = z.object({
  caseId: Id,
  deleted: z.boolean(),
  /** Calls whose transcripts (event logs) were erased with the case. */
  callsDeleted: z.number().int().nonnegative(),
  /** Pending follow-up jobs cancelled with the case. */
  followupsCancelled: z.number().int().nonnegative(),
  message: ShortText,
});
export type DeleteCaseOutput = z.infer<typeof DeleteCaseOutputSchema>;

/** Tool name -> {input, output} schemas. */
export const TOOL_SCHEMAS = {
  open_case: { input: OpenCaseInputSchema, output: OpenCaseOutputSchema },
  update_case_fact: { input: UpdateCaseFactInputSchema, output: UpdateCaseFactOutputSchema },
  place_call: { input: PlaceCallInputSchema, output: PlaceCallOutputSchema },
  call_status: { input: CallStatusInputSchema, output: CallStatusOutputSchema },
  send_to_call: { input: SendToCallInputSchema, output: SendToCallOutputSchema },
  handoff_to_user: { input: HandoffToUserInputSchema, output: HandoffToUserOutputSchema },
  end_call: { input: EndCallInputSchema, output: EndCallOutputSchema },
  get_case: { input: GetCaseInputSchema, output: GetCaseOutputSchema },
  list_cases: { input: ListCasesInputSchema, output: ListCasesOutputSchema },
  schedule_followup: { input: ScheduleFollowupInputSchema, output: ScheduleFollowupOutputSchema },
  delete_case: { input: DeleteCaseInputSchema, output: DeleteCaseOutputSchema },
} as const satisfies Record<ToolName, { input: z.ZodType; output: z.ZodType }>;

export type ToolInput<N extends ToolName> = z.input<(typeof TOOL_SCHEMAS)[N]['input']>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[N]['output']>;

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

/** standin://cases/{id} -> JSON body. */
export const CaseResourceSchema = GetCaseOutputSchema;
export type CaseResource = GetCaseOutput;

/** standin://calls/{id}/transcript -> JSON body (masked at write). */
export const TranscriptResourceSchema = z.object({
  callId: Id,
  caseId: Id,
  lines: z.array(CallLineSchema),
});
export type TranscriptResource = z.infer<typeof TranscriptResourceSchema>;

/* ------------------------------------------------------------------ */
/* Sim host HTTP API (apps/mcp-server serves, apps/alexa-sim calls)     */
/* ------------------------------------------------------------------ */

export const SIM_PATHS = {
  llm: '/sim/api/llm',
  tts: '/sim/api/tts',
  config: '/sim/config',
  mcp: '/mcp',
} as const;

export const AutoplayScenarioSchema = z.enum(['happy', 'otp', 'followup']);
export type AutoplayScenario = z.infer<typeof AutoplayScenarioSchema>;

export const LlmToolCallSchema = z.object({
  id: Id,
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()),
});
export type LlmToolCall = z.infer<typeof LlmToolCallSchema>;

export const LlmMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant', 'tool']),
    /** For role 'tool': the tool result (JSON text of structuredContent, or the error). */
    content: z.string().max(20_000),
    /** role 'assistant' only. */
    toolCalls: z.array(LlmToolCallSchema).max(16).optional(),
    /** role 'tool' only: the LlmToolCall.id this answers. */
    toolCallId: Id.optional(),
  })
  .superRefine((m, ctx) => {
    if (m.role === 'tool' && m.toolCallId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['toolCallId'], message: "role 'tool' requires toolCallId" });
    }
    if (m.role !== 'tool' && m.toolCallId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['toolCallId'], message: "toolCallId is only valid on role 'tool'" });
    }
    if (m.role !== 'assistant' && m.toolCalls !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['toolCalls'], message: "toolCalls is only valid on role 'assistant'" });
    }
  });
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

/** An MCP tool converted for the LLM (inputSchema = the MCP tool's JSON Schema). */
/**
 * Max serialized size of one tool's inputSchema (Stand-In's largest, open_case,
 * is under 1 KB). Bounds what a public /sim/api/llm caller can make the server
 * forward to a billed model as a tool spec.
 */
export const MAX_TOOL_INPUT_SCHEMA_CHARS = 4096;

export const LlmToolSpecSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(4000),
  inputSchema: z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= MAX_TOOL_INPUT_SCHEMA_CHARS, {
      message: `inputSchema must serialize to at most ${MAX_TOOL_INPUT_SCHEMA_CHARS} characters`,
    }),
});
export type LlmToolSpec = z.infer<typeof LlmToolSpecSchema>;

export const SimLlmRequestSchema = z.object({
  messages: z.array(LlmMessageSchema).min(1).max(200),
  tools: z.array(LlmToolSpecSchema).max(64),
  /** Steers the offline scripted intent matcher (autoplay). Ignored by real models. */
  scenarioHint: AutoplayScenarioSchema.optional(),
});
export type SimLlmRequest = z.infer<typeof SimLlmRequestSchema>;

export const SimLlmResponseSchema = z
  .object({
    text: LongText.optional(),
    toolCalls: z.array(LlmToolCallSchema).max(16).optional(),
  })
  .refine((r) => r.text !== undefined || (r.toolCalls !== undefined && r.toolCalls.length > 0), {
    message: 'response needs text or at least one tool call',
  });
export type SimLlmResponse = z.infer<typeof SimLlmResponseSchema>;

/**
 * Voice for POST /sim/api/tts: the core TtsVoiceRole (standin | ivr | agent,
 * the phone line, right pane) plus 'alexa' (the Echo, left pane), which the
 * server maps to its own Polly voice.
 */
export const SimTtsVoiceSchema = z.enum(['alexa', ...TtsVoiceRoleSchema.options]);
export type SimTtsVoice = z.infer<typeof SimTtsVoiceSchema>;

/** POST /sim/api/tts. Text must already be masked; the server DLP-checks it again before Polly. */
/**
 * Max text per /sim/api/tts request. Polly is billed per character, so this is
 * sized to what the page speaks (one phone-line utterance), not a document.
 */
export const SIM_TTS_MAX_CHARS = 600;

export const SimTtsRequestSchema = z.object({
  text: z.string().min(1).max(SIM_TTS_MAX_CHARS),
  voice: SimTtsVoiceSchema,
});
export type SimTtsRequest = z.infer<typeof SimTtsRequestSchema>;
/** Response: 200 with body bytes of this type (aws/Polly), or 204 = use browser speechSynthesis. */
export const SIM_TTS_AUDIO_MIME = 'audio/mpeg' as const;

export const SimModeSchema = z.enum(['offline', 'aws']);
export const SimLlmKindSchema = z.enum(['scripted', 'localllm', 'bedrock']);
export const SimTtsKindSchema = z.enum(['browser', 'polly']);

/** GET /sim/config. demoToken only when DEMO_EMBED_TOKEN=true (hosted judge demo). */
export const SimConfigSchema = z.object({
  mode: SimModeSchema,
  llm: SimLlmKindSchema,
  tts: SimTtsKindSchema,
  demoToken: z.string().min(1).optional(),
});
export type SimConfig = z.infer<typeof SimConfigSchema>;
