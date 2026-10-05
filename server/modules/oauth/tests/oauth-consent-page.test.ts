/**
 * AC-260 criterion: the OAuth consent page.
 *
 * Drives the production route factory (`createOAuthConsentRouter`) over real
 * HTTP (`app.listen(0)` + `fetch`), backed by a real better-sqlite3 database
 * built on a temp `DATABASE_PATH` through the production migration path, the
 * real `createOAuthStore` / `createOAuthProvider`, and the real AC-258 client
 * repository. Password checking is the one injected seam: the harness supplies
 * the same `verifyCredentials` shape the auth module's `createCredentialVerifier`
 * produces, so no real password hashing is involved — which is what lets the
 * criterion assert code issuance purely as a function of the credential gate.
 *
 * Legs map one-to-one onto the AC:
 *   (a) GET returns escaped HTML echoing the client name, callback host and scopes;
 *   (b) `cloudcli:read` is checked+disabled, other scopes are not;
 *   (c) a wrong or empty password issues no code, the right one redirects with a
 *       non-empty code and the verbatim state;
 *   (d) deny redirects `error=access_denied` with no code;
 *   (e) the granted scope set is the submitted subset ∪ {`cloudcli:read`};
 *   (f) each render mints a unique CSRF token and missing/unknown/replayed tokens
 *       are rejected while a valid one passes;
 *   (g) `X-Frame-Options`, CSP `frame-ancestors 'none'` and `Cache-Control: no-store`
 *       are on GET and on the successful POST;
 *   (h) `createCredentialVerifier` maps a login to `{ ok, userId }` and a throw to
 *       `{ ok: false }`.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createCredentialVerifier } from '@/modules/auth/index.js';
import {
  closeConnection,
  getConnection,
  initializeDatabase,
  oauthClientsDb,
} from '@/modules/database/index.js';
import {
  createOAuthConsentRouter,
  createOAuthProvider,
  createOAuthStore,
} from '@/modules/oauth/index.js';
import type { OAuthStore } from '@/modules/oauth/index.js';
import { AppError } from '@/shared/utils.js';

const PUBLIC_BASE_URL = 'https://cli.example';
const REDIRECT_URI = 'https://app.example/cb';
const START_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const READ_SCOPE = 'cloudcli:read';
const WRITE_SCOPE = 'cloudcli:session:send';
const CONTROL_SCOPE = 'cloudcli:session:control';
const USER_ID = 1;
const OWNER = 'owner';
const CORRECT_PASSWORD = 'correct-password';

/** A fresh PKCE pair: a random verifier and its S256 (base64url) challenge. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

type Harness = {
  /** Base URL of the mounted consent router, e.g. `http://127.0.0.1:PORT/oauth`. */
  baseUrl: string;
  /** The store behind the provider, for registering clients. */
  store: OAuthStore;
  /** Registers a public client with the canonical callback and returns its id. */
  registerClient: (clientName: string) => string;
};

