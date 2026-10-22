import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256.js';

const nodeSha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('sha256Hex (pure TS)', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches node:crypto across block boundaries and non-ASCII input', () => {
    const inputs = ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(1000), 'नमस्ते ₹499 🙂', '{"a":1}'];
    for (const s of inputs) expect(sha256Hex(s), s.slice(0, 10)).toBe(nodeSha(s));
  });
});
