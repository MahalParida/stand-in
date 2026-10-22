import { describe, expect, it } from 'vitest';
import { assignTier, AssignTierInputSchema, MASK, mask, scanOutbound } from './index.js';
import type { FactInput } from './types.js';

// Synthetic values only.
const FACTS: FactInput[] = [
  { key: 'otp', label: 'OTP', value: '482913', tier: 'never' },
  { key: 'pw', label: 'Password', value: 'Tiger@123', tier: 'never' },
  { key: 'pin', label: 'PIN', value: '4219', tier: 'never' },
];

describe('DLP: Unicode compatibility and look-alike characters', () => {
  const cases: Array<[string, string]> = [
    ['superscript digits', '⁴⁸²⁹¹³'],
    ['subscript digits', '₄₈₂₉₁₃'],
    ['circled digits', '④⑧②⑨①③'],
    ['negative circled digits', '❹❽❷❾❶❸'],
    ['parenthesised digits', '⑷⑵⑴⑼'],
    ['digit full stop', '⒋⒉⒈⒐'],
    ['fullwidth letters', 'Ｔｉｇｅｒ@123'],
    ['fullwidth letters and at sign', 'Ｔｉｇｅｒ＠１２３'],
    ['math bold letters', '𝐓𝐢𝐠𝐞𝐫@123'],
    ['math sans letters', '𝖳𝗂𝗀𝖾𝗋 at 123'],
    ['modifier letters', 'ᵀⁱᵍᵉʳ@123'],
    ['Cyrillic i', 'Tіger@123'],
    ['Cyrillic e and Greek iota', 'Tιgеr@123'],
    ['Greek omicron in number words', 'fοur twο οne nine'],
    ['Cyrillic o in number words', 'fоur еight twо nine оne three'],
    ['combining accents', 'Tígér@123'],
    ['superscript in sentence', 'the code is ⁴⁸²⁹¹³ ok'],
  ];

  it.each(cases)('%s: scanOutbound blocks %s', (_name, text) => {
    const r = scanOutbound(text, FACTS);
    expect(r.allowed).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain('never_fact');
    expect(r.redacted).toContain(MASK);
  });

  it.each(cases)('%s: mask() removes the value from %s', (_name, text) => {
    const out = mask(text, FACTS);
    expect(out).not.toBe(text);
    expect(out).toContain(MASK);
  });

  it('mask keeps the surrounding original text and masks only the value', () => {
    expect(mask('the code is ⁴⁸²⁹¹³ ok', FACTS)).toBe(`the code is ${MASK} ok`);
    expect(mask('pass Ｔｉｇｅｒ@123 now', FACTS)).toBe(`pass ${MASK} now`);
  });

  it('spans map back correctly over astral (surrogate pair) characters', () => {
    expect(mask('x 𝐓𝐢𝐠𝐞𝐫@123 y', FACTS)).toBe(`x ${MASK} y`);
  });

  it('fullwidth OTP near a keyword is caught by the pattern detector', () => {
    expect(scanOutbound('Ｙｏｕｒ ＯＴＰ ｉｓ ⁷⁷¹²⁰⁴', []).allowed).toBe(false);
  });

  it('ordinary accented and non-Latin speech is still allowed', () => {
    expect(scanOutbound('Café Tigre opens at nine.', FACTS).allowed).toBe(true);
    expect(scanOutbound('Спасибо, всего доброго.', FACTS).allowed).toBe(true);
    expect(scanOutbound('Your ticket number is ⁴⁸²¹¹ and the visit is tomorrow.', FACTS).allowed).toBe(true);
  });
});

describe('DLP: hesitations and short words inside a never-tier secret', () => {
  it.each([
    'four eight two, umm, nine one three',
    'four eight two uh nine one three',
    '4 8 2 so 9 1 3',
    'four eight two (pause) nine one three',
    'four eight two, sorry, nine one three',
    '482, okay, 913',
    'four eight two, the rest are nine one three',
    '48 umm uh er 29 so 13',
    'it is four eight two... nine one three',
  ])('%s is blocked', (text) => {
    const r = scanOutbound(text, FACTS);
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContainEqual(expect.objectContaining({ code: 'never_fact', factKey: 'otp' }));
    expect(mask(text, FACTS)).toContain(MASK);
  });

  it.each(['Tiger and 123', 'Tiger, umm, 123', 'tiger the 123', 'Tiger uh at 123', 'Tiger so one two three'])(
    'password %s is blocked',
    (text) => {
      const r = scanOutbound(text, FACTS);
      expect(r.allowed).toBe(false);
      expect(r.reasons).toContainEqual(expect.objectContaining({ code: 'never_fact', factKey: 'pw' }));
    },
  );

  it('more than two ordinary words between groups do not join a run', () => {
    expect(scanOutbound('We have 482 open tickets and the team closed 913 yesterday.', FACTS).allowed).toBe(true);
  });

  it('three ordinary words between groups do not join a run', () => {
    expect(scanOutbound('Call 482 people before Monday, then 913 more.', FACTS).allowed).toBe(true);
  });
});

