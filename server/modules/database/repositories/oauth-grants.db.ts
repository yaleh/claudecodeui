/**
 * OAuth grant repository.
 *
 * Persists user consent grants and their revocation state. `scopes` is a JSON
 * array string and `resource` the RFC 8707 audience; timestamps are passed in
 * from the store's injected clock rather than read from `CURRENT_TIMESTAMP`, so
 * revocation is deterministic under test.
 *
 * Consumers: server/modules/oauth/oauth-store.service.ts, through the database
 * module barrel.
 */

import { getConnection } from '@/modules/database/connection.js';

/** A persisted OAuth grant row exactly as stored; `scopes` is a JSON array string. */
export type OAuthGrantRow = {
  id: number;
  user_id: number;
  client_id: string;
  scopes: string;
  resource: string;
  created_at: string | null;
  last_used: string | null;
  revoked_at: string | null;
};

/** The fields a caller supplies to insert a grant row; `scopes` is pre-serialized. */
export type InsertOAuthGrantInput = {
  userId: number;
  clientId: string;
  scopes: string;
  resource: string;
  createdAt: string;
};

const GRANT_COLUMNS = 'id, user_id, client_id, scopes, resource, created_at, last_used, revoked_at';

export const oauthGrantsDb = {
  /** Inserts a grant row and returns its new id. */
  insert(input: InsertOAuthGrantInput): number {
    const result = getConnection()
      .prepare(
        `INSERT INTO oauth_grants (user_id, client_id, scopes, resource, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.userId, input.clientId, input.scopes, input.resource, input.createdAt);
    return Number(result.lastInsertRowid);
  },

  /** Finds a grant by its id; undefined when no row matches. */
  findById(id: number): OAuthGrantRow | undefined {
    return getConnection()
      .prepare(`SELECT ${GRANT_COLUMNS} FROM oauth_grants WHERE id = ?`)
      .get(id) as OAuthGrantRow | undefined;
  },

  /**
   * Revokes a live grant. Returns true only when a not-yet-revoked row matched,
   * so a second revocation does not overwrite the first timestamp.
   */
  revoke(id: number, revokedAt: string): boolean {
    const result = getConnection()
      .prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(revokedAt, id);
    return result.changes > 0;
  },

  /** Every grant id issued to `clientId`, for the client-disable cascade. */
  listIdsByClient(clientId: string): number[] {
    return (
      getConnection()
        .prepare('SELECT id FROM oauth_grants WHERE client_id = ? ORDER BY id')
        .all(clientId) as { id: number }[]
    ).map((row) => row.id);
  },
};
