import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

/*
 * Continuous capture, end to end, against the real client and the real backend.
 *
 * WHAT IS REAL AND WHAT IS NOT. The composer, the hook, the segmenter, the shared VAD and the request
 * builder are the shipping code. Two things are stand-ins, and each is named where it lives:
 *
 *   · the microphone, because no CI machine has one and a real one could not be told to say an exact
 *     timeline of speech and pauses. An init script replaces `AudioContext`/`AudioWorkletNode` and
 *     `getUserMedia` with a graph the spec drives: `__voiceFake.speak(1)` feeds one second of speech
 *     with a `speechStart`, `__voiceFake.pause(2.5)` feeds silence. That is the same interface the real
 *     worklet forwards (PCM frames plus VAD events), so everything downstream of the audio thread runs
 *     unchanged.
 *
 *   · the recogniser. The settings name `dashscope-omni`, whose declaration is `proxy-only`, so the
 *     client posts to this app's `/api/voice/transcribe`; Playwright intercepts that route, so the
 *     request never leaves the machine and no credential is spent. The route answers each upload with a
 *     sentence this file chooses, and can delay or fail an individual one — which is what lets the
 *     ordering, incremental and failure readings be taken at all.
 *
 * The fixture session is seeded by `playwright.config.ts` (the server scans its projects once at boot,
 * so a transcript written during the run would never be adopted).
 */

const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;
const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const WORKSPACE = path.join(DATA_DIR, 'voice-continuous-workspace');
const SESSION_ID = 'e2e-voice-continuous';
const SESSION_NAME = 'voice-continuous';

/** What the recogniser stand-in answers each upload with, by the order the uploads arrive in. */
const ANSWERS = ['alpha bravo', 'charlie delta', 'echo foxtrot'];

/** Short enough that a two-word answer cannot be a coincidence with another leg's. */
const FULL_TWO = `${ANSWERS[0]} ${ANSWERS[1]}`;

/** A pause longer than the segmenter's cut threshold (2.0 s), so a cut lands inside it. */
const CUT_PAUSE_SEC = 2.6;

/** A spoken second and a pause: one segment per repetition, once the minimum is turned down. */
const SPEECH_SEC = 1;

/** The segment minimum every leg but the short-input one names, so a pause really ends a segment. */
const SMALL_MIN_SEC = 0.3;

type Recorded = { url: string; answer: string; index: number };

test.describe.configure({ mode: 'serial' });

