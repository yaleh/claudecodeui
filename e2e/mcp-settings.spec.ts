import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

// Real Chromium against a real backend and a real Vite client, twice: once with `MCP_ENABLED` on and once with it
// off. Playwright's shared `webServer` carries one fixed environment, so this spec starts its OWN server + Vite pair
// per state on kernel-assigned ports, against a throwaway data directory — the same shape `scripts/resident-smoke.mjs`
// and `scripts/voice-capture-process-check.mjs` use. Nothing about the backend is stubbed: the settings page asks the
// state's own server over its own Vite `/api` proxy, and the scope reading below is a real `GET /api/oauth/token-info`
// carrying the token the form really issued.
//
// The build under test is the worktree's own source, served by Vite (not a possibly-stale `dist/`), so a change to
// `McpGatewaySection.tsx` or `AccessTokensSection.tsx` is what the browser renders.

const REPO_ROOT = process.cwd();
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE_BIN = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/** The two gate states this criterion drives, each naming the exact `MCP_ENABLED` value its server boots with. */
type GateState = {
  label: 'enabled' | 'disabled';
  /** The value exported as `MCP_ENABLED` (or null to leave the variable absent). */
  mcpEnabled: string | null;
};

const ENABLED_STATE: GateState = { label: 'enabled', mcpEnabled: 'true' };
const DISABLED_STATE: GateState = { label: 'disabled', mcpEnabled: null };

/** The five scope vocabulary values, in the order the create form renders them. */
const SCOPE_VOCABULARY = [
  'cloudcli:read',
  'cloudcli:session:send',
  'cloudcli:session:create',
  'cloudcli:session:control',
  'cloudcli:approve',
] as const;

/** How long a spawned child is given to answer before the criterion gives up on it, naming its own log tail. */
const CHILD_READY_TIMEOUT_MS = 30_000;
/** How long a browser landing is given before the criterion reads the page back as evidence. */
const LANDING_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HTTP / process plumbing
// ---------------------------------------------------------------------------

/**
 * One HTTP exchange over `node:http`, deliberately not the global `fetch`.
 *
 * `listen(0)` + undici is a known bad-port lottery in this repo; every request this criterion makes goes through
 * `node:http` so the port the kernel handed back can never be rejected by an unrelated client policy.
 */
const httpRequest = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
  const target = new URL(url);
  const request = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    },
    (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    },
  );
  request.on('error', reject);
  request.setTimeout(10_000, () => request.destroy(new Error(`no answer from ${url} within 10000ms`)));
  request.end();
});

/** Asks the kernel for a free loopback port. The probe socket is closed before the value is handed back. */
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (address === null || typeof address === 'string') {
      probe.close(() => reject(new Error('the kernel did not hand back a numeric port')));
      return;
    }
    const { port } = address;
    probe.close(() => resolve(port));
  });
});

