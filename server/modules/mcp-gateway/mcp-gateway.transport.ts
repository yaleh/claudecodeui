import type { Express, RequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';

import type { AccessTokensService } from '@/modules/oauth/index.js';

import type { McpToolRegistrar } from './mcp-gateway.audit.js';
import { withMcpAudit } from './mcp-gateway.audit.js';
import { createMcpAuthMiddleware, readMcpPrincipal } from './mcp-gateway.auth.js';
import type { McpOauthSeam, McpPrincipal } from './mcp-gateway.auth.js';
import { MCP_GATEWAY_PATH, readMcpGatewayGate } from './mcp-gateway.gate.js';
import { createMcpLoopbackGuard } from './mcp-gateway.loopback.js';
import { registerMcpReadTools } from './mcp-gateway.read-tools.js';
import type { McpReadToolDeps, McpReadToolSeam } from './mcp-gateway.read-tools.js';
import { registerMcpWriteTools } from './mcp-gateway.write-tools.js';
import type { McpWriteToolDeps, McpWriteToolSeam } from './mcp-gateway.write-tools.js';
import { resolveInputTargets } from './mcp-resolve-target.js';
import type { McpResolveDeps } from './mcp-resolve-target.js';

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
 * refuses every request (fail-closed 401), while supplying `tokens` (and, once
 * OAuth is on, `oauth`) lets this mount build the real AC-241/AC-263 auth
 * middleware in front of the transport.
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
 *
 * AC-246's target gate sits INSIDE the audited wrapper and OUTSIDE the tool
 * body (path 2): a `project` / `session` argument is resolved to an id before
 * the read tool's handler runs, and an unresolvable target refuses the call
 * there. The gate is applied only when {@link McpGatewayDeps.resolveDeps} was
 * supplied — an unwired mount keeps AC-240/244/245's exact behaviour, and the
 * write tools AC-249 registers compose the same `resolveInputTargets` wrapper.
 *
 * Stage-4 write tools (AC-249, extended by AC-250) register through the same
 * seam when {@link McpGatewayDeps.writeTools} is present, so their audit row,
 * scope refusal and target gate are the identical machinery — only the name set
 * and the handlers differ. The write-tools bag flows through unchanged, so
 * AC-250's `sessionCreate` / `sessionInterrupt` members reach
 * `registerMcpWriteTools` and swap in the real `session_create` /
 * `session_interrupt` handlers; a bag without them keeps the placeholders. An
 * unwired mount registers neither read nor write tools and keeps answering an
 * empty `tools/list`.
 */
function createMcpServer(
  registerTools: McpToolRegistrar | undefined,
  principal: McpPrincipal | null,
  readTools: McpReadToolDeps | undefined,
  writeTools: McpWriteToolDeps | undefined,
  resolveDeps: McpResolveDeps | undefined
): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  if (registerTools) {
    registerTools(server, principal);
    return server;
  }
  if (!readTools && !writeTools) {
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    return server;
  }

  /**
   * Applies AC-246's target gate then AC-244's audit wrapper, in that order, to
   * one tool body. Composed once per registration, not per call: the gate closes
   * over the injected entry lists and the tool body, and nothing else.
   */
  const audited = (
    name: string,
    description: string | undefined,
    requiredScope: string,
    inputSchema: ZodRawShape,
    outputSchema: ZodRawShape | undefined,
    handle: (args: Record<string, unknown>) => unknown | Promise<unknown>,
  ): void => {
    const guarded = resolveDeps === undefined ? handle : resolveInputTargets(handle, resolveDeps);
    withMcpAudit({
      name,
      description,
      inputSchema,
      outputSchema,
      requiredScopes: [requiredScope],
      handler: (args) => guarded(args as Record<string, unknown>),
    })(server, principal);
  };

  if (readTools) {
    const register: McpReadToolSeam = (registration) =>
      audited(
        registration.name,
        registration.description,
        registration.requiredScope,
        registration.inputSchema,
        registration.outputSchema,
        (args) => registration.handler(args),
      );
    registerMcpReadTools(register, readTools);
  }

  if (writeTools) {
    const register: McpWriteToolSeam = (registration) =>
      audited(
        registration.name,
        registration.description,
        registration.requiredScope,
        registration.inputSchema,
        registration.outputSchema,
        (args) => {
          if (principal === null) {
            // Unreachable: `withMcpAudit` denies a null principal before the
            // handler is reached. Stated rather than asserted so a future
            // wrapper change fails loudly instead of handing `null` on.
            throw new Error(`${registration.name} requires an authenticated principal.`);
          }
          return registration.handler(args, { principal });
        },
      );
    registerMcpWriteTools(register, writeTools);
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
  readTools: McpReadToolDeps | undefined,
  writeTools: McpWriteToolDeps | undefined,
  resolveDeps: McpResolveDeps | undefined
): void {
  const loopbackGuard = createMcpLoopbackGuard(env);

  app.post(MCP_GATEWAY_PATH, loopbackGuard, authorize, async (req, res) => {
    // The principal the auth middleware attached; audited tools are registered
    // per request against it, so the audit row names the invoking token.
    const server = createMcpServer(registerTools, readMcpPrincipal(res), readTools, writeTools, resolveDeps);
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
   * The token service the DEFAULT auth middleware verifies `ccp_` tokens through
   * (AC-241). Supplying it — instead of an explicit `authorize` — lets this mount
   * build the real middleware and thread {@link McpGatewayDeps.oauth} into it;
   * `server/index.ts` is the consumer that does so. Absent on a mount that injects
   * its own `authorize` (AC-240/241/244/245's criteria).
   */
  tokens?: AccessTokensService;
  /**
   * The OAuth access-token verification seam (AC-263), threaded into the default
   * auth middleware so `/mcp` accepts `cca_` tokens once OAuth is on. Only read
   * when `tokens` is supplied and `authorize` is not.
   */
  oauth?: McpOauthSeam;
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
  /**
   * The services AC-249's stage-4 write tools answer from, assembled by the
   * composition root (`server/index.ts`) over the process singletons: the single
   * chat control service the WebSocket gateway and the scheduled timer share
   * (AC-233), the run registry, AC-248's `run_get` builder over its deps, and —
   * AC-250's optional half — the project/session seams `session_create` reads
   * plus the abort seam `session_interrupt` reads.
   *
   * Supplying it registers the five write tools through the SAME audited seam
   * the read tools use, and threads the whole bag (including AC-250's
   * `sessionCreate` / `sessionInterrupt`) to `registerMcpWriteTools`, which
   * installs the real handlers for exactly the tools whose deps are present.
   * Absent keeps the read-only mount AC-245's criterion reads, and a bag without
   * AC-250's optional members keeps AC-249's placeholder registration.
   */
  writeTools?: McpWriteToolDeps;
  /**
   * The active project/session entries AC-246's target gate resolves a
   * `project` / `session` argument against. Supplying it turns on the gate for
   * every tool this mount registers: the reference is rewritten to an id before
   * the tool body runs, and an ambiguous or unknown reference refuses the call
   * without entering it.
   *
   * Absent means "no resolution wired here": the mount behaves exactly as it did
   * before AC-246, which is what keeps the AC-240/244/245 criteria — none of
   * which names a target by anything but an id — reading what they always read.
   */
  resolveDeps?: McpResolveDeps;
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

  attachTransport(
    app,
    deps.authorize ?? buildDefaultAuthorize(deps),
    deps.env,
    deps.registerTools,
    deps.readTools,
    deps.writeTools,
    deps.resolveDeps
  );
  return { mounted: true, reason: gate.reason };
}

/**
 * The `authorize` middleware when the caller did not inject one: the real
 * AC-241/AC-263 middleware over the supplied token service (and OAuth seam), or
 * the fail-closed default when no token service was supplied. Consumers:
 * `mountMcpGateway`; `server/index.ts` relies on this path while the criteria
 * inject their own `authorize`.
 */
function buildDefaultAuthorize(deps: McpGatewayDeps): RequestHandler {
  if (deps.tokens === undefined) {
    return refuseUnauthorized;
  }
  return createMcpAuthMiddleware({ tokens: deps.tokens, oauth: deps.oauth, env: deps.env });
}
