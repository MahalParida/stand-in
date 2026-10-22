import { luhnValid } from './luhn.js';
import {
  alnumNormalize,
  alnumStream,
  applySpans,
  digitRuns,
  digitsOf,
  fold,
  foldText,
  isNumericValue,
  looseRunVariants,
  runSpan,
  tokenize,
  unfoldSpan,
  type DigitRun,
  type Token,
} from './text.js';
import {
  FactsSchema,
  MASK,
  ScanOptionsSchema,
  TextSchema,
  type DlpReason,
  type DlpReasonCode,
  type Fact,
  type FactInput,
  type ScanOptions,
  type ScanResult,
} from './types.js';

export interface DlpHit {
  code: DlpReasonCode;
  factKey?: string;
  span: [number, number];
}

/** Numeric secrets shorter than this must match whole digit groups, not substrings. */
const SUBSTRING_MIN_DIGITS = 6;
/** Non-numeric secrets shorter than this are only matched verbatim. */
const FUZZY_MIN_CHARS = 4;
/** How far (in characters) a keyword may sit before / after a number. */
const WINDOW_BEFORE = 40;
const WINDOW_AFTER = 25;

/**
 * Phrases that contain a trigger word but are not secrets (postal PIN codes,
 * error codes, ...). They are blanked out before keyword search.
 */
const EXEMPT_PHRASES =
  /\b(?:pin\s*code|pincode|postal\s+code|zip\s*code|area\s+code|std\s+code|country\s+code|promo\s*code|coupon\s+code|discount\s+code|voucher\s+code|referral\s+code|ifsc(?:\s+code)?|error\s+code|status\s+code|product\s+code|plan\s+code|tracking\s+code|qr\s+code|dress\s+code|source\s+code|code\s+of\s+conduct|(?:reference|ref|complaint|ticket|order|customer|consumer|booking|case|request|invoice|docket|service|account|tracking|shipment)\s+(?:code|number|num|id))\b/gi;

/** Keywords that always mark a nearby number as a secret. */
const OTP_KEYWORDS =
  /\b(?:otp|one[\s-]?time[\s-]?(?:password|passcode|pin|code)|pin|m-?pin|passcode|pass\s?code|verification\s+(?:code|pin|number)|auth(?:entication)?\s+code|security\s+pin|login\s+code)\b/gi;

/**
 * The bare word "code" is weak: it only counts when the sentence does not
 * also talk about a ticket/order/complaint/reference identifier.
 */
const WEAK_OTP_KEYWORDS = /\bcode\b/gi;

/** Nouns that introduce a non-secret identifier ("ticket 48211", "order no 553"). */
const ID_NOUN =
  /^(?:ticket|order|complaint|reference|ref|booking|case|request|invoice|docket|customer|consumer|account|acct|sr|srn|awb|tracking|shipment|registration|application|token|room|flat|house|plot|model|serial)$/i;
const ID_NOUN_IN_TEXT =
  /\b(?:ticket|order|complaint|reference|ref|booking|case|request|invoice|docket|sr|srn|s\.\s?r|awb|tracking|shipment|registration|application)\b/i;
