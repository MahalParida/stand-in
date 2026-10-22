import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** ISO-8601 timestamp with an explicit offset (Z or +05:30). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** 64-char lowercase hex sha256 digest. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex digest');

/** "HH:MM" 24h clock time. */
export const ClockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h)');

/** DTMF digits a carrier may press. */
export const DtmfDigitsSchema = z.string().regex(/^[0-9*#]{1,32}$/, 'expected DTMF digits 0-9 * #');

/* ------------------------------------------------------------------ */
/* Case model (spec section 4)                                          */
/* ------------------------------------------------------------------ */

/**
 * Disclosure tier of a case fact.
 * share   - may be spoken freely (name, order ID, issue description)
 * confirm - speak only after user approved for THIS case (phone, email, address, last-4)
 * never   - never spoken by the agent; triggers hand-off (OTP, PIN, CVV, full card, password, Aadhaar)
 */
export const TierSchema = z.enum(['share', 'confirm', 'never']);
export type Tier = z.infer<typeof TierSchema>;

export const FactSourceSchema = z.enum(['user', 'elicited', 'call']);
export type FactSource = z.infer<typeof FactSourceSchema>;

/** Fact keys are referenced by the planner as {{fact:key}}, so keep them template-safe. */
export const FactKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'fact key must be snake_case, start with a letter');

export const CaseFactSchema = z.object({
  key: FactKeySchema,
  label: z.string().min(1).max(200),
  value: z.string().max(2000),
  tier: TierSchema,
  approved: z.boolean(),
  source: FactSourceSchema,
});
export type CaseFact = z.infer<typeof CaseFactSchema>;

export const DesiredOutcomeSchema = z.enum(['refund', 'repair', 'cancel', 'info', 'other']);
export type DesiredOutcome = z.infer<typeof DesiredOutcomeSchema>;

export const CaseStatusSchema = z.enum([
  'draft',
  'ready',
  'calling',
  'awaiting_user',
  'promised',
  'resolved',
  'escalated',
  'failed',
]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

/** What the business committed to (spec calls this `Promise`; renamed to avoid shadowing). */
export const CasePromiseSchema = z.object({
  ticketId: z.string().min(1).max(200).optional(),
  what: z.string().min(1).max(2000),
  dueBy: z.string().min(1).max(200).optional(),
  agentName: z.string().min(1).max(200).optional(),
  callId: z.string().min(1),
});
export type CasePromise = z.infer<typeof CasePromiseSchema>;

/** Shortest never-tier value (letters+digits) checked for inside fact keys. */
const KEY_LEAK_MIN_CHARS = 4;

const alnumLower = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * True when `key` embeds the value of a never-tier fact (case-, space- and
 * punctuation-insensitive), e.g. key `otp_482913` for OTP value "482 913".
 * Fact keys reach the planner/LLM and the stored event log, so such a key
 * would leak the secret.
 */
export function factKeyEmbedsNeverValue(key: string, facts: readonly Pick<CaseFact, 'tier' | 'value'>[]): boolean {
  const k = alnumLower(key);
  return facts.some((f) => {
    if (f.tier !== 'never') return false;
    const v = alnumLower(f.value);
    return v.length >= KEY_LEAK_MIN_CHARS && k.includes(v);
  });
}

export const CaseSchema = z
  .object({
    id: z.string().min(1),
    userName: z.string().min(1).max(200),
    businessId: z.string().min(1),
    goal: z.string().min(1).max(2000),
    desiredOutcome: DesiredOutcomeSchema,
    facts: z.array(CaseFactSchema),
    status: CaseStatusSchema,
    promises: z.array(CasePromiseSchema),
    calls: z.array(z.string().min(1)),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .superRefine((c, ctx) => {
    c.facts.forEach((f, i) => {
      if (factKeyEmbedsNeverValue(f.key, c.facts)) {
        ctx.addIssue({ code: 'custom', path: ['facts', i, 'key'], message: 'fact key must not contain a never-tier value' });
      }
    });
  });
export type Case = z.infer<typeof CaseSchema>;

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

export const CallStateSchema = z.enum([
  'DIALING',
  'IVR',
  'HOLD',
  'HUMAN',
  'HANDOFF_PENDING',
  'USER_ON_LINE',
  'WRAP_UP',
  'ENDED',
  'FAILED',
]);
export type CallState = z.infer<typeof CallStateSchema>;

export const TERMINAL_CALL_STATES: readonly CallState[] = ['ENDED', 'FAILED'];

export const FailureReasonSchema = z.enum([
  'ivr_dead_end',
  'max_duration',
  'remote_hangup',
  'dial_failed',
  'carrier_error',
  'error',
  /** The server process ended while the call was live (recovered at the next start). */
  'server_restart',
  /*
   * Refused before dialling (place_call policy / setup). No call row carries
   * these today; they let a host render a refusal as a FAILED card state.
   */
  'outside_calling_hours',
  'not_allowlisted',
  'daily_cap_reached',
  'call_setup_failed',
]);
export type FailureReason = z.infer<typeof FailureReasonSchema>;

export const OutcomeSchema = z.object({
  ticketId: z.string().min(1).max(200).optional(),
  what: z.string().min(1).max(2000),
  dueBy: z.string().min(1).max(200).optional(),
  agentName: z.string().min(1).max(200).optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

/** Persisted call record (one per dial attempt). */
export const CallSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  businessId: z.string().min(1),
  state: CallStateSchema,
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
  failureReason: FailureReasonSchema.optional(),
  outcome: OutcomeSchema.optional(),
});
export type Call = z.infer<typeof CallSchema>;

export const CallEventTypeSchema = z.enum([
  'state',
  'heard',
  'said',
  'dtmf',
  'blocked_utterance',
  'disclosure_request',
  'handoff',
  'outcome',
  'error',
]);
export type CallEventType = z.infer<typeof CallEventTypeSchema>;

/** Append-only, hash-chained call event (see event-log.ts). */
export const CallEventSchema = z.object({
  id: z.string().min(1),
  callId: z.string().min(1),
  at: IsoDateTimeSchema,
  type: CallEventTypeSchema,
  data: z.unknown(),
  prevHash: Sha256HexSchema,
  hash: Sha256HexSchema,
});
export type CallEvent = z.infer<typeof CallEventSchema>;

/* ------------------------------------------------------------------ */
/* Carrier frames (spec section 5.1 / 5.4)                              */
/* ------------------------------------------------------------------ */

export const InboundFrameKindSchema = z.enum(['ivr_prompt', 'hold', 'speech', 'hangup']);
export type InboundFrameKind = z.infer<typeof InboundFrameKindSchema>;

export const SpeakerSchema = z.enum(['ivr', 'agent', 'system']);
export type Speaker = z.infer<typeof SpeakerSchema>;

export const InboundFrameSchema = z.object({
  kind: InboundFrameKindSchema,
  text: z.string().max(10_000),
  speaker: SpeakerSchema.optional(),
  audio: z.instanceof(Uint8Array).optional(),
});
export type InboundFrame = z.infer<typeof InboundFrameSchema>;

/* ------------------------------------------------------------------ */
/* Planner output (spec section 5.2)                                    */
/* ------------------------------------------------------------------ */

export const PlannerActionSchema = z.enum([
  'say',
  'press',
  'wait',
  'request_handoff',
  'confirm_outcome',
  'end',
]);
export type PlannerAction = z.infer<typeof PlannerActionSchema>;

export const PlannerOutputSchema = z
  .object({
    action: PlannerActionSchema,
    utterance: z.string().min(1).max(2000).optional(),
    digits: DtmfDigitsSchema.optional(),
    outcome: OutcomeSchema.optional(),
    reason: z.string().min(1).max(2000),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'say' && v.utterance === undefined) {
      ctx.addIssue({ code: 'custom', path: ['utterance'], message: "action 'say' requires utterance" });
    }
    if (v.action === 'press' && v.digits === undefined) {
      ctx.addIssue({ code: 'custom', path: ['digits'], message: "action 'press' requires digits" });
    }
    if (v.action === 'confirm_outcome' && v.outcome === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: "action 'confirm_outcome' requires outcome",
      });
    }
  });
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/* ------------------------------------------------------------------ */
/* Business directory (dial allowlist)                                  */
/* ------------------------------------------------------------------ */

export const BusinessHoursSchema = z
  .object({
    start: ClockTimeSchema,
    end: ClockTimeSchema,
    timezone: z.string().min(1).default('Asia/Kolkata'),
  })
  .refine((h) => h.start < h.end, { message: 'hours.start must be before hours.end' });
export type BusinessHours = z.infer<typeof BusinessHoursSchema>;

/** Directory entry. Numbers come ONLY from here, never from conversation or the LLM. */
export const BusinessSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'business id must be kebab-case'),
  name: z.string().min(1).max(200),
  number: z.string().regex(/^\+?[0-9-]{4,20}$/, 'expected a dialable number'),
  hours: BusinessHoursSchema,
  dailyCap: z.number().int().min(0),
  optOut: z.boolean().optional(),
});
export type Business = z.infer<typeof BusinessSchema>;

