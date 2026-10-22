import { PollyClient, type SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { describe, expect, it } from 'vitest';
import { BrowserTts, NullTts } from './browser.js';
import { PollyTts, TtsProviderError, type SynthesizeClient, type SynthesizeOutputLike } from './polly.js';

const SECRET = '482913';

class FakePolly implements SynthesizeClient {
  readonly commands: SynthesizeSpeechCommand[] = [];
  constructor(private readonly respond: () => Promise<SynthesizeOutputLike>) {}
  async send(command: SynthesizeSpeechCommand): Promise<SynthesizeOutputLike> {
    this.commands.push(command);
    return this.respond();
  }
}

const audioOut = (bytes: number[]): SynthesizeOutputLike => ({
  AudioStream: { transformToByteArray: async () => new Uint8Array(bytes) },
  ContentType: 'audio/mpeg',
});

describe('BrowserTts / NullTts', () => {
  it('returns no audio so the UI uses speechSynthesis', async () => {
    const t = new BrowserTts();
    expect(t.defersToBrowser).toBe(true);
    expect(await t.synthesize({ text: 'hello' })).toEqual({});
    expect(new NullTts().name).toBe('null');
  });

  it('validates input', async () => {
    await expect(new BrowserTts().synthesize({ text: '' })).rejects.toThrow();
  });
});

describe('PollyTts', () => {
  it('a real PollyClient satisfies SynthesizeClient', () => {
    const c: SynthesizeClient = new PollyClient({ region: 'ap-south-1' });
    expect(c).toBeDefined();
  });

  it('synthesizes with neural en-IN Kajal by default', async () => {
    const fake = new FakePolly(async () => audioOut([1, 2, 3]));
    const tts = new PollyTts({ region: 'ap-south-1', client: fake });
    const r = await tts.synthesize({ text: 'Hi, I am an AI assistant.' });
    expect(r.audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.mimeType).toBe('audio/mpeg');
    expect(fake.commands[0]?.input).toMatchObject({
      Engine: 'neural',
      OutputFormat: 'mp3',
      VoiceId: 'Kajal',
      LanguageCode: 'en-IN',
      Text: 'Hi, I am an AI assistant.',
    });
  });

  it('uses distinct voices for ivr and agent roles', async () => {
    const fake = new FakePolly(async () => audioOut([0]));
    const tts = new PollyTts({ region: 'ap-south-1', client: fake });
    await tts.synthesize({ text: 'Press 1', voice: 'ivr' });
    await tts.synthesize({ text: 'Hello', voice: 'agent' });
    const voices = fake.commands.map((c) => c.input.VoiceId);
    expect(voices).toEqual(['Amy', 'Brian']);
    expect(voices).not.toContain('Kajal');
  });

  it('honours configured voices', async () => {
    const fake = new FakePolly(async () => audioOut([0]));
    const tts = new PollyTts({
      region: 'ap-south-1',
      client: fake,
      voices: { standin: { voiceId: 'Kajal' }, ivr: { voiceId: 'Joanna', languageCode: 'en-US' }, agent: { voiceId: 'Matthew', languageCode: 'en-US' } },
    });
    await tts.synthesize({ text: 'x', voice: 'ivr' });
    expect(fake.commands[0]?.input).toMatchObject({ VoiceId: 'Joanna', LanguageCode: 'en-US' });
  });

  it('rejects unknown voice ids at construction', () => {
    expect(
      () =>
        new PollyTts({
          region: 'ap-south-1',
          voices: { standin: { voiceId: 'NotAVoice' as 'Kajal' }, ivr: { voiceId: 'Amy' }, agent: { voiceId: 'Brian' } },
        }),
    ).toThrow();
  });

  it('maps SDK errors without echoing the text', async () => {
    const fake = new FakePolly(async () => {
      throw Object.assign(new Error(`bad text ${SECRET}`), { name: 'TextLengthExceededException' });
    });
    const tts = new PollyTts({ region: 'ap-south-1', client: fake });
    const err: unknown = await tts.synthesize({ text: `code ${SECRET}` }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TtsProviderError);
    expect(String(err)).toContain('TextLengthExceededException');
    expect(String(err)).not.toContain(SECRET);
  });

  it('errors when no audio stream is returned', async () => {
    const fake = new FakePolly(async () => ({}));
    const tts = new PollyTts({ region: 'ap-south-1', client: fake });
    await expect(tts.synthesize({ text: 'x' })).rejects.toBeInstanceOf(TtsProviderError);
  });
});
