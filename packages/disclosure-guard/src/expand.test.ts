import { describe, expect, it } from 'vitest';
import { DEFAULT_HANDOFF_PHRASE, expand, MALFORMED_KEY, PACKAGE_NAME } from './index.js';
import { FACTS } from './testing/fixtures.js';

describe('package', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@standin/disclosure-guard');
  });
});

describe('expand', () => {
  it('substitutes share facts', () => {
    const r = expand('Calling for {{fact:name}} about {{fact:order_id}}.', FACTS);
    expect(r.text).toBe('Calling for Asha Rao about OD12345.');
    expect(r.withheld).toEqual([]);
  });

  it('substitutes approved confirm facts', () => {
    const r = expand('Email is {{fact:email}}', FACTS);
    expect(r.text).toBe('Email is asha@example.com');
    expect(r.withheld).toEqual([]);
  });

  it('withholds unapproved confirm facts', () => {
    const r = expand('Phone is {{fact:reg_phone}}', FACTS);
    expect(r.text).toBe(`Phone is ${DEFAULT_HANDOFF_PHRASE}`);
    expect(r.text).not.toContain('98765');
    expect(r.withheld).toEqual(['reg_phone']);
  });

  it('withholds never facts even when approved=true', () => {
    const r = expand('Password: {{fact:password}}', FACTS);
    expect(r.text).not.toContain('Sunflower');
    expect(r.withheld).toEqual(['password']);
  });

  it('withholds unknown keys', () => {
    const r = expand('Account {{fact:account_no}}', FACTS);
    expect(r.text).toBe(`Account ${DEFAULT_HANDOFF_PHRASE}`);
    expect(r.withheld).toEqual(['account_no']);
  });

  it('tolerates whitespace inside placeholders', () => {
    expect(expand('Hi {{ fact : name }}', FACTS).text).toBe('Hi Asha Rao');
  });

  it('reports each withheld key once', () => {
    const r = expand('{{fact:otp}} {{fact:otp}} {{fact:pin}}', FACTS);
    expect(r.withheld).toEqual(['otp', 'pin']);
  });

  it('uses a custom hand-off phrase', () => {
    const r = expand('PIN {{fact:pin}}', FACTS, { handoffPhrase: 'that is for Asha to share' });
    expect(r.text).toBe('PIN that is for Asha to share');
  });

  it('never speaks malformed placeholders raw', () => {
    const r = expand('Code {{fact:bad key}} and {{otp}}', FACTS);
    expect(r.text).not.toContain('{{');
    expect(r.withheld).toEqual([MALFORMED_KEY]);
  });

  it('does not re-expand placeholders inside fact values', () => {
    const facts = [
      { key: 'note', label: 'Note', value: '{{fact:otp}}', tier: 'share' as const, approved: false },
      ...FACTS,
    ];
    const r = expand('{{fact:note}}', facts);
    expect(r.text).toBe('{{fact:otp}}');
    expect(r.text).not.toContain('482911');
  });

  it('on duplicate keys the most restrictive entry wins', () => {
    const facts = [
      { key: 'x', label: 'X', value: '7777', tier: 'never' as const, approved: false },
      { key: 'x', label: 'X', value: '7777', tier: 'share' as const, approved: false },
    ];
    expect(expand('{{fact:x}}', facts).withheld).toEqual(['x']);
  });

  it('rejects invalid facts at the boundary', () => {
    const bad = [{ key: 'a b', label: 'x', value: '1', tier: 'share' }] as unknown as typeof FACTS;
    expect(() => expand('hi', bad)).toThrow();
    const badTier = [{ key: 'a', label: 'x', value: '1', tier: 'secret' }] as unknown as typeof FACTS;
    expect(() => expand('hi', badTier)).toThrow();
  });
});
