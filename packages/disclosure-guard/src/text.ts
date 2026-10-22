/**
 * Tokenisation and spoken-digit normalisation.
 *
 * Text is split into word, number and separator tokens. Digit tokens and
 * spelled digits ("four", "oh", "double five") that are separated only by
 * whitespace, dashes, dots or commas are joined into *digit runs*, so
 * "4219", "42-19", "4 2 1 9" and "four two one nine" all yield the run "4219".
 * Number words are understood too: "forty two nineteen" -> "4219",
 * "four hundred eighty two thousand nine hundred thirteen" -> "482913".
 */

export type TokenKind = 'word' | 'digits' | 'sep';

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
}

export interface RunPart {
  /** Index into the token array. */
  token: number;
  /** Digits contributed by this part ("double five" contributes "55"). */
  digits: string;
  spelled: boolean;
  /** Last token index when the part spans several tokens ("forty-eight"). */
  tokenEnd?: number;
}

export interface DigitRun {
  digits: string;
  parts: RunPart[];
  /** For each digit in `digits`, the index into `parts` it came from. */
  digitPart: number[];
  start: number;
  end: number;
}

const DIGIT_WORDS: Readonly<Record<string, string>> = {
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
  niner: '9',
};

const TEEN_WORDS: Readonly<Record<string, number>> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS_WORDS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Scale words above "hundred". */
const SCALE_WORDS: Readonly<Record<string, number>> = {
  thousand: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  million: 1_000_000,
};

const MULTIPLIERS: Readonly<Record<string, number>> = {
  double: 2,
  triple: 3,
};

/**
 * Words that may sit between the digits of a spoken secret without changing
 * it ("4 and 8 and 2", "four dash two"). Only used in loose mode.
 */
const FILLER_WORDS = new Set([
  'and',
  'then',
  'is',
  'dash',
  'hyphen',
  'slash',
  'dot',
  'point',
  'comma',
  'space',
  'colon',
  'followed',
  'by',
  'next',
  // hesitations and discourse fillers ("four eight two, umm, nine one three")
  'uh',
  'uhh',
  'uhm',
  'um',
  'umm',
  'ummm',
  'er',
  'erm',
  'err',
  'hmm',
  'hm',
  'mm',
  'ah',
  'ahh',
  'eh',
  'so',
  'ok',
  'okay',
  'like',
  'pause',
  'again',
  'sorry',
  'that',
  'thats',
  'its',
  'it',
  's',
  'the',
  'last',
  'first',
  'rest',
  'remaining',
  'are',
  'was',
  'were',
  'i',
  'mean',
  'well',
  'yeah',
  'yes',
  'right',
  'now',
  'plus',
  'with',
]);

/**
 * Loose mode: how many ordinary (non-filler, non-number) words may sit between
 * two digit groups of a never-tier secret ("4 8 2 so 9 1 3",
 * "four eight two, let's see, nine one three"). Filler words do not count.
 */
const LOOSE_MAX_GAP_WORDS = 2;

/**
 * Separators that do not break a digit run: whitespace and common
 * punctuation a writer or TTS engine might put between digit groups
 * ("48:29:13", "482/913", "(482) 913", "4 | 8", "4; 8", quotes).
 * "+" is deliberately excluded (country-code prefix).
 */
const SOFT_SEP = /^[\s\-.,_/\\:;|()[\]{}"'`*#~“”‘’«»]+$/u;

/** Loose mode (never-fact matching): any short separator without a line break. */
function isSoftSep(text: string, loose: boolean): boolean {
  if (SOFT_SEP.test(text)) return true;
  return loose && text.length <= 4 && !/[\n\r]/.test(text);
}

/**
 * Invisible / format code points (zero-width space, joiners, soft hyphen,
 * word joiner, BOM, bidi controls, tag characters), variation selectors and
 * the combining keycap. They are replaced by spaces so offsets are preserved
 * and digits on either side still form one run.
 */
const INVISIBLE = /[\p{Cf}\u{FE00}-\u{FE0F}\u{20E3}\u{E0100}-\u{E01EF}]/gu;

const INVISIBLE_ONE = /^[\p{Cf}\u{FE00}-\u{FE0F}\u{20E3}\u{E0100}-\u{E01EF}]$/u;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, (m) => ' '.repeat(m.length));
}

