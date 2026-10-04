/**
 * Personal access token service.
 *
 * Issues, verifies and revokes `ccp_` tokens. Plaintext is generated here and
 * returned exactly once; only its SHA-256 hash and an 8-character prefix reach
 * the database, so a leaked database cannot be replayed as a token. Every
 * timestamp comes from the injected clock, which is what makes expiry and
 * revocation testable without waiting on wall time.
 *
 * Consumers: this module's criteria, and the AC-227 settings routes.
 */

import crypto from 'crypto';

import { accessTokensDb } from '@/modules/database/index.js';

/** Every token minted by this service carries this prefix, per mcp-gateway-SPEC. */
const TOKEN_PREFIX = 'ccp_';

/** Prefix length stored for display: `ccp_` plus five hex digits. */
const PREFIX_LENGTH = 8;

/** The only accepted lifetimes, in days. A token never outlives 90 days. */
const ALLOWED_EXPIRY_DAYS: readonly number[] = [7, 30, 90];

/** Lifetime applied when the caller omits `expiresInDays`. */
const DEFAULT_EXPIRY_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Why a verification failed. The five values are mutually distinct so a caller
 * can tell an expired token from a revoked one, a mistyped one, a foreign
 * prefix, and a scope escalation.
 */
export type AccessTokenRejectionReason =
  | 'invalid_prefix'
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'insufficient_scope';

/** A freshly issued token. `token` is the plaintext and is never stored. */
export type IssuedAccessToken = {
  id: number;
  token: string;
  tokenPrefix: string;
  expiresAt: string;
};

/**
 * Result of issuing. `invalid_expiry` means the requested lifetime was not one
 * of 7/30/90 (or was a non-number such as `null` for a permanent token); no row
 * is written in that case.
 */
export type IssueAccessTokenResult =
  | { ok: true; token: IssuedAccessToken }
  | { ok: false; reason: 'invalid_expiry' };

/**
 * Result of verifying. On success the owner id and the token's scopes are
 * returned; on failure exactly one of the {@link AccessTokenRejectionReason}
 * values is returned.
 */
export type VerifyAccessTokenResult =
  | { ok: true; userId: number; scopes: string[] }
  | { ok: false; reason: AccessTokenRejectionReason };

/** Caller-supplied fields for {@link AccessTokensService.issueToken}. */
export type IssueAccessTokenInput = {
  userId: number;
  name?: string | null;
  scopes: string[];
  /** One of 7/30/90; omitted means 30. `null`, 0, negatives, 365 and Infinity are rejected. */
  expiresInDays?: number | null;
};

export type AccessTokensService = {
  issueToken(input: IssueAccessTokenInput): IssueAccessTokenResult;
  /**
   * Hashes `token` and looks it up. When `requiredScope` is given, a token that
   * does not grant it is rejected as `insufficient_scope`. A successful check
   * stamps `last_used` from the injected clock.
   */
  verifyToken(token: string, requiredScope?: string): VerifyAccessTokenResult;
  /** Stamps `revoked_at`; the next `verifyToken` rejects the token with no restart. */
  revokeToken(id: number): boolean;
};

/** Construction options; `now` is the only clock the service reads. */
export type AccessTokensServiceOptions = {
  now: () => Date;
};

/** SHA-256 of the plaintext token, lowercase hex — the only form written to disk. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** True when `days` is an integer in the allowed whitelist. */
function isAllowedExpiryDays(days: number | null | undefined): days is number {
  return typeof days === 'number' && Number.isInteger(days) && ALLOWED_EXPIRY_DAYS.includes(days);
}

/**
 * Builds the token service. `now` is called for `created_at`, `expires_at`,
 * `last_used` and `revoked_at`, and for the expiry comparison, so a test can
 * advance time by mutating what the clock returns.
 */
export function createAccessTokensService({ now }: AccessTokensServiceOptions): AccessTokensService {
  return {
    issueToken(input: IssueAccessTokenInput): IssueAccessTokenResult {
      const days = input.expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : input.expiresInDays;
      if (!isAllowedExpiryDays(days)) {
        return { ok: false, reason: 'invalid_expiry' };
      }

      // 32 random bytes; the plaintext exists only in this return value.
      const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + days * MS_PER_DAY);

      const id = accessTokensDb.insert({
        userId: input.userId,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, PREFIX_LENGTH),
        name: input.name ?? null,
        scopes: JSON.stringify(input.scopes),
        expiresAt: expiresAt.toISOString(),
        createdAt: issuedAt.toISOString(),
      });

      return {
        ok: true,
        token: { id, token, tokenPrefix: token.slice(0, PREFIX_LENGTH), expiresAt: expiresAt.toISOString() },
      };
    },

    verifyToken(token: string, requiredScope?: string): VerifyAccessTokenResult {
      if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
        return { ok: false, reason: 'invalid_prefix' };
      }

      const row = accessTokensDb.findByHash(hashToken(token));
      if (!row) {
        return { ok: false, reason: 'not_found' };
      }
      if (row.revoked_at !== null) {
        return { ok: false, reason: 'revoked' };
      }
      if (now().getTime() >= new Date(row.expires_at).getTime()) {
        return { ok: false, reason: 'expired' };
      }

      const scopes = JSON.parse(row.scopes) as string[];
      if (requiredScope !== undefined && !scopes.includes(requiredScope)) {
        return { ok: false, reason: 'insufficient_scope' };
      }

      accessTokensDb.updateLastUsed(row.id, now().toISOString());
      return { ok: true, userId: row.user_id, scopes };
    },

    revokeToken(id: number): boolean {
      return accessTokensDb.revoke(id, now().toISOString());
    },
  };
}