/** Polls `url` until it answers a 2xx/3xx, or throws with the child's own log tail so a boot failure is legible. */
const waitForHttp = async (url: string, describeLog: () => string): Promise<void> => {
  const deadline = Date.now() + CHILD_READY_TIMEOUT_MS;
  let lastAnswer = 'no request was ever attempted';
  while (Date.now() < deadline) {
    try {
      const { status } = await httpRequest('GET', url);
      if (status >= 200 && status < 400) return;
      lastAnswer = `HTTP ${status}`;
    } catch (error) {
      lastAnswer = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${url} never answered inside ${CHILD_READY_TIMEOUT_MS}ms (last: ${lastAnswer}); child output tail:\n`
    + describeLog().split('\n').slice(-25).join('\n'),
  );
};

/** Kills a detached child's whole process group, so the `node -> tsx/vite` wrapper is not left holding the port. */
const killGroup = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone, or never a group leader; either way there is nothing left to signal.
  }
};

/** One state's live backend + client, plus the readings this criterion prints about how it was started. */
type BootedState = {
  state: GateState;
  serverPort: number;
  clientUrl: string;
  /** The exact environment the server was spawned with, for the record the criterion writes out. */
  serverEnv: Record<string, string>;
  stop: () => void;
};

/**
 * Boots one gate state: a real API server (its own data dir, its own `MCP_ENABLED`) and a real Vite client whose
 * `/api` proxy points at that server. The browser then dials the Vite origin, so the page and its API calls share
 * one origin exactly as they do in production.
 */
const bootState = async (state: GateState, dataDir: string): Promise<BootedState> => {
  const serverPort = await freePort();
  const vitePort = await freePort();
  const serverLog: string[] = [];
  const viteLog: string[] = [];

  // The spec process inherits Playwright's environment, which is not the deployment's: strip anything that would
  // point the child at the real database or a real port before setting this state's own values.
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) baseEnv[key] = value;
  }
  for (const name of ['DATABASE_PATH', 'HOST', 'SERVER_PORT', 'JWT_SECRET', 'NODE_OPTIONS', 'PUBLIC_BASE_URL']) {
    delete baseEnv[name];
  }
  for (const name of ['NO_COLOR', 'MCP_ENABLED']) {
    delete baseEnv[name];
  }
  const serverEnv: Record<string, string> = {
    ...baseEnv,
    DATABASE_PATH: path.join(dataDir, 'auth.db'),
    HOME: dataDir,
    CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude-config'),
    HOST: '127.0.0.1',
    SERVER_PORT: String(serverPort),
    // The start-up sweep reaps every session scope on the host, not only this run's.
    CLAUDE_SESSION_SCOPE_SWEEP: 'off',
    FORCE_COLOR: '0',
  };
  if (state.mcpEnabled !== null) serverEnv.MCP_ENABLED = state.mcpEnabled;

  const server = spawn(process.execPath, [TSX_CLI, '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
    cwd: REPO_ROOT,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stdout?.on('data', (chunk) => serverLog.push(String(chunk)));
  server.stderr?.on('data', (chunk) => serverLog.push(String(chunk)));

  await waitForHttp(`http://127.0.0.1:${serverPort}/health`, () => serverLog.join(''));

  const vite = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--strictPort'], {
    cwd: REPO_ROOT,
    env: {
      ...baseEnv,
      SERVER_PORT: String(serverPort),
      VITE_PORT: String(vitePort),
      HOST: '127.0.0.1',
      // Each state gets its own dependency cache: sharing one lets a re-optimization swap the browserHash out from
      // under a page that already has the old urls in flight (the 504 this repo's playwright.config.ts documents).
      VITE_CACHE_DIR: path.join(dataDir, 'vite-cache'),
    },
    // stdin stays an OPEN pipe: the vite CLI exits the moment its stdin reaches EOF, and a closed stdin would kill
    // the dev server before the browser ever asked for a document.
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  vite.stdout?.on('data', (chunk) => viteLog.push(String(chunk)));
  vite.stderr?.on('data', (chunk) => viteLog.push(String(chunk)));

  await waitForHttp(`http://127.0.0.1:${vitePort}/`, () => viteLog.join(''));

  return {
    state,
    serverPort,
    clientUrl: `http://127.0.0.1:${vitePort}`,
    serverEnv,
    stop: () => {
      killGroup(vite);
      killGroup(server);
    },
  };
};

// ---------------------------------------------------------------------------
// Page plumbing
// ---------------------------------------------------------------------------

/** Runs the fresh-database first-run setup so the app shell is reachable; tolerant of an already-set-up account. */
const reachAppShell = async (page: Page): Promise<void> => {
  await expect(page.locator('#username')).toBeVisible({ timeout: LANDING_TIMEOUT_MS });
  await page.locator('#username').fill('e2euser');
  await page.locator('input[type=password]').nth(0).fill('e2epassword');
  await page.locator('input[type=password]').nth(1).fill('e2epassword');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByPlaceholder('John Doe').fill('E2E User');
  await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Complete Setup' }).click();
  await expect(page.getByRole('button', { name: 'Settings', exact: true }).first()).toBeVisible({
    timeout: LANDING_TIMEOUT_MS,
  });
};

/** Opens Settings → "API & Tokens" and waits for the token section, so the whole tab has finished its first read. */
const openApiTokensTab = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'API & Tokens', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Personal Access Tokens' })).toBeVisible({ timeout: 15_000 });
};

/** Every text node of the document, joined — the whole-page surface the token-leak scan reads. */
const readAllTextNodes = (page: Page): Promise<string> => page.evaluate(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  while (walker.nextNode()) {
    parts.push(walker.currentNode.nodeValue ?? '');
  }
  return parts.join('\n');
});

