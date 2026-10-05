/**
 * AC-261 criterion: per-source rate limiting of the consent password submission.
 *
 * Drives the production consent router (`createOAuthConsentRouter`) over real
 * HTTP (`app.listen(0)` + `fetch`), backed by fake clients/provider/credentials
 * — the rate-limit readings only need a real socket, so no database is involved;
 * `provider.authorize` is a spy that proves a blocked attempt never issues a
 * code. The only other injected seam is the clock: a mutable `nowMs` drives the
 * router's `now`, so the fixed window is crossed without waiting on wall time.
 *
 * Legs map one-to-one onto the AC:
 *   (a) ten wrong passwords from one source are 401, the eleventh (with the
 *       CORRECT password) is 429 and never reaches `provider.authorize`;
 *   (b) advancing past the window lets the same source in again (302);
 *   (c) under a trusted proxy, distinct `CF-Connecting-IP`s have independent
 *       buckets (A's 11th is 429, B's first is not);
 *   (d) without a trusted proxy, forged `CF-Connecting-IP`/`X-Forwarded-For`
 *       headers do not move a request into a fresh bucket — the 11th is 429;
 *   (e) a success resets only its own source (B's earlier failures survive A's
 *       success; A itself starts over).
 *
 * A final `(env)` leg proves the `TRUST_PROXY` environment default selects the
 * header, so (a)/(d)'s "no proxy" servers are the genuine default.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { CredentialVerifier } from '@/modules/auth/index.js';
import type { OAuthClientRow } from '@/modules/database/index.js';
import { createOAuthConsentRouter } from '@/modules/oauth/index.js';
import type { CreateOAuthConsentRouterOptions, OAuthProvider } from '@/modules/oauth/index.js';

const REDIRECT_URI = 'https://app.example/cb';
const START_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
/** The production default window, in milliseconds. */
const WINDOW_MS = 15 * 60 * 1000;
/** The production default attempt ceiling. */
const MAX_ATTEMPTS = 10;
const READ_SCOPE = 'cloudcli:read';
const CLIENT_ID = 'client-1';
const OWNER = 'owner';
const CORRECT_PASSWORD = 'correct-password';

type Harness = {
  /** Base URL of the mounted consent router, e.g. `http://127.0.0.1:PORT/oauth`. */
  baseUrl: string;
  /** Advances the injected clock, so window expiry is reached without real waiting. */
  advance: (ms: number) => void;
  /** How many times `provider.authorize` has been called on this server. */
  authorizeCalls: () => number;
};

type ServerOptions = {
  /** Passed through to the router; omitted leaves the service's env default in force. */
  trustProxy?: boolean;
  /** When set, `TRUST_PROXY` is given this value for the router's construction. */
  envTrustProxy?: string;
};

