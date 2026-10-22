import { describe, expect, it } from 'vitest';
import { LlmProviderError, LlmTimeoutError } from './json.js';
import { LocalLlmProvider, type FetchLike } from './localllm.js';

/** A synthetic never-tier-looking value; it must not appear in any error. */
const SECRET = '482913';

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

describe('LocalLlmProvider', () => {
  it('POSTs an OpenAI-compatible chat completion to the base URL', async () => {
    const m = mockFetch(() => completion('hi there'));
    const llm = new LocalLlmProvider({ baseUrl: 'http://localhost:11434/v1/', model: 'test-model', fetch: m.fetch });
    const out = await llm.chat({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
      temperature: 0.2,
      maxTokens: 64,
    });
    expect(out).toBe('hi there');
    expect(m.calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(m.calls[0]?.init.method).toBe('POST');
    expect(m.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    const body = bodyOf(m.calls[0]);
    expect(body).toMatchObject({
      model: 'test-model',
      stream: false,
      reasoning_effort: 'none',
      temperature: 0.2,
      max_tokens: 64,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(body.response_format).toBeUndefined();
  });

  it('defaults to local-model', () => {
    expect(new LocalLlmProvider().model).toBe('local-model');
  });

  it('uses JSON mode via response_format and strips fences', async () => {
    const m = mockFetch(() => completion('```json\n{"action":"wait","reason":"x"}\n```'));
    const llm = new LocalLlmProvider({ fetch: m.fetch });
    const out = await llm.chat({ messages: [{ role: 'user', content: 'plan' }], json: true });
    expect(JSON.parse(out)).toEqual({ action: 'wait', reason: 'x' });
    expect(bodyOf(m.calls[0]).response_format).toEqual({ type: 'json_object' });
  });

  it('maps HTTP errors without echoing prompt or response text', async () => {
    const m = mockFetch(() => new Response(`echo: ${SECRET}`, { status: 500 }));
    const llm = new LocalLlmProvider({ fetch: m.fetch });
    const err: unknown = await llm.chat({ messages: [{ role: 'user', content: `otp ${SECRET}` }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(String(err)).toContain('HTTP 500');
    expect(String(err)).not.toContain(SECRET);
  });

  it('rejects unexpected response shapes', async () => {
    const m = mockFetch(() => new Response(JSON.stringify({ nope: SECRET }), { status: 200 }));
    const llm = new LocalLlmProvider({ fetch: m.fetch });
    const err: unknown = await llm.chat({ messages: [{ role: 'user', content: 'x' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(String(err)).not.toContain(SECRET);
  });

  it('wraps network failures', async () => {
    const llm = new LocalLlmProvider({
      fetch: async () => {
        throw new TypeError(`fetch failed ${SECRET}`);
      },
    });
    const err: unknown = await llm.chat({ messages: [{ role: 'user', content: 'x' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(String(err)).not.toContain(SECRET);
  });

  it('aborts after timeoutMs', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const llm = new LocalLlmProvider({ fetch: hang, timeoutMs: 20 });
    await expect(llm.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('rejects an invalid base URL at construction', () => {
    expect(() => new LocalLlmProvider({ baseUrl: 'not a url' })).toThrow();
  });
});
