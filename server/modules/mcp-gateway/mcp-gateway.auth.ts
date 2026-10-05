/**
 * `/mcp` bearer-token authentication (AC-241).
 *
 * `/mcp` accepts exactly the personal access tokens (`ccp_…`) issued by the OAuth
 * module: the middleware parses `Authorization: Bearer <token>` with the SAME
 * shared parser the `/api/oauth/token-info` route uses, hands the token to the
 * INJECTED `AccessTokensService`, and refuses everything else with one identical
 * 401 body.
 *
 * The service is injected, never constructed here: `server/index.ts` builds one
 * instance and feeds it to both `createTokenInfoRouter` and this middleware, so a
 * process has exactly one verification path. The middleware deliberately does NOT
 * branch on the service's rejection reason — not_found, expired, revoked,
 * invalid_prefix and insufficient_scope all answer the same bytes, so `/mcp`
 * cannot be used as an oracle. Revocation and expiry take effect on the next
 * request because the service re-reads the row on every call.
 *
 * This module imports no database handle, hashes no token and never re-implements
 * verification: the only check is the injected service's `verifyToken`.
 */

import type { RequestHandler, Response } from 'express';

import type { AccessTokensService } from '@/modules/oauth/index.js';
import { bearerToken } from '@/shared/utils.js';

/**
 * The authenticated caller, attached to `res.locals.mcpPrincipal` on a successful
 * check. `userId` is the token owner; `scopes` are the scopes the token carries;
 * `tokenId` is the token's row id and `clientId` the OAuth client it was issued
 * to (always `null` for a personal access token, which has no client).
 *
 * Consumers: the MCP transport's tool dispatch (AC-245+), which maps it to a
 * `ControlCaller` (`{ userId, via: 'mcp' }`), and the audit wrapper (AC-244),
 * which records `tokenId` / `clientId` on every tool call.
 */
export type McpPrincipal = {
  userId: number;
  tokenId: number;
  clientId: string | null;
  scopes: string[];
};

/**
 * The one 401 body `/mcp` ever returns for a rejected credential. Byte-for-byte
 * the body `/api/oauth/token-info` returns, and identical across every rejection
 * reason, so the response never leaks WHY the token was refused.
 */
const UNAUTHORIZED_BODY = { error: 'A valid personal access token is required', code: 'ACCESS_TOKEN_INVALID' };

/** Where the authenticated principal lives on `res.locals`. */
const MCP_PRINCIPAL_LOCAL = 'mcpPrincipal';

/**
 * Builds the `/mcp` authentication middleware that sits in front of the
 * transport. Consumers: `server/index.ts`, which injects the process's single
 * `AccessTokensService` instance, and this module's criterion. A caller must
 * never build a second token service for `/mcp`.
 */
export function createMcpAuthMiddleware(tokens: AccessTokensService): RequestHandler {
  return (req, res, next) => {
    const token = bearerToken(req.headers.authorization);
    const verified = token === null ? null : tokens.verifyToken(token);
    if (verified === null || !verified.ok) {
      res.status(401).json(UNAUTHORIZED_BODY);
      return;
    }

    // `clientId` is null: `/mcp` accepts personal access tokens only, and a PAT
    // is not issued to an OAuth client (SPEC: "client id（PAT 为空）").
    res.locals[MCP_PRINCIPAL_LOCAL] = {
      userId: verified.userId,
      tokenId: verified.tokenId,
      clientId: null,
      scopes: verified.scopes,
    };
    next();
  };
}

/**
 * Reads the principal a successful `createMcpAuthMiddleware` check attached, or
 * `null` when the request was not authenticated. Consumers: the transport's tool
 * dispatch (AC-245+), which needs the caller's `userId` for `ControlCaller`.
 */
export function readMcpPrincipal(res: Response): McpPrincipal | null {
  const principal = res.locals[MCP_PRINCIPAL_LOCAL] as McpPrincipal | undefined;
  return principal ?? null;
}
