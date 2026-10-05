// createAccessTokensService: the OAuth module's public entry point for personal
// access tokens — issuance, verification and revocation. Consumers: this
// module's own criteria, the settings module's /access-tokens routes, and the
// server entrypoint, which builds one instance to back the token-info route.
export { createAccessTokensService } from '@/modules/oauth/access-tokens.service.js';
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
