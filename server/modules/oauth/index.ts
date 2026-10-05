// createAccessTokensService: the OAuth module's public entry point for personal
// access tokens — issuance, verification and revocation. Consumers: this
// module's own criteria, the settings module's /access-tokens routes, and the
// server entrypoint, which builds one instance to back the token-info route.
export { createAccessTokensService } from '@/modules/oauth/access-tokens.service.js';
// ACCESS_TOKEN_SCOPES / normalizeAccessTokenScopes: the single scope vocabulary
// and its deduplicating validator. Consumers: the settings module's
// createAccessToken and this module's scope criterion, both through this barrel.
export {
  ACCESS_TOKEN_SCOPES,
  normalizeAccessTokenScopes,
} from '@/modules/oauth/access-tokens.service.js';
export type {
  AccessTokenRejectionReason,
  AccessTokensService,
  AccessTokensServiceOptions,
  IssueAccessTokenInput,
  IssueAccessTokenResult,
  IssuedAccessToken,
  VerifyAccessTokenResult,
} from '@/modules/oauth/access-tokens.service.js';
// createTokenInfoRouter: used by the server entrypoint to mount
// GET /api/oauth/token-info, and by this module's criterion to mount the
// production route factory on a real express server.
export { createTokenInfoRouter } from '@/modules/oauth/token-info.routes.js';
// createOAuthStore: the OAuth storage layer (clients, grants, authorization
// codes, OAuth access/refresh tokens, revocation cascades, hash-only writes).
// Consumers: this module's oauth-store criterion, and the AC-259+ endpoint
// tasks that build the authorization-code flow on top of it.
export { createOAuthStore } from '@/modules/oauth/oauth-store.service.js';
export type {
  CreateGrantInput,
  CreateGrantResult,
  DisableClientResult,
  IssueAuthorizationCodeInput,
  IssueAuthorizationCodeResult,
  IssueOAuthTokenInput,
  IssueOAuthTokenResult,
  OAuthStore,
  OAuthStoreOptions,
  OAuthTokenKind,
  OAuthTokenRejectionReason,
  RegisterClientInput,
  RegisterClientResult,
  RevokeGrantResult,
  VerifyOAuthTokenResult,
} from '@/modules/oauth/oauth-store.service.js';
