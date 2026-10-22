import { z } from 'zod';

/**
 * Disclosure tier of a fact.
 *
 * - `share`   – may be spoken freely (name, order ID, issue description).
 * - `confirm` – may be spoken only once the owner has approved it for this call.
 * - `never`   – must never be spoken (OTP, PIN, CVV, full card number, password, Aadhaar).
 */
export const TierSchema = z.enum(['share', 'confirm', 'never']);
export type Tier = z.infer<typeof TierSchema>;

/** Fact keys are referenced from templates as `{{fact:key}}`. */
export const FactKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.-]+$/, 'fact key may only contain letters, digits, "_", "." and "-"');

/**
 * A single fact about the case. Unknown extra properties (e.g. `source`) are
 * accepted and ignored, so a richer host model can be passed straight in.
 */
export const FactSchema = z.object({
  key: FactKeySchema,
  label: z.string().max(256),
  value: z.string().max(4096),
  tier: TierSchema,
  approved: z.boolean().default(false),
});
export type Fact = z.infer<typeof FactSchema>;
export type FactInput = z.input<typeof FactSchema>;

export const FactsSchema = z.array(FactSchema).max(1000);

export const ExpandOptionsSchema = z.object({
  /** Phrase substituted for any fact that may not be spoken. */
  handoffPhrase: z.string().min(1).max(500).optional(),
});
export type ExpandOptions = z.infer<typeof ExpandOptionsSchema>;

export const ExpandResultSchema = z.object({
  text: z.string(),
  /** Keys that were referenced but not substituted (never / unknown / unapproved). */
  withheld: z.array(z.string()),
});
export type ExpandResult = z.infer<typeof ExpandResultSchema>;

export const DlpReasonCodeSchema = z.enum([
  'never_fact',
  'unapproved_fact',
  'card_number',
  'aadhaar',
  'otp_like',
  'cvv_like',
  'password',
  'invalid_input',
]);
export type DlpReasonCode = z.infer<typeof DlpReasonCodeSchema>;

/**
 * Why an utterance was blocked. Deliberately carries no matched value, so it
 * is safe to log.
 */
export const DlpReasonSchema = z.object({
  code: DlpReasonCodeSchema,
  /** Present for `never_fact` / `unapproved_fact`. */
  factKey: z.string().optional(),
  message: z.string(),
});
export type DlpReason = z.infer<typeof DlpReasonSchema>;

export const ScanOptionsSchema = z.object({
  /**
   * Also block literal values of `confirm` facts that are not approved.
   * Default `true`.
   */
  blockUnapprovedConfirm: z.boolean().optional(),
});
export type ScanOptions = z.infer<typeof ScanOptionsSchema>;

export const ScanResultSchema = z.object({
  allowed: z.boolean(),
  reasons: z.array(DlpReasonSchema),
  /** The input with every hit replaced by the mask token. Safe to log. */
  redacted: z.string(),
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

export const GuardOptionsSchema = ExpandOptionsSchema.extend(ScanOptionsSchema.shape).extend({
  /** Utterance spoken instead of a blocked one. */
  fallbackUtterance: z.string().min(1).max(500).optional(),
});
export type GuardOptions = z.infer<typeof GuardOptionsSchema>;

export const BlockedRecordSchema = z.object({
  type: z.literal('blocked_utterance'),
  reasons: z.array(DlpReasonSchema),
  /** Masked version of what would have been spoken. Safe to log. */
  redacted: z.string(),
  withheld: z.array(z.string()),
});
export type BlockedRecord = z.infer<typeof BlockedRecordSchema>;

export const GuardResultSchema = z.discriminatedUnion('allowed', [
  z.object({
    allowed: z.literal(true),
    text: z.string(),
    withheld: z.array(z.string()),
  }),
  z.object({
    allowed: z.literal(false),
    /** Safe fallback utterance to speak instead. */
    text: z.string(),
    withheld: z.array(z.string()),
    blocked: BlockedRecordSchema,
  }),
]);
export type GuardResult = z.infer<typeof GuardResultSchema>;

export const DisclosureCategorySchema = z.enum([
  'otp',
  'pin',
  'password',
  'cvv',
  'card',
  'aadhaar',
  'remote_access',
  'payment',
  'upi',
]);
export type DisclosureCategory = z.infer<typeof DisclosureCategorySchema>;

export const InboundClassificationSchema = z.object({
  disclosureRequest: z
    .object({
      tier: z.enum(['never', 'confirm']),
      what: DisclosureCategorySchema,
    })
    .nullable(),
  injection: z.boolean(),
  injectionPhrases: z.array(z.string()),
});
export type InboundClassification = z.infer<typeof InboundClassificationSchema>;

/** Input to `assignTier`: the caller never supplies the tier itself. */
export const AssignTierInputSchema = z.object({
  key: FactKeySchema,
  label: z.string().max(256).optional(),
  value: z.string().max(4096).optional(),
});
export type AssignTierInput = z.input<typeof AssignTierInputSchema>;

export const TextSchema = z.string().max(100_000);

export const DEFAULT_HANDOFF_PHRASE =
  "I'm not able to share that detail on this call; the account holder will follow up on it directly";

export const DEFAULT_FALLBACK_UTTERANCE =
  "Sorry, I'm not able to share that on this call. The account holder will follow up with you directly.";

export const MASK = '•••';
