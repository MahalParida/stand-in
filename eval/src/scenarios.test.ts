import { describe, expect, it } from 'vitest';
import { listScenarioFiles } from './scenarios.js';

describe('@standin/eval', () => {
  it('lists scenario files in data/scenarios', async () => {
    const files = await listScenarioFiles(new URL('../../data/scenarios/', import.meta.url));
    expect(Array.isArray(files)).toBe(true);
  });
});
