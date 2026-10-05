/**
 * The MCP gateway's stage-4 write tools (AC-249).
 *
 * This module owns the one statement of "which write tools exist at stage 4" and
 * the scope each requires: {@link MCP_STAGE4_WRITE_TOOLS} names exactly the five
 * tools the SPEC's stage-4 table lists, and {@link registerMcpWriteTools}
 * installs exactly those names through the audited registration seam AC-244
 * landed. A later task that fills in `session_create` (AC-250) or
 * `session_interrupt` / `session_start` / `session_close` (AC-251) replaces a
 * handler here; it must NOT add or rename a tool, because the name set is a
 * contract the self-referential guard (AC-252) reads to know which tools to
 * protect.
 *
 * `session_send` (AC-249), `session_create` / `session_interrupt` (AC-250) and
 * `session_start` / `session_close` (AC-251) are implemented. The stage-4 table
 * always lists all five names; a tool whose deps are absent still registers with
 * a body that throws a NAMED `MCP_TOOL_NOT_IMPLEMENTED` refusal pointing at its
 * owner. Registering every name keeps the set stable, so a later task replaces a
 * handler without touching the set.
 *
 * The AC-250 handlers are wired through optional deps ({@link McpWriteToolDeps.sessionCreate}
 * / {@link McpWriteToolDeps.sessionInterrupt}): a mount that supplies them gets
 * the real behaviour, while a mount that does not — AC-249's criterion, which
 * exercises only `session_send` — keeps the placeholder and its exact old
 * registration. AC-251's two handlers ride the same seam through
 * {@link McpWriteToolDeps.sessionHostControl}; supplying it swaps in
 * `buildSessionStart` / `buildSessionClose`, which delegate to the session-hosts
 * module's own resident start/close services.
 *
 * The scope literals come from AC-243's single scope vocabulary
 * (`ACCESS_TOKEN_SCOPES`) rather than being re-typed here; the array's order is
 * pinned by the OAuth module's own vocabulary criterion, so the positional read
 * cannot silently select the wrong scope.
 */

import { z } from 'zod';

import { ACCESS_TOKEN_SCOPES } from '@/modules/oauth/index.js';

import type { McpPrincipal } from './mcp-gateway.auth.js';
import { MCP_TOOL_NOT_IMPLEMENTED_CODE } from './mcp-gateway.read-tools.js';
import {
  buildSessionCreate,
  buildSessionInterrupt,
  readSessionCreateInput,
  readSessionInterruptInput,
  SESSION_CREATE_INPUT_SCHEMA,
  SESSION_INTERRUPT_INPUT_SCHEMA,
} from './mcp-session-lifecycle.js';
import type { McpSessionCreateDeps, McpSessionInterruptDeps } from './mcp-session-lifecycle.js';
import {
  buildSessionClose,
  buildSessionStart,
  readSessionCloseInput,
  readSessionStartInput,
  SESSION_CLOSE_INPUT_SCHEMA,
  SESSION_START_INPUT_SCHEMA,
} from './mcp-session-host-control.js';
import type { McpSessionHostDeps } from './mcp-session-host-control.js';
import {
  buildSessionSend,
  readSessionSendInput,
  SESSION_SEND_INPUT_SCHEMA,
} from './mcp-session-send.js';
import type { McpControlSeam, McpRunReader, McpSessionRunGetSeam } from './mcp-session-send.js';

// --------------------------- scope vocabulary ---------------------------

// Positions within AC-243's vocabulary, in the order the constant declares and
// `access-token-scopes.test.ts` pins: read, session:send, session:create,
// session:control, approve.
const [, SESSION_SEND_SCOPE, SESSION_CREATE_SCOPE, SESSION_CONTROL_SCOPE] = ACCESS_TOKEN_SCOPES;

// --------------------------- the stage-4 write table ---------------------------

/**
 * Every write tool this stage ships, with the scope a caller's token must carry.
 * The single source of truth for (a) "exactly this set": the criterion compares
 * the SDK's `tools/list` names against this array, the transport reads each
 * registration's `requiredScope` from here rather than restating the literal,
 * and AC-252 reads the names from here rather than writing a second copy.
 */
