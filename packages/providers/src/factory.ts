/**
 * createProviders(env): selects LLM/TTS/Repo/Scheduler by STANDIN_MODE
 * (spec 2.1). Offline needs no AWS variables; Bedrock is always importable.
 */
import { systemClock, type Clock, type LlmProvider, type Repo, type TtsProvider } from '@standin/core';
import { parseProvidersEnv, type ProvidersEnv, type StandinMode } from './env.js';
import { BedrockProvider, type ConverseClient } from './llm/bedrock.js';
import { LocalLlmProvider, type FetchLike } from './llm/localllm.js';
import { ScriptedLlmProvider, defaultOfflineScript, type ScriptedLlmOptions } from './llm/scripted.js';
import { DynamoRepo, createSqliteRepo } from './repo/index.js';
import { LocalScheduler } from './scheduler/index.js';
import { BrowserTts } from './tts/browser.js';
import { PollyTts, type SynthesizeClient } from './tts/polly.js';

export interface ProviderOverrides {
  clock?: Clock;
  /** Script for the offline ScriptedLlmProvider (defaults to a safe "wait"). */
  scripted?: ScriptedLlmOptions;
  /** fetch used by LocalLlmProvider (tests). */
  fetch?: FetchLike;
  bedrockClient?: ConverseClient;
  pollyClient?: SynthesizeClient;
}

export interface Providers {
  mode: StandinMode;
  config: ProvidersEnv;
  llm: LlmProvider;
  tts: TtsProvider;
  repo: Repo;
  scheduler: LocalScheduler;
  /** Stops the scheduler and closes the repo. */
  close(): void;
}

export function createLlm(cfg: ProvidersEnv, o: ProviderOverrides = {}): LlmProvider {
  if (cfg.STANDIN_MODE === 'aws') {
    // superRefine guarantees both are set in aws mode.
    return new BedrockProvider({
      region: cfg.AWS_REGION ?? '',
      modelId: cfg.BEDROCK_MODEL_ID ?? '',
      timeoutMs: cfg.BEDROCK_TIMEOUT_MS,
      ...(o.bedrockClient !== undefined ? { client: o.bedrockClient } : {}),
    });
  }
  if (cfg.STANDIN_LLM === 'localllm') {
    return new LocalLlmProvider({
      baseUrl: cfg.LOCAL_LLM_BASE_URL,
      model: cfg.LOCAL_LLM_MODEL,
      timeoutMs: cfg.LOCAL_LLM_TIMEOUT_MS,
      reasoningEffort: cfg.LOCAL_LLM_REASONING_EFFORT,
      ...(o.fetch !== undefined ? { fetch: o.fetch } : {}),
    });
  }
  return new ScriptedLlmProvider(o.scripted ?? { script: defaultOfflineScript });
}

export function createTts(cfg: ProvidersEnv, o: ProviderOverrides = {}): TtsProvider {
  if (cfg.STANDIN_MODE !== 'aws') return new BrowserTts();
  return new PollyTts({
    region: cfg.AWS_REGION ?? '',
    voices: {
      standin: { voiceId: cfg.POLLY_VOICE },
      ivr: { voiceId: cfg.POLLY_VOICE_IVR, languageCode: 'en-GB' },
      agent: { voiceId: cfg.POLLY_VOICE_AGENT, languageCode: 'en-GB' },
    },
    ...(o.pollyClient !== undefined ? { client: o.pollyClient } : {}),
  });
}

export function createRepo(cfg: ProvidersEnv): Repo {
  if (cfg.STANDIN_REPO === 'dynamo') {
    return new DynamoRepo({ region: cfg.AWS_REGION ?? 'ap-south-1', table: cfg.DYNAMODB_TABLE });
  }
  return createSqliteRepo({ path: cfg.SQLITE_PATH });
}

export function createProviders(
  env: Record<string, string | undefined> = process.env,
  overrides: ProviderOverrides = {},
): Providers {
  const config = parseProvidersEnv(env);
  const repo = createRepo(config);
  const scheduler = new LocalScheduler({ repo, clock: overrides.clock ?? systemClock });
  return {
    mode: config.STANDIN_MODE,
    config,
    llm: createLlm(config, overrides),
    tts: createTts(config, overrides),
    repo,
    scheduler,
    close() {
      scheduler.stop();
      repo.close();
    },
  };
}
