/**
 * OAuth consent page (mcp-gateway-SPEC stage 5, AC-260).
 *
 * The user-facing half of the authorization-code flow: `GET /authorize` renders
 * a server-side HTML form (never the SPA) that names the requesting client and
 * the callback it will redirect to, shows each requested scope as a checkbox
 * with `cloudcli:read` pinned checked-and-disabled, and collects the user's
 * password; `POST /authorize` verifies that password, honours an explicit deny,
 * and on allow hands the request to the authorization-server provider
 * (`OAuthProvider.authorize`), which performs every semantic check and issues
 * the code. This route owns only transport and page rendering.
 *
 * Security posture, all applied to every response including error pages and
 * redirects:
 *   · every value echoed from the request or the client row is HTML-escaped by
 *     the local `escapeHtml` — a malicious client name or redirect_uri renders
 *     as text, never as markup;
 *   · a single-use, expiring CSRF token is issued on each render and consumed by
 *     the POST, so a cross-site form cannot drive the flow;
 *   · `X-Frame-Options: DENY` and a CSP whose `frame-ancestors 'none'` prevents
 *     the page from being framed, and `Cache-Control: no-store` keeps the form
 *     and its token out of any cache.
 *
 * Out of scope for this task: mounting the router or deciding the https base
 * URL (AC-262), rate limiting and origin checks (AC-261), `/mcp` authentication
 * (AC-263), DCR, the settings surface and the SPA.
 *
 * Consumers: the server entrypoint (mounted by AC-262) and this module's
 * criterion `tests/oauth-consent-page.test.ts`, which mounts this production
 * factory on a real express server with a real provider and client store.
 */

import crypto from 'crypto';

import express from 'express';

import type { CredentialVerifier } from '@/modules/auth/index.js';
import type { OAuthClientRow } from '@/modules/database/index.js';
import type { OAuthProvider } from '@/modules/oauth/oauth-provider.service.js';

/** The scope every consent grants, pinned checked and disabled in the form. */
const READ_SCOPE = 'cloudcli:read';

/** A CSRF ledger entry's absolute expiry, in epoch milliseconds. */
type CsrfEntry = { expiresAtMs: number };

/** The CSRF surface the router needs; a subset of what `createCsrfTokenStore` returns. */
type CsrfTokenStore = {
  issue(): string;
  consume(token: unknown): boolean;
};

/** Caller-supplied seams for {@link createOAuthConsentRouter}. */
export type CreateOAuthConsentRouterOptions = {
  /** Authorization-server semantics (AC-259); only `authorize` is consumed. */
  provider: OAuthProvider;
  /** Client lookup (AC-258's `oauthClientsDb` in production); only `findById` is consumed. */
  clients: { findById(clientId: string): OAuthClientRow | undefined };
  /** The non-throwing credential check (auth module) that gates code issuance. */
  verifyCredentials: CredentialVerifier;
  /** Clock for the default CSRF store; injectable so its TTL can be exercised. */
  now?: () => Date;
  /** Override the CSRF ledger entirely (tests); defaults to an in-process store over `now`. */
  csrfStore?: CsrfTokenStore;
};

/** Escapes `& < > " '` so an attacker-controlled value cannot break out of text or an attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A query/body value only when it is a single string (an array or object is not a usable scalar). */
function firstString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Coerces a repeated form field (a string or a string array) to an array of strings. */
function stringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