/**
 * Look-alike letters from other scripts that TTS engines (and people) read as
 * the Latin letter. Mapped so "Tіger" (Cyrillic і) or "fοur" (Greek ο) match.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic lower
  а: 'a', в: 'b', е: 'e', ё: 'e', і: 'i', ї: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p',
  с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ү: 'y', ӏ: 'l',
  // Cyrillic upper
  А: 'A', В: 'B', Е: 'E', Ё: 'E', І: 'I', Ї: 'I', Ј: 'J', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P',
  С: 'C', Т: 'T', У: 'Y', Х: 'X', Ѕ: 'S', Ԁ: 'D', Ԛ: 'Q', Ԝ: 'W', Һ: 'H', Ү: 'Y', Ӏ: 'I',
  // Greek lower
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c', ϳ: 'j',
  // Greek upper
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T',
  Υ: 'Y', Χ: 'X', Ϲ: 'C',
  // Latin look-alikes outside ASCII that NFKD leaves alone
  ı: 'i', ȷ: 'j', ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ħ: 'h', ŀ: 'l',
};

/**
 * Circled / dingbat digits that compatibility decomposition does not map
 * (❶ ➀ ➊ ⓵ ⓫ ⓿). Each entry: [first code point, value of first, count].
 */
const EXTRA_DIGIT_RANGES: ReadonlyArray<readonly [number, number, number]> = [
  [0x2776, 1, 10], // ❶..❿
  [0x2780, 1, 10], // ➀..➉
  [0x278a, 1, 10], // ➊..➓
  [0x24eb, 11, 10], // ⓫..⓴
  [0x24f5, 1, 10], // ⓵..⓾
  [0x24ff, 0, 1], // ⓿
  [0x1f10b, 0, 2], // 🄋 🄌
];

function extraDigit(cp: number): string | undefined {
  for (const [first, base, count] of EXTRA_DIGIT_RANGES) {
    if (cp >= first && cp < first + count) return String(base + (cp - first));
  }
  return undefined;
}

/**
 * Normalised shadow of a text plus a map back to the original. Each code
 * point is folded independently: compatibility decomposition (fullwidth,
 * math-alphanumeric, superscript, subscript, circled and parenthesised forms,
 * ligatures) with combining marks dropped, extra dingbat digits, look-alike
 * letters from Cyrillic and Greek, and invisible format characters as spaces.
 * `start[i]` / `end[i]` give the original UTF-16 range of shadow char `i`.
 */
export interface Folded {
  text: string;
  start: number[];
  end: number[];
}

export function fold(raw: string): Folded {
  let text = '';
  const start: number[] = [];
  const end: number[] = [];
  let pos = 0;
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    let out: string;
    if (INVISIBLE_ONE.test(ch)) out = ' '.repeat(ch.length);
    else {
      const extra = extraDigit(cp);
      if (extra !== undefined) out = extra;
      else {
        out = ch.normalize('NFKD').replace(/\p{M}/gu, '');
        if (out.length === 0 && !/\p{M}/u.test(ch)) out = ch;
      }
      let mapped = '';
      for (const c of out) mapped += CONFUSABLES[c] ?? c;
      out = mapped;
    }
    for (let k = 0; k < out.length; k++) {
      text += out[k] ?? '';
      start.push(pos);
      end.push(pos + ch.length);
    }
    pos += ch.length;
  }
  return { text, start, end };
}

/** Folded text only (for fact values and keyword matching). */
export function foldText(raw: string): string {
  return fold(raw).text;
}

/** Maps a [from, to) span of the folded text back onto the original. */
export function unfoldSpan(f: Folded, span: [number, number]): [number, number] {
  const [a, b] = span;
  const n = f.text.length;
  if (n === 0) return [0, 0];
  const s = f.start[Math.min(Math.max(a, 0), n - 1)] ?? 0;
  const e = f.end[Math.min(Math.max(b - 1, 0), n - 1)] ?? s;
  return [s, Math.max(s, e)];
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\p{L}+|\p{Nd}+|[^\p{L}\p{Nd}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[0];
    const kind: TokenKind = /^\p{L}/u.test(t) ? 'word' : /^\p{Nd}/u.test(t) ? 'digits' : 'sep';
    tokens.push({ kind, text: t, start: m.index, end: m.index + t.length });
  }
  return tokens;
}

