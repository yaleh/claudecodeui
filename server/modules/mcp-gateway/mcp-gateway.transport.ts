import type { Express, RequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolRegistrar } from './mcp-gateway.audit.js';
import { withMcpAudit } from './mcp-gateway.audit.js';
import { readMcpPrincipal } from './mcp-gateway.auth.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import { MCP_GATEWAY_PATH, readMcpGatewayGate } from './mcp-gateway.gate.js';
import { createMcpLoopbackGuard } from './mcp-gateway.loopback.js';
import { registerMcpReadTools } from './mcp-gateway.read-tools.js';
import type { McpReadToolDeps, McpReadToolSeam } from './mcp-gateway.read-tools.js';

/**
 * The MCP gateway's production assembly (AC-240). The consumer is
 * `server/index.ts`, which mounts it BEFORE the static-assets middleware.
 *
 * `/mcp` is a STATELESS Streamable HTTP endpoint: every POST builds its own
 * `StreamableHTTPServerTransport` with no session generator and its own
 * `McpServer`, connects them, and hands the request to the transport. Two
 * consecutive requests from one client are therefore two independent exchanges,
 * neither carrying an `Mcp-Session-Id`. `GET`/`DELETE` answer 405 in JSON-RPC,
 * following the SDK's stateless recipe.
 *
 * Mount ORDER is load-bearing, not cosmetic: mounted after the static layer the
 * SPA catch-all would answer `/mcp` with `200 text/html` and no MCP client would
 * ever reach the transport — which is why the mount call sits before
 * `createStaticAssetsMiddleware` and a criterion scans for that order.
 *
 * The gate decides AT MOUNT TIME. When `MCP_ENABLED` is not truthy nothing is
 * attached — no `app.post`/`app.get`/`app.delete` layer exists at the path — so
 * the path is ABSENT rather than forbidden. `authorize` is a seam: the default
 * refuses every request (fail-closed 401) and AC-241/242 replace it with token
 * and loopback checks in front of the transport.
 */

/** Advertised to MCP clients in the `initialize` handshake. */
const SERVER_INFO = { name: 'claudecodeui-mcp-gateway', version: '0.1.0' };

/**
 * A fresh server per request, the stateless recipe's other half.
 *
 * Which tools it carries is decided here, once per request:
 *
 *  1. an explicit `registerTools` seam wins — the criterion-injected path
 *     AC-244's audit criterion uses to install scripted tools;
 *  2. otherwise, when production deps were supplied, AC-245's read tools are
 *     registered through the SAME audited wrapper (a seam closing over this
 *     request's server and principal), so each read tool inherits its audit row
 *     and its `cloudcli:read` refusal without restating either;
 *  3. otherwise an empty list handler is installed, because the server still has
 *     to answer `tools/list` with a result rather than "method not found"
 *     (AC-240's tools-less mount).
 *
 * The three paths are exclusive: a registered tool installs the SDK's own
 * list/call handlers, which would collide with a second, manual `tools/list`.
 */
function createMcpServer(
  registerTools: McpToolRegistrar | undefined,
  principal: McpPrincipal | null,
  readTools: McpReadToolDeps | undefined
): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  if (registerTools) {
    registerTools(server, principal);
  } else if (readTools) {
    const register: McpReadToolSeam = (registration) =>
      withMcpAudit({
        name: registration.name,
        description: registration.description,
        inputSchema: registration.inputSchema,
        outputSchema: registration.outputSchema,
        requiredScopes: [registration.requiredScope],
        handler: (args) => registration.handler(args as Record<string, unknown>),
      })(server, principal);
    registerMcpReadTools(register, readTools);
  } else {
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  }

  return server;
}

/**
 * Attaches the three `/mcp` methods onto `app`.
 *
 * Middleware order is load-bearing and written down in exactly one place: body
 * parsing (the caller's) -> the loopback guard -> the injected `authorize` -> the
 * transport handler. The guard sits BEFORE authentication so a request it rejects
 * cannot even reach the token check (AC-242 leg (d) reads this off the spy count);
 * a request it admits still has to pass `authorize`.
 */
function attachTransport(
  app: Express,
  authorize: RequestHandler,
  env: NodeJS.ProcessEnv | undefined,
  registerTools: McpToolRegistrar | undefined,
  readTools: McpReadToolDeps | undefined
): void {
  const loopbackGuard = createMcpLoopbackGuard(env);

  app.post(MCP_GATEWAY_PATH, loopbackGuard, authorize, async (req, res) => {
    // The principal the auth middleware attached; audited tools are registered
    // per request against it, so the audit row names the invoking token.
    const server = createMcpServer(registerTools, readMcpPrincipal(res), readTools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get(MCP_GATEWAY_PATH, loopbackGuard, authorize, methodNotAllowed);
  app.delete(MCP_GATEWAY_PATH, loopbackGuard, authorize, methodNotAllowed);
}

/**
 * The fail-closed default for the `authorize` seam: until AC-241 replaces it, an
 * enabled gateway refuses every request rather than serving unauthenticated MCP
 * traffic.
 */
const refuseUnauthorized: RequestHandler = (_req, res) => {
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
};

/**
 * The seams `mountMcpGateway` reads. Both are injectable so the criterion can
 * (i) read both gate states in one process and (ii) measure the transport alone,
 * without depending on the token/loopback tasks that land later.
 */
export type McpGatewayDeps = {
  /**
   * Environment read by the mount-time gate (`MCP_ENABLED`) AND, per request, by
   * the loopback guard (the MCP OAuth switch). Defaults to `process.env`; the
   * criterion passes two differently-valued objects to read both switch states in
   * one process.
   */
  env?: NodeJS.ProcessEnv;
  /** Auth middleware in front of the transport. Defaults to a fail-closed 401. */
  authorize?: RequestHandler;
  /**
   * The tool-registration seam (AC-244): called once per request with the
   * request's principal, it installs the gateway's tools. Audited tools come from
   * `withMcpAudit`; AC-245+'s real tools register through this same seam.
   *
   * When it is absent and {@link McpGatewayDeps.readTools} is present, the
   * transport registers AC-245's read tools instead. Supplying both is legal and
   * means "this caller owns the tool set": the explicit seam wins.
   */
  registerTools?: McpToolRegistrar;
  /**
   * The services AC-245's read tools answer from, assembled by the composition
   * root (`server/index.ts`) over the process singletons. Absent on a mount that
   * registers its own tools, and absent is what keeps a tools-less mount
   * (AC-240's criterion) answering an empty `tools/list`.
   */
  readTools?: McpReadToolDeps;
};

/** Whether the gateway attached anything, and the gate's own reason. */
export type McpGatewayReading = {
  mounted: boolean;
  reason: string;
};

/**
 * Mounts the stateless `/mcp` endpoint, or attaches nothing at all.
 *
 * Returns the decision so the entrypoint can log it. The attach is SKIPPED — not
 * guarded downstream — when the gate is closed: nothing is added to the
 * application's middleware stack, so the path has no layer to reach and the
 * static catch-all below (or Express's own 404) answers instead.
 */
export function mountMcpGateway(app: Express, deps: McpGatewayDeps = {}): McpGatewayReading {
  const gate = readMcpGatewayGate(deps.env);
  if (!gate.enabled) {
    return { mounted: false, reason: gate.reason };
  }

  attachTransport(app, deps.authorize ?? refuseUnauthorized, deps.env, deps.registerTools, deps.readTools);
  return { mounted: true, reason: gate.reason };
}
