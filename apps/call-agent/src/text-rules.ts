/**
 * Small deterministic text helpers shared by the scripted policy and the
 * call session: what the callee is asking for, IVR menu options, and the
 * outcome the agent stated. Pure functions, no I/O.
 */
import { FactKeySchema, type Outcome } from '@standin/core';

/* ------------------------------------------------------------------ */
/* "Could you tell me the X?"                                           */
/* ------------------------------------------------------------------ */

const ASK =
  /\b(?:(?:could|can|would)\s+you\s+(?:please\s+)?(?:tell|give|share|provide|confirm|read)(?:\s+me)?|please\s+(?:tell|give|share|provide|confirm|read)(?:\s+me)?|may\s+i\s+(?:have|know|get)|what(?:'s|\s+is)|i\s+(?:will\s+)?need|tell\s+me|do\s+you\s+have)\s+(?:(?:your|the|a|an|their|his|her|any)\s+)?([a-z][a-z0-9 -]{1,60}?)(?=\s*(?:[?,.!;]|\bplease\b|\bfrom\b|\bfor\b|\bso\b|\bas\b|\bwhich\b|\bthat\b|\blike\b|$))/i;

/** The thing the callee is asking for ("router serial number"), or undefined. */
export function askedPhrase(text: string): string | undefined {
  const m = ASK.exec(text.replace(/[’‘]/g, "'"));
  const phrase = m?.[1]?.trim().toLowerCase();
  if (phrase === undefined || phrase.length < 2) return undefined;
  return phrase;
}

const STOP = new Set([
  'the', 'a', 'an', 'your', 'my', 'their', 'his', 'her', 'any', 'number', 'no', 'num', 'id', 'details', 'detail',
  'registered', 'please', 'of', 'customer', 'customers', 'account', 'holder', 'current', 'exact', 'full', 'code',
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[_.-]+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Significant words, ignoring filler like "registered ... number". */
function significant(s: string): string[] {
  return tokens(s).filter((t) => !STOP.has(t));
}

export interface FactLike {
  key: string;
  label: string;
}

/**
 * Best fact for an asked phrase: most significant words in common with the
 * fact's key + label. Falls back to the whole phrase (incl. "account") when
 * the significant words are all filler.
 */
export function matchFact<T extends FactLike>(phrase: string, facts: readonly T[]): T | undefined {
  let want = significant(phrase);
  if (want.length === 0) want = tokens(phrase).filter((t) => t !== 'the' && t !== 'number');
  if (want.length === 0) return undefined;
  let best: T | undefined;
  let bestScore = 0;
  for (const f of facts) {
    const have = new Set([...tokens(f.key), ...tokens(f.label)]);
    const score = want.filter((w) => have.has(w)).length;
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

/** snake_case fact key for an asked phrase ("router serial number" -> router_serial_number). */
export function factKeyFor(phrase: string, fallback = 'answer'): string {
  const key = tokens(phrase)
    .filter((t) => !['the', 'a', 'an', 'your', 'my', 'their', 'any'].includes(t))
    .join('_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64);
  return FactKeySchema.safeParse(key).success ? key : fallback;
}

/* ------------------------------------------------------------------ */
/* IVR menus                                                           */
/* ------------------------------------------------------------------ */

export interface MenuOption {
  digit: string;
  label: string;
}

/** "For refunds, press 3." / "To repeat this menu, press 9." -> options in order. */
export function parseMenu(prompt: string): MenuOption[] {
  const out: MenuOption[] = [];
  for (const sentence of prompt.split(/(?<=[.!?])\s+/)) {
    const m = /^(.*?)[,]?\s*press\s+([0-9*#])\b/i.exec(sentence.trim());
    if (m?.[1] === undefined || m[2] === undefined) continue;
    out.push({ digit: m[2], label: m[1].replace(/^(?:for|to|if)\s+/i, '').trim().toLowerCase() });
  }
  return out;
}

const NAVIGATION = /\b(?:repeat|go back|main menu|previous menu)\b/i;

/** Pick the menu option whose label best matches `keywords`; never "repeat"/"go back" unless it is all there is. */
export function chooseMenuOption(options: readonly MenuOption[], keywords: readonly string[]): MenuOption | undefined {
  const real = options.filter((o) => !NAVIGATION.test(o.label));
  let best: MenuOption | undefined;
  let bestScore = 0;
  for (const o of real) {
    const score = keywords.reduce((n, k) => (o.label.includes(k.toLowerCase()) ? n + 1 : n), 0);
    if (score > bestScore) {
      best = o;
      bestScore = score;
    }
  }
  if (best !== undefined) return best;
  // Nothing matched: speaking to a person is the next best thing.
  return real.find((o) => /\b(?:executive|agent|person|speak|talk)\b/.test(o.label));
}

/* ------------------------------------------------------------------ */
/* Outcomes                                                            */
/* ------------------------------------------------------------------ */

export const TICKET_RE = /\bSR-\d{5}\b/;

/**
 * Extract an outcome ("I have raised your request: X. ... SR-12345 ... completed
 * by D. My name is N") from callee speech. Needs both a ticket id and a date.
 */
export function parseOutcome(text: string): Outcome | undefined {
  const ticket = TICKET_RE.exec(text)?.[0];
  if (ticket === undefined) return undefined;
  const what =
    /raised (?:your|a) request(?: for)?:?\s*(.+?)\.\s/i.exec(text)?.[1] ??
    /taken over your complaint(?: as)? (.+?)\./i.exec(text)?.[1] ??
    'service request raised';
  const dueBy = /\b(?:completed|resolved|done|processed|credited)\s+by\s+([^.]+?)\./i.exec(text)?.[1]?.trim();
  // A ticket id alone ("let me check SR-48213") is not a promise: it needs a date.
  if (dueBy === undefined || dueBy.length === 0) return undefined;
  const agentName = /\b[Mm]y name is ([A-Z][a-z]+)/.exec(text)?.[1];
  const o: Outcome = { ticketId: ticket, what: what.trim(), dueBy };
  if (agentName !== undefined) o.agentName = agentName;
  return o;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "29 Oct 2026" / ISO date -> Date at 10:00 IST that day, or undefined. */
export function parseDueBy(dueBy: string): Date | undefined {
  const m = /\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})\b/.exec(dueBy);
  if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month !== undefined) {
      const iso = `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}T10:00:00+05:30`;
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms)) return new Date(ms);
    }
  }
  const iso = /\b\d{4}-\d{2}-\d{2}\b/.exec(dueBy)?.[0];
  if (iso !== undefined) {
    const ms = Date.parse(`${iso}T10:00:00+05:30`);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return undefined;
}