/** Converts any Unicode decimal digits to ASCII 0-9. */
export function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (d) => {
    if (d >= '0' && d <= '9') return d;
    // Unicode Nd characters come in contiguous blocks of ten (0..9), some of
    // them adjacent; the offset from the start of the contiguous range mod 10
    // is the digit value.
    const cp = d.codePointAt(0) ?? 0;
    let start = cp;
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  });
}

function lower(tok: Token | undefined): string | undefined {
  return tok?.kind === 'word' ? tok.text.toLowerCase() : undefined;
}

function spelledDigit(word: string): string | undefined {
  return DIGIT_WORDS[word.toLowerCase()];
}

function multiplier(word: string): number | undefined {
  return MULTIPLIERS[word.toLowerCase()];
}

/** True for a word that can start a spoken number ("four", "twelve", "forty"). */
function isNumberWord(word: string): boolean {
  const w = word.toLowerCase();
  return DIGIT_WORDS[w] !== undefined || TEEN_WORDS[w] !== undefined || TENS_WORDS[w] !== undefined;
}

function isDigitLike(tok: Token | undefined): boolean {
  if (!tok) return false;
  if (tok.kind === 'digits') return true;
  return tok.kind === 'word' && isNumberWord(tok.text);
}

/** Index of the next non-soft-separator token after `i`, or -1. */
function nextSignificant(tokens: Token[], i: number, loose = false): number {
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (!t) break;
    if (t.kind === 'sep' && isSoftSep(t.text, loose)) continue;
    return j;
  }
  return -1;
}

interface Parsed {
  value: number;
  /** Digit string for this reading. */
  digits: string;
  /** Last token index consumed. */
  end: number;
  /** A "hundred"/"thousand"/... scale word was consumed. */
  scaled: boolean;
  /** Reading is a bare zero word ("oh", "zero"). */
  zero: boolean;
}

/** units, teens, or tens [+ unit]: "four", "thirteen", "forty-eight". */
function parseBelowHundred(tokens: Token[], i: number): Parsed | undefined {
  const w = lower(tokens[i]);
  if (w === undefined) return undefined;
  const tens = TENS_WORDS[w];
  if (tens !== undefined) {
    const j = nextSignificant(tokens, i);
    const u = lower(tokens[j]);
    const ud = u === undefined ? undefined : DIGIT_WORDS[u];
    if (ud !== undefined && ud !== '0') {
      const v = tens + Number(ud);
      return { value: v, digits: String(v), end: j, scaled: false, zero: false };
    }
    return { value: tens, digits: String(tens), end: i, scaled: false, zero: false };
  }
  const teen = TEEN_WORDS[w];
  if (teen !== undefined) return { value: teen, digits: String(teen), end: i, scaled: false, zero: false };
  const d = DIGIT_WORDS[w];
  if (d !== undefined) return { value: Number(d), digits: d, end: i, scaled: false, zero: d === '0' };
  return undefined;
}

/** Optional "and" followed by a non-zero number below a hundred. */
function parseTail(tokens: Token[], after: number): Parsed | undefined {
  let k = nextSignificant(tokens, after);
  if (lower(tokens[k]) === 'and') k = nextSignificant(tokens, k);
  const b = k === -1 ? undefined : parseBelowHundred(tokens, k);
  return b && !b.zero ? b : undefined;
}

/** "four hundred [and] eighty two", or a plain below-hundred number. */
function parseBelowThousand(tokens: Token[], i: number): Parsed | undefined {
  const a = parseBelowHundred(tokens, i);
  if (!a) return undefined;
  const j = nextSignificant(tokens, a.end);
  if (!a.zero && lower(tokens[j]) === 'hundred') {
    let value = a.value * 100;
    let end = j;
    const b = parseTail(tokens, j);
    if (b) {
      value += b.value;
      end = b.end;
    }
    return { value, digits: String(value), end, scaled: true, zero: false };
  }
  return a;
}

