// createAccessTokensService: the OAuth module's public entry point for personal
// access tokens — issuance, verification and revocation. Consumers: this
// module's own criteria, and the AC-227 settings routes.
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