/** Runs `run` against a fresh real HTTP server over fakes and an injectable clock. */
async function withConsentServer(
  run: (harness: Harness) => Promise<void>,
  options: ServerOptions = {}
): Promise<void> {
  const clock = { nowMs: START_MS };
  const now = (): Date => new Date(clock.nowMs);

  const authorizeSpy = { calls: 0 };
  const provider = {
    authorize: () => {
      authorizeSpy.calls += 1;
      return { ok: true as const, code: 'test-code' };
    },
  } as unknown as OAuthProvider;

  const clients = {
    findById: (clientId: string) =>
      ({
        client_id: clientId,
        client_name: 'consent-app',
        disabled_at: null,
      }) as unknown as OAuthClientRow,
  };

  const verifyCredentials: CredentialVerifier = async (username, password) =>
    username === OWNER && password === CORRECT_PASSWORD
      ? { ok: true as const, userId: 1 }
      : { ok: false as const };

  const routerOptions: CreateOAuthConsentRouterOptions = { provider, clients, verifyCredentials, now };
  if (options.trustProxy !== undefined) {
    routerOptions.trustProxy = options.trustProxy;
  }

  // The service reads TRUST_PROXY at construction, so the env has to be settled
  // before the router is built (and restored afterwards).
  const previousEnv = process.env.TRUST_PROXY;
  if (options.envTrustProxy === undefined) {
    delete process.env.TRUST_PROXY;
  } else {
    process.env.TRUST_PROXY = options.envTrustProxy;
  }

  const app = express();
  app.use('/oauth', createOAuthConsentRouter(routerOptions));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}/oauth`,
      advance: (ms) => {
        clock.nowMs += ms;
      },
      authorizeCalls: () => authorizeSpy.calls,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousEnv === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = previousEnv;
    }
  }
}

/** GETs the consent form and returns the freshly issued single-use CSRF token. */
async function fetchCsrf(harness: Harness): Promise<string> {
  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: READ_SCOPE,
    state: 'xyz',
    code_challenge: 'challenge-value',
    code_challenge_method: 'S256',
  }).toString();
  const response = await fetch(`${harness.baseUrl}/authorize?${query}`);
  const body = await response.text();
  const match = body.match(/name="csrf_token" value="([0-9a-f]+)"/);
  if (!match) {
    throw new Error('the rendered consent form carried no csrf_token');
  }
  return match[1];
}

type PostResult = { status: number; location: string | null; retryAfter: string | null; body: string };

/** One consent submission: mints a fresh CSRF token, then POSTs `password`. */
async function attempt(
  harness: Harness,
  password: string,
  headers: Record<string, string> = {}
): Promise<PostResult> {
  const csrfToken = await fetchCsrf(harness);
  const params = new URLSearchParams({
    action: 'allow',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: 'xyz',
    code_challenge: 'challenge-value',
    code_challenge_method: 'S256',
    username: OWNER,
    password,
    scope: READ_SCOPE,
    csrf_token: csrfToken,
  });
  const response = await fetch(`${harness.baseUrl}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: params.toString(),
    redirect: 'manual',
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    retryAfter: response.headers.get('retry-after'),
    body: await response.text(),
  };
}

test('(a) the 11th submission from one source is 429 even with the correct password', async () => {
  await withConsentServer(async (harness) => {
    const statuses: number[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const result = await attempt(harness, 'wrong-password');
      statuses.push(result.status);
      assert.notEqual(result.status, 429, `attempt ${i + 1} must not be blocked`);
      assert.equal(result.status, 401);
    }

    const eleventh = await attempt(harness, CORRECT_PASSWORD);
    statuses.push(eleventh.status);
    assert.equal(eleventh.status, 429, 'the correct password must still be answered 429');
    assert.equal(eleventh.location, null, 'a blocked attempt carries no redirect (no code)');
    assert.equal(harness.authorizeCalls(), 0, 'a blocked attempt must never reach provider.authorize');
    assert.equal(eleventh.retryAfter, String(Math.ceil(WINDOW_MS / 1000)));

    console.log(
      `(a) statuses=${statuses.join(',')} authorizeCalls=${harness.authorizeCalls()} `
      + `(11th used the correct password) retry-after=${eleventh.retryAfter}`
    );
  });
});

test('(b) the window expires: past it the same source is allowed again', async () => {
  await withConsentServer(async (harness) => {
    const statuses: number[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      statuses.push((await attempt(harness, 'wrong-password')).status);
    }
    const blocked = await attempt(harness, CORRECT_PASSWORD);
    statuses.push(blocked.status);
    assert.equal(blocked.status, 429);

    harness.advance(WINDOW_MS + 1);
    const recovered = await attempt(harness, CORRECT_PASSWORD);
    statuses.push(recovered.status);
    assert.equal(recovered.status, 302, 'past the window the correct password redirects');
    assert.ok((recovered.location ?? '').startsWith(REDIRECT_URI));

    console.log(`(b) advance=${WINDOW_MS + 1}ms statuses=${statuses.join(',')} recovered=${recovered.status}`);
  });
});

