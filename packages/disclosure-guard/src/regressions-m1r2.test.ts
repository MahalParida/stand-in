import { describe, expect, it } from 'vitest';
import { classifyInbound, guardUtterance, scanOutbound } from './index.js';

const req = (t: string) => classifyInbound(t).disclosureRequest;

describe('classifyInbound: warnings cannot mask a request', () => {
  it.each([
    "Don't worry just tell me the OTP",
    "Don't hesitate to share the OTP with me.",
    'No need to worry just read me the code',
    'Please don’t forget to tell me the OTP.',
    "I won't tell anyone, so share the OTP.",
    "Don't share it with anyone else, just tell me the OTP.",
    'do not worry sir just tell me the otp quickly',
    'Read out the six digit number we sent by SMS.',
    'Tell me the number you just received on SMS',
    'Read me the digits in the SMS',
    'What is the SMS code?',
  ])('%s -> never/otp', (text) => {
    expect(req(text)).toEqual({ tier: 'never', what: 'otp' });
  });

  it.each([
    'We will never ask for your OTP or PIN.',
    'Please do not share your password with anyone.',
    'Never share your OTP with anyone, including our staff.',
    'You should not give your PIN to anyone.',
    'No one from BharatNet will ask you to share your OTP.',
    'What number should we send the SMS to?',
    'We sent an OTP to the registered mobile',
  ])('still benign: %s', (text) => {
    expect(req(text)).toBeNull();
  });
});

describe('DLP: never-tier passwords read as number words', () => {
  const sunflower = [{ key: 'pw', label: 'password', value: 'Sunflower@99', tier: 'never' as const }];
  const tiger = [{ key: 'pw', label: 'password', value: 'Tiger@123', tier: 'never' as const }];
  it.each([
    'Sunflower at ninety-nine',
    'Sunflower ninety nine',
    'Sunflower at the rate 99',
    'It is sunflower at the rate of ninety nine.',
    'Sunflower at nine nine',
  ])('%s is blocked', (text) => {
    const r = scanOutbound(text, sunflower);
    expect(r.allowed).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain('never_fact');
  });

  it.each(['tiger at the rate 123', 'Tiger at one twenty three', 'tiger at one hundred twenty three', 'Tiger one two three'])(
    '%s is blocked',
    (text) => {
      const r = scanOutbound(text, tiger);
      expect(r.allowed).toBe(false);
      expect(r.reasons.map((x) => x.code)).toContain('never_fact');
    },
  );

  it('unrelated speech is not blocked', () => {
    expect(scanOutbound('The sunflower field is ninety kilometres away.', sunflower).allowed).toBe(true);
  });
});

describe('DLP: postal addresses are not OTPs', () => {
  const addr = [{ key: 'addr', label: 'address', value: '12 MG Road, Bengaluru, PIN 560001', tier: 'confirm' as const, approved: true }];

  it('approved address with PIN postcode is spoken', () => {
    const r = guardUtterance('The technician can visit {{fact:addr}}.', addr);
    expect(r.allowed).toBe(true);
    expect(r.text).toBe('The technician can visit 12 MG Road, Bengaluru, PIN 560001.');
  });

  it.each(['Postal PIN 560001', 'The address is 4 Park Street, Kolkata, PIN 700016.', 'Flat 3, Andheri East, Mumbai - PIN: 400069'])(
    '%s is allowed',
    (text) => {
      expect(scanOutbound(text, []).allowed).toBe(true);
    },
  );

  it.each(['Your PIN 560001 please', 'The OTP, PIN 560001', 'my UPI, PIN 4219'])('%s is still blocked', (text) => {
    expect(scanOutbound(text, []).allowed).toBe(false);
  });

  it('an unapproved address is still withheld', () => {
    const r = guardUtterance('Visit {{fact:addr}}.', [{ ...addr[0]!, approved: false }]);
    expect(r.text).not.toContain('560001');
  });
});

describe('DLP: ticket read-backs next to an OTP refusal', () => {
  const tkt = [{ key: 'tkt', label: 'ticket', value: '482110', tier: 'share' as const }];

  it('substituted share-tier ticket is allowed', () => {
    const r = guardUtterance('Your ticket number is {{fact:tkt}}, and I cannot share the OTP.', tkt);
    expect(r.allowed).toBe(true);
    expect(r.text).toContain('482110');
  });

  it.each([
    'Sure, ticket is 482110 — I cannot share the OTP.',
    'The ticket number is 48211 and the code word was fine.',
    'Your complaint number will be 553201; I cannot read out any OTP.',
  ])('%s is allowed', (text) => {
    expect(scanOutbound(text, []).allowed).toBe(true);
  });

  it('a share value does not clear a longer number containing it', () => {
    expect(scanOutbound('Your OTP is 4821101', [{ key: 'tkt', label: 't', value: '48211', tier: 'share' }]).allowed).toBe(false);
  });

  it('never-tier values are still blocked inside a share value', () => {
    const facts = [
      { key: 'tkt', label: 'ticket', value: 'Ticket 482913 open', tier: 'share' as const },
      { key: 'otp', label: 'otp', value: '482913', tier: 'never' as const },
    ];
    expect(guardUtterance('{{fact:tkt}}', facts).allowed).toBe(false);
  });

  it('OTP keyword without an identifier noun is still blocked', () => {
    expect(scanOutbound('The OTP is 482110.', []).allowed).toBe(false);
    expect(scanOutbound('Your PIN is 4219.', []).allowed).toBe(false);
  });
});

describe('DLP: 12-digit utility account numbers', () => {
  it.each(['Account 234567890123 is the BharatNet account', 'customer ID 234567890123', 'Your account number is 234567890123.'])(
    '%s is allowed',
    (text) => {
      expect(scanOutbound(text, []).allowed).toBe(true);
    },
  );

  it.each(['my number is 2345 6789 0123', 'my number is 234567890123', 'Aadhaar account 234567890123'])('%s is blocked', (text) => {
    const r = scanOutbound(text, []);
    expect(r.allowed).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain('aadhaar');
  });

  it('share-tier account fact read-back is allowed', () => {
    const r = guardUtterance('Your account number is {{fact:acct}}.', [
      { key: 'acct', label: 'account', value: '2345 6789 0123', tier: 'share' },
    ]);
    expect(r.allowed).toBe(true);
  });
});
