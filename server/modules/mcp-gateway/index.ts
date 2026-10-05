// The MCP gateway's public surface (AC-240).
//
// Importing this module is inert: the gate is read inside `mountMcpGateway`, not
// at import time, so a consumer pays nothing until it mounts. Cross-module
// consumers must come through here (backend module standards /
// `boundaries/dependencies`):
//
//  - `server/index.ts` — mounts the stateless `/mcp` endpoint before the static
//    assets middleware, logs the gate's decision, and supplies the process's
//    single `AccessTokensService` plus the OAuth verification seam so the mount
//    builds the shared `createMcpAuthMiddleware` that verifies `ccp_` tokens
//    (AC-241) and, once OAuth is on, `cca_` tokens against their audience
//    (AC-263).
//
// The criterion is the module's own test, which reaches the barrel by relative
// path and the gate through `mountMcpGateway`'s injectable seams.
export { MCP_GATEWAY_PATH, readMcpGatewayGate } from './mcp-gateway.gate.js';
export type { McpGatewayGateReading } from './mcp-gateway.gate.js';

export { mountMcpGateway } from './mcp-gateway.transport.js';
export type { McpGatewayDeps, McpGatewayReading } from './mcp-gateway.transport.js';

export { createMcpAuthMiddleware, readMcpPrincipal } from './mcp-gateway.auth.js';
export type {
  McpAuthMiddlewareOptions,
  McpOauthSeam,
  McpOauthVerification,
  McpPrincipal,
} from './mcp-gateway.auth.js';

// The audit surface (AC-244): `withMcpAudit` wraps a tool so every call writes
// exactly one `mcp_audit_log` row; `summarizeToolArgs` reduces arguments to a
// digest; `recordMcpToolCall` is the single writer those paths funnel through;
// `startMcpAuditRetention` runs the 90-day sweep at startup and daily. The
// transport registers AC-245+'s tools through `withMcpAudit`; this module's
// criterion drives each export directly.
export { recordMcpToolCall, startMcpAuditRetention, summarizeToolArgs, withMcpAudit } from './mcp-gateway.audit.js';
export type {
  McpAuditOutcome,
  McpAuditRetentionOptions,
  McpToolCallReading,
  McpToolHandler,
  McpToolRegistrar,
  McpToolRegistration,
} from './mcp-gateway.audit.js';

export { createMcpLoopbackGuard, isLoopbackRemoteAddress, readMcpOauthEnabled } from './mcp-gateway.loopback.js';

// The OAuth discovery documents (AC-262): `readOAuthMetadataGate` / `readMcpDcrMode`
// decide, `mountOAuthMetadata` attaches. `server/index.ts` mounts it (and logs the
// decision) before the static layer; the AC-262 criterion reads the gate and the
// mounted endpoints directly. `readMcpDcrMode` is also the reader AC-264 will reuse
// rather than redefining.
export { readMcpDcrMode, readOAuthMetadataGate } from './oauth-metadata.gate.js';
// buildAuthorizationServerMetadata: the pure metadata builder. Consumers: this
// module's `mountOAuthMetadata`, and the AC-264 DCR criterion, which reads the
// `registration_endpoint` it advertises per DCR mode.
export { buildAuthorizationServerMetadata } from './oauth-metadata.gate.js';
export type { AuthorizationServerMetadata, OAuthMetadataGateReading } from './oauth-metadata.gate.js';

export { mountOAuthMetadata } from './oauth-metadata.mount.js';
export type { OAuthMetadataMountReading } from './oauth-metadata.mount.js';

// The stage-3 read tools (AC-245). `MCP_STAGE3_READ_TOOLS` is the one statement
// of which read tools exist and the scope each requires — the transport's
// registration and the criterion's `tools/list` comparison both read it, so the
// name set is a contract rather than a coincidence. `registerMcpReadTools`
// installs them through the audited seam; `paginateMcpText` and
// `formatMcpTime` are the two text-shaping helpers the criterion drives
// directly (the 4000-character cursor protocol, and the relative+ISO time
// pair); `MCP_TEXT_CHUNK_CHARS` and `MCP_TOOL_NOT_IMPLEMENTED_CODE` are the
// values it asserts against instead of restating.
export {
  formatMcpTime,
  MCP_STAGE3_READ_TOOLS,
  MCP_TEXT_CHUNK_CHARS,
  MCP_TOOL_NOT_IMPLEMENTED_CODE,
  paginateMcpText,
  registerMcpReadTools,
} from './mcp-gateway.read-tools.js';
export type {
  McpReadToolDeps,
  McpReadToolSeam,
  McpTime,
} from './mcp-gateway.read-tools.js';

