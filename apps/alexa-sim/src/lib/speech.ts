/**
 * Voice output with distinct voices: the Echo ('alexa'), Stand-In, the IVR
 * and the human agent Ravi. aws mode plays Polly audio from POST /sim/api/tts;
 * a 204 (offline) or any failure falls back to browser speechSynthesis.
 * All text is masked again before it is spoken or sent.
 */
import { SIM_PATHS, SIM_TTS_MAX_CHARS, SimTtsRequestSchema, type SimTtsVoice } from '@standin/core';
import { maskText } from './redact.js';

interface VoiceStyle {
  pitch: number;
  rate: number;
  /** Preferred voice name fragments, in order. */
  prefer: RegExp[];
  lang: string;
}

const STYLES: Record<SimTtsVoice, VoiceStyle> = {
  alexa: { pitch: 1.05, rate: 1.0, prefer: [/samantha/i, /google us english/i, /female/i], lang: 'en-US' },
  standin: { pitch: 1.0, rate: 1.02, prefer: [/kajal/i, /veena/i, /google.*hindi|india/i, /en-in/i], lang: 'en-IN' },
  ivr: { pitch: 0.75, rate: 1.08, prefer: [/zarvox|fred|ralph/i, /google uk english male/i], lang: 'en-GB' },
  agent: { pitch: 0.9, rate: 1.0, prefer: [/rishi/i, /en-in.*male/i, /daniel/i, /google uk english male/i], lang: 'en-IN' },
};

export type SpeakerMode = 'browser' | 'polly';

export class Speaker {
  readonly #mode: SpeakerMode;
  readonly #token: () => string | undefined;
  #queue: Promise<void> = Promise.resolve();
  #muted = false;
  #generation = 0;
  #audio: HTMLAudioElement | undefined;

  readonly #onBudget: (() => void) | undefined;

  /** `onBudget`: the server said the demo's Polly budget is spent (204 + budget header); browser speech is used. */
  constructor(mode: SpeakerMode, token: () => string | undefined, onBudget?: () => void) {
    this.#mode = mode;
    this.#token = token;
    this.#onBudget = onBudget;
  }

  get muted(): boolean {
    return this.#muted;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (muted) this.cancel();
  }

  /** Stop everything queued or playing. */
  cancel(): void {
    this.#generation++;
    this.#queue = Promise.resolve();
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // no speech synthesis
    }
    this.#audio?.pause();
  }

  /** Queue an utterance; resolves when it has been spoken (or skipped). */
  speak(text: string, voice: SimTtsVoice): Promise<void> {
    const clean = maskText(text).trim();
    if (clean.length === 0 || this.#muted) return Promise.resolve();
    const gen = this.#generation;
    const run = async (): Promise<void> => {
      if (gen !== this.#generation || this.#muted) return;
      if (this.#mode === 'polly' && (await this.#playPolly(clean, voice, gen))) return;
      if (gen !== this.#generation) return;
      await speakBrowser(clean, voice);
    };
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }

  async #playPolly(text: string, voice: SimTtsVoice, gen: number): Promise<boolean> {
    const token = this.#token();
    const body = SimTtsRequestSchema.safeParse({ text: text.slice(0, SIM_TTS_MAX_CHARS), voice });
    if (token === undefined || !body.success) return false;
    try {
      const res = await fetch(SIM_PATHS.tts, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body.data),
      });
      if (res.status === 204 && res.headers.get('x-standin-budget') !== null) this.#onBudget?.();
      if (res.status === 204 || !res.ok) return false;
      const blob = await res.blob();
      if (gen !== this.#generation) return true;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.#audio = audio;
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.onpause = () => resolve();
        audio.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
      return true;
    } catch {
      return false;
    }
  }
}

function pickVoice(style: VoiceStyle, taken: ReadonlySet<string>): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return undefined;
  for (const re of style.prefer) {
    const v = voices.find((x) => re.test(`${x.name} ${x.lang}`) && !taken.has(x.name));
    if (v !== undefined) return v;
  }
  const lang = style.lang.toLowerCase();
  return (
    voices.find((x) => x.lang.toLowerCase() === lang && !taken.has(x.name)) ??
    voices.find((x) => x.lang.toLowerCase().startsWith('en') && !taken.has(x.name)) ??
    voices[0]
  );
}

const chosen = new Map<SimTtsVoice, SpeechSynthesisVoice | undefined>();

function voiceFor(role: SimTtsVoice): SpeechSynthesisVoice | undefined {
  if (chosen.has(role) && chosen.get(role) !== undefined) return chosen.get(role);
  const taken = new Set([...chosen.values()].flatMap((v) => (v === undefined ? [] : [v.name])));
  const v = pickVoice(STYLES[role], taken);
  chosen.set(role, v);
  return v;
}

function speakBrowser(text: string, role: SimTtsVoice): Promise<void> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return Promise.resolve();
  const style = STYLES[role];
  return new Promise<void>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = voiceFor(role);
    if (v !== undefined) u.voice = v;
    u.lang = v?.lang ?? style.lang;
    u.pitch = style.pitch;
    u.rate = style.rate;
    // Some browsers never fire onend; cap the wait by text length.
    const cap = window.setTimeout(resolve, 1500 + text.length * 90);
    const done = (): void => {
      window.clearTimeout(cap);
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  });
}
