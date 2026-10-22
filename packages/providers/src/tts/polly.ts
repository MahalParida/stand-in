/**
 * Amazon Polly TTS (spec 2.1): neural engine, en-IN Kajal for Stand-In and
 * distinct voices for the IVR and the human agent. Default credential chain
 * only; the client is injectable for tests.
 *
 * `text` must already have passed the disclosure guard. Errors never echo it.
 */
import { LanguageCode, PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { TtsRequestSchema, type TtsProvider, type TtsRequest, type TtsResult, type TtsVoiceRole } from '@standin/core';
import { z } from 'zod';
import { PollyVoiceSchema } from '../env.js';

/** Minimal output shape we rely on; the SDK's SynthesizeSpeechCommandOutput satisfies it. */
export interface SynthesizeOutputLike {
  AudioStream?: { transformToByteArray(): Promise<Uint8Array> } | undefined;
  ContentType?: string | undefined;
}

export interface SynthesizeClient {
  send(command: SynthesizeSpeechCommand): Promise<SynthesizeOutputLike>;
}

const PollyLanguageSchema = z.enum(LanguageCode);

const VoiceConfigSchema = z.object({
  voiceId: PollyVoiceSchema,
  /** Fixed language for this voice; when absent, the request's languageCode is used. */
  languageCode: PollyLanguageSchema.optional(),
});

export const PollyOptionsSchema = z.object({
  region: z.string().min(1),
  voices: z
    .object({
      standin: VoiceConfigSchema.default({ voiceId: 'Kajal' }),
      ivr: VoiceConfigSchema.default({ voiceId: 'Amy', languageCode: 'en-GB' }),
      agent: VoiceConfigSchema.default({ voiceId: 'Brian', languageCode: 'en-GB' }),
    })
    .default({
      standin: { voiceId: 'Kajal' },
      ivr: { voiceId: 'Amy', languageCode: 'en-GB' },
      agent: { voiceId: 'Brian', languageCode: 'en-GB' },
    }),
});
export type PollyOptions = z.input<typeof PollyOptionsSchema> & { client?: SynthesizeClient };

export class TtsProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsProviderError';
  }
}

export class PollyTts implements TtsProvider {
  readonly name = 'polly';
  readonly region: string;
  readonly voices: Readonly<Record<TtsVoiceRole, z.infer<typeof VoiceConfigSchema>>>;
  readonly #client: SynthesizeClient;

  constructor(opts: PollyOptions) {
    const o = PollyOptionsSchema.parse({ region: opts.region, voices: opts.voices });
    this.region = o.region;
    this.voices = o.voices;
    this.#client = opts.client ?? new PollyClient({ region: o.region });
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const r = TtsRequestSchema.parse(req);
    const voice = this.voices[r.voice];
    const command = new SynthesizeSpeechCommand({
      Engine: 'neural',
      OutputFormat: 'mp3',
      TextType: 'text',
      Text: r.text,
      VoiceId: voice.voiceId,
      LanguageCode: voice.languageCode ?? PollyLanguageSchema.parse(r.languageCode),
    });
    let out: SynthesizeOutputLike;
    try {
      out = await this.#client.send(command);
    } catch (err) {
      throw new TtsProviderError(`polly: SynthesizeSpeech failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
    if (out.AudioStream === undefined) throw new TtsProviderError('polly: no audio stream in response');
    const audio = await out.AudioStream.transformToByteArray();
    return { audio, mimeType: out.ContentType ?? 'audio/mpeg' };
  }
}