// The overview tools (AC-247). `buildOverview` answers the whole-workspace
// reading (running / awaiting-permission / aborted sessions, resident hosts, and
// per-project quay state read from the snapshot cache ONLY); `buildQuaySnapshot`
// reads one project, refreshing it exactly once when asked. `McpQuayRunner` is
// the injected runner seam (`server/index.ts` binds it to `quayService`);
// `McpOverviewDeps` is the deps bag those two read; `registerMcpOverviewTools`
// installs the two names through the audited seam (consumed by
// `registerMcpReadTools` when the deps are wired, and driven directly by this
// module's criterion). `isOverviewWired` is the branch `registerMcpReadTools`
// takes between the real handlers and the named refusal.
export {
  buildOverview,
  buildQuaySnapshot,
  isOverviewWired,
  NO_QUAY_NOTE,
  registerMcpOverviewTools,
  UNKNOWN_QUAY_NOTE,
} from './mcp-overview-tools.js';
export type {
  McpActivityReader,
  McpOverviewAwaiting,
  McpOverviewAborted,
  McpOverviewDeps,
  McpOverviewHost,
  McpOverviewQuayEntry,
  McpOverviewReadDeps,
  McpOverviewRegistration,
  McpOverviewRunning,
  McpQuayRunner,
  McpQuaySnapshotInput,
  McpQuaySnapshotPayload,
  McpQuaySnapshotReading,
  OverviewPayload,
} from './mcp-overview-tools.js';

// The run-by-id tool (AC-248). `buildRunGet` reads one run by id and waits a
// BOUNDED time for it to settle (terminal / `awaitingPermission` / timeout),
// reading the run registry, the activity store and the sessions history through
// injected seams so the wait moves only on the injected clock and sleeper.
// `MCP_RUN_GET_MAX_WAIT_SECONDS` is the one literal for the cap — AC-248's
// criterion imports it instead of re-typing 25, and a later `session_send`
// reuses it rather than writing a second copy. `registerMcpRunGetTool` installs
// the one `run_get` handler through the audited seam (consumed by
// `registerMcpReadTools` when the deps are wired); `isRunGetWired` is the branch
// it takes between the real handler and the named refusal.
export {
  buildRunGet,
  isRunGetWired,
  MCP_RUN_GET_MAX_WAIT_SECONDS,
  registerMcpRunGetTool,
} from './mcp-run-get.js';
export type {
  McpRunGetDeps,
  McpRunGetFallback,
  McpRunGetHit,
  McpRunGetInput,
  McpRunGetMiss,
  McpRunGetMissReason,
  McpRunGetOutcome,
  McpRunGetRegistration,
  RunGetPayload,
} from './mcp-run-get.js';

// The stage-4 write tools (AC-249). `MCP_STAGE4_WRITE_TOOLS` is the one
// statement of which write tools exist and the scope each requires — the
// self-referential guard (AC-252) reads the names from it rather than writing a
// second copy, and the criterion compares `tools/list` against it.
// `registerMcpWriteTools` installs the five names through the same audited seam
// AC-245's read tools use (consumed by `mcp-gateway.transport.ts` when the mount
// carries a write-tools deps bag). `buildSessionSend` is `session_send`'s
// adapter — tool input to a `ControlCaller` + `SendInput`, then the control
// service's result to the JSON-bodied payload the audit wrapper renders; the
// criterion drives it through the real mount, and `server/index.ts` supplies the
// deps it reads. `SESSION_SEND_INPUT_SCHEMA` / `readSessionSendInput` are the
// one argument shape, shared by registration and validation.
export { MCP_STAGE4_WRITE_TOOLS, registerMcpWriteTools } from './mcp-gateway.write-tools.js';
export type {
  McpStage4WriteToolName,
  McpWriteToolDeps,
  McpWriteToolRegistration,
  McpWriteToolSeam,
} from './mcp-gateway.write-tools.js';

