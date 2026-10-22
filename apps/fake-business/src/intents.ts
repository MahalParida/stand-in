/**
 * Deterministic keyword/intent detection on what the caller (the Stand-In
 * agent) says. Scripted Ravi reacts to these.
 */

const DIGIT_WORDS: Record<string, string> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/** "four eight two one three" / "double four" -> digits; everything else untouched. */
export function spokenDigitsToNumerals(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(double|triple)\s+(zero|oh|one|two|three|four|five|six|seven|eight|nine|\d)\b/g, (_m, mult: string, w: string) => {
      const d = DIGIT_WORDS[w] ?? w;
      return d.repeat(mult === 'double' ? 2 : 3);
    })
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => DIGIT_WORDS[w] ?? w)
    // "oh" only counts as zero between digits ("four oh two").
    .replace(/(\d)\s+oh\s+(?=\d)/g, '$10 ');
}

/** Digit runs in the text, joining digits separated by spaces, commas, dots or dashes. */
export function digitRuns(text: string): string[] {
  const t = spokenDigitsToNumerals(text);
  const runs = t.match(/\d(?:[\s,.\-/]*\d)*/g) ?? [];
  return runs.map((r) => r.replace(/\D/g, ''));
}

function compactAlnum(text: string): string {
  return spokenDigitsToNumerals(text).replace(/[^a-z0-9]/g, '');
}

/** Does `text` contain `value` (digit-normalised for numeric values, alnum-normalised otherwise)? */
export function containsValue(text: string, value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  const vDigits = v.replace(/\D/g, '');
  const isNumeric = /^[\d\s,.\-/+]+$/.test(v) && vDigits.length >= 3;
  if (isNumeric) {
    if (digitRuns(text).some((r) => r.includes(vDigits))) return true;
    return spokenDigitsToNumerals(text).replace(/\D/g, '').includes(vDigits);
  }
  const vc = compactAlnum(v);
  if (vc.length === 0) return false;
  return compactAlnum(text).includes(vc);
}

/** Replace every occurrence of each secret with •••; if anything is still detectable, mask the whole line. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length === 0) continue;
    out = out.split(s).join('•••');
  }
  return secrets.some((s) => containsValue(out, s)) ? '•••' : out;
}

/** SR ids mentioned (digits only), including spoken/spaced forms like "S R four eight two one three". */
export function mentionedTicketDigits(text: string): string[] {
  const t = spokenDigitsToNumerals(text);
  const out: string[] = [];
  for (const m of t.matchAll(/\bs\s*\.?\s*r\b[\s\-:#.]*((?:\d[\s\-,.]*){5})/g)) {
    const digits = (m[1] ?? '').replace(/\D/g, '');
    if (digits.length === 5) out.push(digits);
  }
  return out;
}

export function mentionsTicket(text: string, ticketId: string): boolean {
  const digits = ticketId.replace(/\D/g, '');
  if (mentionedTicketDigits(text).includes(digits)) return true;
  return digitRuns(text).some((r) => r === digits);
}

const GREETING = /\b(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|namaste|namaskar)\b/i;
const ISSUE =
  /\b(?:internet|broadband|connection|wi-?fi|router|down|not\s+working|outage|refund|credit|bill|billing|charged|technician|complain(?:t)?|issue|problem|service\s+request|ticket|disconnect(?:ed)?|speed|slow|cancel)\b/i;
const REFUSAL =
  /\b(?:can(?:no|')?t|cannot|unable|not\s+able|won'?t|will\s+not|not\s+(?:allowed|authori[sz]ed|permitted|comfortable)|(?:don'?t|do\s+not|never)\s+share|not\s+share|call\s+(?:you\s+)?back\s+to\s+verify|decline|refuse|not\s+going\s+to)\b/i;
const WAIT =
  /\b(?:one\s+(?:moment|minute|second|sec)|hold\s+on|just\s+a\s+(?:moment|minute|second|sec)|let\s+me\s+(?:check|ask|get|connect|confirm|find)|please\s+wait|bear\s+with|give\s+me\s+a|checking\s+with|connecting|bring(?:ing)?\s+(?:the\s+)?(?:account\s+holder|customer|user)|(?:account\s+holder|customer|user)\s+(?:will|is\s+joining|to\s+join))\b/i;
const DONT_KNOW =
  /\b(?:(?:don'?t|do\s+not|doesn'?t|does\s+not)\s+(?:have|know)|not\s+(?:available|sure|known)|no\s+idea|unknown|not\s+with\s+(?:me|us|them))\b/i;
const GOODBYE = /\b(?:bye|goodbye|good\s+bye|that'?s\s+all|nothing\s+else|no,?\s+thank|have\s+a\s+(?:good|nice|great)\s+day)\b/i;
const AFFIRM_DONE = /^\s*(?:no|nope|that'?s\s+it|that\s+is\s+all|thanks?|thank\s+you)\b/i;

/** A token with at least one digit and length >= 4 (account no., serial, reference), or >= 4 spoken digits. */
export function hasValueToken(text: string): boolean {
  if (/(?:^|[^A-Za-z0-9])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,}(?![A-Za-z0-9])/.test(text)) return true;
  return digitRuns(text).some((r) => r.length >= 4);
}

export interface CallerIntents {
  greeting: boolean;
  issue: boolean;
  refusal: boolean;
  wait: boolean;
  dontKnow: boolean;
  goodbye: boolean;
  /** Starts with "no" / "thanks" — used for "anything else?". */
  done: boolean;
  valueToken: boolean;
  wordCount: number;
}

export function detectIntents(text: string): CallerIntents {
  return {
    greeting: GREETING.test(text),
    issue: ISSUE.test(text),
    refusal: REFUSAL.test(text),
    wait: WAIT.test(text),
    dontKnow: DONT_KNOW.test(text),
    goodbye: GOODBYE.test(text),
    done: AFFIRM_DONE.test(text),
    valueToken: hasValueToken(text),
    wordCount: text.split(/\s+/).filter((w) => w.length > 0).length,
  };
}
