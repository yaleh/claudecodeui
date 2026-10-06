/**
 * MCP tool-call auditing (AC-244).
 *
 * Every tool invocation writes EXACTLY one row to `mcp_audit_log`, whatever its
 * result: `ok`, `denied` (the token lacks a required scope, so the handler never
 * runs) or `error` (the handler threw). The arguments are reduced to a digest
 * before they reach the database — session and project ids are kept verbatim,
 * every other string is replaced by its length and first 40 characters — so the
 * full text of a tool call can never be read back out of the log.
 *
 * The retention sweep and the audit dispatch are both injectable: the clock and
 * the interval scheduler are seams, so a criterion can plant an old row or
 * capture the daily callback without waiting on wall time. The module holds no
 * module-level timer or cache, so an injected seam is never shadowed by state
 * left over from another mount.
 *
 * Consumers: `mcp-gateway.transport.ts` registers tools through
 * {@link withMcpAudit} and starts retention at mount time; this module's
 * criterion drives every export directly.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { mcpAuditLogDb } from '@/modules/database/index.js';

import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpWriteNotification } from './mcp-write-notification.js';

/** The three results a tool call can leave in the audit log. */
export type McpAuditOutcome = 'ok' | 'denied' | 'error';

/** How many characters of a free-text argument survive into the digest. */
const PREVIEW_LENGTH = 40;

/**
 * Argument keys whose value is an identifier and is therefore kept verbatim.
 * Covers the SPEC's tool table (`{ session }`, `{ project }`) and their variants;
 * a later task that introduces another id key extends this set.
 */
const ID_ARGUMENT_KEYS: ReadonlySet<string> = new Set(['session', 'sessionId', 'project', 'projectId']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Retention window, in days, matching the SPEC. */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Reduces one argument value. An identifier key keeps its value untouched; a
 * string becomes `{ length, preview }`; arrays and objects recurse; every other
 * primitive (number, boolean, null) is returned as-is. `key` is `null` for
 * array elements, which have no key of their own.
 */
function summarizeValue(value: unknown, key: string | null): unknown {
  if (key !== null && ID_ARGUMENT_KEYS.has(key)) {
    return value;
  }
  if (typeof value === 'string') {
    // Only the length and the first PREVIEW_LENGTH characters — no ellipsis, no
    // tail — so nothing past the preview can ever be reconstructed.
    return { length: value.length, preview: value.slice(0, PREVIEW_LENGTH) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeValue(item, null));
  }
  if (typeof value === 'object' && value !== null) {
    const summarized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      summarized[entryKey] = summarizeValue(entryValue, entryKey);
    }
    return summarized;
  }
  return value;
}

/**
 * The argument digest written to `mcp_audit_log.args_digest`. Pure: it reads no
 * clock and touches no database. Consumers: {@link recordMcpToolCall} and this
 * module's criterion, which asserts the full free text appears in neither the
 * digest nor any other column of the row.
 */
export function summarizeToolArgs(args: unknown): string {
  const digest = JSON.stringify(summarizeValue(args, null));
  return digest === undefined ? 'null' : digest;
}

/** What {@link recordMcpToolCall} needs to write its one row. */
export type McpToolCallReading = {
  /** The invoking token's row id, or null when no token could be attributed. */
  tokenId: number | null;
  /** The OAuth client id, always null for a personal access token. */
  clientId: string | null;
  tool: string;
  outcome: McpAuditOutcome;
  /** Non-negative elapsed time of the dispatch, in milliseconds. */
  durationMs: number;
  args: unknown;
};

/**
 * Writes the single audit row for one tool call and returns its id. This is the
 * only writer of `mcp_audit_log`: the ok, denied and error paths of
 * {@link withMcpAudit} all funnel through here, which is what makes "exactly one
 * row per call" a property of one function rather than of three branches.
 */
export function recordMcpToolCall(reading: McpToolCallReading): number {
  return mcpAuditLogDb.insert({
    tokenId: reading.tokenId,
    clientId: reading.clientId,
    tool: reading.tool,
    argsDigest: summarizeToolArgs(reading.args),
    outcome: reading.outcome,
    durationMs: reading.durationMs,
  });
}

