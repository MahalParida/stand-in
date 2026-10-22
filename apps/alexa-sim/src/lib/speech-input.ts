/** Web Speech API speech-to-text, when the browser has it (the text box is always available). */

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative | undefined;
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResult | undefined };
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as Record<string, unknown>;
  const c = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof c === 'function' ? (c as RecognitionCtor) : undefined;
}

export function speechInputSupported(): boolean {
  return ctor() !== undefined;
}

export interface ListenHandle {
  stop(): void;
}

/** Listen once; `onInterim` streams partial text, `onFinal` fires with the final transcript. */
export function listenOnce(handlers: {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onEnd(): void;
  onError(message: string): void;
}): ListenHandle | undefined {
  const C = ctor();
  if (C === undefined) return undefined;
  const rec = new C();
  rec.lang = 'en-IN';
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const t = r?.[0]?.transcript ?? '';
      if (r?.isFinal === true) finalText += t;
      else interim += t;
    }
    handlers.onInterim((finalText + interim).trim());
  };
  rec.onerror = (e) => handlers.onError(e.error ?? 'speech recognition error');
  rec.onend = () => {
    if (finalText.trim().length > 0) handlers.onFinal(finalText.trim());
    handlers.onEnd();
  };
  rec.start();
  return { stop: () => rec.stop() };
}
