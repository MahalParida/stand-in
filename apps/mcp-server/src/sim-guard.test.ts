/**
 * Cost guards on the model-backed sim endpoints: with the hosted demo token
 * public, /sim/api/llm and /sim/api/tts must not turn into an open Bedrock /
 * Polly proxy (spec 13).
 */
import type { ChatRequest, LlmMessage, LlmProvider, LlmToolSpec, SimLlmRequest, TtsProvider, TtsRequest, TtsResult } from '@standin/core';
import { MAX_TOOL_INPUT_SCHEMA_CHARS, SIM_TTS_MAX_CHARS, SimLlmResponseSchema } from '@standin/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetedLlm, boundModelRequest, MAX_MODEL_MESSAGES, MAX_MODEL_TOOL_CHARS, takeBudget, takeBudgets, UtcDayCap, WindowCap } from './sim-guard.js';
import { parseServerEnv } from './config.js';
import { buildToolChatRequest, llmOrchestrator } from './orchestrator.js';
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

  it('drops a tool whose inputSchema is oversized and refuses a tool payload over MAX_MODEL_TOOL_CHARS', () => {
    const msg: LlmMessage[] = [{ role: 'user', content: 'hi' }];
    // Bypasses the zod refinement on purpose: boundModelRequest must hold on its own.
    const fat: LlmToolSpec = { name: 'open_case', description: 'x', inputSchema: { type: 'object', description: 'x'.repeat(1_000_000) } };
    expect(boundModelRequest({ messages: msg, tools: [fat] })).toBeUndefined();
    const kept = boundModelRequest({ messages: msg, tools: [fat, { ...OPEN, name: 'place_call' }] });
    expect(kept?.tools.map((t) => t.name)).toEqual(['place_call']);
    // Many known tools each just under the per-schema limit: over the total tool budget.
    const names = ['open_case', 'update_case_fact', 'place_call', 'call_status', 'send_to_call', 'handoff_to_user', 'end_call', 'get_case'];
    const near: LlmToolSpec[] = names.map((name) => ({ name, description: 'd', inputSchema: { d: 'x'.repeat(MAX_TOOL_INPUT_SCHEMA_CHARS - 8) } }));
    expect(near.length * MAX_TOOL_INPUT_SCHEMA_CHARS).toBeGreaterThan(MAX_MODEL_TOOL_CHARS);
    expect(boundModelRequest({ messages: msg, tools: near })).toBeUndefined();
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

describe('UtcDayCap / takeBudget (M5 daily spend caps)', () => {
  it('counts per UTC calendar day and resets at 00:00 UTC, not at local midnight', () => {
    let now = Date.parse('2026-10-22T23:59:00Z'); // 05:29 IST on the 23rd
    const c = new UtcDayCap({ max: 2, now: () => now });
    expect([c.take(), c.take(), c.take()]).toEqual([true, true, false]);
    expect(c.day).toBe('2026-10-22');
    now = Date.parse('2026-10-23T00:00:01Z');
    expect(c.canTake()).toBe(true);
    expect(c.used).toBe(0);
    expect(c.take()).toBe(true);
    expect(new UtcDayCap({ max: 0 }).take()).toBe(false);
  });

  it('takes from both budgets or neither, checking the daily one first', () => {
    const daily = new UtcDayCap({ max: 1, now: () => 0 });
    const hourly = new WindowCap({ max: 5, windowMs: 1000, now: () => 0 });
    expect(takeBudget(daily, hourly)).toBe('ok');
    expect(takeBudget(daily, hourly)).toBe('daily');
    expect(hourly.used).toBe(1);
    const d2 = new UtcDayCap({ max: 5, now: () => 0 });
    const h2 = new WindowCap({ max: 0, windowMs: 1000, now: () => 0 });
    expect(takeBudget(d2, h2)).toBe('hourly');
    expect(d2.used).toBe(0);
  });

  it('config defaults: SIM_LLM_DAILY_CAP=400, SIM_TTS_DAILY_CAP=1000, transcript TTL 30 days', () => {
    const env = parseServerEnv({ STANDIN_TOKEN: TOKEN });
    expect(env.SIM_LLM_DAILY_CAP).toBe(400);
    expect(env.SIM_TTS_DAILY_CAP).toBe(1000);
    expect(env.SIM_TTS_DAILY_CHAR_CAP).toBe(50_000);
    expect(env.SIM_TTS_HOURLY_CHAR_CAP).toBe(15_000);
    expect(env.TRANSCRIPT_TTL_DAYS).toBe(30);
    expect(parseServerEnv({ STANDIN_TOKEN: TOKEN, SIM_LLM_DAILY_CAP: '', SIM_TTS_DAILY_CAP: '7' }).SIM_TTS_DAILY_CAP).toBe(7);
    expect(() => parseServerEnv({ STANDIN_TOKEN: TOKEN, SIM_LLM_DAILY_CAP: '-1' })).toThrow(/SIM_LLM_DAILY_CAP/);
  });
});

describe('unit-metered budgets', () => {
  it('take(units) takes all or nothing; takeBudgets is atomic across pairs', () => {
    const c = new WindowCap({ max: 10, windowMs: 1000, now: () => 0 });
    expect(c.take(7)).toBe(true);
    expect(c.take(4)).toBe(false);
    expect(c.used).toBe(7);
    const req = { daily: new UtcDayCap({ max: 100, now: () => 0 }), hourly: new WindowCap({ max: 100, windowMs: 1000, now: () => 0 }) };
    const chars = { daily: new UtcDayCap({ max: 1000, now: () => 0 }), hourly: new WindowCap({ max: 1000, windowMs: 1000, now: () => 0 }) };
    expect(takeBudgets([req, chars], [1, 600])).toBe('ok');
    expect(takeBudgets([req, chars], [1, 600])).toBe('daily');
    // The refused request took nothing from the request budget either.
    expect(req.daily.used).toBe(1);
    expect(req.hourly.used).toBe(1);
    expect(chars.daily.used).toBe(600);
  });
});

describe('daily caps on /sim/api/* (process-wide, per UTC day)', () => {
  const awsEnv = { STANDIN_MODE: 'aws', AWS_REGION: 'ap-south-1', BEDROCK_MODEL_ID: 'test-model', SQLITE_PATH: ':memory:' };
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'My BharatNet broadband is down, sort it out' }], tools: [OPEN] });

  it('/sim/api/llm: after SIM_LLM_DAILY_CAP model calls the scripted orchestrator answers, flagged for the UI, until 00:00 UTC', async () => {
    const llm = new CountingLlm();
    let now = Date.parse('2026-10-22T20:00:00Z');
    const s = await startServer({ SIM_LLM_DAILY_CAP: '2', SIM_LLM_HOURLY_CAP: '100' }, { providersEnv: awsEnv, providers: (p) => ({ ...p, llm }), now: () => now });
    started.push(s);
    const post = (): Promise<Response> =>
      fetch(`${s.url}/sim/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body });
    const budget: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await post();
      expect(r.status).toBe(200);
      const out = SimLlmResponseSchema.parse(await r.json());
      budget.push(r.headers.get('x-standin-budget'));
      // The scripted fallback still drives the demo (opens the case).
      if (i >= 2) expect(out.toolCalls?.[0]?.name).toBe('open_case');
    }
    expect(llm.seen).toHaveLength(2);
    expect(budget).toEqual([null, null, 'llm-daily', 'llm-daily']);
    now = Date.parse('2026-10-23T00:00:05Z');
    const next = await post();
    expect(next.headers.get('x-standin-budget')).toBeNull();
    expect(llm.seen).toHaveLength(3);
  });

  it('/sim/api/tts: after SIM_TTS_DAILY_CAP Polly requests it returns 204 (browser voice) with the budget header', async () => {
    const tts = new CountingTts();
    const s = await startServer({ SIM_TTS_DAILY_CAP: '1' }, { providersEnv: awsEnv, providers: (p) => ({ ...p, tts }), now: () => Date.parse('2026-10-22T10:00:00Z') });
    started.push(s);
    const res: [number, string | null][] = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${s.url}/sim/api/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text: 'Please hold.', voice: 'ivr' }),
      });
      await r.arrayBuffer();
      res.push([r.status, r.headers.get('x-standin-budget')]);
    }
    expect(res).toEqual([
      [200, null],
      [204, 'tts-daily'],
      [204, 'tts-daily'],
    ]);
    expect(tts.calls).toBe(1);
  });

  it('/sim/api/tts is metered in characters: SIM_TTS_DAILY_CHAR_CAP stops Polly long before the request cap', async () => {
    const tts = new CountingTts();
    const s = await startServer(
      { SIM_TTS_DAILY_CAP: '1000', SIM_TTS_DAILY_CHAR_CAP: '1000', SIM_TTS_HOURLY_CHAR_CAP: '100000', SIM_TTS_RPS: '100', SIM_TTS_BURST: '100' },
      { providersEnv: awsEnv, providers: (p) => ({ ...p, tts }), now: () => Date.parse('2026-10-22T10:00:00Z') },
    );
    started.push(s);
    const post = async (text: string): Promise<[number, string | null]> => {
      const r = await fetch(`${s.url}/sim/api/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ text, voice: 'standin' }),
      });
      await r.arrayBuffer();
      return [r.status, r.headers.get('x-standin-budget')];
    };
    const long = 'a'.repeat(SIM_TTS_MAX_CHARS);
    expect(await post(long)).toEqual([200, null]);
    // 600 + 600 > 1000 chars: refused, browser voice.
    expect(await post(long)).toEqual([204, 'tts-daily']);
    // A short line still fits the remaining 400 chars.
    expect(await post('Please hold.')).toEqual([200, null]);
    expect(tts.calls).toBe(2);
    // Over the per-request text limit: rejected before anything is metered or billed.
    expect((await post('a'.repeat(3000)))[0]).toBe(400);
    expect(tts.calls).toBe(2);
  });

  it('/sim/api/llm rejects an oversized tool inputSchema with 400 and never calls the model', async () => {
    const llm = new CountingLlm();
    const s = await startServer({}, { providersEnv: awsEnv, providers: (p) => ({ ...p, llm }) });
    started.push(s);
    const r = await fetch(`${s.url}/sim/api/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'open_case', description: 'x', inputSchema: { type: 'object', description: 'x'.repeat(900_000) } }],
      }),
    });
    expect(r.status).toBe(400);
    await r.arrayBuffer();
    expect(llm.seen).toHaveLength(0);
  });

  it('the hourly cap is flagged the same way', async () => {
    const llm = new CountingLlm();
    const s = await startServer({ SIM_LLM_HOURLY_CAP: '1' }, { providersEnv: awsEnv, providers: (p) => ({ ...p, llm }) });
    started.push(s);
    const hdrs: (string | null)[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${s.url}/sim/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body });
      await r.json();
      hdrs.push(r.headers.get('x-standin-budget'));
    }
    expect(hdrs).toEqual([null, 'llm-hourly']);
  });
});

describe('orchestrator output-token cap (Bedrock maxTokens <= 512)', () => {
  it('native tool-use and JSON-prompt requests ask for at most 512 tokens', async () => {
    const req: SimLlmRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [OPEN] };
    expect(buildToolChatRequest(req, []).maxTokens).toBeLessThanOrEqual(512);
    const llm = new CountingLlm();
    await llmOrchestrator(llm, req, { now: new Date(), businesses: [], never: [] });
    expect(llm.seen[0]?.maxTokens).toBeLessThanOrEqual(512);
  });
});


describe('BudgetedLlm (call planner shares the global LLM budget)', () => {
  const llm = (name: string, calls: string[]): LlmProvider => ({
    name,
    chat: async (_req: ChatRequest) => {
      calls.push(name);
      return name;
    },
  });

  it('uses the primary model until the shared daily cap is spent, then the scripted fallback', async () => {
    const calls: string[] = [];
    const budget = { daily: new UtcDayCap({ max: 2 }), hourly: new WindowCap({ max: 100, windowMs: 3_600_000 }) };
    const planner = new BudgetedLlm(llm('bedrock', calls), budget, llm('scripted', calls));
    const req: ChatRequest = { messages: [{ role: 'user', content: 'x' }] };
    // A /sim/api/llm request spends from the same pair.
    expect(takeBudget(budget.daily, budget.hourly)).toBe('ok');
    expect(await planner.chat(req)).toBe('bedrock');
    expect(await planner.chat(req)).toBe('scripted');
    expect(await planner.chat(req)).toBe('scripted');
    expect(calls).toEqual(['bedrock', 'scripted', 'scripted']);
    expect(budget.daily.used).toBe(2);
  });

  it('respects the hourly cap too', async () => {
    const calls: string[] = [];
    const budget = { daily: new UtcDayCap({ max: 100 }), hourly: new WindowCap({ max: 1, windowMs: 3_600_000 }) };
    const planner = new BudgetedLlm(llm('bedrock', calls), budget, llm('scripted', calls));
    const req: ChatRequest = { messages: [{ role: 'user', content: 'x' }] };
    await planner.chat(req);
    await planner.chat(req);
    expect(calls).toEqual(['bedrock', 'scripted']);
  });
});
