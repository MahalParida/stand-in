import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@standin/call-agent', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@standin/call-agent');
  });
});
