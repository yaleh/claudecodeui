import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// The recorder is the browser's own: Chromium is launched with a fake audio device whose samples come from a
// WAV fixture, so `getUserMedia` hands `MediaRecorder` a real stream, the app's own hook encodes it, and the
// browser uploads the blob to the endpoint the *voice settings* name — the settings having been seeded into
// the two places an existing install really keeps them, and imported from there by the app's own hydration.
//
// The one stand-in is the recogniser. No offline speech-to-text exists in this checkout, so the endpoint the
// voice settings point at is a local server that answers `/audio/transcriptions`; the same shape the
// model-library specs already use for the LLM gateway they point a model at. Nothing here stubs the app: the
// request that arrives on that socket was made by the running client through the real
// `transcribeVoice()` path, carrying the seeded credential and model, and every assertion below is about what
// the app itself did with the answer.
//
// The identifier is not a literal on this side either. playwright.config.ts writes `voice.routes.ts` into the
// seeded project's workspace, and the identifier asserted on is read back off that directory — so the claim
// "the composer holds the project's real file name" is decided by the project's own content. The recogniser
// hears it as `voice.rouse.ts`, so the composer holding the real name is a repair that happened, not a
// transcription that was already right.

/** The sentence the fake microphone is saying; the recogniser stand-in answers with it, and the composer must end up holding it repaired. */
const UTTERANCE = process.env.QUAY_E2E_VOICE_UTTERANCE!;
/** The identifier as the recogniser heard it — the fixture's pre-repair state, which the composer must not still hold. */
const SPOKEN = process.env.QUAY_E2E_VOICE_SPOKEN_IDENTIFIER!;
const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;
const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const WORKSPACE = path.join(DATA_DIR, 'voice-identifier-workspace');
const SESSION_ID = 'e2e-voice-identifier';
const SESSION_NAME = 'voice-identifier';
/** What the seeded voice settings name as the recogniser endpoint's credential, so the arriving request can be traced back to them. */
const API_KEY = 'sk-e2e-voice-4b1d9e77';
const STT_MODEL = 'whisper-large-v3-turbo';
/** `useVoiceInput` refuses to upload a blob under 800 bytes ("Recording too short"), so the capture must outlast that floor. */
const MIN_UPLOAD_BYTES = 800;

/**
 * Chromium's fake audio device, fed from the WAV playwright.config.ts wrote before the servers booted.
 *
 * `--use-fake-device-for-media-stream` is what makes `--use-file-for-fake-audio-capture` take effect at all:
 * without it the file is ignored and the device synthesises a beep, which would still record and still
 * transcribe — the run would go green while testing no fixture.
 */
test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${process.env.QUAY_E2E_VOICE_AUDIO}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

/** One request the recogniser stand-in saw, kept so the assertions can be about the real socket. */
type RecognizerRequest = {
  url: string;
  method: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
};

test.describe.configure({ mode: 'serial' });

