import { describe, expect, it } from 'vitest';
import { luhnValid, MASK, scanOutbound } from './index.js';
import { FACTS } from './testing/fixtures.js';

const codes = (text: string, facts = FACTS): string[] => scanOutbound(text, facts).reasons.map((r) => r.code);
const blocked = (text: string, facts = FACTS): boolean => !scanOutbound(text, facts).allowed;

describe('luhnValid', () => {
  it('accepts valid test PANs', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('5555555555554444')).toBe(true);
    expect(luhnValid('378282246310005')).toBe(true);
  });
  it('rejects invalid checksums and non-digits', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('1234567812345678')).toBe(false);
    expect(luhnValid('4111-1111')).toBe(false);
    expect(luhnValid('')).toBe(false);
  });
});

describe('scanOutbound: never-tier values', () => {
  it('allows plain safe text', () => {
    const r = scanOutbound('Hi, I am an AI assistant calling on behalf of Asha Rao.', FACTS);
    expect(r).toEqual({ allowed: true, reasons: [], redacted: 'Hi, I am an AI assistant calling on behalf of Asha Rao.' });
  });

  it('blocks an exact never value', () => {
    const r = scanOutbound('The PIN is 4219.', FACTS);
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((x) => x.code === 'never_fact' && x.factKey === 'pin')).toBe(true);
    expect(r.redacted).toBe(`The PIN is ${MASK}.`);
  });

  it('blocks a never value case-insensitively', () => {
    expect(codes('it is sunflower@99')).toContain('never_fact');
    expect(codes('SUNFLOWER@99 is the one')).toContain('never_fact');
  });

  it('blocks a non-numeric secret written with different punctuation/spacing', () => {
    expect(codes('sunflower 99')).toContain('never_fact');
  });

  it('blocks digit-normalised variants: spaces, dashes, dots', () => {
    for (const t of ['it is 4 2 1 9', 'it is 42-19', 'it is 4.2.1.9', 'otp 48 29 11', 'otp 482-911']) {
      expect(blocked(t), t).toBe(true);
    }
  });

  it('blocks spelled digits: "four two one nine"', () => {
    const r = scanOutbound('sure, four two one nine', FACTS);
    expect(r.allowed).toBe(false);
    expect(r.reasons[0]?.factKey).toBe('pin');
    expect(r.redacted).toBe(`sure, ${MASK}`);
  });

  it('blocks hyphenated spelled digits: "four-two-one-nine"', () => {
    expect(codes('Four-Two-One-Nine')).toContain('never_fact');
  });

  it('blocks mixed spelled and numeric digits', () => {
    expect(codes('it is four 2 one 9')).toContain('never_fact');
  });

  it('blocks "double" and "triple" spoken forms', () => {
    const facts = [{ key: 'otp', label: 'OTP', value: '558884', tier: 'never' as const, approved: false }];
    expect(codes('that would be double five triple eight four', facts)).toContain('never_fact');
    expect(codes('5 5 8 8 8 4', facts)).toContain('never_fact');
  });

  it('blocks "oh" spoken as zero', () => {
    const facts = [{ key: 'pin', label: 'PIN', value: '3071', tier: 'never' as const, approved: false }];
    expect(codes('three oh seven one', facts)).toContain('never_fact');
  });

  it('blocks a long never value embedded in a longer run', () => {
    expect(codes('ref 99482911')).toContain('never_fact');
  });

  it('does not block a short never value that is only part of a larger number', () => {
    // PIN 4219 must not trip on an unrelated amount like 14219.
    expect(blocked('The total was 14219 rupees')).toBe(false);
  });

  it('blocks an unapproved confirm value by default, and allows it when opted out', () => {
    expect(codes('call 98765 00000')).toContain('unapproved_fact');
    expect(scanOutbound('call 98765 00000', FACTS, { blockUnapprovedConfirm: false }).allowed).toBe(true);
  });

  it('allows approved confirm and share values', () => {
    expect(scanOutbound('Email asha@example.com, order OD12345', FACTS).allowed).toBe(true);
  });

  it('never puts the secret value in reasons', () => {
    const r = scanOutbound('PIN 4219, OTP 482911, card 4111 1111 1111 1111', FACTS);
    const serialised = JSON.stringify(r.reasons) + r.redacted;
    expect(serialised).not.toMatch(/4219|482911|4111/);
  });
});