/** The seams {@link startMcpAuditRetention} reads, all injectable for the criterion. */
export type McpAuditRetentionOptions = {
  /** Clock, default `() => new Date()`. */
  now?: () => Date;
  /** Scheduler, default `globalThis.setInterval`. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** Retention window in days, default 90. */
  retentionDays?: number;
};

/**
 * Starts the audit-log retention sweep: one pass immediately (startup) and one
 * every 24 hours thereafter. Returns the sweep so a caller can invoke it
 * directly; the interval handle itself belongs to the injected scheduler.
 *
 * The sweep deletes rows strictly older than `retentionDays`, so a row exactly
 * on the boundary is kept. Consumers: `mountMcpGateway` (production startup) and
 * this module's criterion, which injects a fixed clock and a capturing
 * scheduler to observe both the immediate pass and the 24-hour cadence.
 */
export function startMcpAuditRetention(options: McpAuditRetentionOptions = {}): { prune: () => number } {
  const now = options.now ?? (() => new Date());
  const schedule = options.setInterval ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

  const prune = (): number =>
    mcpAuditLogDb.deleteOlderThan(new Date(now().getTime() - retentionDays * MS_PER_DAY).toISOString());

  // The startup pass runs before the interval is registered, so a caller that
  // captures the registration still observes the immediate sweep.
  prune();
  schedule(prune, MS_PER_DAY);

  return { prune };
}

/** A tool's audited definition, as passed to {@link withMcpAudit}. */
export type McpToolRegistration = {
  name: string;
  /**
   * The client-facing description, when the tool has one. Absent keeps the
   * AC-244 shape: a registration that names only its scope and handler is still
   * a complete one, and the tools that criterion registers must keep answering
   * exactly as they did.
   */
  description?: string;
  /**
   * The tool's argument schema as a Zod raw shape. Defaults to a permissive
   * record, which is what AC-244's tools rely on: the audit digest must see the
   * caller's full argument object, so a fixed shape would strip unknown keys
   * before the handler ever ran. A tool that wants real argument validation
   * (AC-245's read tools) passes its own shape and accepts that stripping.
   */
  inputSchema?: z.ZodRawShape;
  /**
   * The tool's result schema. When present the handler's return value is also
   * emitted as `structuredContent` — the SDK refuses a non-error result from a
   * tool that declares an output schema without one.
   */
  outputSchema?: z.ZodRawShape;
  /**
   * The declaration hints (`readOnlyHint` / `destructiveHint` /
   * `idempotentHint` / `openWorldHint`) forwarded verbatim to
   * `registerTool`. Optional, and absent keeps the AC-244 shape exactly: those
   * criteria register tools with no annotations and must keep answering as they
   * did. The transport's one seam attaches the gateway's table
   * (`readMcpToolAnnotations`) to every production tool. Annotations carry NO
   * authorization weight — the audit wrapper still decides `denied`/`ok`/`error`
   * from `requiredScopes` alone (AC6).
   */
  annotations?: ToolAnnotations;
  /** Every scope the caller's token must carry; a missing one denies the call. */
  requiredScopes: readonly string[];
  handler: (args: unknown, ctx: { principal: McpPrincipal }) => unknown;
};

/**
 * Installs one or more audited tools on the per-request `McpServer`, given the
 * principal of the request being served (or null when the server was built
 * without one). {@link withMcpAudit}'s return and the transport's `registerTools`
 * seam share this shape.
 */
export type McpToolRegistrar = (server: McpServer, principal: McpPrincipal | null) => void;

/**
 * One audited tool's registration function, as returned by {@link withMcpAudit}.
 * Consumers: `mcp-gateway.transport.ts` (through the `registerTools` seam) and
 * AC-245+'s real tool registrations, which reuse this wrapper.
 */
export type McpToolHandler = McpToolRegistrar;

/** Renders an arbitrary handler result as MCP text content. */
function toTextContent(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result ?? null);
}

/**
 * Renders a handler result as `structuredContent`, which the SDK validates
 * against the declared output schema. A non-object result is wrapped rather
 * than rejected, so a tool whose handler returns a bare string still produces a
 * shape an output schema can describe.
 */
function toStructuredContent(result: unknown): Record<string, unknown> {
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { value: result ?? null };
}