/** Space-separated scope parameter → trimmed, non-empty scope names. */
function parseScopes(value: unknown): string[] {
  const raw = firstString(value);
  if (raw === null) {
    return [];
  }
  return raw
    .split(' ')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * In-process CSRF ledger: random 64-hex-character tokens, single-use, expiring.
 * `issue` stores a fresh token under its expiry; `consume` removes a token and
 * returns true only if it was present and unexpired (so a replay, a forgery and
 * an expired token all fail identically). Both operations prune expired entries
 * and cap the map, so the ledger cannot grow without bound.
 */
function createCsrfTokenStore(options: {
  now?: () => Date;
  ttlMs?: number;
  maxEntries?: number;
} = {}): CsrfTokenStore {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 1000;
  const entries = new Map<string, CsrfEntry>();

  function prune(): void {
    const currentMs = now().getTime();
    for (const [token, entry] of entries) {
      if (entry.expiresAtMs <= currentMs) {
        entries.delete(token);
      }
    }
    // Map iteration is insertion-ordered, so this drops the oldest issues first.
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      entries.delete(oldest);
    }
  }

  return {
    issue(): string {
      prune();
      const token = crypto.randomBytes(32).toString('hex');
      entries.set(token, { expiresAtMs: now().getTime() + ttlMs });
      return token;
    },
    consume(token: unknown): boolean {
      prune();
      if (typeof token !== 'string' || token.length === 0) {
        return false;
      }
      const entry = entries.get(token);
      if (entry === undefined) {
        return false;
      }
      entries.delete(token);
      return true;
    },
  };
}

/** Sets the three hardening headers on any response, redirect or page alike. */
function applySecurityHeaders(res: express.Response): void {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  res.setHeader('Cache-Control', 'no-store');
}

/** Renders a minimal HTML error page (no form, no secrets) with the security headers. */
function sendErrorPage(res: express.Response, status: number, message: string): void {
  applySecurityHeaders(res);
  res.status(status).type('html').send(
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head>'
    + `<body><h1>Authorization error</h1><p>${escapeHtml(message)}</p></body></html>`
  );
}

/** Inputs the consent form echoes back; all are escaped at render time. */
type ConsentPageInput = {
  clientName: string;
  callbackHost: string;
  redirectUri: string;
  clientId: string;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  scopes: string[];
  csrfToken: string;
};

