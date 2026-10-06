/**
 * The MCP gateway's ONE tool-failure envelope (AC-284).
 *
 * Every way a gateway tool can fail used to leave a different residue on the
 * wire, and none of them was machine-readable:
 *
 *  - a bare sentence in `content[0].text` — the audit wrapper's `Unauthorized.` /
 *    `Insufficient scope for this tool.` and the caught `Error.message` (which is
 *    how `session_read`'s not-found answer surfaced);
 *  - a JSON string smuggled THROUGH `content[0].text` — every tool's
 *    `refusal()` / `new Error(JSON.stringify(body))`, so a caller had to
 *    `JSON.parse` a prose field to learn the code;
 *  - no `structuredContent` at all, because the audit wrapper only fills it on
 *    the success path.
 *
 * This module is the single statement of the replacement: {@link mcpErrorResult}
 * builds the envelope, {@link McpToolError} lets a handler throw one directly,
 * and {@link toMcpErrorResult} normalizes anything else a handler throws (a
 * JSON-bodied `Error`, a `McpToolError`, a bare `Error`) onto the same shape.
 *
 * Two invariants the criterion reads back off the wire:
 *
 *  - `code` matches `^[A-Z][A-Z0-9_]*$` — a well-formed code, never a sentence;
 *  - `message` is a non-empty human sentence, and the ONLY human-readable field:
 *    `content[0].text` mirrors it so a text-only client still sees words, but the
 *    machine fields live in `structuredContent`.
 *
 * {@link MCP_ERROR_CODES} is the canonical vocabulary for the codes the GATEWAY
 * itself decides. A code forwarded from a service's own vocabulary (the control
 * service's `UNSUPPORTED_PROVIDER`, a resident host's `LIFECYCLE_MODE_*`, the
 * self-target guard's `SELF_TARGET`, …) passes through {@link toMcpErrorResult}
 * unchanged as long as it is well formed — a well-formed code is never silently
 * rewritten to a gateway one, because that would erase the service's reason.
 *
 * Consumers: `mcp-gateway.audit.ts` (the three failure branches of the audited
 * wrapper, plus the declared-input validation), every tool module's refusal path,
 * and `tests/mcp-error-envelope.test.ts`, which reads {@link MCP_ERROR_CODES} as
 * the expected code per probe class rather than re-typing the literals.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// --------------------------- the code vocabulary ---------------------------

/**
 * The canonical codes the gateway decides for itself.
 *
 * `SESSION_NOT_FOUND` is the ONE code for "the session does not exist", on every
 * tool that can say it — the split this task removes had two different codes
 * naming that one category depending on where in the gateway the miss was
 * noticed. `PROJECT_NOT_FOUND` is its project-side sibling; `TARGET_AMBIGUOUS` is
 * "several targets matched, so the gateway refuses to pick".
 *
 * `APPROVAL_NOT_FOUND` / `QUEUED_MESSAGE_NOT_FOUND` / `RUN_NOT_FOUND` are part of
 * this vocabulary but are not MINTED by AC-284: the tools that will emit them
 * (`approval_answer` / `session_cancel_queued` / `run_get`) still answer a miss
 * as a normal payload, and converting those is AC-287's scope. They are declared
 * here so AC-287 mints them through this one module rather than inventing a
 * second vocabulary.
 */
export const MCP_ERROR_CODES = {
  /** The named session does not exist (same code on every tool that can say it). */
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  /** The named project does not exist. */
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  /** Several targets matched and the gateway refuses to pick one for the caller. */
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  /** An argument is missing or of the wrong type. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** The caller named a tool the gateway does not register. */
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  /** The caller's token lacks a scope the tool requires. */
  INSUFFICIENT_SCOPE: 'INSUFFICIENT_SCOPE',
  /** The session already has a run in progress. */
  SESSION_BUSY: 'SESSION_BUSY',
  /** The named approval request no longer exists (minted by AC-287). */
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  /** The named queued message no longer exists (minted by AC-287). */
  QUEUED_MESSAGE_NOT_FOUND: 'QUEUED_MESSAGE_NOT_FOUND',
  /** The named run no longer exists (minted by AC-287). */
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  /** The tool is registered but its behaviour is owned by a later task. */
  MCP_TOOL_NOT_IMPLEMENTED: 'MCP_TOOL_NOT_IMPLEMENTED',
  /** The named background task / cron does not exist. */
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  /** The provider does not support the requested permission mode. */
  UNSUPPORTED_PERMISSION_MODE: 'UNSUPPORTED_PERMISSION_MODE',
  /** The caller is not allowed to act on the target. */
  FORBIDDEN: 'FORBIDDEN',
  /** A handler threw something the envelope could not attribute to a known code. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/** One canonical gateway error code. */
export type McpErrorCode = (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES];

/** Every well-formed code: an upper-snake identifier, never a sentence. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Whether a string is a well-formed error code. */
export function isMcpErrorCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value);
}

