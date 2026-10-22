/**
 * Browser-side disclosure masking. The server already masks everything it
 * returns, but the host also handles the user's own words (typed or spoken)
 * and whatever the user types into an elicitation form. Every string that
 * reaches the LLM proxy, the trace panel, the on-screen transcripts or TTS
 * goes through here first, so a secret-shaped value (OTP near a keyword, card
 * number, Aadhaar, CVV, password) is shown and spoken as "•••".
 */
import { mask } from '@standin/disclosure-guard';

const MAX_MASKABLE = 100_000;
export const MASK_TOKEN = '•••';

/** Mask one string. Never throws: unmaskable input is replaced wholesale. */
export function maskText(text: string): string {
  if (text.length === 0) return text;
  if (text.length > MAX_MASKABLE) return MASK_TOKEN;
  try {
    return mask(text, []);
  } catch {
    return MASK_TOKEN;
  }
}

/** Keys whose values are secrets by name, whatever they look like. */
const SECRET_KEY = /^(otp|pin|cvv|cvc|password|passcode|aadhaar|card_?number|one_?time_?(pass(word)?|code))$/i;

/** Deep-copy a JSON-ish value with every string leaf masked. */
export function maskDeep(value: unknown, depth = 0): unknown {
  if (depth > 40) return MASK_TOKEN;
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && (typeof v === 'string' || typeof v === 'number') ? MASK_TOKEN : maskDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}