test('(c) under a trusted proxy, distinct CF-Connecting-IPs have independent buckets', async () => {
  await withConsentServer(
    async (harness) => {
      const sourceA = { 'CF-Connecting-IP': '1.1.1.1' };
      const sourceB = { 'CF-Connecting-IP': '2.2.2.2' };
      const aStatuses: number[] = [];
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        aStatuses.push((await attempt(harness, 'wrong-password', sourceA)).status);
      }
      const aEleventh = await attempt(harness, 'wrong-password', sourceA);
      aStatuses.push(aEleventh.status);
      assert.equal(aEleventh.status, 429);

      const bFirst = await attempt(harness, 'wrong-password', sourceB);
      assert.notEqual(bFirst.status, 429, "source B's first attempt must not inherit A's budget");
      assert.equal(bFirst.status, 401);

      console.log(`(c) A(1.1.1.1)=${aStatuses.join(',')} B(2.2.2.2) first=${bFirst.status}`);
    },
    { trustProxy: true }
  );
});

test('(d) without a trusted proxy, forged forwarding headers share one bucket', async () => {
  await withConsentServer(async (harness) => {
    const forged: { header: string; sent: Record<string, string> }[] = [
      { header: 'CF-Connecting-IP: 9.9.9.9', sent: { 'CF-Connecting-IP': '9.9.9.9' } },
      { header: 'CF-Connecting-IP: 8.8.8.8', sent: { 'CF-Connecting-IP': '8.8.8.8' } },
      { header: 'X-Forwarded-For: 7.7.7.7', sent: { 'X-Forwarded-For': '7.7.7.7' } },
    ];
    const statuses: number[] = [];
    const used: string[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const header = forged[i % forged.length];
      used.push(header.header);
      statuses.push((await attempt(harness, 'wrong-password', header.sent)).status);
    }
    const eleventh = await attempt(harness, CORRECT_PASSWORD, { 'CF-Connecting-IP': '9.9.9.9' });
    statuses.push(eleventh.status);
    assert.equal(
      eleventh.status,
      429,
      'forged headers must not have moved any request into a fresh bucket'
    );

    console.log(
      `(d) forged=[${used.join(' | ')}] statuses=${statuses.join(',')} `
      + `11th(CF-Connecting-IP:9.9.9.9, correct pw)=${eleventh.status}`
    );
  });
});

test('(e) a success resets only its own source', async () => {
  await withConsentServer(
    async (harness) => {
      const sourceA = { 'CF-Connecting-IP': '1.1.1.1' };
      const sourceB = { 'CF-Connecting-IP': '2.2.2.2' };
      const aFail: number[] = [];
      const bFail: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        aFail.push((await attempt(harness, 'wrong-password', sourceA)).status);
        bFail.push((await attempt(harness, 'wrong-password', sourceB)).status);
      }

      const aOk = await attempt(harness, CORRECT_PASSWORD, sourceA);
      assert.equal(aOk.status, 302);

      const bAfter: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        bAfter.push((await attempt(harness, 'wrong-password', sourceB)).status);
      }
      assert.equal(bAfter[5], 429, "B's five earlier failures must survive A's success (5+5+1=11)");

      const aAfter: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        aAfter.push((await attempt(harness, 'wrong-password', sourceA)).status);
      }
      assert.ok(
        aAfter.slice(0, 10).every((status) => status === 401),
        "A's counter was reset: its first ten fresh failures pass"
      );
      assert.equal(aAfter[10], 429, 'A is blocked only on its eleventh fresh failure');

      console.log(
        `(e) A fails=[${aFail.join(',')}] A ok=${aOk.status} B fails=[${bFail.join(',')}] `
        + `B after=[${bAfter.join(',')}] A after=[${aAfter.join(',')}]`
      );
    },
    { trustProxy: true }
  );
});

test('(env) a non-blank TRUST_PROXY selects CF-Connecting-IP as the source', async () => {
  await withConsentServer(
    async (harness) => {
      const sourceA = { 'CF-Connecting-IP': '3.3.3.3' };
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        assert.equal((await attempt(harness, 'wrong-password', sourceA)).status, 401);
      }
      const blocked = await attempt(harness, 'wrong-password', sourceA);
      assert.equal(blocked.status, 429);

      const other = await attempt(harness, 'wrong-password', { 'CF-Connecting-IP': '4.4.4.4' });
      assert.equal(other.status, 401);

      console.log(
        `(env) TRUST_PROXY=1 A(3.3.3.3) 11th=${blocked.status} B(4.4.4.4) first=${other.status}`
      );
    },
    { envTrustProxy: '1' }
  );
});