export const MCP_STAGE4_WRITE_TOOLS = [
  {
    name: 'session_send',
    requiredScope: SESSION_SEND_SCOPE,
    description: 'Send a message to a session, returning the run id at once.',
  },
  {
    name: 'session_create',
    requiredScope: SESSION_CREATE_SCOPE,
    description: 'Create a session.',
  },
  {
    name: 'session_interrupt',
    requiredScope: SESSION_CONTROL_SCOPE,
    description: 'Interrupt the current run of a session.',
  },
  {
    name: 'session_start',
    requiredScope: SESSION_CONTROL_SCOPE,
    description: 'Start a session.',
  },
  {
    name: 'session_close',
    requiredScope: SESSION_CONTROL_SCOPE,
    description: 'Close a session.',
  },
] as const;

/** One stage-4 write tool's name, derived from the table so the two cannot drift. */
export type McpStage4WriteToolName = (typeof MCP_STAGE4_WRITE_TOOLS)[number]['name'];

// --------------------------- injected services ---------------------------

/**
 * The services the write tools answer from, all injected.
 *
 * Production passes the process singletons (`server/index.ts`): the single chat
 * control service every front end shares (AC-233), the run registry, and AC-248's
 * `run_get` builder over its own deps. The criterion passes the same real
 * objects over its fixture.
 */
export type McpWriteToolDeps = {
  control: McpControlSeam;
  runs: McpRunReader;
  runGet: McpSessionRunGetSeam;
  /**
   * The services `session_create` answers from (AC-250). Optional so a mount
   * that only exercises `session_send` — AC-240/244/245/249's criteria — stays a
   * valid deps bag and keeps `session_create`'s placeholder. Supplying it swaps
   * in `buildSessionCreate`.
   */
  sessionCreate?: McpSessionCreateDeps;
  /**
   * The abort seam `session_interrupt` answers from (AC-250). Optional for the
   * same reason as {@link McpWriteToolDeps.sessionCreate}: absent keeps the
   * placeholder, present swaps in `buildSessionInterrupt`.
   */
  sessionInterrupt?: McpSessionInterruptDeps;
  /**
   * The resident host start/close services `session_start` / `session_close`
   * answer from (AC-251). Optional for the same reason as the two above: a mount
   * that does not supply it — AC-240/244/245/249's criteria, none of which drive
   * these two tools — keeps their `MCP_TOOL_NOT_IMPLEMENTED` placeholder and its
   * exact old registration. Present swaps in `buildSessionStart` /
   * `buildSessionClose`, which delegate every start and close to the
   * session-hosts module's own services (production: `createSessionHostControl`
   * over the session-hosts barrel).
   */
  sessionHostControl?: McpSessionHostDeps;
};

// --------------------------- registration ---------------------------

/**
 * One write tool as it is handed to the registration seam.
 *
 * `outputSchema` is optional so the placeholder tools (no result schema) and
 * `session_send` (which declares one so its payload also reaches the client as
 * `structuredContent`) share one seam shape.
 */
export type McpWriteToolRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: { principal: McpPrincipal }) => unknown | Promise<unknown>;
};

/**
 * The seam `registerMcpWriteTools` installs through.
 *
 * The transport supplies one backed by AC-244's `withMcpAudit` (and, when wired,
 * AC-246's target gate), so every write tool inherits the single audit row and
 * the scope refusal without restating either. The criterion supplies a recording
 * seam, which is how it reads back the names and required scopes a registration
 * actually declared.
 */
export type McpWriteToolSeam = (registration: McpWriteToolRegistration) => void;

/**
 * The refusal a registered-but-unowned write tool answers with. AC-250 delivers
 * `session_create` and `session_interrupt`; AC-251 delivers `session_start` and
 * `session_close`.
 */
function notImplemented(name: McpStage4WriteToolName, owner: string): never {
  throw new Error(
    JSON.stringify({
      code: MCP_TOOL_NOT_IMPLEMENTED_CODE,
      tool: name,
      owner,
      message: `${name} is registered by AC-249 but its behaviour is delivered by ${owner}.`,
    }),
  );
}

