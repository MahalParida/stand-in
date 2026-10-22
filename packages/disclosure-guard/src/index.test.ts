import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@standin/disclosure-guard', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@standin/disclosure-guard');
  });
});