describe('scanOutbound: pattern detectors', () => {
  const none: typeof FACTS = [];

  it('blocks a Luhn-valid 16-digit PAN, spaced or dashed', () => {
    expect(codes('card 5555 5555 5555 4444', none)).toContain('card_number');
    expect(codes('card 5555-5555-5555-4444', none)).toContain('card_number');
    expect(codes('5555555555554444', none)).toContain('card_number');
  });

  it('does not block a 16-digit number failing Luhn', () => {
    expect(codes('reference 5555 5555 5555 4445', none)).not.toContain('card_number');
  });

  it('blocks a spoken card number', () => {
    const spoken = 'four one one one one one one one one one one one one one one one';
    expect(codes(spoken, none)).toContain('card_number');
  });

  it('blocks a 12-digit Aadhaar, spaced, dashed or plain', () => {
    expect(codes('Aadhaar 2345 6789 0123', none)).toContain('aadhaar');
    expect(codes('UID 2345-6789-0123', none)).toContain('aadhaar');
    expect(codes('234567890123', none)).toContain('aadhaar');
  });

  it('does not treat a +91 phone number as Aadhaar', () => {
    expect(blocked('call back on +91 98765 43210', none)).toBe(false);
  });

  it('blocks a 6-digit code near OTP / code / verification keywords', () => {
    expect(codes('Your OTP is 739201', none)).toContain('otp_like');
    expect(codes('the verification code: 739201', none)).toContain('otp_like');
    expect(codes('739201 is the code', none)).toContain('otp_like');
    expect(codes('passcode 7392', none)).toContain('otp_like');
  });

  it('blocks a 4-8 digit spoken code near PIN', () => {
    expect(codes('my PIN is seven three nine two', none)).toContain('otp_like');
  });

  it('does not block order IDs like OD12345, even near "code"', () => {
    expect(blocked('Your order OD12345 has shipped', none)).toBe(false);
    expect(blocked('the order code is OD123456', none)).toBe(false);
  });

  it('does not block ticket numbers like SR-48211', () => {
    expect(blocked('Your ticket SR-48211 is open', none)).toBe(false);
    expect(blocked('The reference code is SR-48211', none)).toBe(false);
  });

  it('does not block numbers far from any keyword', () => {
    expect(blocked('The technician will visit between 1400 and 1600 hours', none)).toBe(false);
    expect(blocked('Your plan costs 1499 rupees per month', none)).toBe(false);
  });

  it('does not carry keyword context across sentences', () => {
    expect(blocked("I can't share the PIN. Your ticket 48211 is open.", none)).toBe(false);
  });

  it('does not block postal PIN codes or error codes', () => {
    expect(blocked('The installation address pin code is 560001', none)).toBe(false);
    expect(blocked('The router shows error code 1068', none)).toBe(false);
  });

  it('blocks a CVV near CVV/CVC/security code, not elsewhere', () => {
    expect(codes('the CVV is 123', none)).toContain('cvv_like');
    expect(codes('CVC: 4821', none)).toContain('cvv_like');
    expect(codes('security code 987', none)).toContain('cvv_like');
    expect(blocked('we have 123 complaints', none)).toBe(false);
  });

  it('blocks "password is X" but not "password is not ..."', () => {
    const r = scanOutbound('the password is hunter2', none);
    expect(r.allowed).toBe(false);
    expect(r.reasons[0]?.code).toBe('password');
    expect(r.redacted).toBe(`the password is ${MASK}`);
    expect(blocked('my password is: Tr0ub4dor', none)).toBe(true);
    expect(blocked('the password is not something I can share', none)).toBe(false);
    expect(blocked("the password isn't working", none)).toBe(false);
  });
});
