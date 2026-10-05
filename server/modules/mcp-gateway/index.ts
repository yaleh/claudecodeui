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