/**
 * Wraps a tool so every call is audited exactly once, then returns the
 * registration function that installs it. The scope check happens BEFORE the
 * handler: a token missing a required scope is recorded as `denied` and the
 * handler never runs. A handler that throws is recorded as `error` and turned
 * into an `isError` result rather than being allowed to crash the process; a
 * normal return is recorded as `ok`. All three paths write through the single
 * {@link recordMcpToolCall}.
 *
 * The input schema accepts arbitrary keys (`z.record`) unless the registration
 * declares one, so the digest sees the caller's full argument object; a fixed
 * shape would strip unknown keys before the handler ever ran. A registration
 * that declares an output schema gets its result emitted as `structuredContent`
 * alongside the text, because the SDK refuses a non-error result that has none.
 *
 * A registration may also declare `annotations` (AC1–AC7); they are forwarded to
 * `registerTool` verbatim and appear on `tools/list`, but they are metadata only
 * — the `denied`/`ok`/`error` decision below is made from `requiredScopes`
 * alone, so a declaration can never widen or narrow what a token may call.
 *
 * An optional second argument threads AC-303's write-notification seam. It is
 * called ONLY from the `ok` branch, AFTER the audit row is written, and is wrapped
 * in its own try/catch: a throwing notifier must not change the tool call's
 * result nor turn the `ok` row into an `error` one. The seam is handed every
 * registration (read and write alike) and classifies each call itself — a
 * read-only tool returns without notifying — so the write/read split stays in
 * one place. Omitting the argument keeps AC-244's behaviour byte-for-byte.
 */
export function withMcpAudit(
  registration: McpToolRegistration,
  writeNotifications?: McpWriteNotification,
): McpToolHandler {
  return (server, principal) => {
    server.registerTool(
      registration.name,
      {
        ...(registration.description === undefined ? {} : { description: registration.description }),
        inputSchema: registration.inputSchema ?? z.record(z.string(), z.unknown()),
        ...(registration.outputSchema === undefined ? {} : { outputSchema: registration.outputSchema }),
        // Metadata only: forwarded to the SDK so it appears verbatim on
        // `tools/list`. It changes nothing about the scope check below.
        ...(registration.annotations === undefined ? {} : { annotations: registration.annotations }),
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const startedAt = Date.now();
        const elapsedMs = (): number => Math.max(0, Date.now() - startedAt);

        // No principal means no authenticated caller (unreachable behind the auth
        // middleware, but a denial is the safe reading rather than an ok).
        if (principal === null) {
          recordMcpToolCall({
            tokenId: null,
            clientId: null,
            tool: registration.name,
            outcome: 'denied',
            durationMs: elapsedMs(),
            args,
          });
          return { content: [{ type: 'text', text: 'Unauthorized.' }], isError: true };
        }

        const permitted = registration.requiredScopes.every((scope) => principal.scopes.includes(scope));
        if (!permitted) {
          recordMcpToolCall({
            tokenId: principal.tokenId,
            clientId: principal.clientId,
            tool: registration.name,
            outcome: 'denied',
            durationMs: elapsedMs(),
            args,
          });
          return { content: [{ type: 'text', text: 'Insufficient scope for this tool.' }], isError: true };
        }

        try {
          const result = await registration.handler(args, { principal });
          recordMcpToolCall({
            tokenId: principal.tokenId,
            clientId: principal.clientId,
            tool: registration.name,
            outcome: 'ok',
            durationMs: elapsedMs(),
            args,
          });
          // AC-303: notify the token's owner of a SUCCESSFUL call only. Its own
          // try/catch keeps a throwing notifier from reaching the outer catch,
          // which would otherwise write an `error` row and return `isError` for
          // a call that actually succeeded.
          if (writeNotifications !== undefined) {
            try {
              writeNotifications.notify({ principal, tool: registration.name, args });
            } catch {
              // Swallowed by design — the audit row above is already `ok` and the
              // caller still receives the handler's result.
            }
          }
          return registration.outputSchema === undefined
            ? { content: [{ type: 'text', text: toTextContent(result) }] }
            : {
                content: [{ type: 'text', text: toTextContent(result) }],
                structuredContent: toStructuredContent(result),
              };
        } catch (error) {
          recordMcpToolCall({
            tokenId: principal.tokenId,
            clientId: principal.clientId,
            tool: registration.name,
            outcome: 'error',
            durationMs: elapsedMs(),
            args,
          });
          return {
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          };
        }
      }
    );
  };
}