/** Boots one state in a fresh browser context seeded with a fresh data directory. */
const bootStateWithPage = async (browser: Browser, state: GateState): Promise<{
  booted: BootedState;
  page: Page;
  close: () => Promise<void>;
}> => {
  const dataDir = fs.mkdtempSync(path.join(process.env.QUAY_E2E_DATA_DIR ?? '/tmp', `mcp-settings-${state.label}-`));
  const booted = await bootState(state, dataDir);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(booted.clientUrl, { waitUntil: 'domcontentloaded' });
  await reachAppShell(page);
  return {
    booted,
    page,
    close: async () => {
      await context.close();
      booted.stop();
    },
  };
};

test.describe.configure({ mode: 'serial', timeout: 110_000 });

test.describe('CloudCLI MCP block and token scopes in settings', () => {
  test('(b) disabled state: the page shows "not enabled" and renders no connect command', async ({ browser }) => {
    const { booted, page, close } = await bootStateWithPage(browser, DISABLED_STATE);
    try {
      await openApiTokensTab(page);

      const status = page.getByTestId('mcp-gateway-status');
      await expect(status).toHaveAttribute('data-enabled', 'false');
      const statusText = (await status.innerText()).trim();

      const hint = page.getByTestId('mcp-gateway-enable-hint');
      await expect(hint).toBeVisible();
      const hintText = (await hint.innerText()).trim();

      const commandCount = await page.getByTestId('mcp-gateway-command').count();
      const bodyText = await page.locator('body').innerText();
      const bearerOnPage = bodyText.includes('Bearer');

      console.log(
        `(b) MCP_ENABLED=${JSON.stringify(booted.state.mcpEnabled)}; status node="${statusText}" `
        + `(data-enabled=${await status.getAttribute('data-enabled')}); enable hint="${hintText}"; `
        + `connect-command nodes=${commandCount}; "Bearer" anywhere on page=${bearerOnPage}`,
      );

      expect(statusText.length).toBeGreaterThan(0);
      expect(hintText.length).toBeGreaterThan(0);
      expect(commandCount).toBe(0);
      expect(bearerOnPage).toBe(false);
    } finally {
      await close();
    }
  });

  test('(a)(c)(d)(e) enabled state: endpoint, copy button, safe command, scope checkboxes and token-info scopes', async ({ browser }) => {
    const { booted, page, close } = await bootStateWithPage(browser, ENABLED_STATE);
    try {
      await openApiTokensTab(page);

      // (a) The enabled reading: status, endpoint url and a copy button, all really on screen.
      const status = page.getByTestId('mcp-gateway-status');
      await expect(status).toHaveAttribute('data-enabled', 'true');
      const statusText = (await status.innerText()).trim();

      const endpointNode = page.getByTestId('mcp-gateway-endpoint');
      await expect(endpointNode).toBeVisible();
      const endpointText = (await endpointNode.innerText()).trim();

      const copyButton = page.getByTestId('mcp-gateway-copy');
      const copyVisible = await copyButton.isVisible();

      console.log(
        `(a) server env MCP_ENABLED=${JSON.stringify(booted.serverEnv.MCP_ENABLED)}; status node="${statusText}" `
        + `(data-enabled=${await status.getAttribute('data-enabled')}); endpoint="${endpointText}"; `
        + `copy button visible=${copyVisible}`,
      );

      expect(statusText.length).toBeGreaterThan(0);
      expect(copyVisible).toBe(true);
      // `<base>/mcp`, where the base is this state's own server origin: the Vite `/api` proxy forwards the request
      // to the server, so the origin the server reports is the address an MCP client should dial.
      expect(endpointText).toMatch(/^https?:\/\/[^/]+\/mcp$/);
      expect(Number(new URL(endpointText).port)).toBe(booted.serverPort);

      // (c) The connect command carries the endpoint and a Bearer placeholder — never a real token.
      const commandNode = page.getByTestId('mcp-gateway-command');
      await expect(commandNode).toBeVisible();
      const commandText = (await commandNode.innerText()).trim();
      console.log(`(c) connect command = ${JSON.stringify(commandText)}`);
      expect(commandText).toContain(endpointText);
      expect(commandText).toMatch(/Authorization:\s*Bearer\s*<token>/);

      // (d) Five scope checkboxes: only the read baseline starts checked; the risk note appears on the first write scope.
      await page.getByRole('button', { name: 'New Token', exact: true }).click();
      const boxFor = (scope: string) =>
        page.locator(`[data-testid="access-token-scope"][data-scope="${scope}"]`);
      const initialChecked: Record<string, boolean> = {};
      for (const scope of SCOPE_VOCABULARY) {
        initialChecked[scope] = await boxFor(scope).isChecked();
      }
      const riskNote = page.getByTestId('access-token-scope-risk');
      const riskBefore = await riskNote.count();

      await boxFor('cloudcli:session:send').check();
      await expect(riskNote).toBeVisible();
      const riskAfter = await riskNote.count();

      console.log(
        `(d) initial checked=${JSON.stringify(initialChecked)}; risk note before=${riskBefore} `
        + `after checking cloudcli:session:send=${riskAfter}; risk text="${(await riskNote.innerText()).trim()}"`,
      );

      expect(initialChecked['cloudcli:read']).toBe(true);
      for (const scope of SCOPE_VOCABULARY.slice(1)) {
        expect(initialChecked[scope]).toBe(false);
      }
      expect(riskBefore).toBe(0);
      expect(riskAfter).toBe(1);

      // (e) A multi-scope positive: create a token with the read baseline plus two write scopes.
      await boxFor('cloudcli:session:create').check();
      const selectedScopes = ['cloudcli:read', 'cloudcli:session:send', 'cloudcli:session:create'];
      const tokenName = `e2e-mcp-${Date.now()}`;
      await page.getByPlaceholder('Token name (e.g., My MCP client)').fill(tokenName);
      await page.getByTestId('access-token-expiry').selectOption('30');

      const [createResponse] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === 'POST' && response.url().endsWith('/api/settings/access-tokens')),
        page.getByRole('button', { name: 'Create token', exact: true }).click(),
      ]);
      const plaintext = (await page.getByTestId('new-access-token-plaintext').innerText()).trim();
      expect(createResponse.status()).toBe(201);

      // Dismiss the one-time plaintext card so the scan below measures the page as it stands after the token exists.
      await page.getByRole('button', { name: "I've saved it" }).click();
      await expect(page.getByTestId('new-access-token-plaintext')).toHaveCount(0);

      const pageText = await readAllTextNodes(page);
      const leakedHits = pageText.split(plaintext).length - 1;
      console.log(
        `(c) dismissed the one-time card; real token hits across ALL page text nodes = ${leakedHits} `
        + `(token prefix ${plaintext.slice(0, 8)})`,
      );
      expect(leakedHits).toBe(0);

      const tokenInfo = await httpRequest(
        'GET',
        `http://127.0.0.1:${booted.serverPort}/api/oauth/token-info`,
        { authorization: `Bearer ${plaintext}` },
      );
      const info = JSON.parse(tokenInfo.body) as { userId?: number; scopes?: string[]; expiresAt?: string };
      console.log(
        `(e) checked scopes=${JSON.stringify(selectedScopes)}; GET /api/oauth/token-info -> ${tokenInfo.status} `
        + `scopes=${JSON.stringify(info.scopes)} userId=${info.userId} expiresAt=${info.expiresAt}`,
      );
      expect(tokenInfo.status).toBe(200);
      expect([...(info.scopes ?? [])].sort()).toEqual([...selectedScopes].sort());
    } finally {
      await close();
    }
  });
});