export { buildSessionSend, readSessionSendInput, SESSION_SEND_INPUT_SCHEMA } from './mcp-session-send.js';
export type {
  McpControlCaller,
  McpControlRefusalCode,
  McpControlSeam,
  McpControlSendResult,
  McpRunReader,
  McpSessionRunGetSeam,
  McpSessionRunRecord,
  McpSessionSendDeps,
  McpSessionSendInput,
  SessionSendPayload,
} from './mcp-session-send.js';

// The session lifecycle write tools (AC-250). `buildSessionCreate` creates a
// session through the real `sessionsService.createAppSession` and, only for a
// non-empty message, opens its first run through the same `ChatControlService`
// a UI send uses — returning the run id alongside the session id, and starting
// nothing when no message was given. `buildSessionInterrupt` stops the run a
// session currently has through the control service's `abort` and leaves the
// resident host untouched; an idle session is reported as `aborted: false` with
// a message saying there was no run to abort. `registerMcpWriteTools` installs
// both when `McpWriteToolDeps.sessionCreate` / `.sessionInterrupt` are supplied;
// `server/index.ts` (via AC-253) supplies them, and this module's criterion
// drives both through the real mount. The two input schemas / readers are the
// one argument shape, shared by registration and validation.
export {
  buildSessionCreate,
  buildSessionInterrupt,
  readSessionCreateInput,
  readSessionInterruptInput,
  SESSION_CREATE_INPUT_SCHEMA,
  SESSION_INTERRUPT_INPUT_SCHEMA,
} from './mcp-session-lifecycle.js';
export type {
  McpControlAbortResult,
  McpControlAbortSeam,
  McpProjectEntry,
  McpSessionCreateDeps,
  McpSessionCreateInput,
  McpSessionInterruptDeps,
  McpSessionInterruptInput,
  SessionCreatePayload,
  SessionInterruptPayload,
} from './mcp-session-lifecycle.js';

// The resident host control write tools (AC-251). `buildSessionStart` starts a
// session's resident host by delegating to the session-hosts module's
// `startResidentHost` — so an already-running session answers with the SAME host
// and pid rather than a second process — and `buildSessionClose` delegates to
// `closeResidentHost`, refusing first (with `SESSION_HAS_ACTIVE_LEASES`) while
// the session holds a `cron` / `background-task` lease and no `force: true` was
// given. `createSessionHostControl` is the production wiring over the
// session-hosts barrel (consumed by `server/index.ts` via AC-253 and by this
// module's criterion); `McpSessionHostDeps` is the injected seam those two
// handlers read; the two input schemas / readers are the one argument shape,
// shared by registration and validation. `registerMcpWriteTools` installs both
// handlers when `McpWriteToolDeps.sessionHostControl` is supplied.
export {
  buildSessionClose,
  buildSessionStart,
  createSessionHostControl,
  readLiveHost,
  readSessionCloseInput,
  readSessionStartInput,
  SESSION_CLOSE_INPUT_SCHEMA,
  SESSION_HAS_ACTIVE_LEASES_CODE,
  SESSION_START_INPUT_SCHEMA,
} from './mcp-session-host-control.js';
export type {
  McpSessionCloseInput,
  McpSessionHostControl,
  McpSessionHostDeps,
  McpSessionStartInput,
  SessionClosePayload,
  SessionStartPayload,
} from './mcp-session-host-control.js';

// The target-resolution surface (AC-246). `resolveMcpTarget` turns a caller's
// project/session reference into one id (or into an explicit refusal listing the
// candidates), and `resolveInputTargets` is the gate that applies it to a tool's
// `project`/`session` argument before its handler runs. Consumers: the transport
// (which wires the gate onto every tool it registers, from `resolveDeps`), and
// AC-245's read tools / AC-249–AC-251's write tools / AC-250's `session_create`,
// which take ids and names through the same two functions instead of writing a
// resolution rule of their own. This module's criterion drives both directly.
export { resolveInputTargets, resolveMcpTarget } from './mcp-resolve-target.js';
export type {
  McpResolveCandidate,
  McpResolveDeps,
  McpResolveEntry,
  McpResolveResult,
  McpTargetKind,
} from './mcp-resolve-target.js';