/**
 * Parses a spoken number starting at token `i`. With a scale word it is read
 * as a cardinal ("four hundred eighty two thousand nine hundred thirteen" ->
 * "482913"); otherwise only the first below-hundred group is consumed, so
 * pairs are read digit-wise ("forty two nineteen" -> "42", then "19").
 */
function parseSpokenNumber(tokens: Token[], i: number): Parsed | undefined {
  const first = parseBelowThousand(tokens, i);
  if (!first) return undefined;
  let total = 0;
  let cur: Parsed | undefined = first;
  let end = first.end;
  let scaled = first.scaled;
  for (;;) {
    const j = nextSignificant(tokens, end);
    const w = lower(tokens[j]);
    const scale = w === undefined ? undefined : SCALE_WORDS[w];
    if (scale === undefined || !cur || cur.zero) break;
    total += cur.value * scale;
    scaled = true;
    end = j;
    let k = nextSignificant(tokens, j);
    if (lower(tokens[k]) === 'and') k = nextSignificant(tokens, k);
    const nxt = k === -1 ? undefined : parseBelowThousand(tokens, k);
    if (nxt && !nxt.zero) {
      cur = nxt;
      end = nxt.end;
    } else {
      cur = undefined;
      break;
    }
  }
  if (!scaled) return first;
  total += cur?.value ?? 0;
  return { value: total, digits: String(total), end, scaled: true, zero: false };
}

export interface DigitRunOptions {
  /**
   * Loose mode for matching known secrets: any short separator without a line
   * break, and filler words ("and", "then", "dash"...), do not break a run.
   */
  loose?: boolean;
  /**
   * Loose mode only: a number word that counts digits rather than being one
   * ("the first *three* are 482", "the last *two* digits are 19") is a gap
   * word, not part of the run.
   */
  countWordGaps?: boolean;
  /**
   * Loose mode only: words a TTS engine pronounces exactly like a digit
   * ("to"/"too" = two, "for"/"fore" = four, "won" = one, "ate" = eight) are
   * read as that digit.
   */
  homophones?: boolean;
}

/** Spoken homophones of digit words (only for never-fact matching). */
const DIGIT_HOMOPHONES: Readonly<Record<string, string>> = {
  to: 'two',
  too: 'two',
  for: 'four',
  fore: 'four',
  won: 'one',
  ate: 'eight',
};

/** Words before a number word that make it a count of digits ("first three"). */
const COUNT_BEFORE = new Set(['first', 'last', 'next', 'other', 'remaining', 'final', 'initial', 'ending']);
/** Words after a number word that make it a count of digits ("two digits are"). */
const COUNT_AFTER = new Set(['digits', 'digit', 'numbers', 'number', 'are', 'is']);

/** Index of the previous non-soft-separator token before `i`, or -1. */
function prevSignificant(tokens: Token[], i: number, loose: boolean): number {
  for (let j = i - 1; j >= 0; j--) {
    const t = tokens[j];
    if (!t) break;
    if (t.kind === 'sep' && isSoftSep(t.text, loose)) continue;
    return j;
  }
  return -1;
}

/** Loose variant runs used to match never-tier values; their hits are unioned. */
export function looseRunVariants(tokens: Token[]): DigitRun[][] {
  const homophoneTokens = tokens.map((t) => {
    const w = t.kind === 'word' ? DIGIT_HOMOPHONES[t.text.toLowerCase()] : undefined;
    return w === undefined ? t : { ...t, text: w };
  });
  return [
    digitRuns(tokens, { loose: true }),
    digitRuns(tokens, { loose: true, countWordGaps: true }),
    digitRuns(homophoneTokens, { loose: true }),
    digitRuns(homophoneTokens, { loose: true, countWordGaps: true }),
  ];
}

