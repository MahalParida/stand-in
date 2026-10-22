import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, TierSchema } from './index.js';

describe('@standin/core', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@standin/core');
  });

  it('validates disclosure tiers', () => {
    expect(TierSchema.parse('never')).toBe('never');
    expect(TierSchema.safeParse('sometimes').success).toBe(false);
  });
});