// The stage-6 resident tools (AC-271, extended by AC-272). `MCP_STAGE6_RESIDENT_TOOLS`
// is the one statement of the table-listed stage-6 tools and the scope each
// requires — AC-272 adds `session_reconfigure` alongside it rather than growing
// the table, because AC-271's criterion pins the table's observable contents;
// AC-252's self-referential guard reads the gateway tool names from these
// tables. `registerMcpResidentTools` installs them through the same audited
// seam the read/write tools use; the transport calls it when the mount carries
// a resident-tools deps bag. `buildSessionCancelQueued` is `session_cancel_queued`'s
// adapter — it translates the control service's `withdrawn` into AC-271's
// `cancelled`, and never reads a non-withdrawn verdict as `cancelled` — driven
// by the criterion through the real mount; `server/index.ts` supplies the deps.
export { MCP_STAGE6_RESIDENT_TOOLS, registerMcpResidentTools } from './mcp-gateway.resident-tools.js';
export type { McpResidentToolDeps, McpResidentToolSeam, McpStage6ResidentToolName } from './mcp-gateway.resident-tools.js';

export { buildSessionCancelQueued, readSessionCancelQueuedInput, SESSION_CANCEL_QUEUED_INPUT_SCHEMA } from './mcp-session-cancel-queued.js';
export type {
  McpSessionCancelQueuedDeps,
  McpSessionCancelQueuedInput,
  McpSessionCancelQueuedRegistration,
  McpSessionCancelQueuedSeam,
  SessionCancelQueuedOutcome,
  SessionCancelQueuedPayload,
} from './mcp-session-cancel-queued.js';

// `session_reconfigure` (AC-272). `buildSessionReconfigure` records a session's
// model/effort/permissionMode and, when the provider declares the setting live,
// asks the running resident process to move; an unsupported permission mode is
// REFUSED with the supported list (the deliberate opposite of the WebSocket
// path's silent ignore). `registerMcpSessionReconfigureTool` installs it through
// the audited seam under `cloudcli:session:control`; the transport registers it
// via `registerMcpResidentTools` and `server/index.ts` supplies the deps.
export {
  buildSessionReconfigure,
  readSessionReconfigureInput,
  registerMcpSessionReconfigureTool,
  SESSION_RECONFIGURE_FIELDS,
  SESSION_RECONFIGURE_INPUT_SCHEMA,
} from './mcp-session-reconfigure.js';
export type {
  McpSessionReconfigureDeps,
  McpSessionReconfigureInput,
  McpSessionReconfigureRegistration,
  McpSessionReconfigureSeam,
  SessionReconfigureField,
  SessionReconfigurePayload,
} from './mcp-session-reconfigure.js';

// The self-referential guard (AC-252). `buildSelfTargetGuard` is the decision the
// write-tool dispatch point (`registerMcpWriteTools`) applies before each write
// handler: a target session whose live turn is executing a gateway write tool
// (`phase === 'tool'` and an `mcp__<any alias>__<write tool name>` `toolName`)
// is refused with `SELF_TARGET_CODE`, so the control and host services are never
// reached. `isSelfTargetTurn` is the pure rule over one turn and the injected
// write-tool name set; `MCP_SELF_TARGET_WRITE_OPS` is the one statement of which
// operations are protected. `SelfTargetDeps` is the injectable seam (turn
// reader + write-tool names) the transport threads from
// `McpGatewayDeps.selfTarget`; `SelfTargetDecision` is the answer shape. This
// module's criterion drives both functions directly (including the
// `session_cancel_queued` operation) and through the real `/mcp` mount.
export {
  buildSelfTargetGuard,
  isSelfTargetTurn,
  MCP_SELF_TARGET_WRITE_OPS,
  SELF_TARGET_CODE,
} from './mcp-self-target.js';
export type { SelfTargetDecision, SelfTargetDeps } from './mcp-self-target.js';
