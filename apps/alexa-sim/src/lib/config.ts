/**
 * /sim/config + Bearer token resolution. The token is never logged or traced:
 * it lives in memory and (only when entered by hand or via ?token=) in
 * sessionStorage, which dies with the tab.
 */
import { SIM_PATHS, SimConfigSchema, type SimConfig } from '@standin/core';
import { z } from 'zod';

export const TOKEN_STORAGE_KEY = 'standin.token';

const TokenSchema = z.string().trim().min(1).max(4096);

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<SimConfig> {
  const res = await fetchImpl(SIM_PATHS.config, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${SIM_PATHS.config} -> HTTP ${res.status}`);
  return SimConfigSchema.parse(await res.json());
}

export type TokenSource = 'url' | 'demo' | 'session';

/**
 * Token precedence: ?token= (stored for the tab) > demoToken from
 * /sim/config (hosted judge demo) > sessionStorage. Undefined = ask the user.
 */
export function resolveToken(
  config: Pick<SimConfig, 'demoToken'> | undefined,
  search: string,
  storage: StorageLike | undefined,
): { token: string; source: TokenSource } | undefined {
  const fromUrl = TokenSchema.safeParse(new URLSearchParams(search).get('token') ?? undefined);
  if (fromUrl.success) {
    safeSet(storage, fromUrl.data);
    return { token: fromUrl.data, source: 'url' };
  }
  const demo = TokenSchema.safeParse(config?.demoToken);
  if (demo.success) return { token: demo.data, source: 'demo' };
  const stored = TokenSchema.safeParse(safeGet(storage));
  if (stored.success) return { token: stored.data, source: 'session' };
  return undefined;
}

export function storeToken(storage: StorageLike | undefined, token: string): string | undefined {
  const t = TokenSchema.safeParse(token);
  if (!t.success) return undefined;
  safeSet(storage, t.data);
  return t.data;
}

export function forgetToken(storage: StorageLike | undefined): void {
  try {
    storage?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // storage unavailable
  }
}

/** Drop ?token= from the address bar so it never shows up in a recording. */
export function stripTokenFromUrl(loc: { href: string }, history: { replaceState(data: unknown, unused: string, url: string): void }): void {
  const url = new URL(loc.href);
  if (!url.searchParams.has('token')) return;
  url.searchParams.delete('token');
  history.replaceState(null, '', url.toString());
}

function safeGet(storage: StorageLike | undefined): string | undefined {
  try {
    return storage?.getItem(TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function safeSet(storage: StorageLike | undefined, token: string): void {
  try {
    storage?.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // storage unavailable (private mode): keep the token in memory only
  }
}
