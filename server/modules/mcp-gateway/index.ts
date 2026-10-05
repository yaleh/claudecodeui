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
