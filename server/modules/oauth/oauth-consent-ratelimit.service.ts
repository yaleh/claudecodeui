/**
 * Consent-password submission rate limiter (mcp-gateway-SPEC stage 5, AC-261).
 *
 * The authorization server's consent page accepts a user password on
 * `POST /authorize`, so it is a brute-force target. This service counts failures
 * per *source* in a fixed window and reports when a source has spent its budget;
 * the consent router consumes it to answer `429` before the password is ever
 * checked.
 *
 * Source resolution is the security-relevant half: behind cloudflared the socket
 * remote address is always the docker bridge, so a trusted proxy deployment
 * (`TRUST_PROXY`, which the entrypoint also hands to `app.set('trust proxy', …)`)
 * keys on the `CF-Connecting-IP` header instead. Without that configuration the
 * header — like every other request header — is ignored, so a forged
 * `CF-Connecting-IP`/`X-Forwarded-For` cannot move a request into a fresh bucket.
 *
 * The window is fixed (not sliding): the first failure after an idle window opens
 * a new window; `now` is injectable so no caller waits on wall time.
 *
 * Consumers: `oauth-consent.routes.ts`, which builds one limiter per router and
 * gates the password branch with it. Not re-exported through the module barrel —
 * it has no cross-module consumer.
 */

import type { Request } from 'express';

/** Default fixed window length: 15 minutes. */
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

/** Default failures allowed per source within one window. */
const DEFAULT_MAX_ATTEMPTS = 10;

/** One source's fixed-window counter: failures recorded and when the window opened. */
type RateLimitBucket = { count: number; windowStart: number };

/** The limiter surface the consent router consumes. */
export type ConsentPasswordRateLimiter = {
  /**
   * The true source key for `req`: the `CF-Connecting-IP` header when the proxy
   * is trusted, the socket remote address otherwise. Request headers that are not
   * trusted cannot influence the result.
   */
  source(req: Request): string;
  /** True once `source` has reached the attempt ceiling within its current window. */
  isBlocked(source: string): boolean;
  /** Counts one failed password attempt, opening a fresh window if the old one expired. */
  recordFailure(source: string): void;
  /** Clears only `source`'s counter (a successful login); other sources are untouched. */
  resetSource(source: string): void;
  /** Milliseconds until `source`'s window expires (0 when it has no live window). */
  retryAfterMs(source: string): number;
};

/**
 * Builds a fixed-window, per-source limiter for consent-password submissions.
 * `trustProxy` defaults to whether `TRUST_PROXY` is set to a non-blank value.
 */
export function createConsentPasswordRateLimiter(
  options: {
    now?: () => Date;
    windowMs?: number;
    maxAttempts?: number;
    trustProxy?: boolean;
  } = {}
): ConsentPasswordRateLimiter {
  const now = options.now ?? (() => new Date());
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const trustProxy = options.trustProxy ?? String(process.env.TRUST_PROXY ?? '').trim() !== '';
  const buckets = new Map<string, RateLimitBucket>();

  function nowMs(): number {
    return now().getTime();
  }

  /** Drops every expired bucket so the map tracks only live windows. */
  function pruneExpired(currentMs: number): void {
    for (const [source, bucket] of buckets) {
      if (currentMs - bucket.windowStart >= windowMs) {
        buckets.delete(source);
      }
    }
  }

  return {
    source(req: Request): string {
      if (trustProxy) {
        const header = req.get('CF-Connecting-IP');
        const trimmed = typeof header === 'string' ? header.trim() : '';
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
      return req.socket?.remoteAddress ?? 'unknown';
    },
    isBlocked(source: string): boolean {
      const bucket = buckets.get(source);
      if (bucket === undefined) {
        return false;
      }
      if (nowMs() - bucket.windowStart >= windowMs) {
        buckets.delete(source);
        return false;
      }
      return bucket.count >= maxAttempts;
    },
    recordFailure(source: string): void {
      const currentMs = nowMs();
      pruneExpired(currentMs);
      const bucket = buckets.get(source);
      if (bucket === undefined) {
        buckets.set(source, { count: 1, windowStart: currentMs });
        return;
      }
      bucket.count += 1;
    },
    resetSource(source: string): void {
      buckets.delete(source);
    },
    retryAfterMs(source: string): number {
      const bucket = buckets.get(source);
      if (bucket === undefined) {
        return 0;
      }
      const remaining = bucket.windowStart + windowMs - nowMs();
      return remaining > 0 ? remaining : 0;
    },
  };
}
