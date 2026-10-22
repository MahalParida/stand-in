/**
 * Persistence for the built-in OAuth 2.1 authorization server (Alexa+ account
 * linking). Authorization codes, access tokens and refresh tokens are stored
 * only as SHA-256 hashes of the random values, so a copy of the database
 * cannot be replayed. Rows are re-validated with zod on read.
 *
 * Backed by better-sqlite3 at SQLITE_PATH (a file keeps Alexa linked across
 * restarts); ':memory:' for tests.
 */
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_ms INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  family_id TEXT
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_expiry ON oauth_tokens(expires_ms);
`;

export const AuthCodeRowSchema = z.object({
  code_hash: z.string(),
  client_id: z.string(),
  redirect_uri: z.string(),
  resource: z.string(),
  scope: z.string(),
  code_challenge: z.string(),
  expires_ms: z.number().int(),
  used: z.number().int(),
  family_id: z.string().nullable(),
});
export type AuthCodeRow = z.infer<typeof AuthCodeRowSchema>;

export const TokenKindSchema = z.enum(['access', 'refresh']);
export type TokenKind = z.infer<typeof TokenKindSchema>;

export const TokenRowSchema = z.object({
  token_hash: z.string(),
  kind: TokenKindSchema,
  client_id: z.string(),
  family_id: z.string(),
  resource: z.string(),
  scope: z.string(),
  created_ms: z.number().int(),
  expires_ms: z.number().int(),
  revoked: z.number().int(),
});
export type TokenRow = z.infer<typeof TokenRowSchema>;

export interface NewCode {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  expiresMs: number;
}

export interface NewToken {
  tokenHash: string;
  kind: TokenKind;
  clientId: string;
  familyId: string;
  resource: string;
  scope: string;
  createdMs: number;
  expiresMs: number;
}

export class OAuthStore {
  readonly #db: Database.Database;

  constructor(filename = ':memory:') {
    this.#db = new Database(filename);
    if (filename !== ':memory:') this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('busy_timeout = 5000');
    this.#db.exec(SCHEMA_SQL);
  }

  close(): void {
    if (this.#db.open) this.#db.close();
  }

  putCode(c: NewCode): void {
    this.#db
      .prepare(
        'INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, resource, scope, code_challenge, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(c.codeHash, c.clientId, c.redirectUri, c.resource, c.scope, c.codeChallenge, c.expiresMs);
  }

  /**
   * Atomically marks a code used and returns its row as it was before. A row
   * whose `used` is already 1 is a replay: the caller revokes `family_id`.
   */
  consumeCode(codeHash: string): AuthCodeRow | undefined {
    return this.#db.transaction((): AuthCodeRow | undefined => {
      const raw: unknown = this.#db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash);
      if (raw === undefined) return undefined;
      const row = AuthCodeRowSchema.parse(raw);
      if (row.used === 0) this.#db.prepare('UPDATE oauth_codes SET used = 1 WHERE code_hash = ?').run(codeHash);
      return row;
    })();
  }

  /** Records which token family a redeemed code produced (for replay revocation). */
  setCodeFamily(codeHash: string, familyId: string): void {
    this.#db.prepare('UPDATE oauth_codes SET family_id = ? WHERE code_hash = ?').run(familyId, codeHash);
  }

  putToken(t: NewToken): void {
    this.#db
      .prepare(
        'INSERT INTO oauth_tokens (token_hash, kind, client_id, family_id, resource, scope, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(t.tokenHash, t.kind, t.clientId, t.familyId, t.resource, t.scope, t.createdMs, t.expiresMs);
  }

  getToken(tokenHash: string): TokenRow | undefined {
    const raw: unknown = this.#db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(tokenHash);
    return raw === undefined ? undefined : TokenRowSchema.parse(raw);
  }

  /**
   * Refresh-token rotation: atomically revokes `oldHash` (only if it is still
   * live) and inserts the new pair. Returns false when the old token was
   * already revoked, i.e. the caller lost a race or this is a replay.
   */
  rotate(oldHash: string, next: NewToken[]): boolean {
    return this.#db.transaction((): boolean => {
      const r = this.#db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND revoked = 0 AND kind = 'refresh'").run(oldHash);
      if (r.changes !== 1) return false;
      for (const t of next) this.putToken(t);
      return true;
    })();
  }

  revokeFamily(familyId: string): number {
    return this.#db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE family_id = ? AND revoked = 0').run(familyId).changes;
  }

  /** Drops expired codes and tokens. Revoked-but-unexpired refresh tokens stay, so a replay is still detected. */
  purgeExpired(nowMs: number): void {
    this.#db.prepare('DELETE FROM oauth_codes WHERE expires_ms < ?').run(nowMs - 3_600_000);
    this.#db.prepare('DELETE FROM oauth_tokens WHERE expires_ms < ?').run(nowMs);
  }
}
