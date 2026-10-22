import { describe, expect, it } from 'vitest';
import { scanOutbound } from './index.js';
import type { FactInput } from './types.js';

// Synthetic values only.
const OTP: FactInput[] = [{ key: 'otp', label: 'OTP', value: '482913', tier: 'never' }];
const PIN: FactInput[] = [{ key: 'pin', label: 'PIN', value: '4219', tier: 'never' }];

describe('never-fact: digit-count words between groups', () => {
  it.each<[string, FactInput[]]>([
    ['the first three are 482 and the last three are 913', OTP],
    ['first three digits 482, last three digits 913', OTP],
    ['the first two digits are 42 and the last two are 19', PIN],
    ['first two are four two, the other two are one nine', PIN],
  ])('blocks %s', (text, facts) => {
    const r = scanOutbound(text, facts);
    expect(r.allowed).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain('never_fact');
  });

  it('still blocks a plain run that ends before "is"', () => {
    expect(scanOutbound('four two one nine is the number', PIN).allowed).toBe(false);
  });
});

describe('never-fact: digit homophones', () => {
  it.each(['four to one nine', 'for two one nine', 'for too won nine', 'fore to one nine'])('blocks %s', (text) => {
    const r = scanOutbound(text, PIN);
    expect(r.allowed).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain('never_fact');
  });

  it('blocks "four ate two nine one three" for the OTP', () => {
    expect(scanOutbound('four ate two nine won three', OTP).allowed).toBe(false);
  });

  it('still blocks digits next to "for" ("I need 42 for 19")', () => {
    expect(scanOutbound('I need 42 for 19', PIN).allowed).toBe(false);
  });

  it('allows ordinary speech with homophones', () => {
    expect(scanOutbound('I want to go for a refund too, we won and ate.', PIN).allowed).toBe(true);
  });
});

describe('otp_like: refund amounts and order/ticket IDs near an OTP refusal', () => {
  it.each([
    "I can't share the OTP, but please process the refund of ₹2,499.",
    'I was charged 2499 after entering the OTP',
    'We need a refund of 2499 rupees, not an OTP',
    'Without the OTP, can you look up 553219, the order number?',
    'PIN aside, the case number for 553219 order',
    'S.R. 48211 — no code needed',
    'I will not share the OTP. The amount is Rs. 2499.',
    'No OTP from me; the order 553219 was charged INR 2499.',
  ])('allows %s', (text) => {
    const r = scanOutbound(text, OTP);
    expect(r.reasons).toEqual([]);
    expect(r.allowed).toBe(true);
  });

  it.each([
    'Your OTP is 771204',
    'the OTP for the refund is 771204',
    '771204 is the OTP for your order',
    'the order OTP is 771204',
    'PIN 7712 for the order',
  ])('still blocks %s', (text) => {
    expect(scanOutbound(text, []).allowed).toBe(false);
  });
});
