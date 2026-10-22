import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import {
  BedrockProvider,
  BrowserTts,
  DynamoRepo,
  LocalLlmProvider,
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
      LOCAL_LLM_BASE_URL: 'http://localhost:11434/v1',
      LOCAL_LLM_MODEL: 'local-model',
      POLLY_VOICE: 'Kajal',
    });
    expect(c.AWS_REGION).toBeUndefined();
  });

  it('treats empty strings (KEY= in .env) as unset', () => {
    const c = parseProvidersEnv({ STANDIN_MODE: '', BEDROCK_MODEL_ID: '', AWS_PROFILE: '', LOCAL_LLM_MODEL: ' ' });
    expect(c.STANDIN_MODE).toBe('offline');
    expect(c.BEDROCK_MODEL_ID).toBeUndefined();
    expect(c.LOCAL_LLM_MODEL).toBe('local-model');
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

  it('rejects unknown Polly voices and bad LocalLlm URLs', () => {
    expect(() => parseProvidersEnv({ POLLY_VOICE: 'Nobody' })).toThrow(ProvidersConfigError);
    expect(() => parseProvidersEnv({ LOCAL_LLM_BASE_URL: 'nope' })).toThrow(ProvidersConfigError);
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

  it('offline + STANDIN_LLM=localllm uses LocalLlm with env config', async () => {
    let url = '';
    const p = createProviders(
      { STANDIN_LLM: 'localllm', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:9999/v1', LOCAL_LLM_MODEL: 'm' },
      {
        fetch: async (u) => {
          url = u;
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        },
      },
    );
    expect(p.llm).toBeInstanceOf(LocalLlmProvider);
    expect(await p.llm.chat({ messages: [{ role: 'user', content: 'x' }] })).toBe('ok');
    expect(url).toBe('http://127.0.0.1:9999/v1/chat/completions');
    p.close();
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
