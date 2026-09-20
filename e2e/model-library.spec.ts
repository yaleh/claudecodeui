import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// AC-027: real Chromium against the real backend + Vite client (playwright.config.ts, isolated data dir).
// The model is created only through the Settings UI; the only stub is the LLM gateway the model points at,
// so "the request landed" is observed on a real socket instead of being asserted from component state.

const MODEL = { name: 'E2E Gateway Model', id: 'e2e-gateway-model' };
const TOKEN = 'sk-e2e-secret-7f3a9c1d5b';
const PROMPT = 'hello gateway from model-library e2e';

// Namespaced i18n keys leak into the UI as literals like "modelLibrary.env.gatewayTemplate" when a translation is missing.
const UNTRANSLATED_KEY = /\b(?:modelLibrary|composer|settings|chat|common|sidebar|mainTabs)\.[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)*\b/;

type GatewayHit = { url: string; headers: http.IncomingHttpHeaders; body: string };

test.describe.serial('model library in a real browser', () => {
  let page: Page;
  let gateway: http.Server;
  let gatewayUrl = '';
  const gatewayHits: GatewayHit[] = [];
  const responseBodies: string[] = [];

  const openModelsPage = async () => {
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: 'Agents' }).click();
    // Claude is the Agents tab's default provider, so its Models category is one click away.
    await page.getByRole('tab', { name: 'Models' }).click();
    await expect(page.getByText('Model library')).toBeVisible();
  };

  test.beforeAll(async ({ browser }) => {
    gateway = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        gatewayHits.push({ url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        // Fail fast: the assertion is that the request arrived with the token, not that a reply is rendered.
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'e2e mock gateway' } }));
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

    page = await browser.newPage();
    page.on('response', (response) => {
      if (response.url().includes('/api/')) {
        response.text().then((text) => responseBodies.push(text)).catch(() => {});
      }
    });

    // First run on a fresh database: create the single account, then finish onboarding.
    await page.goto('/');
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(page.getByText('Choose Your Project')).toBeVisible();
  });

  test.afterAll(async () => {
    // Leave no model behind, whatever the tests did.
    try {
      await page.goto('/');
      await openModelsPage();
      const remove = page.getByRole('button', { name: `Delete ${MODEL.name}` });
      if (await remove.count()) {
        await remove.click();
        await page.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(page.getByRole('button', { name: `Delete ${MODEL.name}` })).toHaveCount(0);
      }
    } finally {
      await page.close();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });

  test('creates a model from the gateway template through the Models page', async () => {
    await openModelsPage();
    expect(await page.locator('body').innerText()).not.toMatch(UNTRANSLATED_KEY);

    await page.getByLabel('Model name').fill(MODEL.name);
    await page.getByLabel('Model ID').fill(MODEL.id);
    await page.getByRole('button', { name: 'Gateway template' }).click();

    const rows = page.getByTestId('model-env-row');
    await expect(rows).toHaveCount(6);
    const rowFor = (key: string) => rows.filter({ has: page.locator(`input[value="${key}"]`) });
    await rowFor('ANTHROPIC_BASE_URL').getByLabel('Value').fill(gatewayUrl);
    await rowFor('ANTHROPIC_AUTH_TOKEN').getByLabel('Secret value').fill(TOKEN);
    expect(await page.locator('body').innerText()).not.toMatch(UNTRANSLATED_KEY);

    const created = page.waitForResponse(
      (response) => /\/api\/providers\/claude\/models/.test(response.url()) && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Add model' }).click();
    expect((await created).status()).toBeLessThan(300);
    await expect(page.getByRole('button', { name: `Edit ${MODEL.name}` })).toBeVisible();
  });

  test('after a reload the secret is only shown as set and its value is nowhere to be found', async () => {
    await page.reload();
    await openModelsPage();
    await page.getByRole('button', { name: `Edit ${MODEL.name}` }).click();

    const secretRow = page.getByTestId('model-env-row').filter({ has: page.locator('input[value="ANTHROPIC_AUTH_TOKEN"]') });
    await expect(secretRow.getByTestId('secret-set-badge')).toBeVisible();
    await expect(secretRow.getByLabel('Secret value')).toHaveValue('');

    expect(await page.locator('body').innerText()).not.toContain(TOKEN);
    expect(await page.content()).not.toContain(TOKEN);
    expect(await page.locator('body').innerText()).not.toMatch(UNTRANSLATED_KEY);
    // The create response, the reload's catalog fetches and every other API body seen so far.
    expect(responseBodies.length).toBeGreaterThan(0);
    for (const body of responseBodies) {
      expect(body).not.toContain(TOKEN);
    }
  });

  test('the model is selectable in the composer and the gateway receives the request with its token', async () => {
    await page.keyboard.press('Escape');
    await page.reload();
    const workspace = path.join(process.env.QUAY_E2E_DATA_DIR!, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    await page.getByTitle('Create new project').click();
    await page.getByPlaceholder('/path/to/project/workspace').fill(workspace);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Create Project' }).click();
    await page.getByText('workspace', { exact: true }).first().click();

    await page.getByRole('button', { name: 'Select model and reasoning effort' }).click();
    await page.getByRole('menuitem').first().click();
    await page.getByRole('menuitemradio', { name: MODEL.name }).click();
    await expect(page.getByRole('button', { name: 'Select model and reasoning effort' })).toContainText(MODEL.name);

    const composer = page.locator('form').filter({ has: page.getByPlaceholder(/Type \/ for commands/) });
    expect(await composer.innerText()).not.toMatch(UNTRANSLATED_KEY);

    await page.getByPlaceholder(/Type \/ for commands/).fill(PROMPT);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect
      .poll(() => gatewayHits.some((hit) => hit.headers['authorization'] === `Bearer ${TOKEN}` || hit.headers['x-api-key'] === TOKEN), {
        timeout: 45_000,
      })
      .toBe(true);
    const hit = gatewayHits.find((entry) => entry.url.includes('/v1/messages'));
    expect(hit).toBeTruthy();
    expect(hit!.body).toContain(MODEL.id);
  });
});
