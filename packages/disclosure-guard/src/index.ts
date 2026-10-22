/**
 * @standin/disclosure-guard — code-level disclosure guard for voice agents.
 * MIT licensed. No runtime dependency other than zod.
 */
export const PACKAGE_NAME = '@standin/disclosure-guard' as const;

export { expand, isSpeakable, MALFORMED_KEY } from './expand.js';
export { scanOutbound, mask } from './dlp.js';
export { guardUtterance } from './guard.js';
export { classifyInbound } from './inbound.js';
export { luhnValid } from './luhn.js';
export { assignTier } from './tier.js';
export {
  TierSchema,
  FactKeySchema,
  FactSchema,
  FactsSchema,
  ExpandOptionsSchema,
  ExpandResultSchema,
  DlpReasonCodeSchema,
  DlpReasonSchema,
  ScanOptionsSchema,
  ScanResultSchema,
  GuardOptionsSchema,
  BlockedRecordSchema,
  GuardResultSchema,
  DisclosureCategorySchema,
  InboundClassificationSchema,
  AssignTierInputSchema,
  DEFAULT_HANDOFF_PHRASE,
  DEFAULT_FALLBACK_UTTERANCE,
  MASK,
} from './types.js';
export type {
  Tier,
  Fact,
  FactInput,
  ExpandOptions,
  ExpandResult,
  DlpReasonCode,
  DlpReason,
  ScanOptions,
  ScanResult,
  GuardOptions,
  BlockedRecord,
  GuardResult,
  DisclosureCategory,
  InboundClassification,
  AssignTierInput,
} from './types.js';