// --------------------------- the envelope ---------------------------

/** The free-form machine payload that rides alongside a code and its message. */
export type McpErrorDetails = Record<string, unknown>;

/** The `structuredContent` an error envelope carries. */
export type McpErrorEnvelope = {
  code: string;
  message: string;
  retryable: boolean;
  details?: McpErrorDetails;
};

/**
 * Builds the one failure result every gateway error path returns.
 *
 * `content[0].text` mirrors `message` so a text-only client still reads words,
 * but the machine-readable fields live in `structuredContent` — never as a JSON
 * string stuffed into the text. An empty `message` is replaced by the code, so
 * the "non-empty message" invariant holds no matter what a caller passes.
 *
 * Consumers: {@link toMcpErrorResult}, `mcp-gateway.audit.ts` (the denied /
 * invalid-argument branches) and this module's criterion, which reads the shape
 * back off the wire.
 */
export function mcpErrorResult(
  code: string,
  message: string,
  retryable = false,
  details?: McpErrorDetails,
): CallToolResult {
  const text = typeof message === 'string' && message.trim().length > 0 ? message : `${code}.`;
  const envelope: McpErrorEnvelope = {
    code,
    message: text,
    retryable,
    ...(details === undefined ? {} : { details }),
  };
  return {
    content: [{ type: 'text', text }],
    isError: true,
    structuredContent: envelope,
  };
}

/**
 * A tool failure a handler throws to reach {@link mcpErrorResult} directly,
 * instead of building a JSON string and relying on the wrapper to parse it back.
 *
 * Consumers: every tool module's refusal path (`mcp-session-send.ts`,
 * `mcp-session-lifecycle.ts`, `mcp-resolve-target.ts`, …).
 */
export class McpToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: McpErrorDetails | undefined;

  constructor(code: string, message: string, retryable = false, details?: McpErrorDetails) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * Reads a JSON object out of an `Error` whose message is a stringified body, the
 * shape every tool module used before this task (`new Error(JSON.stringify(body))`).
 */
function readJsonBody(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const message = error.message.trim();
  if (!message.startsWith('{')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Normalizes anything a tool handler can throw onto the one envelope.
 *
 *  - a {@link McpToolError} carries its own code / retryable / details;
 *  - a JSON-bodied `Error` (the pre-AC-284 `refusal()` shape, still thrown by any
 *    module that has not been converted) contributes its `code`, its `message`,
 *    its optional `retryable`, and every OTHER key as `details`;
 *  - anything else (a bare `Error`, a string, a thrown object) becomes
 *    `INTERNAL_ERROR` with its message (or `String(error)`) as the sentence.
 *
 * A JSON body whose `code` is not well formed is treated as a bare `Error`, so a
 * malformed body can never put a sentence in the `code` field.
 *
 * Consumers: `mcp-gateway.audit.ts` (the wrapper's catch branch) and this
 * module's criterion.
 */
export function toMcpErrorResult(error: unknown): CallToolResult {
  if (error instanceof McpToolError) {
    return mcpErrorResult(error.code, error.message, error.retryable, error.details);
  }

  const body = readJsonBody(error);
  if (body !== null && isMcpErrorCode(body.code)) {
    const { code, message, retryable, ...rest } = body;
    const text = typeof message === 'string' && message.trim().length > 0 ? message : `${code}.`;
    const details = Object.keys(rest).length > 0 ? rest : undefined;
    return mcpErrorResult(code, text, typeof retryable === 'boolean' ? retryable : false, details);
  }

  const message = error instanceof Error ? error.message : String(error);
  return mcpErrorResult(MCP_ERROR_CODES.INTERNAL_ERROR, message);
}