test.describe('AC-115 the repair holds end to end through the voice button', () => {
  let context: BrowserContext;
  let page: Page;
  let recognizer: http.Server;
  let recognizerUrl = '';
  const requests: RecognizerRequest[] = [];

  /**
   * The OpenAI-compatible speech endpoint the voice settings point at.
   *
   * A cross-origin multipart POST carrying `Authorization` is not a simple request, so the browser sends a
   * preflight first and would block the call without an answer to it — the preflight is handled here for the
   * same reason a real provider handles it, not as a convenience.
   */
  const startRecognizer = async (): Promise<http.Server> => {
    const server = http.createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
      response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');

      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }

      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          url: request.url ?? '',
          method: request.method ?? '',
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body: Buffer.concat(chunks),
        });

        if (!(request.url ?? '').endsWith('/audio/transcriptions')) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'unexpected path' }));
          return;
        }

        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ text: UTTERANCE }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  };

  /** The project row is a toggle whose accessible name starts with the workspace's display name. */
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${path.basename(WORKSPACE)}`) }).first();

  const sessionLink = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

  /**
   * Expands the project's session list. The row is a toggle, so a click that lands while the sidebar is still
   * re-rendering (right after a reload) would leave it collapsed — retry until the row is really on screen.
   */
  const expandProject = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await sessionLink().isVisible().catch(() => false)) {
        return;
      }
      await projectRow().click();
      try {
        await expect(sessionLink()).toBeVisible({ timeout: 10_000 });
        return;
      } catch {
        // Collapsed again (or the click missed); the loop clicks once more.
      }
    }
    await expect(sessionLink()).toBeVisible({ timeout: 15_000 });
  };

  test.beforeAll(async ({ browser }) => {
    // Onboarding plus the first project load outlasts the default per-test budget, and the whole criterion has
    // to fit inside the goal gate's 60s — so the budget is raised only as far as the flow needs.
    test.setTimeout(120_000);

    recognizer = await startRecognizer();
    recognizerUrl = `http://127.0.0.1:${(recognizer.address() as AddressInfo).port}`;

    context = await browser.newContext({
      baseURL: CLIENT_URL,
      permissions: ['microphone'],
    });

    // The two places an install that predates the server-side move really keeps these values, written before
    // the app runs so the app's own readers are what consume them:
    //   - `user-preferences`, the mirror the first paint reads synchronously;
    //   - `uiPreferences`, the legacy key that mirror's `uiPreferences` entry is migrated from on hydrate;
    //   - `voiceConfig`, the legacy voice settings, imported to the server on the first voice hydration.
    // Seeding both the mirror and the legacy keys is the point: the built-in this exercises is the migration,
    // and a value that only ever existed in the mirror would be dropped the moment hydration replaced it.
    await context.addInitScript(
      ({ voiceConfig, preferences }: { voiceConfig: unknown; preferences: unknown }) => {
        window.localStorage.setItem('voiceConfig', JSON.stringify(voiceConfig));
        window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
        window.localStorage.setItem('user-preferences', JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }));
        window.localStorage.setItem('userLanguage', 'en');
      },
      {
        voiceConfig: {
          baseUrl: recognizerUrl,
          apiKey: API_KEY,
          sttModel: STT_MODEL,
          ttsModel: '',
          ttsVoice: '',
          ttsFormat: '',
        },
        preferences: { voiceEnabled: true },
      },
    );

    page = await context.newPage();

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

    // Indexing a session auto-registers its project, so the seeded workspace is already a project here; the
    // sidebar is the proof that the fixture really reached the backend.
    await expect(projectRow()).toBeVisible({ timeout: 30_000 });

    // Loading the app re-reads /api/projects, which synchronizes sessions before it answers.
    await page.reload();
    await expandProject();
    await expect(sessionLink()).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await context?.close();
    await new Promise<void>((resolve) => recognizer?.close(() => resolve()));
  });

  test('AC-115 a recording made through the voice button lands the project\'s real file name in the composer', async () => {
    // The project's own file name, read off the project rather than restated here.
    const fileNames = fs.readdirSync(WORKSPACE).filter((name) => name.endsWith('.ts'));
    expect(fileNames, 'the seeded workspace must hold the file the utterance names').toHaveLength(1);
    const [identifier] = fileNames;
    // The fixture must arrive BEFORE the repair. An utterance that already carried the real name would satisfy
    // every assertion below whether or not anything repairs it — green in exactly the world this criterion
    // exists to catch. Asserting the spoken form is present and the real name is absent is what keeps it able
    // to fail, so this premise failing is a criterion defect, not a product one.
    expect(UTTERANCE).toContain(SPOKEN);
    expect(UTTERANCE).not.toContain(identifier);
    /** What the composer has to hold: the recogniser's sentence with the name it got wrong put back. */
    const expected = UTTERANCE.split(SPOKEN).join(identifier);

    // The audio the fake device was pointed at, checked as audio. A path that does not resolve to a WAV is not
    // an error Chromium reports: it quietly plays its own fallback tone instead, which records and transcribes
    // exactly like the fixture — so a criterion that only looked at the composer could go green on a run where
    // nothing was injected at all.
    const audio = fs.readFileSync(process.env.QUAY_E2E_VOICE_AUDIO!);
    expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(audio.subarray(8, 12).toString('ascii')).toBe('WAVE');
    // 48kHz mono 16-bit, so a second of it is 96kB: the fixture is seconds long, not a click.
    expect(audio.length).toBeGreaterThan(96_000);

    await sessionLink().click();
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));

    const composer = page.locator('[data-slot="prompt-input-textarea"]');
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await expect(composer).toHaveValue('');

    // The mic button is on screen only once both halves of the gate are satisfied: `voiceEnabled` from the
    // seeded preferences, and a configured backend from the seeded `voiceConfig` after its hydration ran.
    const record = page.getByRole('button', { name: 'Voice input' });
    await expect(record).toBeVisible({ timeout: 15_000 });
    await record.click();

    // Recording really started: the button renames itself for as long as the recorder is running.
    const stop = page.getByRole('button', { name: 'Stop recording' });
    await expect(stop).toBeVisible({ timeout: 10_000 });

    // The recorder has to run long enough to clear the hook's own 800-byte floor. There is no event to wait on
    // for "enough audio" — the upload does not exist until the stop — so the wait is the capture duration.
    await page.waitForTimeout(2500);
    await stop.click();

    // The transcript travelled the whole path back into the composer, and it is the recogniser's text with the
    // one name it got wrong put back — the app is free to trim, but the only thing allowed to re-spell it is the
    // repair, and only against a name the project really has.
    // The ceiling is deliberately short: a regression here has to surface as this assertion rather than as an
    // unattributable timeout, because the gate that runs this file caps the whole command at 60s.
    await expect(composer).toHaveValue(expected, { timeout: 15_000 });
    const value = await composer.inputValue();

    // The identifier survives with its own case and its own dots, character for character...
    expect(value).toContain(identifier);
    // ...and what landed is not the shape a recogniser produces when it drops the dot — which is the failure
    // this criterion exists to catch, and which any dots-blind comparison would accept.
    expect(value).not.toContain(identifier.replace(/\./g, ' '));
    // ...and it is not the name the recogniser actually said either. This is the reading that separates a
    // repair from a fixture that was already spelled right: the composer must hold the project's name and no
    // longer the wrong one, so the criterion fails if the repair stops running.
    expect(value).not.toContain(SPOKEN);

    // The transcription was the app's own call, made from the seeded settings, and it carried real audio.
    expect(requests).toHaveLength(1);
    const [upload] = requests;
    expect(upload.method).toBe('POST');
    expect(upload.url.endsWith('/audio/transcriptions')).toBe(true);
    // The credential proves the request was built from the settings that were seeded, not from a default.
    expect(upload.authorization).toBe(`Bearer ${API_KEY}`);
    expect(upload.contentType).toContain('multipart/form-data');
    // A real recording: the browser encoded audio, and it cleared the hook's own floor before uploading.
    expect(upload.body.length).toBeGreaterThan(MIN_UPLOAD_BYTES);
    // ...encoded by `MediaRecorder` from the microphone stream, not a payload the test assembled.
    expect(upload.body.includes(Buffer.from('audio/webm'))).toBe(true);
    expect(upload.body.includes(Buffer.from(`name="model"`))).toBe(true);
    expect(upload.body.includes(Buffer.from(STT_MODEL))).toBe(true);
  });
});
