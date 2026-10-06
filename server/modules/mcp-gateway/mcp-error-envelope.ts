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
 * One canonical gateway error code: the code itself, one English sentence
 * stating what it means, and whether repeating the same call could plausibly
 * succeed.
 *
 * `code` repeats the entry's key so a call site can hand the WHOLE descriptor to
 * {@link mcpErrorResult} / {@link McpToolError} — `mcpErrorResult(MCP_ERROR_CODES.SESSION_NOT_FOUND, …)` —
 * without ever restating the name as a bare string. The criterion pins
 * `descriptor.code === key`, so the copy can never drift from the key it lives
 * under.
 */
export type McpErrorDescriptor = {
  /** The code itself — the same string as this entry's key in {@link MCP_ERROR_CODES}. */
  readonly code: string;
  /** One English sentence a human can read: never empty, never CJK. */
  readonly message: string;
  /** Whether repeating the same call against the same state could plausibly succeed. */
  readonly retryable: boolean;
};

/**
 * The canonical codes the gateway decides for itself — the ONE vocabulary (AC-285).
 *
 * `SESSION_NOT_FOUND` is the ONE code for "the session does not exist", on every
 * tool that can say it — the split AC-284 removed had two different codes naming
 * that one category depending on where in the gateway the miss was noticed.
 * `PROJECT_NOT_FOUND` is its project-side sibling; `TARGET_AMBIGUOUS` is
 * "several targets matched, so the gateway refuses to pick".
 *
 * `APPROVAL_NOT_FOUND` / `QUEUED_MESSAGE_NOT_FOUND` / `RUN_NOT_FOUND` are part of
 * this vocabulary but are not MINTED by AC-284: the tools that will emit them
 * (`approval_answer` / `session_cancel_queued` / `run_get`) still answer a miss
 * as a normal payload, and converting those is AC-287's scope. They are declared
 * here so AC-287 mints them through this one module rather than inventing a
 * second vocabulary. `APPROVAL_EXPIRED_OR_NOT_FOUND` is the one code
 * `approval_answer` currently reports INSIDE its normal payload rather than as an
 * envelope; it lives here so the value-position literal that mints it points at
 * the vocabulary (AC-285 (e)) rather than at a second string.
 *
 * The record is `as const satisfies Record<string, McpErrorDescriptor>`: every
 * value is checked against the descriptor type, and {@link McpErrorCode} below is
 * derived from the SAME object, so the type and the record can never hold two
 * different key sets.
 */
export const MCP_ERROR_CODES = {
  SESSION_NOT_FOUND: {
    code: 'SESSION_NOT_FOUND',
    message: 'No session matches the id or title the caller named.',
    retryable: false,
  },
  PROJECT_NOT_FOUND: {
    code: 'PROJECT_NOT_FOUND',
    message: 'No project matches the id or title the caller named.',
    retryable: false,
  },
  TARGET_AMBIGUOUS: {
    code: 'TARGET_AMBIGUOUS',
    message: 'Several targets matched the name; the gateway will not pick one for the caller.',
    retryable: false,
  },
  INVALID_ARGUMENT: {
    code: 'INVALID_ARGUMENT',
    message: 'An argument is missing or has the wrong type.',
    retryable: false,
  },
  UNKNOWN_TOOL: {
    code: 'UNKNOWN_TOOL',
    message: 'The caller named a tool the gateway does not register.',
    retryable: false,
  },
  INSUFFICIENT_SCOPE: {
    code: 'INSUFFICIENT_SCOPE',
    message: "The caller's token lacks a scope the tool requires.",
    retryable: false,
  },
  SESSION_BUSY: {
    code: 'SESSION_BUSY',
    message: 'The session already has a run in progress.',
    retryable: true,
  },
  APPROVAL_NOT_FOUND: {
    code: 'APPROVAL_NOT_FOUND',
    message: 'No pending approval has the id the caller named.',
    retryable: false,
  },
  QUEUED_MESSAGE_NOT_FOUND: {
    code: 'QUEUED_MESSAGE_NOT_FOUND',
    message: 'No queued message has the id the caller named.',
    retryable: false,
  },
  RUN_NOT_FOUND: {
    code: 'RUN_NOT_FOUND',
    message: 'No run has the id the caller named.',
    retryable: false,
  },
  MCP_TOOL_NOT_IMPLEMENTED: {
    code: 'MCP_TOOL_NOT_IMPLEMENTED',
    message: 'The tool is registered but its behaviour is owned by a later task.',
    retryable: false,
  },
  TASK_NOT_FOUND: {
    code: 'TASK_NOT_FOUND',
    message: 'No background task or schedule in this session has the id the caller named.',
    retryable: false,
  },
  UNSUPPORTED_PERMISSION_MODE: {
    code: 'UNSUPPORTED_PERMISSION_MODE',
    message: 'The provider does not support the requested permission mode.',
    retryable: false,
  },
  FORBIDDEN: {
    code: 'FORBIDDEN',
    message: 'The caller is not allowed to act on this target.',
    retryable: false,
  },
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    message: 'The handler failed in a way the gateway could not attribute to a known code.',
    retryable: false,
  },
  APPROVAL_EXPIRED_OR_NOT_FOUND: {
    code: 'APPROVAL_EXPIRED_OR_NOT_FOUND',
    message: 'The approval request has expired or no longer exists.',
    retryable: false,
  },
} as const satisfies Record<string, McpErrorDescriptor>;