/** Runs `run` against a fresh temp database, real provider/store and the production consent router. */
async function withConsentServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'oauth-consent-'));
  const databasePath = path.join(tempDirectory, 'oauth-consent.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  // `oauth_grants.user_id` references `users(id)`; the owner row has to exist.
  // The hash is a placeholder — the injected verifyCredentials is the real gate.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, OWNER, 'placeholder-hash');

  // One fixed clock for both layers: nothing in this criterion waits on wall
  // time, but sharing it mirrors the production wiring (provider and store must
  // agree on "now").
  const now = (): Date => new Date(START_MS);
  const store = createOAuthStore({ now });
  const provider = createOAuthProvider({ store, now, publicBaseUrl: PUBLIC_BASE_URL });
  const verifyCredentials = async (username: string, password: string) =>
    username === OWNER && password === CORRECT_PASSWORD
      ? { ok: true as const, userId: USER_ID }
      : { ok: false as const };

  const registerClient = (clientName: string): string =>
    store.registerClient({
      clientName,
      redirectUris: [REDIRECT_URI],
      metadata: {},
      createdVia: 'manual',
      publicClient: true,
    }).clientId;

  const app = express();
  app.use('/oauth', createOAuthConsentRouter({ provider, clients: oauthClientsDb, verifyCredentials }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}/oauth`,
      store,
      registerClient,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The number of rows in the authorization-code table right now. */
function codeCount(): number {
  const row = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM oauth_authorization_codes')
    .get() as { n: number };
  return row.n;
}

/** Builds the `/authorize` query string the consent page renders from. */
function authorizeQuery(
  clientId: string,
  challenge: string,
  scopes: string[],
  state = 'xyz'
): string {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
}

type FormResponse = { status: number; body: string; headers: Headers };

/** GETs the consent form and returns its status, body and headers. */
async function getConsentForm(
  harness: Harness,
  clientId: string,
  challenge: string,
  scopes: string[],
  state = 'xyz'
): Promise<FormResponse> {
  const response = await fetch(
    `${harness.baseUrl}/authorize?${authorizeQuery(clientId, challenge, scopes, state)}`
  );
  return { status: response.status, body: await response.text(), headers: response.headers };
}

/** Pulls the freshly issued CSRF token out of a rendered form. */
function extractCsrfToken(body: string): string {
  const match = body.match(/name="csrf_token" value="([0-9a-f]+)"/);
  if (!match) {
    throw new Error('the rendered consent form carried no csrf_token');
  }
  return match[1];
}

/** Pulls the raw `<input>` tag whose `value` is `scope`. */
function extractScopeInput(body: string, scope: string): string {
  const match = body.match(new RegExp(`<input[^>]*value="${scope}"[^>]*>`));
  if (!match) {
    throw new Error(`the rendered consent form had no checkbox for scope ${scope}`);
  }
  return match[0];
}

type PostResponse = { status: number; location: string | null; body: string; headers: Headers };

/** POSTs a urlencoded form to `/authorize` without following the redirect. */
async function postConsent(
  harness: Harness,
  fields: Record<string, string | string[]>
): Promise<PostResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item);
      }
    } else {
      params.set(key, value);
    }
  }
  const response = await fetch(`${harness.baseUrl}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    redirect: 'manual',
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    body: await response.text(),
    headers: response.headers,
  };
}

test('(a) GET returns escaped HTML echoing client name, callback host and scopes', async () => {
  await withConsentServer(async (harness) => {
    const scriptName = '<script>alert(1)</script>';
    const scriptClientId = harness.registerClient(scriptName);
    const first = await getConsentForm(harness, scriptClientId, pkcePair().challenge, [
      READ_SCOPE,
      WRITE_SCOPE,
    ]);
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type') ?? '', /text\/html/);
    const scriptRaw = first.body.includes('<script>alert(1)</script>');
    const scriptEscaped = first.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;');
    const echoesHost = first.body.includes('app.example');
    const echoesScope = first.body.includes(WRITE_SCOPE);
    assert.equal(scriptRaw, false);
    assert.equal(scriptEscaped, true);
    assert.equal(echoesHost, true);
    assert.equal(echoesScope, true);

    const imgName = '"><img src=x onerror=1>';
    const imgClientId = harness.registerClient(imgName);
    const second = await getConsentForm(harness, imgClientId, pkcePair().challenge, [READ_SCOPE]);
    const imgRaw = second.body.includes('<img src=x onerror=1>');
    const imgEscaped = second.body.includes('&lt;img src=x onerror=1&gt;');
    assert.equal(imgRaw, false);
    assert.equal(imgEscaped, true);

    console.log(
      `(a) status=${first.status} script raw=${scriptRaw} escaped=${scriptEscaped}; `
      + `img raw=${imgRaw} escaped=${imgEscaped}; host=${echoesHost} scope=${echoesScope}`
    );
  });
});

test('(b) cloudcli:read is checked+disabled; another scope is neither', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const form = await getConsentForm(harness, clientId, pkcePair().challenge, [
      READ_SCOPE,
      WRITE_SCOPE,
    ]);
    const readTag = extractScopeInput(form.body, READ_SCOPE);
    const writeTag = extractScopeInput(form.body, WRITE_SCOPE);
    assert.ok(readTag.includes('checked'), 'the read-only checkbox must be checked');
    assert.ok(readTag.includes('disabled'), 'the read-only checkbox must be disabled');
    assert.ok(!writeTag.includes('checked'), 'a non-read-only checkbox must start unchecked');

    console.log(`(b) read=<${readTag}> write=<${writeTag}>`);
  });
});