describe('assignTier: guard-owned tier assignment', () => {
  it.each([
    ['otp', 'OTP', '482913'],
    ['otp_code', undefined, '482913'],
    ['upiPin', 'UPI PIN', '4219'],
    ['atm-pin', undefined, '4219'],
    ['mpin', undefined, '4219'],
    ['password', undefined, 'Tiger@123'],
    ['net_banking_pwd', undefined, 'Tiger@123'],
    ['cvv', undefined, '123'],
    ['card_number', undefined, '4111 1111 1111 1111'],
    ['cardNumber', 'Debit card', 'x'],
    ['aadhaar', undefined, '2345 6789 0123'],
    ['uid', 'Aadhaar number', ''],
    ['verification_code', undefined, '123456'],
    ['code', undefined, '482913'],
    ['api_key', undefined, 'k'],
    ['card_expiry', undefined, '12/29'],
  ] as const)('%s -> never', (key, label, value) => {
    expect(assignTier({ key, label, value })).toBe('never');
  });

  it.each([
    ['phone', undefined, '+91 90000 00000'],
    ['mobile_number', undefined, 'x'],
    ['email', undefined, 'someone@example.test'],
    ['address', 'Home address', '12 MG Road, Bengaluru, PIN 560001'],
    ['pincode', undefined, '560001'],
    ['postal_pin', undefined, '560001'],
    ['card_last4', 'Card ending', '1111'],
    ['credit_card_last_four', undefined, '1111'],
    ['dob', undefined, '1990-01-01'],
    ['account_number', undefined, 'AC-12345'],
    ['notes', undefined, 'someone@example.test'],
    ['callback', undefined, '9000000000'],
  ] as const)('%s -> confirm', (key, label, value) => {
    expect(assignTier({ key, label, value })).toBe('confirm');
  });

  it.each([
    ['name', 'Name', 'Asha Rao'],
    ['order_id', 'Order ID', 'OD48211'],
    ['ticket', 'Ticket number', '482110'],
    ['issue', 'Issue description', 'Broadband down since Monday'],
    ['isp', 'Provider', 'BharatNet'],
    ['promo_code', 'Promo code', 'WELCOME10'],
  ] as const)('%s -> share', (key, label, value) => {
    expect(assignTier({ key, label, value })).toBe('share');
  });

  it.each([
    ['note', 'Note', '4111 1111 1111 1111'],
    ['order_id', 'Order ID', '4111-1111-1111-1111'],
    ['reference', 'Reference', '2345 6789 0123'],
    ['name', 'Name', 'OTP 482913'],
    ['misc', 'Misc', 'password is Tiger@123'],
    ['phone', 'Phone', '4111111111111111'],
  ] as const)('never-shaped value with a share/confirm key (%s) is still never', (key, label, value) => {
    expect(assignTier({ key, label, value })).toBe('never');
  });

  it('look-alike characters in the label do not evade the name rules', () => {
    expect(assignTier({ key: 'x', label: 'ОТР', value: '' })).toBe('never'); // Cyrillic
    expect(assignTier({ key: 'x', label: 'Ｐａｓｓｗｏｒｄ' })).toBe('never');
  });

  it('a Luhn-invalid 16-digit number is not forced to never', () => {
    expect(assignTier({ key: 'order_id', value: '4111 1111 1111 1112' })).toBe('share');
  });

  it('validates input with zod', () => {
    expect(() => assignTier({ key: 'bad key!' })).toThrow();
    expect(AssignTierInputSchema.safeParse({ key: 'otp', tier: 'share' }).success).toBe(true);
    // A caller-supplied tier is ignored.
    expect(assignTier({ key: 'otp', tier: 'share' } as unknown as { key: string })).toBe('never');
  });
});
