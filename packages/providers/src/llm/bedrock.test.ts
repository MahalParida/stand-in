import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import { BedrockProvider, toConverseInput, type ConverseClient } from './bedrock.js';
import { JSON_ONLY_INSTRUCTION, LlmProviderError, LlmTimeoutError } from './json.js';

const SECRET = '482913';

function output(text: string): ConverseCommandOutput {
  return {
    $metadata: {},
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 1 },
  };
}

class FakeConverse implements ConverseClient {
  readonly commands: ConverseCommand[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  constructor(private readonly respond: (cmd: ConverseCommand, signal?: AbortSignal) => Promise<ConverseCommandOutput>) {}
  async send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput> {
    this.commands.push(command);
    this.signals.push(options?.abortSignal);
    return this.respond(command, options?.abortSignal);
  }
}

describe('BedrockProvider', () => {
  it('a real BedrockRuntimeClient satisfies ConverseClient (stays wired)', () => {
    const client: ConverseClient = new BedrockRuntimeClient({ region: 'ap-south-1' });
    const p = new BedrockProvider({ region: 'ap-south-1', modelId: 'test-model' });
    expect(client).toBeDefined();
    expect(p.name).toBe('bedrock');
  });

  it('sends a ConverseCommand with modelId, system and inference config', async () => {
    const fake = new FakeConverse(async () => output('hello'));
    const llm = new BedrockProvider({ region: 'ap-south-1', modelId: 'test-model', client: fake });
    const out = await llm.chat({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.1,
      maxTokens: 50,
    });
    expect(out).toBe('hello');
    const input = fake.commands[0]?.input;
    expect(fake.commands[0]).toBeInstanceOf(ConverseCommand);
    expect(input?.modelId).toBe('test-model');
    expect(input?.system).toEqual([{ text: 'be brief' }]);
    expect(input?.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
    expect(input?.inferenceConfig).toEqual({ temperature: 0.1, maxTokens: 50 });
    expect(fake.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('adds a JSON-only instruction and strips fences in JSON mode', async () => {
    const fake = new FakeConverse(async () => output('```json\n{"action":"wait","reason":"r"}\n```'));
    const llm = new BedrockProvider({ region: 'ap-south-1', modelId: 'm', client: fake });
    const out = await llm.chat({ messages: [{ role: 'user', content: 'plan' }], json: true });
    expect(JSON.parse(out)).toEqual({ action: 'wait', reason: 'r' });
    expect(fake.commands[0]?.input.system).toEqual([{ text: JSON_ONLY_INSTRUCTION }]);
  });

  it('maps SDK errors without echoing prompt text', async () => {
    const fake = new FakeConverse(async () => {
      const e = Object.assign(new Error(`bad input ${SECRET}`), {
        name: 'ValidationException',
        $metadata: { httpStatusCode: 400 },
      });
      throw e;
    });
    const llm = new BedrockProvider({ region: 'ap-south-1', modelId: 'm', client: fake });
    const err: unknown = await llm.chat({ messages: [{ role: 'user', content: `otp ${SECRET}` }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).status).toBe(400);
    expect(String(err)).toContain('ValidationException');
    expect(String(err)).not.toContain(SECRET);
  });

  it('rejects an unexpected output shape', async () => {
    const fake = new FakeConverse(async () => ({ $metadata: {} }) as ConverseCommandOutput);
    const llm = new BedrockProvider({ region: 'ap-south-1', modelId: 'm', client: fake });
    await expect(llm.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(LlmProviderError);
  });

  it('aborts after timeoutMs', async () => {
    const fake = new FakeConverse(
      (_cmd, signal) =>
        new Promise((_res, rej) => {
          signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const llm = new BedrockProvider({ region: 'ap-south-1', modelId: 'm', client: fake, timeoutMs: 20 });
    await expect(llm.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('requires region and modelId', () => {
    expect(() => new BedrockProvider({ region: '', modelId: 'm' })).toThrow();
    expect(() => new BedrockProvider({ region: 'ap-south-1', modelId: '' })).toThrow();
  });
});

describe('toConverseInput', () => {
  it('merges consecutive same-role turns and leads with user', () => {
    const r = toConverseInput(
      [
        { role: 'system', content: 's1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u1' },
        { role: 'user', content: 'u2' },
        { role: 'system', content: 's2' },
        { role: 'assistant', content: 'a2' },
      ],
      false,
    );
    expect(r.system).toEqual([{ text: 's1' }, { text: 's2' }]);
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(r.messages[2]?.content).toEqual([{ text: 'u1\n\nu2' }]);
  });
});
