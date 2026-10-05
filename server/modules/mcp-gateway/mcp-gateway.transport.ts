import type { Express, RequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { MCP_GATEWAY_PATH, readMcpGatewayGate } from './mcp-gateway.gate.js';

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
 * No tools are registered yet — AC-245+ fills them — but `tools/list` must still
 * answer with a result rather than a "method not found", so it is registered
 * explicitly with an empty tool set. The `tools` capability is declared for the
 * same reason: without it the SDK refuses to install the list handler at all.
 */
function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));

  return server;
}

/** Attaches the three `/mcp` methods onto `app`, in front of `authorize`. */
function attachTransport(app: Express, authorize: RequestHandler): void {
  app.post(MCP_GATEWAY_PATH, authorize, async (req, res) => {
    const server = createMcpServer();
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
  app.get(MCP_GATEWAY_PATH, authorize, methodNotAllowed);
  app.delete(MCP_GATEWAY_PATH, authorize, methodNotAllowed);
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
  /** Environment to read the gate from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Auth middleware in front of the transport. Defaults to a fail-closed 401. */
  authorize?: RequestHandler;
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

  attachTransport(app, deps.authorize ?? refuseUnauthorized);
  return { mounted: true, reason: gate.reason };
}
