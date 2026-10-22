/**
 * Opt-in live test against a local LocalLlm: LOCAL_LLM_LIVE=1 pnpm test.
 * Uses LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL from the environment (defaults otherwise).
 */
import { describe, expect, it } from 'vitest';
import { LocalLlmProvider } from './localllm.js';

const live = process.env.LOCAL_LLM_LIVE === '1';

describe.skipIf(!live)('LocalLlmProvider (live)', () => {
  const llm = new LocalLlmProvider({
    ...(process.env.LOCAL_LLM_BASE_URL ? { baseUrl: process.env.LOCAL_LLM_BASE_URL } : {}),
    ...(process.env.LOCAL_LLM_MODEL ? { model: process.env.LOCAL_LLM_MODEL } : {}),
    timeoutMs: 120_000,
  });

  it('returns text', async () => {
    const out = await llm.chat({
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      temperature: 0,
      maxTokens: 16,
    });
    expect(out.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it('returns a JSON object in JSON mode', async () => {
    const out = await llm.chat({
      messages: [
        { role: 'system', content: 'You output JSON objects of the form {"action": string, "reason": string}.' },
        { role: 'user', content: 'The line is silent. What do you do?' },
      ],
      json: true,
      temperature: 0,
    });
    const v: unknown = JSON.parse(out);
    expect(typeof v).toBe('object');
  }, 120_000);
});
