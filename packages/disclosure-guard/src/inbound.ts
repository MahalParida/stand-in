import { TextSchema, type DisclosureCategory, type InboundClassification } from './types.js';

interface CategoryRule {
  what: DisclosureCategory;
  tier: 'never' | 'confirm';
  pattern: RegExp;
  /** Mentioning it at all is a request (e.g. "open AnyDesk"). */
  implicit?: boolean;
}

/** Non-secret phrases that contain trigger words; blanked before matching. */
const EXEMPT_PHRASES =
  /\b(?:pin\s*code|pincode|postal\s+code|zip\s*code|area\s+code|std\s+code|country\s+code|promo\s*code|coupon\s+code|discount\s+code|voucher\s+code|referral\s+code|ifsc(?:\s+code)?|error\s+code|status\s+code|product\s+code|plan\s+code|tracking\s+code|dress\s+code|source\s+code|ticket\s+(?:number|id|code)|order\s+(?:number|id|code)|reference\s+(?:number|id|code))\b/gi;

/** Ordered by priority: the first matching rule names the request. */
const RULES: readonly CategoryRule[] = [
  {
    what: 'otp',
    tier: 'never',
    pattern:
      /\b(?:otp|o\.t\.p\.?|one[\s-]?time[\s-]?(?:password|passcode|pin|code)|verification\s+code|auth(?:entication)?\s+code|(?:the|that|this|your|a|six|6|four|4)[\s-]+(?:digit\s+)?code|code\s+(?:you|we|i)\s+(?:received|got|sent|get)|(?:six|6|four|4|eight|8)[\s-]+digits?\s+(?:number|code|pin)|(?:sms|text\s+message|message)\s+(?:code|number|digits?)|(?:number|digits?|code)\b(?:\s+\w+){0,5}?\s+(?:received|sent|got|came|in|on|from|via|by)\b(?:\s+\w+){0,3}?\s+(?:sms|text\s+message|message))\b/i,
  },
  {
    what: 'pin',
    tier: 'never',
    pattern: /\b(?:upi\s+pin|atm\s+pin|card\s+pin|m-?pin|t-?pin|pin(?:\s+number)?)\b/i,
  },
  {
    what: 'password',
    tier: 'never',
    pattern: /\b(?:password|passcode|pass\s+word|passwd|login\s+credentials|net\s*banking\s+(?:login|credentials))\b/i,
  },
  {
    what: 'cvv',
    tier: 'never',
    pattern:
      /\b(?:cvv2?|cvc2?|card\s+verification|security\s+code|(?:three|3)[\s-]+digits?\s+(?:number|code)?\s*(?:on|at)\s+the\s+back)\b/i,
  },
  {
    what: 'card',
    tier: 'never',
    pattern:
      /\b(?:(?:full\s+)?card\s+(?:number|details|no\.?)|(?:debit|credit|atm)\s+card|(?:16|sixteen)[\s-]+digit(?:s)?(?:\s+(?:card\s+)?number)?|expiry\s+date)\b/i,
  },
  {
    what: 'aadhaar',
    tier: 'never',
    pattern: /\b(?:aadhaa?r|adhaa?r|aadhar|uidai|uid\s+number)\b/i,
  },
  {
    what: 'remote_access',
    tier: 'never',
    implicit: true,
    pattern:
      /\b(?:any\s?desk|team\s?viewer|quick\s?support|rust\s?desk|ultra\s?viewer|air\s?droid|ammyy|supremo|chrome\s+remote\s+desktop|remote\s+(?:access|desktop|support\s+app|control)|screen[\s-]?shar(?:e|ing))\b/i,
  },
  {
    what: 'upi',
    tier: 'confirm',
    pattern: /\b(?:upi|vpa|collect\s+request|google\s+pay|gpay|phone\s?pe|paytm|bhim)\b/i,
  },
  {
    what: 'payment',
    tier: 'confirm',
    pattern:
      /\b(?:pay(?:\s+(?:now|online|the|a|an|us|rs\.?|inr|rupees|₹|\d))?|make\s+(?:a|the)\s+payment|payment\s+of|(?:processing|activation|registration|verification|reactivation|security)\s+(?:fee|charge|deposit)|refundable\s+deposit|transfer\s+(?:the\s+)?(?:money|amount|funds|rs\.?|inr|rupees|₹|\d)|send\s+(?:the\s+)?money|bank\s+transfer)\b/i,
  },
];

