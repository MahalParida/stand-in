import { describe, expect, it } from 'vitest';
import {
  BlockedRecordSchema,
  DEFAULT_FALLBACK_UTTERANCE,
  GuardResultSchema,
  guardUtterance,
  mask,
  MASK,
} from './index.js';
import { FACTS } from './testing/fixtures.js';

describe('guardUtterance', () => {
  it('passes a safe template through expand', () => {
    const r = guardUtterance('Hi, calling for {{fact:name}} about {{fact:order_id}}.', FACTS);
    expect(r).toEqual({ allowed: true, text: 'Hi, calling for Asha Rao about OD12345.', withheld: [] });
    expect(GuardResultSchema.parse(r)).toEqual(r);
  });

  it('withholds a never fact referenced by template without blocking', () => {
    const r = guardUtterance('The OTP is {{fact:otp}}.', FACTS);
    expect(r.allowed).toBe(true);
    expect(r.text).not.toContain('482911');
    expect(r.withheld).toEqual(['otp']);
  });

  it('blocks when the LLM writes a never value literally', () => {
    const r = guardUtterance('Sure, the OTP is four eight two nine one one.', FACTS);
    expect(r.allowed).toBe(false);
    expect(r.text).toBe(DEFAULT_FALLBACK_UTTERANCE);
    if (r.allowed) throw new Error('unreachable');
    expect(BlockedRecordSchema.parse(r.blocked).type).toBe('blocked_utterance');
    expect(r.blocked.reasons.map((x) => x.code)).toContain('never_fact');
    expect(r.blocked.redacted).not.toMatch(/four eight two/i);
  });

  it('blocks a pattern hit even with no facts', () => {
    const r = guardUtterance('Card is 4111-1111-1111-1111', []);
    expect(r.allowed).toBe(false);
    expect(r.text).not.toContain('4111');
  });

  it('uses a custom fallback utterance', () => {
    const r = guardUtterance('PIN 4219', FACTS, { fallbackUtterance: 'Let me check with Asha.' });
    expect(r.text).toBe('Let me check with Asha.');
  });

  it('never throws on invalid input; returns a blocked fallback', () => {
    const r = guardUtterance(42 as unknown as string, FACTS);
    expect(r.allowed).toBe(false);
    if (r.allowed) throw new Error('unreachable');
    expect(r.blocked.reasons[0]?.code).toBe('invalid_input');
    expect(r.blocked.redacted).toBe(MASK);
  });

  it('confirm-tier approved fact is spoken, unapproved is withheld', () => {
    const ok = guardUtterance('Email {{fact:email}}', FACTS);
    expect(ok.allowed && ok.text).toBe('Email asha@example.com');
    const no = guardUtterance('Phone {{fact:reg_phone}}', FACTS);
    expect(no.withheld).toEqual(['reg_phone']);
    expect(no.text).not.toContain('98765');
  });
});

describe('mask', () => {
  it('masks never values and pattern hits for transcript storage', () => {
    const out = mask('Your OTP is 482911 and card 5555 5555 5555 4444, PIN four two one nine.', FACTS);
    expect(out).toBe(`Your OTP is ${MASK} and card ${MASK}, PIN ${MASK}.`);
  });

  it('masks Aadhaar and passwords said by the callee', () => {
    expect(mask('Aadhaar 2345 6789 0123 noted', [])).toBe(`Aadhaar ${MASK} noted`);
    expect(mask('the password is hunter2.', [])).toBe(`the password is ${MASK}.`);
  });

  it('does not mask share values, confirm values, order or ticket IDs', () => {
    const t = 'Asha Rao, order OD12345, ticket SR-48211, phone 98765 00000';
    expect(mask(t, FACTS)).toBe(t);
  });
});