/**
 * Which later task owns each placeholder tool's behaviour.
 *
 * Only reached when the matching optional deps are absent — the real handlers
 * (AC-249's `session_send`, AC-250's `session_create` / `session_interrupt`)
 * register ahead of this map, so the owner named here is informational for the
 * two that still lack behaviour.
 */
const PLACEHOLDER_OWNER: Record<McpStage4WriteToolName, string> = {
  session_send: 'AC-249',
  session_create: 'AC-250',
  session_interrupt: 'AC-250',
  session_start: 'AC-251',
  session_close: 'AC-251',
};

/**
 * Registers every stage-4 write tool exactly once.
 *
 * The scope comes from {@link MCP_STAGE4_WRITE_TOOLS} — the table is the one
 * place the pair (name, scope) is written down. `session_send`'s handler is
 * `buildSessionSend`; AC-250's two handlers are installed when their optional
 * deps are present; the rest throw a named `MCP_TOOL_NOT_IMPLEMENTED` refusal
 * owned by AC-250/AC-251, so the registered name set is stable across those
 * tasks.
 */
export function registerMcpWriteTools(seam: McpWriteToolSeam, deps: McpWriteToolDeps): void {
  const sessionCreate = deps.sessionCreate;
  const sessionInterrupt = deps.sessionInterrupt;
  const sessionHostControl = deps.sessionHostControl;
  for (const tool of MCP_STAGE4_WRITE_TOOLS) {
    if (tool.name === 'session_send') {
      seam({
        name: tool.name,
        description: tool.description,
        requiredScope: tool.requiredScope,
        inputSchema: SESSION_SEND_INPUT_SCHEMA,
        outputSchema: {
          runId: z.string(),
          queued: z.boolean(),
          queuedMessageUuid: z.string().nullable(),
          source: z.string(),
          run: z.unknown().optional(),
        },
        handler: (args, ctx) => buildSessionSend(readSessionSendInput(args), ctx, deps),
      });
      continue;
    }
    if (tool.name === 'session_create' && sessionCreate !== undefined) {
      seam({
        name: tool.name,
        description: tool.description,
        requiredScope: tool.requiredScope,
        inputSchema: SESSION_CREATE_INPUT_SCHEMA,
        outputSchema: { sessionId: z.string(), runId: z.string().optional() },
        handler: (args, ctx) => buildSessionCreate(readSessionCreateInput(args), ctx, sessionCreate),
      });
      continue;
    }
    if (tool.name === 'session_interrupt' && sessionInterrupt !== undefined) {
      seam({
        name: tool.name,
        description: tool.description,
        requiredScope: tool.requiredScope,
        inputSchema: SESSION_INTERRUPT_INPUT_SCHEMA,
        outputSchema: { aborted: z.boolean(), message: z.string().optional() },
        handler: (args, ctx) => buildSessionInterrupt(readSessionInterruptInput(args), ctx, sessionInterrupt),
      });
      continue;
    }
    if (tool.name === 'session_start' && sessionHostControl !== undefined) {
      seam({
        name: tool.name,
        description: tool.description,
        requiredScope: tool.requiredScope,
        inputSchema: SESSION_START_INPUT_SCHEMA,
        outputSchema: { hostId: z.string(), sessionId: z.string(), mode: z.string(), pid: z.number().nullable() },
        handler: (args, ctx) => buildSessionStart(readSessionStartInput(args), ctx, sessionHostControl),
      });
      continue;
    }
    if (tool.name === 'session_close' && sessionHostControl !== undefined) {
      seam({
        name: tool.name,
        description: tool.description,
        requiredScope: tool.requiredScope,
        inputSchema: SESSION_CLOSE_INPUT_SCHEMA,
        outputSchema: {
          hostId: z.string(),
          sessionId: z.string(),
          mode: z.string(),
          closeReason: z.string(),
          leases: z.array(z.unknown()),
        },
        handler: (args, ctx) => buildSessionClose(readSessionCloseInput(args), ctx, sessionHostControl),
      });
      continue;
    }
    seam({
      name: tool.name,
      description: tool.description,
      requiredScope: tool.requiredScope,
      inputSchema: {},
      handler: () => notImplemented(tool.name, PLACEHOLDER_OWNER[tool.name]),
    });
  }
}