/** Dotted "S.R." / "S. R. No." right before a number (service-request ticket). */
const SR_BEFORE = /\bs\.\s?r\.?\s*(?:no\.?|number|num|id)?\s*[:#-]?\s*$/i;
/**
 * Identifier nouns that may *follow* a number ("553219, the order number",
 * "for 553219 order"). Narrower than ID_NOUN: no account/token words.
 */
const ID_NOUN_AFTER =
  /^(?:ticket|order|complaint|reference|ref|booking|case|request|invoice|docket|sr|srn|awb|tracking|shipment)$/i;
/** How many words may sit between a number and a following identifier noun. */
const ID_AFTER_MAX_WORDS = 3;

/** Currency marker right before a number ("₹2,499", "Rs. 2499", "INR 2499", "$25"). */
const CURRENCY_BEFORE = /(?:[₹$€£]|\b(?:rs|inr|usd|eur|gbp)\.?)\s*$/i;
/** Currency word right after a number ("2499 rupees", "2499 rs"). */
const CURRENCY_AFTER = /^\s*(?:rupees?|rs\b|inr\b|dollars?|bucks|paise|usd\b|\/-)/i;
/** Words that introduce a money amount ("charged 2499", "refund of 2499"). */
const AMOUNT_WORD =
  /^(?:charged|paid|pay|debited|credited|deducted|refund|refunded|billed|bill|cost|costs|priced|price|amount|total|balance|worth|fee|fees)$/i;
/** Words allowed between an amount word and the number ("refund of", "charged me"). */
const AMOUNT_LINK = /^(?:of|me|us|only|just|around|about|approx|approximately)$/i;
/**
 * Words allowed between an ID noun and its number ("ticket number 48211",
 * "order id #553", "ticket is 482110", "account number will be 553").
 */
const ID_LINK = /^(?:number|no|num|id|nr|is|was|will|be)$/i;
/** Maximum ID_LINK words between the noun and the number. */
const ID_LINK_MAX = 3;

const CVV_KEYWORDS =
  /\b(?:cvv2?|cvc2?|cid|security\s+code|card\s+verification(?:\s+(?:value|code|number))?)\b/gi;

/** Keywords that, when glued to a number ("PIN-4219"), do not make it an identifier. */
const SECRET_PREFIX = /^(?:otp|code|pin|mpin|passcode|cvv|cvv2|cvc|cvc2|cid|pwd|password)$/i;

const PASSWORD_RE =
  /\b(?:password|passcode|pass\s+word|passwd|pwd|login\s+pin)\s*(?:(?:is|was|will\s+be|should\s+be)\b|[:=])\s*[:=]?\s*["'“‘]?([^\s"'”’]+)/gi;

/** Words after "password is" that indicate no secret follows. */
const PASSWORD_STOPWORDS = new Set([
  'not',
  'something',
  'private',
  'confidential',
  'secret',
  'personal',
  'the',
  'a',
  'an',
  'your',
  'their',
  'his',
  'her',
  'my',
  'known',
  'only',
  'never',
  'unknown',
  'set',
  'reset',
  'changed',
  'expired',
  'incorrect',
  'wrong',
  'correct',
  'required',
  'needed',
  'sent',
  'case',
  'with',
  'held',
  'kept',
  'stored',
  'protected',
  'still',
  'being',
  'going',
  'too',
  'also',
  'same',
  'different',
  'that',
  'this',
  'it',
  'one',
]);

interface KeywordSpan {
  start: number;
  end: number;
}

/**
 * Indian postal addresses: "Bengaluru, PIN 560001", "Postal PIN: 560001",
 * "Bengaluru - PIN 560 001". "PIN" right after a place name and a comma or
 * dash (or after "postal"), followed by a 6-digit postcode, is not a secret.
 */
const POSTAL_PIN =
  /(?:\bpostal\s+pin\b|(?<=\b([A-Za-z]{3,})\s*[,–-]\s*)pin(?=\s*[:-]?\s*[1-9]\d{2}\s?\d{3}\b(?!\s*[-.]?\s*\d)))/gi;
/** Words that, before "PIN", mean it is a secret PIN rather than a postcode. */
const SECRET_PIN_CONTEXT =
  /^(?:otp|upi|atm|card|debit|credit|bank|banking|login|mpin|tpin|secret|security|the|your|my|his|her|their|our|a|new|old|is|was|and|or|code|password|passcode|cvv)$/i;

function blankExempt(text: string): string {
  return text
    .replace(EXEMPT_PHRASES, (m) => ' '.repeat(m.length))
    .replace(POSTAL_PIN, (m, word: string | undefined) =>
      word !== undefined && SECRET_PIN_CONTEXT.test(word) ? m : ' '.repeat(m.length),
    );
}

function keywordSpans(text: string, re: RegExp): KeywordSpan[] {
  const out: KeywordSpan[] = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/** Sentence boundary: the keyword context does not carry across it. */
const SENTENCE_BREAK = /[.?!;]\s|\n/;
const SENTENCE_BREAK_G = /[.?!;]\s|\n/g;

/** Drops weak keywords whose sentence mentions a ticket/order/... identifier noun. */
function strongEnough(text: string, kws: KeywordSpan[]): KeywordSpan[] {
  return kws.filter((k) => {
    let from = 0;
    let to = text.length;
    const r = new RegExp(SENTENCE_BREAK_G.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = r.exec(text)) !== null) {
      const brk = m.index + m[0].length;
      if (brk <= k.start) from = brk;
      else if (m.index >= k.end) {
        to = m.index;
        break;
      }
    }
    return !ID_NOUN_IN_TEXT.test(text.slice(from, to));
  });
}

function near(text: string, kws: KeywordSpan[], start: number, end: number): boolean {
  return kws.some((k) => {
    if (k.start < end && k.end > start) return true;
    if (k.end <= start && start - k.end <= WINDOW_BEFORE) return !SENTENCE_BREAK.test(text.slice(k.end, start));
    if (k.start >= end && k.start - end <= WINDOW_AFTER) return !SENTENCE_BREAK.test(text.slice(end, k.start));
    return false;
  });
}

/**
 * A run glued to letters ("OD12345", "SR-48211", "12345AB") is an identifier
 * such as an order or ticket number, not a code.
 */
function isIdentifier(run: DigitRun, tokens: Token[], text: string): boolean {
  const first = run.parts[0];
  const last = run.parts[run.parts.length - 1];
  if (!first || !last) return false;
  if (followsIdNoun(tokens, first.token)) return true;
  if (!afterSecretKeyword(tokens, first.token) && precedesIdNoun(tokens, last.tokenEnd ?? last.token)) return true;
  if (SR_BEFORE.test(text.slice(Math.max(0, run.start - 20), run.start))) return true;
  if (first.spelled) return false;
  const fi = first.token;
  const prev = tokens[fi - 1];
  if (prev?.kind === 'word' && !SECRET_PREFIX.test(prev.text)) return true;
  if (prev?.kind === 'sep' && /^[-/#]$/.test(prev.text)) {
    const pp = tokens[fi - 2];
    if (pp?.kind === 'word' && !SECRET_PREFIX.test(pp.text)) return true;
  }
  const next = tokens[(last.tokenEnd ?? last.token) + 1];
  if (!last.spelled && next?.kind === 'word') return true;
  return false;
}

/**
 * True when the number at token `fi` is introduced by an identifier noun:
 * "ticket 48211", "order number 553", "complaint no. 48211", "ticket #48211".
 */
function followsIdNoun(tokens: Token[], fi: number): boolean {
  let words = 0;
  for (let j = fi - 1; j >= 0; j--) {
    const t = tokens[j];
    if (!t) return false;
    if (t.kind === 'sep') {
      if (/[\n!?]/.test(t.text) || /\.\s/.test(t.text)) return false;
      continue;
    }
    if (t.kind !== 'word') return false;
    if (ID_NOUN.test(t.text)) return true;
    if (!ID_LINK.test(t.text) || ++words > ID_LINK_MAX) return false;
  }
  return false;
}

/**
 * True when an identifier noun follows the number at token `li` within a few
 * words in the same sentence ("553219, the order number", "553219 order"),
 * and is not itself followed by a secret keyword ("order OTP").
 */
function precedesIdNoun(tokens: Token[], li: number): boolean {
  let words = 0;
  for (let j = li + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (!t) return false;
    if (t.kind === 'sep') {
      if (/[\n!?;]/.test(t.text) || /\.(?:\s|$)/.test(t.text)) return false;
      continue;
    }
    if (t.kind !== 'word') return false;
    if (SECRET_PREFIX.test(t.text) || /^(?:otp|pin)$/i.test(t.text)) return false;
    if (ID_NOUN_AFTER.test(t.text)) {
      const nxt = tokens.slice(j + 1).find((x) => x.kind !== 'sep');
      return !(nxt?.kind === 'word' && SECRET_PREFIX.test(nxt.text));
    }
    if (++words >= ID_AFTER_MAX_WORDS) return false;
  }
  return false;
}

/** True when a secret keyword introduces the number at token `fi` ("PIN 7712", "OTP is 7712"). */
function afterSecretKeyword(tokens: Token[], fi: number): boolean {
  let words = 0;
  for (let j = fi - 1; j >= 0; j--) {
    const t = tokens[j];
    if (!t) return false;
    if (t.kind === 'sep') {
      if (/[\n!?;]/.test(t.text) || /\.\s/.test(t.text)) return false;
      continue;
    }
    if (t.kind !== 'word') return false;
    if (SECRET_PREFIX.test(t.text)) return true;
    if (!/^(?:is|was|will|be|number|no)$/i.test(t.text) || ++words > 2) return false;
  }
  return false;
}

/**
 * True when the run is a money amount: a currency sign or word next to it
 * ("₹2,499", "2499 rupees") or an amount word before it ("charged 2499",
 * "refund of 2499").
 */
function isAmount(run: DigitRun, tokens: Token[], text: string): boolean {
  if (CURRENCY_BEFORE.test(text.slice(Math.max(0, run.start - 5), run.start))) return true;
  if (CURRENCY_AFTER.test(text.slice(run.end, run.end + 10))) return true;
  const first = run.parts[0];
  if (!first) return false;
  let links = 0;
  for (let j = first.token - 1; j >= 0; j--) {
    const t = tokens[j];
    if (!t) return false;
    if (t.kind === 'sep') {
      if (/[\n!?;]/.test(t.text) || /\.\s/.test(t.text)) return false;
      continue;
    }
    if (t.kind !== 'word') return false;
    if (AMOUNT_WORD.test(t.text)) return true;
    if (!AMOUNT_LINK.test(t.text) || ++links > 2) return false;
  }
  return false;
}

/** Token-aligned slices of a run whose digits equal `target`. */
function alignedMatches(run: DigitRun, target: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  // Digit offsets where each part starts.
  const starts: number[] = [];
  let off = 0;
  for (const p of run.parts) {
    starts.push(off);
    off += p.digits.length;
  }
  for (let i = 0; i < run.parts.length; i++) {
    let acc = '';
    for (let j = i; j < run.parts.length; j++) {
      acc += run.parts[j]?.digits ?? '';
      if (acc.length > target.length) break;
      if (acc === target) {
        const s = starts[i] ?? 0;
        out.push([s, s + acc.length]);
        break;
      }
    }
  }
  return out;
}

function substringMatches(hay: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (needle.length === 0) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push([i, i + needle.length]);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

function caseInsensitiveMatches(text: string, value: string): Array<[number, number]> {
  return substringMatches(text.toLowerCase(), value.toLowerCase());
}

/** How TTS engines and people read symbols aloud. */
const SPOKEN_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  '@': ['at', 'at the rate', 'at the rate of', 'at sign', 'at the rate sign'],
  '#': ['hash', 'pound', 'hashtag'],
  $: ['dollar'],
  '&': ['and'],
  '.': ['dot', 'point'],
  _: ['underscore'],
  '-': ['dash', 'hyphen', 'minus'],
  '!': ['exclamation', 'bang'],
  '*': ['star', 'asterisk'],
  '+': ['plus'],
  '/': ['slash'],
  '%': ['percent'],
  '=': ['equals'],
  '~': ['tilde'],
};
const MAX_SPOKEN_VARIANTS = 64;

/** "Tiger@123" -> ["Tiger at 123"]; symbols with several names expand to each (capped). */
function spokenSymbolVariants(value: string): string[] {
  let variants = [''];
  let anySymbol = false;
  for (const ch of value) {
    const names = SPOKEN_SYMBOLS[ch];
    if (!names) {
      variants = variants.map((x) => x + ch);
      continue;
    }
    anySymbol = true;
    const next: string[] = [];
    for (const x of variants) for (const n of names) if (next.length < MAX_SPOKEN_VARIANTS) next.push(`${x} ${n} `);
    variants = next;
  }
  return anySymbol ? variants : [];
}

/** Spans where a secret value appears, exact or normalised. */
function valueSpans(
  text: string,
  tokens: Token[],
  runs: DigitRun[],
  value: string,
  loose = false,
): Array<[number, number]> {
  const v = value.trim();
  if (v.length === 0) return [];
  const spans: Array<[number, number]> = [];

  if (isNumericValue(v)) {
    // Numeric secrets are matched on digit runs only, so a short PIN does not
    // trip on a longer unrelated number that merely contains it.
    const d = digitsOf(v);
    if (d.length > 0) {
      for (const run of runs) {
        const ms = d.length >= SUBSTRING_MIN_DIGITS ? substringMatches(run.digits, d) : alignedMatches(run, d);
        for (const [a, b] of ms) spans.push(runSpan(run, tokens, a, b));
      }
    }
    return spans;
  }

  spans.push(...caseInsensitiveMatches(text, v));
  const needles = new Set([alnumNormalize(v), ...spokenSymbolVariants(v).map(alnumNormalize)]);
  // Plain stream (spelled single digits) and run-aware stream (number words
  // such as "ninety nine" read as "99"), since TTS may read digits either way.
  const streams = [alnumStream(tokens), alnumStream(tokens, runs)];
  // Never-tier secrets: also tolerate filler / short words a speaker inserts
  // between letter and digit groups ("Tiger, umm, 123", "Tiger and 123").
  if (loose) streams.push(alnumStream(tokens, [], { dropGapWords: true }), alnumStream(tokens, runs, { dropGapWords: true }));
  for (const stream of streams) {
    for (const norm of needles) {
      if (norm.length < FUZZY_MIN_CHARS) continue;
      for (const [a, b] of substringMatches(stream.text, norm)) {
        const ta = tokens[stream.charToken[a] ?? 0];
        const tb = tokens[stream.charToken[b - 1] ?? 0];
        if (ta && tb) spans.push([ta.start, tb.end]);
      }
    }
  }
  return spans;
}

const AADHAAR_WORD = /\b(?:aadhaa?r|adhaa?r|uidai|uid)\b/i;

/** True when the sentence containing `run` mentions Aadhaar. */
function mentionsAadhaar(text: string, run: DigitRun): boolean {
  let from = 0;
  let to = text.length;
  const r = new RegExp(SENTENCE_BREAK_G.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    const brk = m.index + m[0].length;
    if (brk <= run.start) from = brk;
    else if (m.index >= run.end) {
      to = m.index;
      break;
    }
  }
  return AADHAAR_WORD.test(text.slice(from, to));
}

function aadhaarShaped(run: DigitRun, text: string): boolean {
  if (run.digits.length !== 12 || !/^[2-9]/.test(run.digits)) return false;
  // "+91 98765 43210" is a phone number with country code.
  if (/\+\s*$/.test(text.slice(Math.max(0, run.start - 3), run.start))) return false;
  if (run.parts.some((p) => p.spelled)) return true;
  const groups = run.parts.map((p) => p.digits.length).join(',');
  return groups === '12' || groups === '4,4,4';
}

/** Pattern-based detectors that need no knowledge of the facts. */
export function patternHits(text: string, tokens: Token[], runs: DigitRun[]): DlpHit[] {
  const hits: DlpHit[] = [];
  const kwText = blankExempt(text);
  const otpKw = [...keywordSpans(kwText, OTP_KEYWORDS), ...strongEnough(kwText, keywordSpans(kwText, WEAK_OTP_KEYWORDS))];
  const cvvKw = keywordSpans(kwText, CVV_KEYWORDS);

  for (const run of runs) {
    const n = run.digits.length;
    const whole = runSpan(run, tokens, 0, n);

    // Payment card numbers (13-19 digits) that pass Luhn; also scan 16-digit
    // windows inside longer runs.
    if (n >= 13 && n <= 19 && luhnValid(run.digits)) {
      hits.push({ code: 'card_number', span: whole });
    } else if (n > 16) {
      for (let i = 0; i + 16 <= n; i++) {
        if (luhnValid(run.digits.slice(i, i + 16))) {
          hits.push({ code: 'card_number', span: runSpan(run, tokens, i, i + 16) });
          break;
        }
      }
    }

    const first = run.parts[0];
    const afterIdNoun = first !== undefined && followsIdNoun(tokens, first.token);
    // "Account 234567890123" / "customer ID 234567890123" are utility account
    // numbers, unless the sentence talks about Aadhaar.
    if (aadhaarShaped(run, text) && !(afterIdNoun && !mentionsAadhaar(text, run))) {
      hits.push({ code: 'aadhaar', span: whole });
    }

    const ident = isIdentifier(run, tokens, text) || isAmount(run, tokens, text);
    if (!ident && n >= 4 && n <= 8 && near(text, otpKw, run.start, run.end)) {
      hits.push({ code: 'otp_like', span: whole });
    }
    if (!ident && n >= 3 && n <= 4 && near(text, cvvKw, run.start, run.end)) {
      hits.push({ code: 'cvv_like', span: whole });
    }
  }

  const pw = new RegExp(PASSWORD_RE.source, PASSWORD_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = pw.exec(text)) !== null) {
    const word = m[1] ?? '';
    const bare = word.replace(/[.,;!?]+$/, '');
    if (bare.length === 0 || PASSWORD_STOPWORDS.has(bare.toLowerCase())) continue;
    const end = m.index + m[0].length;
    hits.push({ code: 'password', span: [end - word.length, end - (word.length - bare.length)] });
  }

  return hits;
}

/** Fact-based detectors: literal secret values. */
export function factHits(
  text: string,
  tokens: Token[],
  runs: DigitRun[],
  facts: readonly Fact[],
  blockUnapprovedConfirm: boolean,
  looseRunSets: readonly DigitRun[][] = [runs],
): DlpHit[] {
  const hits: DlpHit[] = [];
  for (const f of facts) {
    let code: DlpReasonCode | undefined;
    if (f.tier === 'never') code = 'never_fact';
    else if (f.tier === 'confirm' && !f.approved && blockUnapprovedConfirm) code = 'unapproved_fact';
    if (!code) continue;
    // never-tier values are matched on each loose run variant, which join
    // digits across any short punctuation and filler words ("4 and 8 and 2"),
    // skip digit-count words ("the last three are") and read homophones
    // ("four to one nine"). A match in any variant is a hit.
    const sets = code === 'never_fact' ? looseRunSets : [runs];
    for (const rs of sets) {
      for (const span of valueSpans(text, tokens, rs, f.value, code === 'never_fact')) hits.push({ code, factKey: f.key, span });
    }
  }
  return hits;
}

const MESSAGES: Readonly<Record<DlpReasonCode, string>> = {
  never_fact: 'a never-tier fact value appears in the utterance',
  unapproved_fact: 'an unapproved confirm-tier fact value appears in the utterance',
  card_number: 'a Luhn-valid payment card number appears in the utterance',
  aadhaar: 'an Aadhaar-shaped 12-digit number appears in the utterance',
  otp_like: 'a 4-8 digit code appears near an OTP/PIN/code keyword',
  cvv_like: 'a 3-4 digit number appears near a CVV/security-code keyword',
  password: 'a value follows "password is"',
  invalid_input: 'guard input failed validation',
};

function reasonsOf(hits: DlpHit[]): DlpReason[] {
  const seen = new Set<string>();
  const out: DlpReason[] = [];
  for (const h of hits) {
    const id = `${h.code}:${h.factKey ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(h.factKey === undefined ? { code: h.code, message: MESSAGES[h.code] } : { code: h.code, factKey: h.factKey, message: MESSAGES[h.code] });
  }
  return out;
}

/** Runs every detector over `text`. Inputs must already be validated. */
export function detect(raw: string, rawFacts: readonly Fact[], blockUnapprovedConfirm: boolean): DlpHit[] {
  // All detectors run on a normalised shadow of the text (compatibility forms,
  // look-alike letters, invisible characters folded); spans are mapped back
  // onto the original before they are returned.
  const folded = fold(raw);
  const text = folded.text;
  const facts = rawFacts.map((f) => ({ ...f, value: foldText(f.value) }));
  const tokens = tokenize(text);
  const runs = digitRuns(tokens);
  const looseRunSets = looseRunVariants(tokens);
  // Pattern detectors skip text that is exactly a speakable fact value (a
  // share-tier ticket ID, an approved address with its postal PIN): the owner
  // already cleared it. Never-fact matching still runs over the whole text.
  const cleared = speakableSpans(text, facts);
  const patterns = patternHits(text, tokens, runs).filter(
    (h) => !cleared.some(([a, b]) => h.span[0] >= a && h.span[1] <= b),
  );
  return [...factHits(text, tokens, runs, facts, blockUnapprovedConfirm, looseRunSets), ...patterns].map((h) => ({
    ...h,
    span: unfoldSpan(folded, h.span),
  }));
}

/** Shortest speakable value that may clear pattern hits inside it. */
const CLEARED_MIN_CHARS = 4;

/** Spans of `share` / approved `confirm` fact values, verbatim (case-insensitive) and on word boundaries. */
export function speakableSpans(text: string, facts: readonly Fact[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{Nd}]/u.test(ch);
  for (const f of facts) {
    const speakable = f.tier === 'share' || (f.tier === 'confirm' && f.approved);
    const v = f.value.trim();
    if (!speakable || v.length < CLEARED_MIN_CHARS) continue;
    for (const [a, b] of caseInsensitiveMatches(text, v)) {
      // "48211" must not clear part of a longer number "482110".
      if (isAlnum(text[a - 1]) || isAlnum(text[b])) continue;
      out.push([a, b]);
    }
  }
  return out;
}

/**
 * Output DLP. Blocks the utterance if any `never` fact value (exact,
 * case-insensitive, digit-normalised or spelled out) or any secret-shaped
 * pattern (card number, Aadhaar, OTP/PIN near a keyword, CVV, password) is
 * present. `redacted` has every hit masked and is safe to log.
 */
export function scanOutbound(text: string, facts: readonly FactInput[], options: ScanOptions = {}): ScanResult {
  const t = TextSchema.parse(text);
  const parsed = FactsSchema.parse(facts);
  const opts = ScanOptionsSchema.parse(options);
  const hits = detect(t, parsed, opts.blockUnapprovedConfirm ?? true);
  return {
    allowed: hits.length === 0,
    reasons: reasonsOf(hits),
    redacted: applySpans(t, hits.map((h) => h.span), MASK),
  };
}

/**
 * Masks `never`-tier values and every DLP pattern hit with "•••", for
 * transcript storage. Works on both sides of the conversation.
 */
export function mask(text: string, facts: readonly FactInput[]): string {
  const t = TextSchema.parse(text);
  const parsed = FactsSchema.parse(facts);
  return applySpans(t, detect(t, parsed, false).map((h) => h.span), MASK);
}