/** On-disk shape of data/business-directory.json. */
export const BusinessDirectoryFileSchema = z.object({
  version: z.literal(1),
  note: z.string().optional(),
  businesses: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      aliases: z.array(z.string()).optional(),
      category: z.string().optional(),
      phone: z.string(),
      carrier: z.enum(['sim', 'twilio']).optional(),
      timezone: z.string().optional(),
      callingHours: z.object({ start: z.string(), end: z.string() }),
      dailyCallCap: z.number(),
      optOut: z.boolean().optional(),
      fictional: z.boolean().optional(),
    }),
  ),
});
export type BusinessDirectoryFile = z.infer<typeof BusinessDirectoryFileSchema>;

/** Parse data/business-directory.json (already JSON.parse'd) into validated Business entries. */
export function parseBusinessDirectory(raw: unknown): Business[] {
  const file = BusinessDirectoryFileSchema.parse(raw);
  const out = file.businesses.map((b) =>
    BusinessSchema.parse({
      id: b.id,
      name: b.name,
      number: b.phone,
      hours: { start: b.callingHours.start, end: b.callingHours.end, timezone: b.timezone },
      dailyCap: b.dailyCallCap,
      optOut: b.optOut,
    }),
  );
  const ids = new Set<string>();
  for (const b of out) {
    if (ids.has(b.id)) throw new Error(`duplicate business id in directory: ${b.id}`);
    ids.add(b.id);
  }
  return out;
}
