/**
 * Offline TTS (spec 2.1): returns no audio, so the UI speaks the text with the
 * browser's `speechSynthesis`. The text is validated and then discarded —
 * nothing is stored or logged.
 */
import { TtsRequestSchema, type TtsProvider, type TtsRequest, type TtsResult } from '@standin/core';

export class BrowserTts implements TtsProvider {
  readonly name: string = 'browser';
  /** Marker the UI checks: true means "speak it yourself". */
  readonly defersToBrowser = true as const;

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    TtsRequestSchema.parse(req);
    return {};
  }
}

/** Alias for tests/headless runs: same behaviour, different name. */
export class NullTts extends BrowserTts {
  override readonly name: string = 'null';
}