/** Renders the consent form: escaped client identity, per-scope checkboxes, password, CSRF token. */
function renderConsentPage(input: ConsentPageInput): string {
  const scopeInputs = input.scopes
    .map((scope) => {
      const required = scope === READ_SCOPE;
      const requiredAttributes = required ? ' checked disabled' : '';
      return `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"${requiredAttributes}> ${escapeHtml(scope)}</label>`;
    })
    .join('\n        ');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize access</title></head>
<body>
  <h1>Authorize access</h1>
  <p>Application: ${escapeHtml(input.clientName)}</p>
  <p>Callback host: ${escapeHtml(input.callbackHost)}</p>
  <p>Redirect URI: ${escapeHtml(input.redirectUri)}</p>
  <form method="post" action="">
    <input type="hidden" name="client_id" value="${escapeHtml(input.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(input.redirectUri)}">
    <input type="hidden" name="state" value="${escapeHtml(input.state ?? '')}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(input.codeChallenge ?? '')}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(input.codeChallengeMethod ?? '')}">
    <input type="hidden" name="csrf_token" value="${escapeHtml(input.csrfToken)}">
    <fieldset>
      <legend>Requested scopes</legend>
        ${scopeInputs}
    </fieldset>
    <label>Username <input name="username" autocomplete="username"></label>
    <label>Password <input type="password" name="password" autocomplete="current-password"></label>
    <button type="submit" name="action" value="allow">Allow</button>
    <button type="submit" name="action" value="deny">Deny</button>
  </form>
</body>
</html>`;
}

/**
 * Builds the consent router. `GET /authorize` renders the form for a live
 * client; `POST /authorize` consumes the CSRF token, then either redirects a
 * deny, challenges a failed password, or asks the provider to authorize the
 * narrowed scope set and redirects the resulting code.
 */
export function createOAuthConsentRouter(options: CreateOAuthConsentRouterOptions): express.Router {
  const csrfStore = options.csrfStore ?? createCsrfTokenStore({ now: options.now });
  const router = express.Router();

  router.get('/authorize', (req, res) => {
    const clientId = firstString(req.query.client_id);
    const redirectUri = firstString(req.query.redirect_uri);
    const responseType = firstString(req.query.response_type);
    const state = firstString(req.query.state);
    const codeChallenge = firstString(req.query.code_challenge);
    const codeChallengeMethod = firstString(req.query.code_challenge_method);

    if (clientId === null) {
      sendErrorPage(res, 400, 'Missing client_id');
      return;
    }
    if (responseType !== 'code') {
      sendErrorPage(res, 400, 'Unsupported response_type; only "code" is allowed');
      return;
    }
    const client = options.clients.findById(clientId);
    if (!client || client.disabled_at !== null) {
      sendErrorPage(res, 400, 'Unknown or disabled client');
      return;
    }
    if (redirectUri === null) {
      sendErrorPage(res, 400, 'Missing redirect_uri');
      return;
    }
    let callbackHost: string;
    try {
      callbackHost = new URL(redirectUri).host;
    } catch {
      sendErrorPage(res, 400, 'Invalid redirect_uri');
      return;
    }

    // `cloudcli:read` is always granted, so it is always shown — even when the
    // request did not ask for it — pinned checked and disabled.
    const requestedScopes = parseScopes(req.query.scope);
    const scopes = requestedScopes.includes(READ_SCOPE)
      ? requestedScopes
      : [READ_SCOPE, ...requestedScopes];

    applySecurityHeaders(res);
    res.status(200).type('html').send(
      renderConsentPage({
        clientName: client.client_name ?? '',
        callbackHost,
        redirectUri,
        clientId,
        state,
        codeChallenge,
        codeChallengeMethod,
        scopes,
        csrfToken: csrfStore.issue(),
      })
    );
  });

  router.post('/authorize', express.urlencoded({ extended: false }), async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const clientId = firstString(body.client_id);
    const redirectUri = firstString(body.redirect_uri);
    const state = firstString(body.state);
    const codeChallenge = firstString(body.code_challenge);
    const codeChallengeMethod = firstString(body.code_challenge_method);
    const username = firstString(body.username) ?? '';
    const password = firstString(body.password) ?? '';
    const action = firstString(body.action);

    if (clientId === null || redirectUri === null) {
      sendErrorPage(res, 400, 'Missing client_id or redirect_uri');
      return;
    }
    let redirectTarget: URL;
    try {
      redirectTarget = new URL(redirectUri);
    } catch {
      sendErrorPage(res, 400, 'Invalid redirect_uri');
      return;
    }

    // The CSRF gate runs before anything can be issued or redirected.
    if (!csrfStore.consume(body.csrf_token)) {
      sendErrorPage(res, 403, 'Invalid or expired CSRF token');
      return;
    }

    if (action === 'deny') {
      redirectTarget.searchParams.set('error', 'access_denied');
      if (state !== null) {
        redirectTarget.searchParams.set('state', state);
      }
      applySecurityHeaders(res);
      res.redirect(302, redirectTarget.toString());
      return;
    }

    if (password.length === 0) {
      sendErrorPage(res, 401, 'Password is required');
      return;
    }

    const identity = await options.verifyCredentials(username, password);
    if (!identity.ok) {
      sendErrorPage(res, 401, 'Invalid username or password');
      return;
    }

    // Only the checked boxes arrive (the read-only box is disabled and is not
    // submitted), so the granted set is the deduplicated submission with the
    // read-only scope forced back in.
    const submitted = stringArray(body.scope).filter(
      (scope) => scope.length > 0 && scope !== READ_SCOPE
    );
    const scopes = [READ_SCOPE, ...submitted.filter((scope, index) => submitted.indexOf(scope) === index)];

    const authorized = options.provider.authorize({
      clientId,
      redirectUri,
      codeChallenge: codeChallenge ?? undefined,
      codeChallengeMethod: codeChallengeMethod ?? undefined,
      scopes,
      userId: identity.userId,
    });
    if (!authorized.ok) {
      sendErrorPage(res, 400, `Authorization failed: ${authorized.error}`);
      return;
    }

    redirectTarget.searchParams.set('code', authorized.code);
    if (state !== null) {
      redirectTarget.searchParams.set('state', state);
    }
    applySecurityHeaders(res);
    res.redirect(302, redirectTarget.toString());
  });

  return router;
}
