// The MCP gateway's public surface (AC-240).
//
// Importing this module is inert: the gate is read inside `mountMcpGateway`, not
// at import time, so a consumer pays nothing until it mounts. Cross-module
// consumers must come through here (backend module standards /
// `boundaries/dependencies`):
//
//  - `server/index.ts` — mounts the stateless `/mcp` endpoint before the static
//    assets middleware, logs the gate's decision, and injects the shared
//    `createMcpAuthMiddleware` instance that verifies `ccp_` tokens through the
//    process's single `AccessTokensService`.
//
// The criterion is the module's own test, which reaches the barrel by relative
// path and the gate through `mountMcpGateway`'s injectable seams.
export { MCP_GATEWAY_PATH, readMcpGatewayGate } from './mcp-gateway.gate.js';
export type { McpGatewayGateReading } from './mcp-gateway.gate.js';

export { mountMcpGateway } from './mcp-gateway.transport.js';
export type { McpGatewayDeps, McpGatewayReading } from './mcp-gateway.transport.js';

export { createMcpAuthMiddleware, readMcpPrincipal } from './mcp-gateway.auth.js';
export type { McpPrincipal } from './mcp-gateway.auth.js';

export { createMcpLoopbackGuard, isLoopbackRemoteAddress, readMcpOauthEnabled } from './mcp-gateway.loopback.js';

// The OAuth discovery documents (AC-262): `readOAuthMetadataGate` / `readMcpDcrMode`
// decide, `mountOAuthMetadata` attaches. `server/index.ts` mounts it (and logs the
// decision) before the static layer; the AC-262 criterion reads the gate and the
// mounted endpoints directly. `readMcpDcrMode` is also the reader AC-264 will reuse
// rather than redefining.
export { readMcpDcrMode, readOAuthMetadataGate } from './oauth-metadata.gate.js';
export type { OAuthMetadataGateReading } from './oauth-metadata.gate.js';

export { mountOAuthMetadata } from './oauth-metadata.mount.js';
export type { OAuthMetadataMountReading } from './oauth-metadata.mount.js';
