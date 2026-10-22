import { describe, expect, it } from 'vitest';
import { MASK, mask, scanOutbound } from './index.js';
import type { FactInput } from './types.js';

// Synthetic values only.
const SECRETS: FactInput[] = [
  { key: 'otp', label: 'OTP', value: '482913', tier: 'never', approved: false },
  { key: 'pin', label: 'PIN', value: '4219', tier: 'never', approved: false },
];
const PASSWORD: FactInput[] = [{ key: 'pw', label: 'Password', value: 'Tiger@123', tier: 'never', approved: false }];
const none: FactInput[] = [];

const blocked = (text: string, facts: readonly FactInput[]): boolean => !scanOutbound(text, facts).allowed;

describe('scanOutbound: separator and invisible-character evasion (must block)', () => {
  const cases = [
    '4/8/2/9/1/3',
    '48:29:13',
    '4 | 8 | 2 | 9 | 1 | 3',
    'The digits: 4; 8; 2; 9; 1; 3',
    '(482) 913',
    '"4","8","2","9","1","3"',
    '4 and 8 and 2 and 9 and 1 and 3',
    '4 then 8 then 2 then 9 then 1 then 3',
    '482​913',
    '482­913',
    '482⁠913',
    '4‌8‍2913',
    '﻿482913',
    'four​eight two nine one three',
    '4️⃣8️⃣2️⃣9️⃣1️⃣3️⃣',
  ];
  for (const t of cases) {
    it(`blocks ${JSON.stringify(t)}`, () => {
      const r = scanOutbound(t, SECRETS);
      expect(r.allowed).toBe(false);
      expect(r.reasons.some((x) => x.code === 'never_fact' && x.factKey === 'otp')).toBe(true);
      expect(r.redacted).not.toMatch(/4\D{0,8}8\D{0,8}2\D{0,8}9\D{0,8}1\D{0,8}3/);
    });
  }

  it('masks values hidden by invisible characters in the original text', () => {
    expect(mask('code 482​913 ok', SECRETS)).toBe(`code ${MASK} ok`);
  });

  it('pattern detectors see through colon and slash separators without facts', () => {
    expect(blocked('The OTP is 48:29:13', none)).toBe(true);
    expect(blocked('OTP: 482/913', none)).toBe(true);
    expect(blocked('OTP 482​913', none)).toBe(true);
  });
});

describe('scanOutbound: spoken number words (must block)', () => {
  it('blocks pairwise tens/teens readings', () => {
    expect(blocked('forty-eight twenty-nine thirteen', SECRETS)).toBe(true);
    expect(blocked('forty eight, twenty nine, thirteen', SECRETS)).toBe(true);
    expect(blocked('forty two nineteen', SECRETS)).toBe(true);
    expect(blocked('it is forty-two nineteen.', SECRETS)).toBe(true);
  });

  it('blocks cardinal readings with hundred and thousand', () => {
    expect(blocked('four hundred eighty two thousand nine hundred thirteen', SECRETS)).toBe(true);
    expect(blocked('four hundred and eighty two thousand, nine hundred and thirteen', SECRETS)).toBe(true);
    expect(blocked('four thousand two hundred nineteen', SECRETS)).toBe(true);
    expect(blocked('forty-eight two nine thirteen', SECRETS)).toBe(true);
  });

  it('blocks a spoken OTP near a keyword without facts', () => {
    expect(blocked('your OTP is forty-eight twenty-nine thirteen', none)).toBe(true);
  });

  it('does not invent numbers from ordinary prose', () => {
    expect(blocked('I waited for twenty minutes and then one more', SECRETS)).toBe(false);
    expect(blocked('The total was fourteen thousand two hundred nineteen rupees', SECRETS)).toBe(false);
  });
});

describe('scanOutbound: spoken symbols in non-numeric secrets (must block)', () => {
  for (const t of ['tiger at one two three', 'tigerat123', 'Its T-I-G-E-R at 1 2 3', 'TIGER AT 123', 'tiger @ 123']) {
    it(`blocks ${JSON.stringify(t)}`, () => {
      const r = scanOutbound(t, PASSWORD);
      expect(r.allowed).toBe(false);
      expect(r.reasons[0]?.factKey).toBe('pw');
    });
  }

  it('expands symbols with several spoken names', () => {
    const facts: FactInput[] = [{ key: 'pw', label: 'Password', value: 'blue#cat_7', tier: 'never', approved: false }];
    expect(blocked('blue hash cat underscore seven', facts)).toBe(true);
    expect(blocked('blue pound cat underscore 7', facts)).toBe(true);
  });
});

describe('scanOutbound: ticket and order IDs during read-back (must allow)', () => {
  const cases = [
    'To confirm, the reference code for my complaint is 48211.',
    'Do I need a code for ticket 48211',
    'I need the verification visit for ticket 48211.',
    'Is that ticket 48211 or the code 48212?',
    'My customer code is 7781234.',
    'Your ticket is 4821 and the code of conduct applies.',
    'Verification of order OD12345 pending since 2024',
    'The complaint number is 48211.',
    'Your ticket number 48211 is open; the technician visits at 14:30.',
  ];
  for (const t of cases) {
    it(`allows ${JSON.stringify(t)}`, () => {
      expect(scanOutbound(t, none)).toEqual({ allowed: true, reasons: [], redacted: t });
    });
  }

  it('still blocks OTP-near-keyword strings', () => {
    expect(blocked('Your OTP is 739201', none)).toBe(true);
    expect(blocked('the verification code: 739201', none)).toBe(true);
    expect(blocked('739201 is the code', none)).toBe(true);
    expect(blocked('The OTP for order 4821 is 739201', none)).toBe(true);
    expect(blocked('The code is 739201', none)).toBe(true);
  });
});
