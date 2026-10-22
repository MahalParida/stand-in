/**
 * Cost guards on the model-backed sim endpoints: with the hosted demo token
 * public, /sim/api/llm and /sim/api/tts must not turn into an open Bedrock /
 * Polly proxy (spec 13).
 */
import type { ChatRequest, LlmMessage, LlmProvider, LlmToolSpec, SimLlmRequest, TtsProvider, TtsRequest, TtsResult } from '@standin/core';
import { SimLlmResponseSchema } from '@standin/core';
import { afterEach, describe, expect, it } from 'vitest';
import { boundModelRequest, MAX_MODEL_MESSAGES, WindowCap } from './sim-guard.js';
import { startServer, TOKEN, type Started } from './test-helpers.js';

let started: Started[] = [];
afterEach(async () => {
  for (const s of started) await s.close();
  started = [];
});

const OPEN: LlmToolSpec = { name: 'open_case', description: 'Open a case', inputSchema: { type: 'object' } };

class CountingLlm implements LlmProvider {
  readonly name = 'counting';
  readonly seen: ChatRequest[] = [];
  async chat(req: ChatRequest): Promise<string> {
    this.seen.push(req);
    return JSON.stringify({ text: 'Okay.' });
  }
}

class CountingTts implements TtsProvider {
  readonly name = 'counting';
  calls = 0;
  async synthesize(_req: TtsRequest): Promise<TtsResult> {
    this.calls++;
    return { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg' };
  }
}

describe('WindowCap', () => {
  it('allows max per window, then refuses until the window rolls over', () => {
    let now = 0;
    const c = new WindowCap({ max: 2, windowMs: 1000, now: () => now });
    expect([c.take(), c.take(), c.take()]).toEqual([true, true, false]);
    now = 1000;
    expect(c.take()).toBe(true);
    expect(new WindowCap({ max: 0, windowMs: 1000 }).take()).toBe(false);
  });
});

describe('boundModelRequest', () => {
  it('keeps only Stand-In tools and refuses a request with none', () => {
    const req: SimLlmRequest = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [OPEN, OPEN, { name: 'x', description: 'free chatbot', inputSchema: { type: 'object' } }, { ...OPEN, name: 'call_status', description: 'd'.repeat(4000) }],
    };
    const b = boundModelRequest(req);
    expect(b?.tools.map((t) => t.name)).toEqual(['open_case', 'call_status']);
    expect(b?.tools[1]?.description.length).toBe(1000);
    expect(boundModelRequest({ ...req, tools: [{ name: 'x', description: 'y', inputSchema: {} }] })).toBeUndefined();
  });

  it('forwards only the tail of the history, cut at a user turn', () => {
    const messages: LlmMessage[] = [];
    for (let i = 0; i < 60; i++) {
      messages.push(
        { role: 'user', content: `u${i}` },
        { role: 'assistant', content: '', toolCalls: [{ id: `t${i}`, name: 'open_case', arguments: {} }] },
        { role: 'tool', toolCallId: `t${i}`, content: '{}' },
      );
    }
    const b = boundModelRequest({ messages, tools: [OPEN] });
    expect(b?.messages.length).toBeLessThanOrEqual(MAX_MODEL_MESSAGES);
    expect(b?.messages[0]?.role).toBe('user');
    expect(b?.messages.at(-1)).toEqual(messages.at(-1));
    const big = boundModelRequest({ messages: [{ role: 'user', content: 'a'.repeat(20_000) }, { role: 'user', content: 'b'.repeat(20_000) }, { role: 'user', content: 'c'.repeat(20_000) }, { role: 'user', content: 'd'.repeat(20_000) }], tools: [OPEN] }, 40, 50_000);
    expect(big?.messages.map((m) => m.content[0])).toEqual(['c', 'd']);
  });
});

describe('model-backed /sim/api/* behind the public demo token', () => {
  const awsEnv = { STANDIN_MODE: 'aws', AWS_REGION: 'ap-south-1', BEDROCK_MODEL_ID: 'test-model', SQLITE_PATH: ':memory:' };

  it('/sim/api/llm: a strict per-IP bucket and a global budget; over either, the scripted matcher answers and the model is not called', async () => {
    const llm = new CountingLlm();
    const s = await startServer(
      { DEMO_EMBED_TOKEN: 'true', SIM_LLM_RPS: '0.001', SIM_LLM_BURST: '3', SIM_LLM_HOURLY_CAP: '100' },
      { providersEnv: awsEnv, providers: (p) => ({ ...p, llm }) },
    );
    started.push(s);
    const post = (body: unknown): Promise<Response> =>
      fetch(`${s.url}/sim/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    const req: SimLlmRequest = { messages: [{ role: 'user', content: 'My BharatNet broadband is down' }], tools: [OPEN] };

    // Arbitrary tools only: refused before any model call.
    expect((await post({ ...req, tools: [{ name: 'x', description: 'y', inputSchema: { type: 'object' } }] })).status).toBe(400);
    expect(llm.seen).toHaveLength(0);

    const fallbacks: (string | null)[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await post(req);
      expect(r.status).toBe(200);
      SimLlmResponseSchema.parse(await r.json());
      fallbacks.push(r.headers.get('x-standin-fallback'));
    }
    expect(llm.seen).toHaveLength(3);
    expect(fallbacks.slice(3)).toEqual(['scripted-limit', 'scripted-limit', 'scripted-limit']);
  });

  it('/sim/api/llm: the global hourly budget holds across clients', async () => {
    const llm = new CountingLlm();
    const s = await startServer({ SIM_LLM_HOURLY_CAP: '2' }, { providersEnv: awsEnv, providers: (p) => ({ ...p, llm }) });
    started.push(s);
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${s.url}/sim/api/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], tools: [OPEN] }),
      });
      expect(r.status).toBe(200);
    }
    expect(llm.seen).toHaveLength(2);
  });

  it('/sim/api/tts: over the per-IP bucket Polly is not called; 204 sends the page to browser speech', async () => {
    const tts = new CountingTts();
    const s = await startServer({ SIM_TTS_RPS: '0.001', SIM_TTS_BURST: '2' }, { providersEnv: awsEnv, providers: (p) => ({ ...p, tts }) });
    started.push(s);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${s.url}/sim/api/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text: 'Please hold.', voice: 'ivr' }),
      });
      statuses.push(r.status);
      await r.arrayBuffer();
    }
    expect(statuses).toEqual([200, 200, 204, 204]);
    expect(tts.calls).toBe(2);
  });
});
