/**
 * The MCP gateway's stage-6 resident tools (AC-271).
 *
 * This module owns the one statement of "which stage-6 tools exist and the scope
 * each requires": {@link MCP_STAGE6_RESIDENT_TOOLS}. AC-271 delivers exactly one
 * — `session_cancel_queued`, requiring `cloudcli:session:control` — and later
 * stage-6 tasks (AC-272 `session_reconfigure`/`session_background`, AC-273/274
 * `approvals_list`/`approval_answer`) APPEND to this table rather than minting a
 * second one. AC-252's self-referential guard reads the gateway write-tool names
 * from the gateway's own tables, so this list must stay the single source.
 *
 * {@link registerMcpResidentTools} installs each name through the SAME audited
 * registration seam AC-244 landed (the transport builds one over `withMcpAudit`,
 * so every tool inherits its audit row and its scope refusal). It is called by
 * `mountMcpGateway` alongside the read and write tools, over the one control
 * service instance the composition root already supplied (`server/index.ts` —
 * never a second instance).
 *
 * The scope literal comes from AC-243's single scope vocabulary
 * (`ACCESS_TOKEN_SCOPES`) rather than being re-typed here, matching the stage-4
 * write table; the array's order is pinned by the OAuth module's own vocabulary
 * criterion, so the positional read cannot silently select the wrong scope.
 */

import { ACCESS_TOKEN_SCOPES } from '@/modules/oauth/index.js';

import type {
  McpSessionCancelQueuedDeps,
  McpSessionCancelQueuedSeam,
} from './mcp-session-cancel-queued.js';
import { registerMcpSessionCancelQueuedTool } from './mcp-session-cancel-queued.js';

// Position within AC-243's vocabulary, in the order the constant declares and
// `access-token-scopes.test.ts` pins: read, session:send, session:create,
// session:control, approve.
const [, , , SESSION_CONTROL_SCOPE] = ACCESS_TOKEN_SCOPES;

// --------------------------- the stage-6 resident table ---------------------------

/**
 * Every stage-6 resident tool, with the scope a caller's token must carry.
 *
 * The single source of truth for "exactly this set" and for the scope of each
 * name. AC-271's criterion reads the `session_cancel_queued` row from here
 * instead of re-typing the name or the scope; a later stage-6 task appends.
 */
export const MCP_STAGE6_RESIDENT_TOOLS = [
  {
    name: 'session_cancel_queued',
    scope: SESSION_CONTROL_SCOPE,
  },
] as const;

/** One stage-6 resident tool's name, derived from the table so the two cannot drift. */
export type McpStage6ResidentToolName = (typeof MCP_STAGE6_RESIDENT_TOOLS)[number]['name'];

// --------------------------- injected services ---------------------------

/**
 * The services the stage-6 resident tools answer from, all injected.
 *
 * Production passes the process singleton the write tools already use
 * (`server/index.ts`): the single chat control service (AC-233). The criterion
 * passes the same real object, wrapped by a spy that counts `cancelQueued`.
 */
export type McpResidentToolDeps = McpSessionCancelQueuedDeps;

/**
 * The seam `registerMcpResidentTools` installs through — the transport's audited
 * registration seam, shared with the read and write tools.
 */
export type McpResidentToolSeam = McpSessionCancelQueuedSeam;

// --------------------------- registration ---------------------------

/**
 * Registers every stage-6 resident tool exactly once, over `deps`.
 *
 * `session_cancel_queued`'s scope comes from {@link MCP_STAGE6_RESIDENT_TOOLS} —
 * the table is the one place the pair (name, scope) is written down — and its
 * handler is AC-271's `buildSessionCancelQueued`.
 */
export function registerMcpResidentTools(seam: McpResidentToolSeam, deps: McpResidentToolDeps): void {
  for (const tool of MCP_STAGE6_RESIDENT_TOOLS) {
    if (tool.name === 'session_cancel_queued') {
      registerMcpSessionCancelQueuedTool(seam, deps, tool.scope);
    }
  }
}