test('(c) a wrong/empty password never issues a code; the right one redirects with code+state', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const pair = pkcePair();
    const scopes = [READ_SCOPE, WRITE_SCOPE];

    const common = {
      action: 'allow',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'xyz',
      code_challenge: pair.challenge,
      code_challenge_method: 'S256',
      username: OWNER,
      scope: [WRITE_SCOPE],
    };

    const before = codeCount();

    const wrongForm = await getConsentForm(harness, clientId, pair.challenge, scopes);
    const wrong = await postConsent(harness, {
      ...common,
      csrf_token: extractCsrfToken(wrongForm.body),
      password: 'wrong-password',
    });
    assert.notEqual(wrong.status, 302);
    assert.match(wrong.body, /password/i);
    const afterWrong = codeCount();
    assert.equal(afterWrong, before, 'a wrong password must not create a code');

    const emptyForm = await getConsentForm(harness, clientId, pair.challenge, scopes);
    const empty = await postConsent(harness, {
      ...common,
      csrf_token: extractCsrfToken(emptyForm.body),
      password: '',
    });
    assert.notEqual(empty.status, 302);
    assert.equal(codeCount(), afterWrong, 'an empty password must not create a code');

    const okForm = await getConsentForm(harness, clientId, pair.challenge, scopes);
    const ok = await postConsent(harness, {
      ...common,
      csrf_token: extractCsrfToken(okForm.body),
      password: CORRECT_PASSWORD,
    });
    assert.equal(ok.status, 302);
    const location = ok.location ?? '';
    assert.ok(location.startsWith(REDIRECT_URI), `redirect must target the callback: ${location}`);
    const url = new URL(location);
    const code = url.searchParams.get('code');
    assert.ok(code !== null && code.length > 0, 'the redirect must carry a non-empty code');
    assert.equal(url.searchParams.get('state'), 'xyz');
    assert.equal(codeCount(), afterWrong + 1, 'the right password must create exactly one code');

    console.log(
      `(c) wrong=${wrong.status} empty=${empty.status} ok=${ok.status} `
      + `code=${code === null ? 'MISSING' : 'non-empty'} state=${url.searchParams.get('state')} `
      + `codes ${before}->${codeCount()}`
    );
  });
});

test('(d) deny redirects error=access_denied with no code', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const pair = pkcePair();
    const form = await getConsentForm(harness, clientId, pair.challenge, [
      READ_SCOPE,
      WRITE_SCOPE,
    ]);
    const before = codeCount();
    const denied = await postConsent(harness, {
      csrf_token: extractCsrfToken(form.body),
      action: 'deny',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'xyz',
      code_challenge: pair.challenge,
      code_challenge_method: 'S256',
      username: OWNER,
      password: CORRECT_PASSWORD,
    });
    assert.equal(denied.status, 302);
    const location = denied.location ?? '';
    assert.ok(location.startsWith(REDIRECT_URI));
    const url = new URL(location);
    assert.equal(url.searchParams.get('error'), 'access_denied');
    assert.equal(url.searchParams.get('code'), null);
    assert.equal(codeCount(), before);

    console.log(
      `(d) status=${denied.status} error=${url.searchParams.get('error')} `
      + `code=${url.searchParams.get('code')} location=${location}`
    );
  });
});

test('(e) the granted scopes are the submitted subset plus cloudcli:read', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const pair = pkcePair();
    const form = await getConsentForm(harness, clientId, pair.challenge, [
      READ_SCOPE,
      WRITE_SCOPE,
      CONTROL_SCOPE,
    ]);
    const ok = await postConsent(harness, {
      csrf_token: extractCsrfToken(form.body),
      action: 'allow',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'xyz',
      code_challenge: pair.challenge,
      code_challenge_method: 'S256',
      username: OWNER,
      password: CORRECT_PASSWORD,
      // The read-only box is disabled and therefore never submitted; control was
      // left unchecked. Only `session:send` is posted.
      scope: [WRITE_SCOPE],
    });
    assert.equal(ok.status, 302);

    const grant = getConnection()
      .prepare('SELECT scopes FROM oauth_grants ORDER BY id DESC LIMIT 1')
      .get() as { scopes: string };
    const scopes = JSON.parse(grant.scopes) as string[];
    assert.deepEqual(
      [...scopes].sort(),
      [READ_SCOPE, WRITE_SCOPE].sort(),
      'the grant must carry exactly the checked scopes plus the forced read-only scope'
    );
    assert.ok(!scopes.includes(CONTROL_SCOPE));

    console.log(`(e) grant.scopes=${grant.scopes}`);
  });
});