/** Something is actually being asked for, or an action demanded. */
const REQUEST_CUE =
  /\b(?:share|tell|give|read|send|provide|say|state|what'?s|what\s+is|whats|confirm|need|enter|type|install|download|open|forward|spell|dictate|verify|repeat|recite|quote|let\s+me\s+(?:know|have)|may\s+i\s+(?:have|know|get)|can\s+i\s+(?:have|get)|could\s+you|can\s+you|would\s+you|will\s+you|please|pay|make|approve|accept|transfer|connect|allow|grant|scan|click|tap|go\s+ahead|required|must|have\s+to|has\s+to)\b/i;

/**
 * Warnings like "never share your OTP" are not requests. The negation must
 * govern the share/ask verb itself (only a few neutral words in between), so
 * "don't worry, just tell me the OTP" or "don't hesitate to share the OTP"
 * are not mistaken for warnings. The whole warning clause, up to a clause
 * boundary, is removed and the rest of the sentence is still classified
 * ("I won't tell anyone, so share the OTP").
 */
const WARNING_CLAUSE = new RegExp(
  String.raw`\b(?:never|don'?t|do\s+not|dont|won'?t|will\s+not|shouldn'?t|should\s+not|must\s+not|mustn'?t|not\s+to|(?:no\s+one|nobody)(?:\s+\w+){0,3}?\s+(?:will|should|can|would))` +
    String.raw`\s+(?:(?:ever|you|to|anyone|need|needs|have|has|ask|asks|for|be|asked|going|gonna|will|should|must|please|ever|i|we|it|with|from|really|by|us|them)\s+){0,3}?` +
    String.raw`(?:share|tell|give|disclose|reveal|ask|install|send|pay)\b` +
    String.raw`.*?(?=[,;:]|\b(?:but|so|just|instead|however|though|now|rather|except|only|then)\b|$)`,
  'gi',
);

interface InjectionRule {
  pattern: RegExp;
}

const INJECTION_RULES: readonly InjectionRule[] = [
  {
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass|drop|skip)\b(?:\s+(?:all|any|of|your|the|my|these|those|previous|prior|earlier|above|original|current|existing|safety|system)){0,4}\s+(?:instructions?|rules?|prompts?|guidelines?|directions?|programming|polic(?:y|ies)|guardrails?|restrictions?|constraints?|training|orders)\b/i,
  },
  { pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier|everything)\b/i },
  { pattern: /\byou\s+are\s+now\b/i },
  { pattern: /\bfrom\s+now\s+on,?\s+you\b/i },
  { pattern: /\bas\s+your\s+(?:supervisor|manager|boss|developer|admin(?:istrator)?|creator|owner|operator|master)\b/i },
  { pattern: /\bi\s*(?:am|'m)\s+your\s+(?:supervisor|manager|boss|developer|admin(?:istrator)?|creator|owner|operator|master)\b/i },
  { pattern: /\bsystem\s+(?:prompt|message|instructions?)\b/i },
  { pattern: /\b(?:read|tell|give|say)\s+me\s+(?:the|that|your)\s+(?:\w+\s+)?(?:code|otp|pin|password|cvv)\b/i },
  { pattern: /\bnew\s+instructions?\b/i },
  { pattern: /\b(?:developer|debug|admin|god|jailbreak|dan)\s+mode\b/i },
  { pattern: /\bpretend\s+(?:to\s+be|you\s+are|you're)\b/i },
  { pattern: /\b(?:act|behave)\s+as\s+(?:if|though|an?|my|the)\b/i },
  { pattern: /\byou\s+(?:are\s+)?(?:now\s+)?(?:authori[sz]ed|allowed|permitted)\s+to\s+(?:share|tell|give|read|disclose|reveal)\b/i },
  { pattern: /\b(?:reveal|print|repeat|show)\s+(?:me\s+)?(?:your|the)\s+(?:instructions|prompt|rules|configuration)\b/i },
];

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Classifies a callee utterance (untrusted input). Detects requests for
 * secrets / remote access / payment, and prompt-injection attempts. The
 * caller decides what to do; the recommended policy is: `never` requests
 * hand off, `confirm` requests wait for owner approval, injections are
 * logged and otherwise ignored.
 */
export function classifyInbound(text: string): InboundClassification {
  const raw = TextSchema.parse(text);
  // Curly apostrophes from ASR -> straight.
  const t = raw.replace(/[’‘]/g, "'");

  let bestRank = RULES.length;
  for (const sentence of sentences(t)) {
    const s = sentence
      .replace(EXEMPT_PHRASES, (m) => ' '.repeat(m.length))
      .replace(WARNING_CLAUSE, (m) => ' '.repeat(m.length));
    const cue = REQUEST_CUE.test(s) || /\?\s*$/.test(s);
    for (let rank = 0; rank < bestRank; rank++) {
      const rule = RULES[rank];
      if (!rule || !rule.pattern.test(s)) continue;
      if (!cue && !rule.implicit) continue;
      bestRank = rank;
      break;
    }
  }
  const found = RULES[bestRank];

  const injectionPhrases: string[] = [];
  for (const { pattern } of INJECTION_RULES) {
    const m = pattern.exec(t);
    if (m) {
      const phrase = m[0].toLowerCase().replace(/\s+/g, ' ').trim();
      if (!injectionPhrases.includes(phrase)) injectionPhrases.push(phrase);
    }
  }

  return {
    disclosureRequest: found ? { tier: found.tier, what: found.what } : null,
    injection: injectionPhrases.length > 0,
    injectionPhrases,
  };
}
