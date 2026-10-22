import { patternHits } from './dlp.js';
import { luhnValid } from './luhn.js';
import { digitRuns, digitsOf, foldText, isNumericValue, tokenize } from './text.js';
import { AssignTierInputSchema, type AssignTierInput, type Tier } from './types.js';

/**
 * Tier assignment. Spec: the tier of a case fact is assigned by the guard,
 * never by the caller (host or LLM). Rules look at the key and label (using
 * the same vocabulary as the inbound classifier) and at the value's shape;
 * when rules disagree the most restrictive tier wins.
 */

const RANK: Readonly<Record<Tier, number>> = { share: 0, confirm: 1, never: 2 };

function stricter(a: Tier, b: Tier): Tier {
  return RANK[b] > RANK[a] ? b : a;
}

/** Postal codes contain "pin" but are address data, not secrets. */
const POSTAL = /\b(?:pin\s*code|pincode|postal\s+(?:pin|code)|zip\s*code|zip|postcode|post\s+code)\b/g;

/** Key / label words that make a fact a secret. */
const NEVER_NAME =
  /\b(?:otp|one\s*time\s*(?:password|passcode|pin|code)|pin|pins|mpin|m\s+pin|tpin|t\s+pin|upi\s*pin|atm\s*pin|card\s*pin|pin\s*(?:no|num|number)|password|passwords|passcode|passwd|pass\s+word|pwd|pw|cvv\d?|cvc\d?|cid|security\s*code|card\s*verification(?:\s+(?:value|code|number))?|card\s*(?:no|num|number)|cardnumber|cardno|pan\s+(?:number|no)\s+of\s+card|full\s+card|debit\s*card|credit\s*card|atm\s*card|expiry|exp\s+date|expiration|aadhaa?r|adhaa?r|aadhar|uid|uidai|verification\s*code|auth(?:entication)?\s*code|login\s*code|sms\s*code|secret|secrets|api\s*key|private\s*key|(?:access|auth|refresh|api|bearer|session)\s*token|seed\s*phrase|recovery\s*(?:phrase|code|key)|security\s*(?:answer|question)|mother'?s?\s+maiden\s+name|maiden\s+name|netbanking|net\s+banking|credentials?)\b/;

/** A fact called just "code" / "token" is most likely a one-time code. */
const BARE_SECRET_NAME = /^(?:(?:the|my|your)\s+)?(?:code|token|key)(?:\s+(?:the|my|your)?\s*(?:code|token|key))?$/;

/** Card-related words that are fine when only the last four digits are meant. */
const CARD_NAME = /\b(?:card\s*(?:no|num|number)|cardnumber|cardno|full\s+card|debit\s*card|credit\s*card|atm\s*card)\b/;
const LAST_FOUR = /\b(?:last\s*(?:4|four)|last4|ending|ends\s+with|masked)\b/;

/** Personal contact / identity details: spoken only with owner approval. */
const CONFIRM_NAME =
  /\b(?:phone|phones|mobile|mob|cell|cellphone|telephone|tel|contact\s*(?:no|num|number)|whatsapp|landline|email|e\s*mail|mail|address|addr|street|house|flat|apartment|locality|landmark|postal|pin\s*code|pincode|zip|postcode|last\s*(?:4|four)|last4|dob|date\s+of\s+birth|birth\s*date|birthday|birth|age|account\s*(?:no|num|number)|acct|acc\s*no|bank\s*account|ifsc|upi|upi\s*id|vpa|pan|pan\s*card|passport|driving\s*licen[cs]e|dl\s*(?:no|number)|voter\s*id|gst(?:in)?|ssn|social\s+security|national\s+id|tax\s*id|salary|income|location|gps|ip|imei)\b/;

/** camelCase / snake_case / kebab / dotted -> lower-case words. */
function words(s: string): string {
  return foldText(s)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/[_.\-/:]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tierFromName(name: string): Tier {
  if (name.length === 0) return 'share';
  const lastFour = LAST_FOUR.test(name);
  const noPostal = name.replace(POSTAL, (m) => ' '.repeat(m.length));
  // A last-four card reference is not the full card number.
  const forNever = lastFour ? noPostal.replace(new RegExp(CARD_NAME.source, 'g'), (m) => ' '.repeat(m.length)) : noPostal;
  if (NEVER_NAME.test(forNever) || BARE_SECRET_NAME.test(name)) return 'never';
  if (CONFIRM_NAME.test(name) || lastFour) return 'confirm';
  return 'share';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function tierFromValue(value: string): Tier {
  const v = foldText(value).trim();
  if (v.length === 0) return 'share';
  // Any secret-shaped pattern in the value (Luhn card, Aadhaar, "OTP 482913",
  // "password is ...") makes the whole fact a secret.
  const tokens = tokenize(v);
  if (patternHits(v, tokens, digitRuns(tokens)).length > 0) return 'never';
  if (isNumericValue(v)) {
    const d = digitsOf(v);
    if (d.length >= 13 && d.length <= 19 && luhnValid(d)) return 'never';
    // 12 digits starting 2-9 is Aadhaar-shaped unless it carries a "+" country code.
    if (d.length === 12 && /^[2-9]/.test(d) && !v.startsWith('+')) return 'never';
    // Phone numbers (10 digits, or with a + country code).
    if (/^\+/.test(v) || /^(?:0|91)?[6-9]\d{9}$/.test(d)) return 'confirm';
  }
  if (EMAIL.test(v)) return 'confirm';
  return 'share';
}

/**
 * Assigns the disclosure tier of a fact from its key, label and value.
 * The caller cannot choose: a never-shaped value is `never` whatever its key
 * says, and the most restrictive matching rule wins.
 */
export function assignTier(input: AssignTierInput): Tier {
  const { key, label, value } = AssignTierInputSchema.parse(input);
  const name = `${words(key)} ${words(label ?? '')}`.trim();
  return stricter(tierFromName(name), tierFromValue(value ?? ''));
}