export function digitRuns(tokens: Token[], options: DigitRunOptions = {}): DigitRun[] {
  const loose = options.loose ?? false;
  const countGaps = loose && (options.countWordGaps ?? false);

  /** True when the word at `i` counts digits rather than being one. */
  const isCountWord = (i: number): boolean => {
    if (!countGaps) return false;
    const t = tokens[i];
    if (t?.kind !== 'word' || !isNumberWord(t.text)) return false;
    const before = lower(tokens[prevSignificant(tokens, i, loose)]);
    if (before !== undefined && COUNT_BEFORE.has(before)) return true;
    const after = lower(tokens[nextSignificant(tokens, i, loose)]);
    return after !== undefined && COUNT_AFTER.has(after);
  };
  const runs: DigitRun[] = [];
  let cur: DigitRun | null = null;
  let pendingMult = 1;

  const close = (): void => {
    if (cur && cur.digits.length > 0) runs.push(cur);
    cur = null;
    pendingMult = 1;
  };

  const push = (idx: number, endIdx: number, digits: string, spelled: boolean): void => {
    const tok = tokens[idx];
    const last = tokens[endIdx];
    if (!tok || !last) return;
    let d = digits;
    if (pendingMult > 1 && d.length > 0) {
      d = (d[0] ?? '').repeat(pendingMult) + d.slice(1);
      pendingMult = 1;
    }
    if (!cur) cur = { digits: '', parts: [], digitPart: [], start: tok.start, end: last.end };
    const partIdx = cur.parts.length;
    const part: RunPart = { token: idx, digits: d, spelled };
    if (endIdx !== idx) part.tokenEnd = endIdx;
    cur.parts.push(part);
    for (let k = 0; k < d.length; k++) cur.digitPart.push(partIdx);
    cur.digits += d;
    cur.end = last.end;
  };

  /**
   * Loose mode: true when the word at `i` is part of a short gap (filler words
   * plus at most LOOSE_MAX_GAP_WORDS other words, soft separators only) that is
   * followed by another digit group.
   */
  const bridgesToDigits = (i: number): boolean => {
    let j = i;
    let others = 0;
    while (j !== -1) {
      const t = tokens[j];
      if (!t) return false;
      const counting = isCountWord(j);
      if (!counting && (isDigitLike(t) || (t.kind === 'word' && multiplier(t.text) !== undefined))) return j !== i;
      if (t.kind !== 'word') return false;
      if (!counting && !FILLER_WORDS.has(t.text.toLowerCase()) && ++others > LOOSE_MAX_GAP_WORDS) return false;
      j = nextSignificant(tokens, j, loose);
    }
    return false;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.kind === 'digits') {
      push(i, i, asciiDigits(tok.text), false);
      continue;
    }
    if (tok.kind === 'word') {
      if (isCountWord(i)) {
        if (cur && bridgesToDigits(i)) continue;
        close();
        continue;
      }
      const num = parseSpokenNumber(tokens, i);
      if (num) {
        push(i, num.end, num.digits, true);
        i = num.end;
        continue;
      }
      const mult = multiplier(tok.text);
      if (mult !== undefined && isDigitLike(tokens[nextSignificant(tokens, i)])) {
        // "double five": keep the run open and repeat the next digit.
        if (!cur) cur = { digits: '', parts: [], digitPart: [], start: tok.start, end: tok.end };
        pendingMult = mult;
        continue;
      }
      if (loose && cur && bridgesToDigits(i)) continue;
      close();
      continue;
    }
    // separator
    if (!isSoftSep(tok.text, loose)) close();
  }
  close();
  return runs;
}

/** Character range in the original text covered by run digits [from, to). */
export function runSpan(run: DigitRun, tokens: Token[], from: number, to: number): [number, number] {
  const pFrom = run.parts[run.digitPart[from] ?? 0];
  const pTo = run.parts[run.digitPart[to - 1] ?? run.parts.length - 1];
  const tFrom = pFrom ? tokens[pFrom.token] : undefined;
  const tTo = pTo ? tokens[pTo.tokenEnd ?? pTo.token] : undefined;
  let start = tFrom?.start ?? run.start;
  // Include a directly preceding multiplier word ("double five").
  if (from === 0) start = Math.min(start, run.start);
  return [start, tTo?.end ?? run.end];
}

/**
 * Alphanumeric stream: lower-cased letters and digits only, with spelled
 * digits converted, plus a map from each stream char back to its token.
 * Used for fuzzy matching of non-numeric secrets like passwords.
 */