test.describe('the continuous voice path end to end', () => {
  let context: BrowserContext;
  let page: Page;
  /** Every upload the route saw, in arrival order. */
  const uploads: Recorded[] = [];
  /** Per-upload delay, in ms, keyed by arrival index. */
  let delayMs: Record<number, number> = {};
  /**
   * When set, every upload whose body is larger than this is refused.
   *
   * The body, not the arrival index, because a refused segment is retried: the retry is a new request
   * with a new index, so an index-keyed refusal would let a later attempt succeed. The largest segment
   * is the one the failure leg makes fail, and every one of its attempts carries the same bytes.
   */
  const failAboveBytes: { value: number | null } = { value: null };

  /** The composer's textarea, the one place committed text lands. */
  const composer = () => page.locator('[data-slot="prompt-input-textarea"]');
  const micButton = () => page.getByRole('button', { name: 'Voice input' });
  const stopButton = () => page.getByRole('button', { name: 'Stop recording' });
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${path.basename(WORKSPACE)}`) }).first();
  const sessionLink = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

  /** Expands the project's session list, retrying past a sidebar that is still re-rendering. */
  const expandProject = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await sessionLink().isVisible().catch(() => false)) return;
      await projectRow().click();
      try {
        await expect(sessionLink()).toBeVisible({ timeout: 10_000 });
        return;
      } catch {
        /* collapsed again; click once more */
      }
    }
    await expect(sessionLink()).toBeVisible({ timeout: 15_000 });
  };

  /** Loads `url` (which names the debug switches), opens the fixture session, and empties the box. */
  const openComposer = async (url: string) => {
    await page.goto(url);
    await expandProject();
    await sessionLink().click();
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
    await expect(composer()).toBeVisible({ timeout: 15_000 });
    await composer().fill('');
    await expect(composer()).toHaveValue('');
  };

  /** Starts a listen and waits for the fake graph to be connected. */
  const startListening = async (url: string) => {
    await openComposer(url);
    await micButton().click();
    await expect(stopButton()).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => page.evaluate(() => Boolean((window as unknown as { __voiceFake?: { node?: unknown } }).__voiceFake?.node)))
      .toBe(true);
  };

  /** Feeds `seconds` of speech followed by a pause long enough to close the segment. */
  const speakThenCut = async (seconds = SPEECH_SEC) => {
    await page.evaluate(([s, pause]) => {
      const fake = (window as unknown as { __voiceFake: { speak: (n: number) => void; pause: (n: number) => void } }).__voiceFake;
      fake.speak(s);
      fake.pause(pause);
    }, [seconds, CUT_PAUSE_SEC]);
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(60_000);

    context = await browser.newContext({ baseURL: CLIENT_URL });
    await context.addInitScript(
      ({ voiceConfig, preferences }) => {
        window.localStorage.setItem('voiceConfig', JSON.stringify(voiceConfig));
        window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
        window.localStorage.setItem(
          'user-preferences',
          JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }),
        );
        window.localStorage.setItem('userLanguage', 'en');

        // The fake audio graph. `speak`/`pause` are the driver the spec uses; `node` is where the
        // hook attaches its `onmessage`, and it is captured at construction.
        type Port = { port: { onmessage: ((m: unknown) => void) | null } };
        const state: {
          node: Port | null;
          atSample: number;
          speak: (seconds: number) => void;
          pause: (seconds: number) => void;
        } = {
          node: null,
          atSample: 0,
          // A speech run: the `speechStart` is posted BEFORE the PCM, so the hook buffers it and hands
          // it to this same push — exactly the order the real worklet uses, and what makes the frames
          // that follow read as speech.
          speak(seconds: number) {
            const node = state.node;
            if (!node) throw new Error('the fake capture was not connected yet');
            node.port.onmessage?.({ data: { type: 'event', event: { type: 'speechStart', atSample: state.atSample } } });
            push(seconds, 0.3);
          },
          // A pause: the `speechEnd` is posted first (it ends the run at the silence's first frame),
          // then the silence itself. A leading `pause` with no speech before it posts a harmless
          // `speechEnd` the detector was already in.
          pause(seconds: number, amplitude = 0) {
            const node = state.node;
            if (!node) throw new Error('the fake capture was not connected yet');
            node.port.onmessage?.({ data: { type: 'event', event: { type: 'speechEnd', atSample: state.atSample } } });
            push(seconds, amplitude);
          },
        };
        function push(seconds: number, amplitude: number): void {
          const node = state.node;
          if (!node) throw new Error('the fake capture was not connected yet');
          const count = Math.max(1, Math.round(seconds * 16_000));
          const samples = new Float32Array(count);
          samples.fill(amplitude);
          node.port.onmessage?.({ data: { type: 'pcm', samples, atSample: state.atSample } });
          state.atSample += count;
        }
        (window as unknown as { __voiceFake: typeof state }).__voiceFake = state;

        class FakeWorkletNode {
          port: { onmessage: ((m: unknown) => void) | null; postMessage: () => void };
          constructor() {
            this.port = { onmessage: null, postMessage: () => undefined };
            state.node = this as unknown as typeof state.node;
          }

          connect() {
            /* the graph is inert; the spec drives the port directly */
          }
        }

        class FakeAudioContext {
          sampleRate = 16_000;
          destination = {};
          audioWorklet = { addModule: async () => undefined };
          createGain() {
            return { gain: { value: 0 }, connect: () => undefined };
          }

          createMediaStreamSource() {
            return { connect: () => undefined };
          }

          close() {
            return Promise.resolve();
          }
        }

        (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
        (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
        });
      },
      {
        // dashscope-omni is proxy-only, so the client posts to this app's /api/voice/transcribe; its
        // credential fields are what make the server call it configured.
        voiceConfig: {
          baseUrl: '',
          apiKey: '',
          sttModel: '',
          ttsModel: '',
          ttsVoice: '',
          ttsFormat: '',
          providerId: 'dashscope-omni',
          dashscopeEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          dashscopeApiKey: 'sk-e2e-continuous-fake',
          dashscopeModel: 'qwen3-asr-flash',
        },
        preferences: { voiceEnabled: true },
      },
    );
    page = await context.newPage();

    // The one recogniser stand-in. The request never leaves the machine and no credential is spent.
    await page.route('**/api/voice/transcribe', async (route) => {
      const index = uploads.length;
      const answer = ANSWERS[Math.min(index, ANSWERS.length - 1)];
      uploads.push({ url: route.request().url(), answer, index });
      const delay = delayMs[index] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const bodyBytes = route.request().postDataBuffer()?.length ?? 0;
      if (failAboveBytes.value !== null && bodyBytes > failAboveBytes.value) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'the stand-in refused this segment' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: answer }),
      });
    });

    // First run on a fresh database: create the single account and finish onboarding, with the same
    // cold-Vite retry the other voice specs carry.
    await page.goto('/');
    let onboarded = await page.locator('#username').isVisible().catch(() => false);
    for (let attempt = 0; !onboarded && attempt < 3; attempt += 1) {
      await page.reload();
      onboarded = await page.locator('#username').isVisible().catch(() => false);
    }
    if (!onboarded) {
      const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
      throw new Error(`the account form never rendered; the page shows: ${JSON.stringify(shown.slice(0, 300))}`);
    }
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(projectRow()).toBeVisible({ timeout: 12_000 });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test.beforeEach(() => {
    uploads.length = 0;
    delayMs = {};
    failAboveBytes.value = null;
  });

  test('a short dictation is exactly one request and fills the box with its answer', async () => {
    test.setTimeout(40_000);
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=30`);

    // Three seconds of speech, one continuous run: below the 30 s minimum, so the stop flushes it as
    // the single trailing segment.
    await page.evaluate(() => {
      (window as unknown as { __voiceFake: { speak: (n: number) => void } }).__voiceFake.speak(3);
    });
    await stopButton().click();

    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
    await expect(composer()).toHaveValue(ANSWERS[0], { timeout: 10_000 });
    expect(uploads.length, 'a short dictation made more than one request').toBe(1);
  });

  test('a long dictation commits in spoken order even when a later segment answers first', async () => {
    test.setTimeout(45_000);
    // The first segment's answer is held back well past the second's, so "the second is not committed
    // early" is a reading this run can actually take.
    delayMs = { 0: 5_000 };
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    await speakThenCut();
    await speakThenCut();
    await stopButton().click();

    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(2);

    // The second segment has answered (no delay on it), but the first has not settled, so neither may
    // be in the box yet.
    await page.waitForTimeout(1_500);
    expect(await composer().inputValue(), 'a later segment was committed before the earlier one').not.toContain(ANSWERS[1]);

    await expect(composer()).toHaveValue(FULL_TWO, { timeout: 15_000 });
  });

  test('text is committed while the microphone is still recording', async () => {
    test.setTimeout(40_000);
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    await speakThenCut();

    // Still recording: the stop control is on screen, and the first segment's answer is already in the box.
    await expect(composer()).toHaveValue(ANSWERS[0], { timeout: 15_000 });
    await expect(stopButton()).toBeVisible();

    await stopButton().click();
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
  });

  test('a lost segment leaves no marker in the box, reports once, and does not stop the rest', async () => {
    test.setTimeout(45_000);
    // The middle segment is the longest, so its upload is the one the refusal is keyed on; the first
    // and last are shorter and go through. Every retry of the middle one carries the same bytes.
    failAboveBytes.value = 50_000;
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    await speakThenCut(1);
    await speakThenCut(2);
    await speakThenCut(1);
    await stopButton().click();

    // Both good segments are committed, in order, and the failed one contributes nothing.
    await expect(composer()).toHaveValue(`${ANSWERS[0]} ${ANSWERS[2]}`, { timeout: 20_000 });
    await expect(page.getByTestId('voice-error-notice')).toHaveCount(1);
    const value = await composer().inputValue();
    expect(value, `the box carries a placeholder: ${JSON.stringify(value)}`).not.toMatch(/\[|\]|failed|segment \d/i);
  });

  test('an input with no speech spends no request and reports nothing', async () => {
    test.setTimeout(40_000);
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    await page.evaluate(() => {
      (window as unknown as { __voiceFake: { pause: (n: number) => void } }).__voiceFake.pause(3);
    });
    await stopButton().click();

    // Back to idle with nothing spent.
    await expect(micButton()).toBeVisible({ timeout: 10_000 });
    await expect(composer()).toHaveValue('');
    expect(uploads.length, 'silence spent a request').toBe(0);
    await expect(page.getByTestId('voice-error-notice')).toHaveCount(0);
  });

  test('a silent listen auto-stops on its own after the idle window, with no request', async () => {
    test.setTimeout(40_000);
    await startListening(`/?voiceDebug=1&voiceIdleSec=2&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    // No speech at all: the idle guard closes the microphone on its own and the stop control goes away.
    await expect(micButton()).toBeVisible({ timeout: 12_000 });
    expect(uploads.length, 'the idle auto-stop spent a request').toBe(0);
  });

  test('pressing send while recording sends the whole concatenation once', async () => {
    test.setTimeout(45_000);
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    await speakThenCut();
    await speakThenCut();

    // The composer's submit control is the send entry while recording. `exact` because a sidebar
    // project row's accessible name can contain the word too.
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // The whole dictation reaches the conversation as one message.
    await expect(page.locator('body')).toContainText(FULL_TWO, { timeout: 20_000 });
  });

  test('after a stop the replay slot offers the filtered audio, and drops the raw track past the cap', async () => {
    test.setTimeout(45_000);

    // Default cap: both tracks are offered.
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);
    await speakThenCut();
    await stopButton().click();
    await expect(page.getByRole('button', { name: 'Replay trimmed' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Replay original' })).toBeVisible();

    // A cap below the stream's length: the raw track is dropped whole, the filtered one stays.
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}&voiceOriginalCapSec=1`);
    await page.evaluate(() => {
      (window as unknown as { __voiceFake: { speak: (n: number) => void } }).__voiceFake.speak(3);
    });
    await stopButton().click();
    await expect(page.getByRole('button', { name: 'Replay trimmed' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Replay original' })).toHaveCount(0);
  });
});
