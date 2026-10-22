import {
  DEFAULT_HANDOFF_PHRASE,
  ExpandOptionsSchema,
  FactsSchema,
  TextSchema,
  type ExpandOptions,
  type ExpandResult,
  type Fact,
  type FactInput,
} from './types.js';

/** Any `{{...}}` slot. */
const SLOT = /\{\{([^{}]*)\}\}/g;
/** Inner part of a well-formed `{{fact:key}}` slot, tolerating whitespace. */
const FACT_SLOT = /^\s*fact\s*:\s*([A-Za-z0-9_.-]+)\s*$/;
/** Reported in `withheld` for a malformed placeholder. */
export const MALFORMED_KEY = '(malformed)';

/** Whether a fact may be spoken aloud right now. */
export function isSpeakable(fact: Fact): boolean {
  if (fact.tier === 'share') return true;
  if (fact.tier === 'confirm') return fact.approved;
  return false;
}

/**
 * Substitutes `{{fact:key}}` placeholders. `share` facts are always
 * substituted, `confirm` facts only when approved; `never`, unapproved and
 * unknown keys are replaced by the hand-off phrase and reported in `withheld`.
 *
 * Substitution is single-pass: a fact value that itself looks like a
 * placeholder is not expanded again.
 */
export function expand(
  template: string,
  facts: readonly FactInput[],
  options: ExpandOptions = {},
): ExpandResult {
  const tpl = TextSchema.parse(template);
  const parsed = FactsSchema.parse(facts);
  const opts = ExpandOptionsSchema.parse(options);
  const handoff = opts.handoffPhrase ?? DEFAULT_HANDOFF_PHRASE;

  const byKey = new Map<string, Fact>();
  for (const f of parsed) {
    // On duplicate keys the most restrictive entry wins.
    const prev = byKey.get(f.key);
    if (!prev || isSpeakable(prev)) byKey.set(f.key, f);
  }

  const withheld: string[] = [];
  const withhold = (key: string): string => {
    if (!withheld.includes(key)) withheld.push(key);
    return handoff;
  };
  // Single pass over every `{{...}}` slot; anything that is not a well-formed
  // fact placeholder is treated as malformed and never spoken raw.
  const text = tpl.replace(SLOT, (_m, inner: string) => {
    const m = FACT_SLOT.exec(inner);
    const key = m?.[1];
    if (key === undefined) return withhold(MALFORMED_KEY);
    const fact = byKey.get(key);
    if (fact && isSpeakable(fact)) return fact.value;
    return withhold(key);
  });

  return { text, withheld };
}
