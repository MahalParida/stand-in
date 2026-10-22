import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import {
  BedrockProvider,
  BrowserTts,
  DynamoRepo,
  OpenAiProvider,
  PACKAGE_NAME,
  PollyTts,
  ProvidersConfigError,
  ScriptedLlmProvider,
  SqliteRepo,
  createProviders,
  parseProvidersEnv,
} from './index.js';

const AWS_ENV = {
  STANDIN_MODE: 'aws',
  AWS_REGION: 'ap-south-1',
  BEDROCK_MODEL_ID: 'test-model-id',
};

describe('@standin/providers', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@standin/providers');
  });
});

describe('parseProvidersEnv', () => {
  it('offline needs no variables at all', () => {
    const c = parseProvidersEnv({});
    expect(c).toMatchObject({
      STANDIN_MODE: 'offline',
      STANDIN_LLM: 'scripted',
      STANDIN_REPO: 'sqlite',
      SQLITE_PATH: ':memory:',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_REASONING_EFFORT: 'off',
      POLLY_VOICE: 'Kajal',
    });
    expect(c.AWS_REGION).toBeUndefined();
    expect(c.OPENAI_API_KEY).toBeUndefined();
    expect(c.OPENAI_MODEL).toBeUndefined();
  });

  it('treats empty strings (KEY= in .env) as unset', () => {
    const c = parseProvidersEnv({
      STANDIN_MODE: '',
      BEDROCK_MODEL_ID: '',
      AWS_PROFILE: '',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: ' ',
      OPENAI_BASE_URL: '',
      OPENAI_REASONING_EFFORT: '',
    });
    expect(c.STANDIN_MODE).toBe('offline');
    expect(c.BEDROCK_MODEL_ID).toBeUndefined();
    expect(c.OPENAI_API_KEY).toBeUndefined();
    expect(c.OPENAI_MODEL).toBeUndefined();
    expect(c.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(c.OPENAI_REASONING_EFFORT).toBe('off');
  });

  it('aws mode requires AWS_REGION and BEDROCK_MODEL_ID', () => {
    try {
      parseProvidersEnv({ STANDIN_MODE: 'aws' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProvidersConfigError);
      expect((e as ProvidersConfigError).variables.sort()).toEqual(['AWS_REGION', 'BEDROCK_MODEL_ID']);
    }
  });

  it('names bad variables without echoing their values', () => {
    const bad = 'sk-not-a-real-secret-value';
    try {
      parseProvidersEnv({ STANDIN_MODE: bad });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain('STANDIN_MODE');
      expect(String(e)).not.toContain(bad);
    }
  });

  it('rejects unknown Polly voices and bad OpenAI URLs', () => {
    expect(() => parseProvidersEnv({ POLLY_VOICE: 'Nobody' })).toThrow(ProvidersConfigError);
    expect(() => parseProvidersEnv({ OPENAI_BASE_URL: 'nope' })).toThrow(ProvidersConfigError);
    expect(() => parseProvidersEnv({ STANDIN_LLM: 'local-model' })).toThrow(ProvidersConfigError);
    expect(() => parseProvidersEnv({ OPENAI_REASONING_EFFORT: 'none' })).toThrow(ProvidersConfigError);
  });

  it('STANDIN_LLM=openai requires OPENAI_API_KEY and OPENAI_MODEL, naming them without values', () => {
    try {
      parseProvidersEnv({ STANDIN_LLM: 'openai', OPENAI_API_KEY: '' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProvidersConfigError);
      expect((e as ProvidersConfigError).variables.sort()).toEqual(['OPENAI_API_KEY', 'OPENAI_MODEL']);
    }
    const key = 'sk-not-a-real-secret-value';
    try {
      parseProvidersEnv({ STANDIN_LLM: 'openai', OPENAI_API_KEY: key });
      expect.unreachable();
    } catch (e) {
      expect((e as ProvidersConfigError).variables).toEqual(['OPENAI_MODEL']);
      expect(String(e)).not.toContain(key);
    }
  });
});

describe('createProviders', () => {
  it('offline: scripted LLM, browser TTS, sqlite repo, local scheduler', async () => {
    const p = createProviders({});
    expect(p.mode).toBe('offline');
    expect(p.llm).toBeInstanceOf(ScriptedLlmProvider);
    expect(p.tts).toBeInstanceOf(BrowserTts);
    expect(p.repo).toBeInstanceOf(SqliteRepo);
    const out = await p.llm.chat({ messages: [{ role: 'user', content: 'x' }], json: true });
    expect(JSON.parse(out)).toMatchObject({ action: 'wait' });
    expect(await p.tts.synthesize({ text: 'hello' })).toEqual({});
    await p.scheduler.schedule({ id: 'j', kind: 'followup', caseId: 'c', runAt: '2026-11-12T10:00:00Z', payload: {} });
    expect(await p.repo.listJobs()).toHaveLength(1);
    p.close();
  });

  it('offline + STANDIN_LLM=openai uses OpenAI with env config', async () => {
    let url = '';
    let auth = '';
    let body: Record<string, unknown> = {};
    const p = createProviders(
      {
        STANDIN_LLM: 'openai',
        OPENAI_API_KEY: 'sk-test',
        OPENAI_MODEL: 'm',
        OPENAI_BASE_URL: 'http://127.0.0.1:9999/v1',
        OPENAI_REASONING_EFFORT: 'low',
      },
      {
        fetch: async (u, init) => {
          url = u;
          auth = (init.headers as Record<string, string>).authorization ?? '';
          body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        },
      },
    );
    expect(p.llm).toBeInstanceOf(OpenAiProvider);
    expect(p.llm.name).toBe('openai');
    expect(await p.llm.chat({ messages: [{ role: 'user', content: 'x' }] })).toBe('ok');
    expect(url).toBe('http://127.0.0.1:9999/v1/chat/completions');
    expect(auth).toBe('Bearer sk-test');
    expect(body).toMatchObject({ model: 'm', reasoning_effort: 'low' });
    p.close();
  });

  it('OPENAI_REASONING_EFFORT=off sends no reasoning_effort', async () => {
    let body: Record<string, unknown> = {};
    const p = createProviders(
      { STANDIN_LLM: 'openai', OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'm' },
      {
        fetch: async (_u, init) => {
          body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        },
      },
    );
    await p.llm.chat({ messages: [{ role: 'user', content: 'x' }], temperature: 0.1 });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.temperature).toBe(0.1);
    p.close();
  });

  it('aws mode always uses Bedrock, even with STANDIN_LLM=openai', () => {
    const fetchCalls: string[] = [];
    const p = createProviders(
      { ...AWS_ENV, STANDIN_LLM: 'openai', OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'm' },
      {
        bedrockClient: { send: async () => { throw new Error('unused'); } },
        fetch: async (u) => {
          fetchCalls.push(u);
          return new Response('{}');
        },
      },
    );
    expect(p.llm).toBeInstanceOf(BedrockProvider);
    expect(p.llm).not.toBeInstanceOf(OpenAiProvider);
    p.close();
    // aws mode does not require the OpenAI variables either.
    const q = createProviders({ ...AWS_ENV, STANDIN_LLM: 'openai' });
    expect(q.llm).toBeInstanceOf(BedrockProvider);
    q.close();
    expect(fetchCalls).toEqual([]);
  });

  it('offline accepts a custom script', async () => {
    const p = createProviders({}, { scripted: { script: ['canned'] } });
    expect(await p.llm.chat({ messages: [{ role: 'user', content: 'x' }] })).toBe('canned');
    p.close();
  });

  it('aws: Bedrock LLM and Polly TTS, with injected clients', async () => {
    const out: ConverseCommandOutput = {
      $metadata: {},
      output: { message: { role: 'assistant', content: [{ text: 'from bedrock' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      metrics: { latencyMs: 1 },
    };
    const p = createProviders(
      { ...AWS_ENV, POLLY_VOICE: 'Kajal' },
      {
        bedrockClient: { send: async () => out },
        pollyClient: { send: async () => ({ AudioStream: { transformToByteArray: async () => new Uint8Array([9]) } }) },
      },
    );
    expect(p.mode).toBe('aws');
    expect(p.llm).toBeInstanceOf(BedrockProvider);
    expect((p.llm as BedrockProvider).modelId).toBe('test-model-id');
    expect(p.tts).toBeInstanceOf(PollyTts);
    expect(await p.llm.chat({ messages: [{ role: 'user', content: 'x' }] })).toBe('from bedrock');
    expect((await p.tts.synthesize({ text: 'x' })).audio).toEqual(new Uint8Array([9]));
    expect(p.repo).toBeInstanceOf(SqliteRepo);
    p.close();
  });

  it('aws: builds real SDK clients when none are injected (no network on construction)', () => {
    const p = createProviders(AWS_ENV);
    expect(p.llm).toBeInstanceOf(BedrockProvider);
    expect(p.tts).toBeInstanceOf(PollyTts);
    p.close();
  });

  it('STANDIN_REPO=dynamo selects the M6 stub', () => {
    const p = createProviders({ ...AWS_ENV, STANDIN_REPO: 'dynamo' });
    expect(p.repo).toBeInstanceOf(DynamoRepo);
    p.close();
  });
});
