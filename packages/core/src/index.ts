import { z } from 'zod';

export const PACKAGE_NAME = '@standin/core' as const;

/**
 * Disclosure tier of a case fact (spec section 4).
 * share   - may be spoken freely
 * confirm - speak only after user approved for this case
 * never   - never spoken by the agent; triggers hand-off
 */
export const TierSchema = z.enum(['share', 'confirm', 'never']);
export type Tier = z.infer<typeof TierSchema>;
