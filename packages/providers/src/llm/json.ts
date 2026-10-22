/**
 * Models sometimes wrap JSON in markdown fences even when asked not to.
 * Strip a single surrounding fence; never validate (the caller does, with zod).
 */
export function stripJsonFence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/i.exec(text);
  return m?.[1] !== undefined ? m[1].trim() : text.trim();
}

export const JSON_ONLY_INSTRUCTION =
  'Respond with exactly one JSON object and nothing else: no prose, no markdown fences.';

/** An AbortSignal that fires after `ms`; call `clear()` once the request settles. */
export function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new LlmTimeoutError(ms)), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

export class LlmTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`LLM request timed out after ${ms} ms`);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * Provider failure. Messages carry status codes and error names only, never
 * prompt or response text, so nothing from a conversation can leak into logs.
 */
export class LlmProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'LlmProviderError';
  }
}
