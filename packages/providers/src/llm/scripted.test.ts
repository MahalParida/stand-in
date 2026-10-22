import { describe, expect, it } from 'vitest';
import {
  INVALID_JSON_OUTPUT,
  ScriptExhaustedError,
  ScriptedLlmError,
  ScriptedLlmProvider,
  defaultOfflineScript,
} from './scripted.js';

const user = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

describe('ScriptedLlmProvider', () => {
  it('returns queued steps in order and records requests', async () => {
    const llm = new ScriptedLlmProvider({
      script: ['hello', { kind: 'text', text: 'world' }, { kind: 'json', value: { action: 'wait', reason: 'r' } }],
    });
    expect(await llm.chat(user('a'))).toBe('hello');
    expect(await llm.chat(user('b'))).toBe('world');
    expect(JSON.parse(await llm.chat(user('c')))).toEqual({ action: 'wait', reason: 'r' });
    expect(llm.requests.map((r) => r.messages[0]?.content)).toEqual(['a', 'b', 'c']);
    expect(llm.remaining).toBe(0);
  });

  it('throws when the queue is exhausted and no fallback is set', async () => {
    const llm = new ScriptedLlmProvider({ script: [] });
    await expect(llm.chat(user('x'))).rejects.toBeInstanceOf(ScriptExhaustedError);
  });

  it('uses the fallback after the queue', async () => {
    const llm = new ScriptedLlmProvider({ script: ['one'], fallback: 'again' });
    expect(await llm.chat(user('x'))).toBe('one');
    expect(await llm.chat(user('x'))).toBe('again');
    expect(await llm.chat(user('x'))).toBe('again');
  });

  it('accepts a function of the request', async () => {
    const llm = new ScriptedLlmProvider({
      script: (req, i) => `${i}:${req.messages.at(-1)?.content ?? ''}:${req.json === true ? 'json' : 'text'}`,
    });
    expect(await llm.chat(user('hi'))).toBe('0:hi:text');
    expect(await llm.chat({ ...user('yo'), json: true })).toBe('1:yo:json');
  });

  it('injects invalid JSON (S8) ahead of the queue', async () => {
    const llm = new ScriptedLlmProvider({ script: ['{"ok":true}'] });
    llm.injectInvalidJson();
    const bad = await llm.chat({ ...user('x'), json: true });
    expect(bad).toBe(INVALID_JSON_OUTPUT);
    expect(() => JSON.parse(bad)).toThrow();
    expect(JSON.parse(await llm.chat(user('x')))).toEqual({ ok: true });
  });

  it('supports explicit invalid_json and error steps', async () => {
    const llm = new ScriptedLlmProvider({
      script: [{ kind: 'invalid_json', text: 'not json at all' }, { kind: 'error', message: 'boom' }],
    });
    expect(await llm.chat(user('x'))).toBe('not json at all');
    await expect(llm.chat(user('x'))).rejects.toBeInstanceOf(ScriptedLlmError);
  });

  it('validates requests with zod', async () => {
    const llm = new ScriptedLlmProvider({ script: ['x'] });
    await expect(llm.chat({ messages: [] })).rejects.toThrow();
  });

  it('defaultOfflineScript yields schema-shaped JSON in json mode', async () => {
    const llm = new ScriptedLlmProvider({ script: defaultOfflineScript });
    expect(JSON.parse(await llm.chat({ ...user('x'), json: true }))).toMatchObject({ action: 'wait' });
    expect(await llm.chat(user('x'))).toBe('Okay.');
  });
});
