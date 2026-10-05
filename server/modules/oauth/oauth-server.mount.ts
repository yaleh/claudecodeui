/**
 * OAuth authorization-server HTTP mount (mcp-gateway-SPEC §148–§156, AC-268).
 *
 * The production wiring of the three endpoints the discovery documents advertise
 * (`buildAuthorizationServerMetadata`: `authorization_endpoint`, `token_endpoint`,
 * `revocation_endpoint`) and that every earlier stage-5 task left to its own
 * mechanism:
 *
 *   GET/POST /oauth/authorize → AC-260's consent page factory
 *                               ({@link createOAuthConsentRouter}, reused verbatim)
 *   POST     /oauth/token     → AC-259's provider exchanges (authorization_code,
 *                               refresh_token)
 *   POST     /oauth/revoke    → AC-258's grant cascade (RFC 7009)
 *
 * This file owns TRANSPORT ONLY. It does not re-implement the store, the
 * authorization-server semantics, the page, DCR or the settings surface: the
 * consent form, the PKCE/rotation/reuse rules and the revocation cascade stay
 * where their own tasks put them, and are reached through the injected seams.
 *
 * Mount ORDER is the composition root's job (`server/index.ts` calls this BEFORE
 * `createStaticAssetsMiddleware`): behind the SPA catch-all a `POST /oauth/token`
 * would answer `200 text/html` and no client could ever exchange a code.
 *
 * Consumers: `server/index.ts` (mounts it when OAuth is on, sharing the ONE
 * provider that also backs `/mcp`'s verification seam) and this module's
 * end-to-end criterion `tests/oauth-flow.e2e.test.ts` (AC-268), which drives the
 * whole flow over real HTTP against the real server process.
 */

import type { Express, Request, Response } from 'express';
import express from 'express';

import type { CredentialVerifier } from '@/modules/auth/index.js';
import type { OAuthClientRow } from '@/modules/database/index.js';

import { createOAuthConsentRouter } from './oauth-consent.routes.js';
import type { ExchangeResult, OAuthProvider } from './oauth-provider.service.js';
import type { OAuthStore } from './oauth-store.service.js';

/**
 * The seams the mount needs. `provider` is the SAME instance `server/index.ts`
 * hands `/mcp`'s verification seam, so an authorization issued at
 * `/oauth/authorize` and verified at `/mcp` are two views of one object;
 * `clients` is the store-backed lookup the consent page renders; and
 * `verifyCredentials` is the auth module's non-throwing credential check the
 * consent POST authenticates the browser user with.
 *
 * Consumers: `server/index.ts` and this module's AC-268 criterion.
 */
export type MountOAuthServerDeps = {
  provider: OAuthProvider;
  store: OAuthStore;
  clients: { findById(clientId: string): OAuthClientRow | undefined };
  verifyCredentials: CredentialVerifier;
};

/**
 * Whether the three endpoints were attached, and why. Mirrors the sibling mount
 * readings (`mountOAuthMetadata`, `mountOAuthRegister`) so `server/index.ts` logs
 * one shape. Consumers: `server/index.ts` and the AC-268 criterion.
 */
export type OAuthServerMountReading = { mounted: boolean; reason: string };

/** A form/body field only when it is a single string (an array or object is not a usable scalar). */
function firstString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Sets the RFC 6749 §5.1 no-store headers on a token/revoke response. */
function applyNoStoreHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

/**
 * Formats one exchange outcome. A success is the RFC 6749 §5.1 token response;
 * a failure is the §5.2 error object, with `invalid_client` answered 401 (the
 * one error that is about the client's authentication rather than the request)
 * and every other code 400.
 */
function sendExchangeResult(res: Response, result: ExchangeResult): void {
  applyNoStoreHeaders(res);
  if (result.ok) {
    res.status(200).json({
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
    });
    return;
  }
  res.status(result.error === 'invalid_client' ? 401 : 400).json({ error: result.error });
}

/**
 * Mounts `/oauth/authorize`, `/oauth/token` and `/oauth/revoke` on `app`.
 *
 * `/authorize` is AC-260's router mounted verbatim, so the page render,
 * HTML escaping, CSRF ledger and password rate limiter are the ones that task's
 * criterion already pins. `/token` and `/revoke` are form-encoded POSTs; the
 * body parser is attached on the route rather than assumed, so the factory is
 * self-contained whether it sits behind `server/index.ts`'s global
 * `express.urlencoded` or on a bare app (the AC-268 criterion does both).
 *
 * `/token` dispatches on `grant_type` to the two provider exchanges and never
 * inspects a token itself. `/revoke` looks the presented token up through the
 * store and, when it is live, revokes the whole grant it belongs to — the store's
 * only cascade — which is what RFC 7009 §2.1 asks for a refresh token and what
 * makes the presented access token fail the very next `/mcp` request.
 */
export function mountOAuthServer(app: Express, deps: MountOAuthServerDeps): OAuthServerMountReading {
  const { provider, store, clients, verifyCredentials } = deps;

  const router = express.Router();

  // The consent page (AC-260): GET renders, POST re-verifies the password and
  // hands the request to the provider. Mounted at `/oauth` so its `/authorize`
  // path matches the advertised `authorization_endpoint`.
  router.use(createOAuthConsentRouter({ provider, clients, verifyCredentials }));

  // The token endpoint (AC-259's exchanges over HTTP, RFC 6749 §3.2).
  router.post('/token', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = firstString(body.grant_type);
    const clientId = firstString(body.client_id);
    const clientSecret = firstString(body.client_secret) ?? undefined;
    const resource = firstString(body.resource) ?? undefined;

    if (grantType === 'authorization_code') {
      const code = firstString(body.code);
      const redirectUri = firstString(body.redirect_uri);
      const codeVerifier = firstString(body.code_verifier);
      if (code === null || clientId === null || redirectUri === null || codeVerifier === null) {
        applyNoStoreHeaders(res);
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      sendExchangeResult(
        res,
        provider.exchangeAuthorizationCode({ code, clientId, clientSecret, redirectUri, codeVerifier, resource })
      );
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = firstString(body.refresh_token);
      const scopeParam = firstString(body.scope);
      if (refreshToken === null || clientId === null) {
        applyNoStoreHeaders(res);
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const scopes =
        scopeParam === null
          ? undefined
          : scopeParam.split(' ').map((scope) => scope.trim()).filter((scope) => scope !== '');
      sendExchangeResult(
        res,
        provider.exchangeRefreshToken({ refreshToken, clientId, clientSecret, scopes, resource })
      );
      return;
    }

    applyNoStoreHeaders(res);
    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // The revocation endpoint (RFC 7009). Always answers 200 with an empty JSON
  // body — RFC 7009 requires 200 both for a successful revocation and for a
  // token the server does not know, so the endpoint is not a token oracle.
  router.post('/revoke', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = firstString(body.token);
    if (token !== null) {
      const verified = store.verifyOAuthToken(token);
      // A live token's grant is revoked (the store's cascade invalidates the
      // token and its siblings). A replayed/expired/unknown token is a no-op.
      if (verified.ok && verified.grantId !== null) {
        store.revokeGrant(verified.grantId);
      }
    }
    applyNoStoreHeaders(res);
    res.status(200).json({});
  });

  app.use('/oauth', router);

  return { mounted: true, reason: 'MCP OAuth is on' };
}
