import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
// Nothing here stubs a request: every assertion is about what the UI really rendered or really sent.

const PROFILE = {
  name: 'E2E Gateway',
  model: 'claude-e2e-model',
  baseUrl: 'https://gateway.example.test/v1',
  authEnvVarName: 'E2E_GATEWAY_KEY',
  contextWindow: '123456',
};

// Namespaced i18n keys leak into the UI as literals like "mainTabs.profiles" when a translation is missing.
const UNTRANSLATED_KEY = /\b(?:mainTabs|launchProfiles|launchProfile|settings|chat|common|sidebar)\.[a-z][A-Za-z]+\b/;

test.describe.serial('launch profiles in a real browser', () => {
  let page: Page;
  let profileId = '';
  const sentFrames: string[] = [];

  const openProfilesTab = async () => {
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: 'Profiles' }).click();
    await expect(page.getByText('Named launch configurations')).toBeVisible();
  };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('websocket', (socket) => {
      socket.on('framesent', (frame) => sentFrames.push(String(frame.payload)));
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
    await page.close();
  });

  test('(b) editor takes baseUrl, auth mode and context window and shows them again after reopening', async () => {
    await openProfilesTab();
    // No profile exists yet, so the create form is the only editor on the page and its labels are unique.
    const form = page;
    await form.getByLabel('Name').fill(PROFILE.name);
    await form.getByLabel('Model').fill(PROFILE.model);
    await form.getByLabel('Base URL').fill(PROFILE.baseUrl);
    await form.getByLabel('Authentication').selectOption('envVar');
    await form.getByLabel('Environment variable name').fill(PROFILE.authEnvVarName);
    await form.getByLabel('Context window (tokens)').fill(PROFILE.contextWindow);

    const created = page.waitForResponse(
      (response) => response.url().endsWith('/api/launch-profiles') && response.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Create profile' }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    profileId = (await response.json()).id;
    expect(profileId).toBeTruthy();

    // Close and reopen Settings: values must come back from the server, not from leftover component state.
    await page.keyboard.press('Escape');
    await page.reload();
    await openProfilesTab();
    await expect(page.getByLabel('Name').first()).toHaveValue(PROFILE.name);
    await expect(page.getByLabel('Model').first()).toHaveValue(PROFILE.model);
    await expect(page.getByLabel('Base URL').first()).toHaveValue(PROFILE.baseUrl);
    await expect(page.getByLabel('Authentication').first()).toHaveValue('envVar');
    await expect(page.getByLabel('Environment variable name').first()).toHaveValue(PROFILE.authEnvVarName);
    await expect(page.getByLabel('Context window (tokens)').first()).toHaveValue(PROFILE.contextWindow);
  });

  test('(a) Profiles page and session entry show no untranslated i18n keys', async () => {
    await expect(page.getByText('Launch profiles', { exact: false }).first()).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(UNTRANSLATED_KEY);

    await page.keyboard.press('Escape');
    const workspace = path.join(process.env.QUAY_E2E_DATA_DIR!, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    await page.getByTitle('Create new project').click();
    await page.getByPlaceholder('/path/to/project/workspace').fill(workspace);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Create Project' }).click();
    await page.getByText('workspace', { exact: true }).first().click();

    const select = page.getByLabel('Launch profile');
    await expect(select).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(UNTRANSLATED_KEY);
    expect(await select.innerText()).not.toMatch(UNTRANSLATED_KEY);
  });

  test('(c) the selected profile is sent with the session message', async () => {
    await page.getByLabel('Launch profile').selectOption(profileId);
    await page.getByPlaceholder(/Type \/ for commands/).fill('hello from e2e');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect
      .poll(() => sentFrames.some((frame) => frame.includes('hello from e2e')), { timeout: 15_000 })
      .toBe(true);
    const frame = JSON.parse(sentFrames.find((payload) => payload.includes('hello from e2e'))!);
    expect(frame.type).toBe('chat.send');
    expect(frame.launchProfileId).toBe(profileId);
  });
});
