import { describe, expect, it } from 'vitest';
import { LlmProviderError, LlmTimeoutError } from './json.js';
import { OPENAI_REASONING_HEADROOM_TOKENS, OpenAiProvider, type FetchLike, type OpenAiOptions } from './openai.js';

/** A synthetic never-tier-looking value; it must not appear in any error. */
const SECRET = '482913';
const KEY = 'sk-test-not-a-real-key';

interface Captured {
  url: string;
  init: RequestInit;
}

function mockFetch(respond: (c: Captured) => Response | Promise<Response>): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const c = { url, init };
      calls.push(c);
      return respond(c);
    },
  };
}

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const bodyOf = (c: Captured | undefined): Record<string, unknown> => {
  if (c === undefined || typeof c.init.body !== 'string') throw new Error('no body');
  const v: unknown = JSON.parse(c.init.body);
  if (typeof v !== 'object' || v === null) throw new Error('bad body');
  return v as Record<string, unknown>;
};

const make = (o: Partial<OpenAiOptions> = {}) => new OpenAiProvider({ model: 'test-model', apiKey: KEY, ...o });

describe('OpenAiProvider', () => {
  it('POSTs a chat completion with a Bearer key and max_completion_tokens', async () => {
    const m = mockFetch(() => completion('hi there'));
    const llm = make({ baseUrl: 'https://example.test/v1/', fetch: m.fetch });
    expect(llm.name).toBe('openai');
    const out = await llm.chat({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
      temperature: 0.2,
      maxTokens: 64,
    });
    expect(out).toBe('hi there');
    expect(m.calls[0]?.url).toBe('https://example.test/v1/chat/completions');
    expect(m.calls[0]?.init.method).toBe('POST');
    expect(m.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect((m.calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = bodyOf(m.calls[0]);
    expect(body).toMatchObject({
      model: 'test-model',
      stream: false,
      temperature: 0.2,
      max_completion_tokens: 64,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.response_format).toBeUndefined();
  });

  it('defaults to the OpenAI API base URL', async () => {
    const m = mockFetch(() => completion('ok'));
    await make({ fetch: m.fetch }).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(m.calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('requires a model and an API key', () => {
    expect(() => new OpenAiProvider({ model: '', apiKey: KEY })).toThrow();
    expect(() => new OpenAiProvider({ model: 'm', apiKey: '' })).toThrow();
  });

  it('uses JSON mode via response_format and strips fences', async () => {
    const m = mockFetch(() => completion('```json\n{"action":"wait","reason":"x"}\n```'));
    const out = await make({ fetch: m.fetch }).chat({ messages: [{ role: 'user', content: 'plan' }], json: true });
    expect(JSON.parse(out)).toEqual({ action: 'wait', reason: 'x' });
    expect(bodyOf(m.calls[0]).response_format).toEqual({ type: 'json_object' });
  });

  it('reasoning models: sends reasoning_effort, omits temperature, adds completion headroom', async () => {
    const m = mockFetch(() => completion('{}'));
    const p = make({ openaiReasoningEffort: 'minimal', fetch: m.fetch });
    await p.chat({ messages: [{ role: 'user', content: 'json' }], temperature: 0, seed: 3, maxTokens: 400 });
    const body = bodyOf(m.calls[0]);
    expect(body.reasoning_effort).toBe('minimal');
    expect(body).not.toHaveProperty('temperature');
    expect(body.seed).toBe(3);
    expect(body.max_completion_tokens).toBe(400 + OPENAI_REASONING_HEADROOM_TOKENS);
  });

  it('maps HTTP errors without echoing prompt or response text', async () => {
    const m = mockFetch(() => new Response(`echo: ${SECRET}`, { status: 500 }));
    const err: unknown = await make({ fetch: m.fetch })
      .chat({ messages: [{ role: 'user', content: `otp ${SECRET}` }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(String(err)).toContain('HTTP 500');
    expect(String(err)).not.toContain(SECRET);
  });

  it('never echoes the API key in errors', async () => {
    const m = mockFetch(() => new Response(`bad key ${KEY}`, { status: 401 }));
    const err = await make({ fetch: m.fetch })
      .chat({ messages: [{ role: 'user', content: 'hi' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(String(err)).not.toContain(KEY);
  });

  it('rejects unexpected response shapes', async () => {
    const m = mockFetch(() => new Response(JSON.stringify({ nope: SECRET }), { status: 200 }));
    const err: unknown = await make({ fetch: m.fetch })
      .chat({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(String(err)).not.toContain(SECRET);
  });

  it('wraps network failures', async () => {
    const llm = make({
      fetch: async () => {
        throw new TypeError(`fetch failed ${SECRET} ${KEY}`);
      },
    });
    const err: unknown = await llm.chat({ messages: [{ role: 'user', content: 'x' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(String(err)).not.toContain(SECRET);
    expect(String(err)).not.toContain(KEY);
  });

  it('aborts after timeoutMs', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const llm = make({ fetch: hang, timeoutMs: 20 });
    await expect(llm.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('rejects an invalid base URL at construction', () => {
    expect(() => make({ baseUrl: 'not a url' })).toThrow();
  });
});

describe('OpenAiProvider seed (seeded eval runs)', () => {
  it('passes seed and temperature through, and omits seed when not given', async () => {
    const m = mockFetch(() => completion('{}'));
    const llm = make({ fetch: m.fetch });
    await llm.chat({ messages: [{ role: 'user', content: 'x' }], json: true, temperature: 0.3, seed: 4 });
    await llm.chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(bodyOf(m.calls[0])).toMatchObject({ seed: 4, temperature: 0.3 });
    expect(bodyOf(m.calls[1])).not.toHaveProperty('seed');
  });
});