test('(f) CSRF: unique per render; missing/unknown/replayed tokens are rejected', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const pair = pkcePair();
    const scopes = [READ_SCOPE, WRITE_SCOPE];

    const firstForm = await getConsentForm(harness, clientId, pair.challenge, scopes);
    const secondForm = await getConsentForm(harness, clientId, pair.challenge, scopes);
    const tokenOne = extractCsrfToken(firstForm.body);
    const tokenTwo = extractCsrfToken(secondForm.body);
    assert.notEqual(tokenOne, tokenTwo, 'each render must mint a distinct token');

    const base = {
      action: 'allow',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'xyz',
      code_challenge: pair.challenge,
      code_challenge_method: 'S256',
      username: OWNER,
      password: CORRECT_PASSWORD,
      scope: [WRITE_SCOPE],
    };
    const before = codeCount();

    const missing = await postConsent(harness, { ...base });
    assert.notEqual(missing.status, 302);
    const unknown = await postConsent(harness, { ...base, csrf_token: 'f'.repeat(64) });
    assert.notEqual(unknown.status, 302);

    const validForm = await getConsentForm(harness, clientId, pair.challenge, scopes);
    const validToken = extractCsrfToken(validForm.body);
    const allowed = await postConsent(harness, { ...base, csrf_token: validToken });
    assert.equal(allowed.status, 302);
    const replayed = await postConsent(harness, { ...base, csrf_token: validToken });
    assert.notEqual(replayed.status, 302);

    assert.equal(codeCount(), before + 1, 'only the valid, single-use token may issue a code');

    console.log(
      `(f) token1=${tokenOne} token2=${tokenTwo} distinct=${tokenOne !== tokenTwo}; `
      + `missing=${missing.status} unknown=${unknown.status} valid=${allowed.status} `
      + `replay=${replayed.status}; codes ${before}->${codeCount()}`
    );
  });
});

test('(g) GET and successful POST carry the anti-framing and no-store headers', async () => {
  await withConsentServer(async (harness) => {
    const clientId = harness.registerClient('consent-app');
    const pair = pkcePair();
    const scopes = [READ_SCOPE, WRITE_SCOPE];
    const form = await getConsentForm(harness, clientId, pair.challenge, scopes);
    const getFrame = form.headers.get('x-frame-options');
    const getCsp = form.headers.get('content-security-policy');
    const getCache = form.headers.get('cache-control');
    assert.equal(getFrame, 'DENY');
    assert.ok((getCsp ?? '').includes("frame-ancestors 'none'"));
    assert.ok((getCache ?? '').includes('no-store'));

    const ok = await postConsent(harness, {
      csrf_token: extractCsrfToken(form.body),
      action: 'allow',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'xyz',
      code_challenge: pair.challenge,
      code_challenge_method: 'S256',
      username: OWNER,
      password: CORRECT_PASSWORD,
      scope: [WRITE_SCOPE],
    });
    assert.equal(ok.status, 302);
    const postFrame = ok.headers.get('x-frame-options');
    const postCsp = ok.headers.get('content-security-policy');
    const postCache = ok.headers.get('cache-control');
    assert.equal(postFrame, 'DENY');
    assert.ok((postCsp ?? '').includes("frame-ancestors 'none'"));
    assert.ok((postCache ?? '').includes('no-store'));

    console.log(
      `(g) GET x-frame-options=${getFrame} csp="${getCsp}" cache-control=${getCache}; `
      + `POST x-frame-options=${postFrame} csp="${postCsp}" cache-control=${postCache}`
    );
  });
});

test('(h) createCredentialVerifier maps login success and failure without throwing', async () => {
  const verifier = createCredentialVerifier({
    async login(username: unknown) {
      if (username === 'owner') {
        return { user: { id: 7 } };
      }
      throw new AppError('Invalid username or password', {
        code: 'AUTH_INVALID_CREDENTIALS',
        statusCode: 401,
      });
    },
  });

  const success = await verifier('owner', 'pw');
  const failure = await verifier('nobody', 'pw');
  assert.deepEqual(success, { ok: true, userId: 7 });
  assert.deepEqual(failure, { ok: false });

  console.log(`(h) success=${JSON.stringify(success)} failure=${JSON.stringify(failure)}`);
});