/**
 * One canonical gateway error code, derived from {@link MCP_ERROR_CODES} — the
 * key set and the type are one statement, never two copies that can drift.
 */
export type McpErrorCode = keyof typeof MCP_ERROR_CODES;

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
 * `code` may be either a bare string (a code a service forwarded — see the
 * module header: a well-formed service code passes through unchanged) or a
 * {@link McpErrorDescriptor} read straight out of {@link MCP_ERROR_CODES}. When
 * it is a descriptor, the code, the fallback sentence and the default
 * `retryable` all come FROM the vocabulary, so a call site names the code once
 * and never restates its meaning. An explicit `message` / `retryable` argument
 * always wins over the descriptor's, so existing call sites keep their exact
 * wording.
 *
 * `content[0].text` mirrors `message` so a text-only client still reads words,
 * but the machine-readable fields live in `structuredContent` — never as a JSON
 * string stuffed into the text. An empty `message` falls back to the
 * descriptor's sentence, then to the code, so the "non-empty message" invariant
 * holds no matter what a caller passes.
 *
 * Consumers: {@link toMcpErrorResult}, `mcp-gateway.audit.ts` (the denied /
 * invalid-argument branches), every tool module's refusal path, and this
 * module's criterion, which reads the shape back off the wire.
 */
export function mcpErrorResult(
  code: string | McpErrorDescriptor,
  message?: string,
  retryable?: boolean,
  details?: McpErrorDetails,
): CallToolResult {
  const resolvedCode = typeof code === 'string' ? code : code.code;
  const resolvedRetryable = retryable ?? (typeof code === 'string' ? false : code.retryable);
  const fallbackMessage = typeof code === 'string' ? '' : code.message;
  const candidate =
    typeof message === 'string' && message.trim().length > 0 ? message : fallbackMessage;
  const text = candidate.trim().length > 0 ? candidate : `${resolvedCode}.`;
  const envelope: McpErrorEnvelope = {
    code: resolvedCode,
    message: text,
    retryable: resolvedRetryable,
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
 * `code` may be a bare string (a forwarded service code) or a
 * {@link McpErrorDescriptor} from {@link MCP_ERROR_CODES}; a descriptor
 * contributes its own code and its `retryable`, while an explicit `retryable`
 * argument wins, exactly as in {@link mcpErrorResult}.
 *
 * Consumers: every tool module's refusal path (`mcp-session-send.ts`,
 * `mcp-session-lifecycle.ts`, `mcp-resolve-target.ts`, …).
 */
export class McpToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: McpErrorDetails | undefined;

  constructor(
    code: string | McpErrorDescriptor,
    message: string,
    retryable?: boolean,
    details?: McpErrorDetails,
  ) {
    super(message);
    this.name = 'McpToolError';
    this.code = typeof code === 'string' ? code : code.code;
    this.retryable = retryable ?? (typeof code === 'string' ? false : code.retryable);
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
