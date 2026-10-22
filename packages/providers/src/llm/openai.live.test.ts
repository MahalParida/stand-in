/**
 * Opt-in live test against the OpenAI API: OPENAI_LIVE=1 pnpm test.
 * Reads OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL / OPENAI_REASONING_EFFORT
 * from the environment via parseProvidersEnv (the key is never printed).
 */
import { describe, expect, it } from 'vitest';
import { parseProvidersEnv } from '../env.js';
import { createLlm } from '../factory.js';

const live = process.env.OPENAI_LIVE === '1';

describe.skipIf(!live)('OpenAiProvider (live)', () => {
  const llm = live
    ? createLlm(parseProvidersEnv({ ...process.env, STANDIN_MODE: 'offline', STANDIN_LLM: 'openai', OPENAI_TIMEOUT_MS: '120000' }))
    : undefined;

  it('returns text', async () => {
    if (llm === undefined) return;
    const out = await llm.chat({
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      temperature: 0,
      maxTokens: 16,
    });
    expect(out.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it('returns a JSON object in JSON mode', async () => {
    if (llm === undefined) return;
    const out = await llm.chat({
      messages: [
        { role: 'system', content: 'You output JSON objects of the form {"action": string, "reason": string}.' },
        { role: 'user', content: 'The line is silent. What do you do? Reply in JSON.' },
      ],
      json: true,
      temperature: 0,
      maxTokens: 200,
    });
    const v: unknown = JSON.parse(out);
    expect(typeof v).toBe('object');
  }, 120_000);
});
