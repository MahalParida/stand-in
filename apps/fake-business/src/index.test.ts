import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@standin/fake-business', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@standin/fake-business');
  });
});
