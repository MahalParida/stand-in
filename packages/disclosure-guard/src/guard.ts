import { detect, scanOutbound } from './dlp.js';
import { expand } from './expand.js';
import { applySpans } from './text.js';
import {
  DEFAULT_FALLBACK_UTTERANCE,
  FactsSchema,
  GuardOptionsSchema,
  MASK,
  TextSchema,
  type DlpReason,
  type FactInput,
  type GuardOptions,
  type GuardResult,
} from './types.js';

/**
 * The single choke point for anything the agent is about to say:
 * `expand` the planner's template, then run output DLP on the result.
 *
 * Never throws. On a DLP hit — or on invalid input — it returns the safe
 * fallback utterance plus a `blocked_utterance` record whose `redacted`
 * text and reasons are safe to log.
 */
export function guardUtterance(
  template: string,
  facts: readonly FactInput[],
  options: GuardOptions = {},
): GuardResult {
  const parsedOpts = GuardOptionsSchema.safeParse(options);
  const opts = parsedOpts.success ? parsedOpts.data : {};
  const fallback = opts.fallbackUtterance ?? DEFAULT_FALLBACK_UTTERANCE;

  const tpl = TextSchema.safeParse(template);
  const fs = FactsSchema.safeParse(facts);
  if (!parsedOpts.success || !tpl.success || !fs.success) {
    // Invalid input: we cannot prove the text is safe, so none of it is echoed.
    const reason: DlpReason = { code: 'invalid_input', message: 'guard input failed validation' };
    return {
      allowed: false,
      text: fallback,
      withheld: [],
      blocked: { type: 'blocked_utterance', reasons: [reason], redacted: MASK, withheld: [] },
    };
  }

  const expanded = expand(tpl.data, fs.data, opts.handoffPhrase === undefined ? {} : { handoffPhrase: opts.handoffPhrase });
  const scan = scanOutbound(
    expanded.text,
    fs.data,
    opts.blockUnapprovedConfirm === undefined ? {} : { blockUnapprovedConfirm: opts.blockUnapprovedConfirm },
  );
  if (scan.allowed) return { allowed: true, text: expanded.text, withheld: expanded.withheld };

  // Defence in depth: re-mask with the default detector set before handing
  // the record to loggers.
  const redacted = applySpans(
    scan.redacted,
    detect(scan.redacted, fs.data, false).map((h) => h.span),
    MASK,
  );
  return {
    allowed: false,
    text: fallback,
    withheld: expanded.withheld,
    blocked: { type: 'blocked_utterance', reasons: scan.reasons, redacted, withheld: expanded.withheld },
  };
}
