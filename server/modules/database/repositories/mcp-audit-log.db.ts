/**
 * MCP tool-call audit-log repository (AC-244).
 *
 * Persists one row per MCP tool invocation (mcp-gateway-SPEC §389). The writer is
 * the mcp-gateway module's audit wrapper, which reduces the tool arguments to a
 * digest before calling here — this repository stores whatever `argsDigest` it is
 * handed and never inspects the arguments itself.
 *
 * `at` is caller-supplied when given (the retention criterion plants rows days
 * old to exercise the sweep) and falls back to the column's `CURRENT_TIMESTAMP`
 * default, matching how the audit wrapper writes "now" without reading the clock
 * twice. `deleteOlderThan` deletes strictly before the cutoff, so a row exactly
 * on the boundary is retained.
 *
 * Consumers: server/modules/mcp-gateway (mcp-gateway.audit.ts) through the
 * database module barrel.
 */

import { getConnection } from '@/modules/database/connection.js';

/** A persisted audit row exactly as stored. `outcome` is 'ok' | 'denied' | 'error'. */
export type McpAuditLogRow = {
  id: number;
  at: string;
  token_id: number | null;
  client_id: string | null;
  tool: string;
  args_digest: string | null;
  outcome: string;
  duration_ms: number | null;
};

/**
 * The fields a caller supplies to insert a row. `at` is optional: when omitted
 * the column default (`CURRENT_TIMESTAMP`) is used, so the audit wrapper does not
 * have to read the clock just to stamp the row.
 */
export type InsertMcpAuditLogInput = {
  at?: string;
  tokenId: number | null;
  clientId: string | null;
  tool: string;
  argsDigest: string | null;
  outcome: string;
  durationMs: number | null;
};

const AUDIT_COLUMNS = 'id, at, token_id, client_id, tool, args_digest, outcome, duration_ms';

export const mcpAuditLogDb = {
  /**
   * Inserts one audit row and returns its new id. `at` is honoured when the
   * caller passes it; otherwise `COALESCE(?, CURRENT_TIMESTAMP)` uses the
   * column's default, so an omitted timestamp is the insert instant.
   */
  insert(input: InsertMcpAuditLogInput): number {
    const db = getConnection();
    const result = db
      .prepare(
        `INSERT INTO mcp_audit_log
           (at, token_id, client_id, tool, args_digest, outcome, duration_ms)
         VALUES (COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.at ?? null,
        input.tokenId,
        input.clientId,
        input.tool,
        input.argsDigest,
        input.outcome,
        input.durationMs
      );
    return Number(result.lastInsertRowid);
  },

  /** Total number of audit rows. The criterion reads this before/after each call. */
  count(): number {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) AS count FROM mcp_audit_log').get() as { count: number };
    return row.count;
  },

  /**
   * Every audit row, oldest first. Consumers: the criterion, which reassembles
   * all columns of a row to prove the full free text appears in none of them.
   */
  allRows(): McpAuditLogRow[] {
    const db = getConnection();
    return db.prepare(`SELECT ${AUDIT_COLUMNS} FROM mcp_audit_log ORDER BY id ASC`).all() as McpAuditLogRow[];
  },

  /**
   * Deletes every row whose `at` is strictly before `cutoffIso`, returning the
   * number removed. Strict `<` is deliberate: the retention window keeps a row
   * exactly `retentionDays` old.
   */
  deleteOlderThan(cutoffIso: string): number {
    const db = getConnection();
    const result = db.prepare('DELETE FROM mcp_audit_log WHERE at < ?').run(cutoffIso);
    return result.changes;
  },
};
