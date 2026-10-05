/**
 * Access-token repository.
 *
 * Persists the rows behind the OAuth module's personal access tokens. The
 * module never stores plaintext: callers pass the SHA-256 hash and the display
 * prefix. Every timestamp is passed in from the caller's clock rather than read
 * from `CURRENT_TIMESTAMP`, because the service injects a clock so expiry and
 * revocation are deterministic under test.
 *
 * Consumers: server/modules/oauth (access-tokens.service.ts) and
 * server/modules/settings (settings.module.ts, for the /access-tokens
 * routes), both through the database module barrel.
 */

import { getConnection } from '@/modules/database/connection.js';

/** A persisted access-token row exactly as stored; `scopes` is a JSON array string. */
export type AccessTokenRow = {
  id: number;
  user_id: number;
  token_hash: string;
  token_prefix: string;
  name: string | null;
  scopes: string;
  expires_at: string;
  created_at: string | null;
  last_used: string | null;
  revoked_at: string | null;
};

/** The fields a caller supplies to insert a token row; all timestamps are ISO strings. */
export type InsertAccessTokenInput = {
  userId: number;
  tokenHash: string;
  tokenPrefix: string;
  name: string | null;
  scopes: string;
  expiresAt: string;
  createdAt: string;
};

export const accessTokensDb = {
  /** Inserts a token row and returns its new id. */
  insert(input: InsertAccessTokenInput): number {
    const db = getConnection();
    const result = db
      .prepare(
        `INSERT INTO access_tokens
           (user_id, token_hash, token_prefix, name, scopes, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.userId,
        input.tokenHash,
        input.tokenPrefix,
        input.name,
        input.scopes,
        input.expiresAt,
        input.createdAt
      );
    return Number(result.lastInsertRowid);
  },

  /**
   * Lists every token row owned by `userId`, newest first. Used by the settings
   * module's `/access-tokens` list; the caller projects away `token_hash`, which
   * this read deliberately includes so the projection is the caller's explicit
   * allowlist rather than an accidental omission.
   */
  listByUser(userId: number): AccessTokenRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT id, user_id, token_hash, token_prefix, name, scopes,
                expires_at, created_at, last_used, revoked_at
         FROM access_tokens WHERE user_id = ? ORDER BY id DESC`
      )
      .all(userId) as AccessTokenRow[];
  },

  /** Finds a token by its row id; undefined when no row matches. Used to check ownership before revocation. */
  findById(id: number): AccessTokenRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        `SELECT id, user_id, token_hash, token_prefix, name, scopes,
                expires_at, created_at, last_used, revoked_at
         FROM access_tokens WHERE id = ?`
      )
      .get(id) as AccessTokenRow | undefined;
  },

  /** Finds a token by its SHA-256 hash; undefined when no row matches. */
  findByHash(tokenHash: string): AccessTokenRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        `SELECT id, user_id, token_hash, token_prefix, name, scopes,
                expires_at, created_at, last_used, revoked_at
         FROM access_tokens WHERE token_hash = ?`
      )
      .get(tokenHash) as AccessTokenRow | undefined;
  },

  /** Records the instant a token was last accepted. */
  updateLastUsed(id: number, lastUsed: string): void {
    const db = getConnection();
    db.prepare('UPDATE access_tokens SET last_used = ? WHERE id = ?').run(lastUsed, id);
  },

  /**
   * Revokes a live token by id. Returns true only when a not-yet-revoked row
   * matched, so a second revocation does not overwrite the first timestamp.
   */
  revoke(id: number, revokedAt: string): boolean {
    const db = getConnection();
    const result = db
      .prepare('UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(revokedAt, id);
    return result.changes > 0;
  },
};