export interface AlnumStream {
  text: string;
  charToken: number[];
}

/**
 * With `runs` (loose digit runs), every token inside a run contributes that
 * run's digits instead of its words, so spoken numbers ("ninety nine",
 * "one twenty three", "double five") match the digits of a secret, and filler
 * words between digits ("4 and 8") are dropped.
 */
export function alnumStream(
  tokens: Token[],
  runs: readonly DigitRun[] = [],
  options: { dropGapWords?: boolean } = {},
): AlnumStream {
  const drop = options.dropGapWords === true ? gapWords(tokens) : new Set<number>();
  let text = '';
  const charToken: number[] = [];
  const emit = (piece: string, i: number): void => {
    for (const ch of piece) {
      text += ch;
      charToken.push(i);
    }
  };
  // Token index -> digits contributed by the run part starting there.
  const partAt = new Map<number, { digits: string; end: number }>();
  const inRun = new Set<number>();
  for (const run of runs) {
    for (const p of run.parts) partAt.set(p.token, { digits: p.digits, end: p.tokenEnd ?? p.token });
    tokens.forEach((tok, i) => {
      if (tok.start >= run.start && tok.end <= run.end) inRun.add(i);
    });
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const part = partAt.get(i);
    if (part) {
      emit(part.digits, i);
      for (let j = i + 1; j <= part.end; j++) inRun.add(j);
      i = Math.max(i, part.end);
      continue;
    }
    if (inRun.has(i) || drop.has(i)) continue;
    if (tok.kind === 'digits') emit(asciiDigits(tok.text), i);
    else if (tok.kind === 'word') emit(spelledDigit(tok.text) ?? tok.text.toLowerCase(), i);
  }
  return { text, charToken };
}

/** Longest ordinary word that may be skipped between letters and digits ("Tiger the 123"). */
const GAP_WORD_MAX_CHARS = 4;

/**
 * Word tokens a speaker may insert inside a spoken secret: filler words, and
 * one short word between a letter group and a digit group ("Tiger and 123").
 */
function gapWords(tokens: Token[]): Set<number> {
  const out = new Set<number>();
  const classOf = (t: Token | undefined): 'alpha' | 'digit' | undefined => {
    if (!t || t.kind === 'sep') return undefined;
    if (t.kind === 'digits' || isNumberWord(t.text)) return 'digit';
    return 'alpha';
  };
  const neighbour = (i: number, dir: 1 | -1): Token | undefined => {
    for (let j = i + dir; j >= 0 && j < tokens.length; j += dir) {
      const t = tokens[j];
      if (!t) return undefined;
      if (t.kind === 'sep') {
        if (/[\n\r]/.test(t.text) || t.text.length > 4) return undefined;
        continue;
      }
      return t;
    }
    return undefined;
  };
  tokens.forEach((t, i) => {
    if (t.kind !== 'word' || isNumberWord(t.text)) return;
    if (FILLER_WORDS.has(t.text.toLowerCase())) {
      out.add(i);
      return;
    }
    if (t.text.length > GAP_WORD_MAX_CHARS) return;
    const a = classOf(neighbour(i, -1));
    const b = classOf(neighbour(i, 1));
    if (a !== undefined && b !== undefined && a !== b) out.add(i);
  });
  return out;
}

export function alnumNormalize(s: string): string {
  return asciiDigits(s.toLowerCase()).replace(/[^\p{L}\p{Nd}]+/gu, '');
}

/** True when the value is a number possibly written with separators. */
export function isNumericValue(value: string): boolean {
  return /^[\s\p{Nd}\-.()+/,_]+$/u.test(value) && /\p{Nd}/u.test(value);
}

export function digitsOf(value: string): string {
  return asciiDigits(value).replace(/\D/g, '');
}

/** Merges overlapping spans and replaces them with `mask`. */
export function applySpans(text: string, spans: Array<[number, number]>, mask: string): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  let out = '';
  let pos = 0;
  for (const [s, e] of merged) {
    out += text.slice(pos, s) + mask;
    pos = e;
  }
  return out + text.slice(pos);
}
