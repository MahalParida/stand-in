/**
 * Dial allowlist (spec principle 5). Numbers come ONLY from
 * data/business-directory.json, never from the conversation, an SMS or the LLM.
 */
import { readFileSync } from 'node:fs';
import { parseBusinessDirectory, type Business } from '@standin/core';

/** data/business-directory.json, resolved from src/ or dist/ alike. */
export const DEFAULT_DIRECTORY_URL = new URL('../../../data/business-directory.json', import.meta.url);

/** Reads and validates (zod) the directory file. Throws on a malformed file. */
export function loadDirectory(path: string | URL = DEFAULT_DIRECTORY_URL): Business[] {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parseBusinessDirectory(raw);
}

function digits(n: string): string {
  return n.replace(/\D/g, '');
}

/** True if `number` is exactly (digit-normalised) the number of an allowlisted, non-opted-out business. */
export function isAllowlistedNumber(number: string, directory: readonly Business[]): boolean {
  const d = digits(number);
  if (d.length === 0) return false;
  return directory.some((b) => b.optOut !== true && digits(b.number) === d);
}

export class NotAllowlistedError extends Error {
  constructor() {
    super('refusing to dial a number that is not in the business directory');
    this.name = 'NotAllowlistedError';
  }
}
