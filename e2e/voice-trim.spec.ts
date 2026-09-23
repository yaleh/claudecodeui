import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir),
// recording through the app's own voice button. The recorder is the browser's own: Chromium is launched with a
// fake audio device whose samples come from the WAV playwright.config.ts wrote before the servers booted, so
// `getUserMedia` hands `MediaRecorder` a real stream and the app's own hook encodes what it hears.
//
// What this file adds over e2e/voice-identifier-repair.spec.ts is a *pair*. The same fixture is recorded twice —
// once with trimming on (the default) and once with `?voiceTrim=off` — and the two uploads that arrive at the
// recogniser stand-in are read back as audio and compared. That is the only way to see the trim from outside:
// the app is free to trim, and the assertion has to be about what it actually sent.
//
// The one stand-in is the recogniser, exactly as in the identifier spec: no offline speech-to-text exists in
// this checkout, so the endpoint the voice settings name is a local server answering `/audio/transcriptions`.
// Nothing here stubs the app — the request that arrives on that socket was made by the running client through
// the real `transcribeVoice()` path, carrying the seeded credential and model.
//
// Both uploads are measured by parsing the container they are in, never by their byte count. A byte count would
// be worse than useless here: the trimmed leg is re-encoded as PCM WAV and the untrimmed leg is the recorder's
// own webm/opus, so the *shorter* upload is the *larger* one. Only the container says how long the audio is.

const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;
const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const WORKSPACE = path.join(DATA_DIR, 'voice-trim-workspace');
const SESSION_ID = 'e2e-voice-trim';
const SESSION_NAME = 'voice-trim';
/** Where the fake microphone reads its samples from; the config wrote it before the browser was launched. */
const AUDIO_FILE = process.env.QUAY_E2E_VOICE_TRIM_AUDIO!;
/** The fixture's own duration, derived by the config from the samples it wrote. */
const FIXTURE_SEC = Number(process.env.QUAY_E2E_VOICE_TRIM_FIXTURE_SEC);
/** What the seeded voice settings name as the recogniser endpoint's credential, so the arriving request can be traced back to them. */
const API_KEY = 'sk-e2e-voice-trim-7c2f5a13';
const STT_MODEL = 'whisper-large-v3-turbo';

/**
 * How long each leg holds the recorder open: one pass of the fixture, so the untrimmed upload is the fixture.
 *
 * `useVoiceInput` refuses to upload a blob under 800 bytes ("Recording too short"), which this clears by three
 * orders of magnitude, and the pause the trim is meant to remove has to be *inside* the window for the trim to
 * have anything to do — hence a whole pass rather than a fraction of one.
 */
const CAPTURE_MS = Math.round(FIXTURE_SEC * 1000);

/**
 * How far the untrimmed upload may differ from the fixture and still count as "the whole capture".
 *
 * The gap is the recorder's own start/stop overhead, measured at ~40 ms on a 2.5 s take, so a third of a second
 * is several times the observed error. It is not slack for a trim: nothing the pipeline can do to the audio
 * shortens it by less than the fixture's 1.6 s pause, which is what the trim exists to remove.
 */
const CAPTURE_TOLERANCE_SEC = 0.3;

/**
 * How much shorter the trimmed upload has to be.
 *
 * The fixture's two phrases are separated by 1.6 s of silence and the file's seam adds another 0.4 s, both of
 * which the shipped pause table caps at 0.18 s; whichever point of the loop the capture starts at, at least
 * ~0.9 s of the window is a pause the trim removes. A third of a second is well inside that, and far outside
 * anything jitter could produce.
 */
const MIN_SAVING_SEC = 0.3;

/**
 * What the recogniser stand-in answers, one entry per upload.
 *
 * Leg-specific on purpose: each leg then has to end up holding *its own* sentence. A single utterance for both
 * would leave the second composer assertion satisfiable by the first leg's text, which is exactly the state a
 * leg that never transcribed anything would be in.
 *
 * Both are ordinary lowercase sentences with nothing an identifier could be: the criterion they were written
 * for is about duration, and a name the repair might rewrite would put a second, unrelated transformation
 * between the recogniser and the assertion. The leg that needs a name to be present names its own answer
 * instead of taking one of these (see `nextAnswer`).
 */
const UTTERANCES = [
  'please repeat the whole sentence back to me',
  'and now read the second line out loud',
];

/**
 * The sentences `useVoiceInput` reports its own failures with, looked for in the page when a transcript never
 * lands. Each one names a link in the chain the composer cannot show: a recording the app refused to send, a
 * recogniser call that came back unusable, a call that returned nothing to say.
 */
const VOICE_ERRORS = [
  'Recording too short',
  'Audio file too small',
  'Transcription failed',
  'No speech detected',
  'Microphone access denied',
];

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
      `--use-file-for-fake-audio-capture=${AUDIO_FILE}`,
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
  /**
   * What the stand-in answered this request with.
   *
   * Kept beside the bytes it was asked about rather than restated by the test: the sentence a leg has
   * to end up holding is the one the recogniser really returned, which is a property of the run's own
   * request order and not of a constant the test could get wrong on its own.
   */
  answer: string;
};

/** A variable-length integer as EBML writes it. `keepMarker` keeps the length-marker bit, which is what an element id needs. */
const readVint = (bytes: Buffer, at: number, keepMarker: boolean): { value: number; length: number; allOnes: boolean } | null => {
  if (at >= bytes.length) return null;
  const first = bytes[at];
  if (first === 0) return null;
  let length = 1;
  while ((first & (0x80 >> (length - 1))) === 0) {
    length += 1;
    if (length > 8) return null;
  }
  // For a one-byte vint the mask is the seven low bits; for an eight-byte one the first byte is all marker.
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let allOnes = (first & mask) === mask;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[at + index];
    if (bytes[at + index] !== 0xff) allOnes = false;
  }
  return { value, length, allOnes };
};

/** An EBML element body read as a big-endian unsigned integer. */
const readUint = (bytes: Buffer, from: number, to: number): number => {
  let value = 0;
  for (let at = from; at < to; at += 1) value = value * 256 + bytes[at];
  return value;
};

const EBML_HEAD = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const CLUSTER = 0x1f43b675;
const CLUSTER_TIMESTAMP = 0xe7;
const SIMPLE_BLOCK = 0xa3;

/**
 * The duration of an EBML/WebM recording, in seconds, read from the container's own structure.
 *
 * `MediaRecorder` writes no `Duration` element — the file is a live stream and its length is not known until it
 * ends — so the length has to be reconstructed from the blocks. Each cluster carries a timestamp and each block
 * a timecode relative to it, which gives the position of every frame; the last one plus one frame is the end.
 * The frame size is itself read from the stream, as the gap between two consecutive blocks, rather than assumed
 * from what this checkout's Chromium happens to choose.
 *
 * Returns null when there are no blocks to measure, which is the caller's cue that this is not a recording it
 * can reason about.
 */
const ebmlDurationSec = (bytes: Buffer): number | null => {
  let timestampScaleNs = 1_000_000; // EBML's default: one tick is a millisecond.
  const ticks: number[] = [];

  /** Visits the element children laid out between `from` and `to`. */
  const forEachElement = (
    from: number,
    to: number,
    visit: (id: number, bodyAt: number, bodyEnd: number) => void,
  ): void => {
    let at = from;
    while (at < to) {
      const id = readVint(bytes, at, true);
      const size = id ? readVint(bytes, at + id.length, false) : null;
      if (!id || !size) return;
      const bodyAt = at + id.length + size.length;
      // An unknown size means "until the parent ends" — how a live stream leaves its Segment open.
      const bodyEnd = size.allOnes ? to : Math.min(to, bodyAt + size.value);
      visit(id.value, bodyAt, bodyEnd);
      at = bodyEnd;
    }
  };

  forEachElement(0, bytes.length, (topLevel, topAt, topEnd) => {
    if (topLevel !== EBML_HEAD && topLevel !== SEGMENT) return;
    forEachElement(topAt, topEnd, (element, bodyAt, bodyEnd) => {
      if (element === INFO) {
        forEachElement(bodyAt, bodyEnd, (leaf, leafAt, leafEnd) => {
          if (leaf === TIMESTAMP_SCALE) timestampScaleNs = readUint(bytes, leafAt, leafEnd);
        });
      }
      if (element !== CLUSTER) return;
      let clusterTick = 0;
      forEachElement(bodyAt, bodyEnd, (leaf, leafAt, leafEnd) => {
        if (leaf === CLUSTER_TIMESTAMP) clusterTick = readUint(bytes, leafAt, leafEnd);
        if (leaf !== SIMPLE_BLOCK) return;
        const track = readVint(bytes, leafAt, false);
        // The block's payload: track number, then a signed 16-bit timecode relative to the cluster.
        if (track) ticks.push(clusterTick + bytes.readInt16BE(leafAt + track.length));
      });
    });
  });

  if (ticks.length === 0) return null;

  let last = ticks[0];
  for (const tick of ticks) if (tick > last) last = tick;
  const deltas: number[] = [];
  for (let index = 1; index < ticks.length; index += 1) deltas.push(ticks[index] - ticks[index - 1]);
  deltas.sort((a, b) => a - b);
  const frameTicks = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)] : 0;

  return ((last + frameTicks) * timestampScaleNs) / 1e9;
};

/** The duration of a 16-bit PCM WAV, in seconds, from its own `fmt `/`data` chunks. */
const wavDurationSec = (bytes: Buffer): number => {
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataBytes = 0;

  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(at + 10);
      sampleRate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    } else if (id === 'data') {
      dataBytes = size;
    }
    at += 8 + size + (size % 2);
  }

  const bytesPerSecond = sampleRate * channels * (bits / 8);
  if (!bytesPerSecond || !dataBytes) throw new Error('not a PCM WAV with a readable data chunk');
  return dataBytes / bytesPerSecond;
};

/** The duration of an upload in seconds, decided by the container it is really in rather than by its name. */
const containerDurationSec = (bytes: Buffer): number => {
  const magic = bytes.subarray(0, 4).toString('hex');
  if (magic === '52494646') return wavDurationSec(bytes); // 'RIFF'
  if (magic === '1a45dfa3') {
    const seconds = ebmlDurationSec(bytes);
    if (seconds === null) throw new Error('EBML upload carried no block to measure');
    return seconds;
  }
  throw new Error(`unrecognised audio container: ${magic}`);
};

/**
 * The uploaded file's bytes, taken out of the multipart body that carried them.
 *
 * The client posts a `FormData`, so the audio is one part among a few and the part boundaries are the only
 * thing that says where it starts and ends. Reading it here rather than trusting a length in a header keeps the
 * assertion about the bytes the app really put on the socket.
 */
const uploadedFile = (body: Buffer, contentType: string | undefined): Buffer => {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundary) throw new Error(`no boundary in upload content type: ${contentType}`);

  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let at = body.indexOf(delimiter);
  while (at >= 0) {
    const start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break; // the closing delimiter
    const next = body.indexOf(delimiter, start);
    const part = body.subarray(start, next >= 0 ? next : body.length);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw new Error('malformed multipart part: no header terminator');
    if (/name="file"/.test(part.subarray(0, headerEnd).toString('ascii'))) {
      return part.subarray(headerEnd + 4, part.length - 2); // the trailing CRLF before the next boundary
    }
    at = next;
  }
  throw new Error('the upload carried no file part');
};

/**
 * Whether `locator` showed up within `timeoutMs`.
 *
 * The boolean rather than a thrown timeout, because the caller's decision is what to do about its absence and a
 * caught assertion error reads as a failure that has already been reported.
 */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

test.describe.configure({ mode: 'serial' });

/**
 * The voice path end to end, one test per criterion.
 *
 * The criteria land in one file because they share the expensive half: a real browser, a real client
 * and backend, an account created on a fresh database, and a recogniser stand-in to point the voice
 * settings at. Each criterion names itself in its own title — which is what `-g` selects on — so a
 * criterion can be run alone without this file's other legs paying for it.
 */
test.describe('the voice path end to end', () => {
  let context: BrowserContext;
  let page: Page;
  let recognizer: http.Server;
  let recognizerUrl = '';
  const requests: RecognizerRequest[] = [];
  /**
   * What the page said about the voice call, for a red that explains itself.
   *
   * The step this spec waits on — "the transcript reached the composer" — is the far end of a chain that can
   * break in several places, and every one of them looks identical from the composer: empty. `RecognizerRequest`
   * only covers the case where a request got all the way out; a recorder that produced nothing, a proxy that
   * answered 500, and a decode that threw all leave it empty while the composer stays empty too. So the page's
   * own traffic is collected here and reported by `expectTranscript` when the wait fails.
   */
  const voiceTraffic: string[] = [];
  /**
   * The `[voice:trim]` readings the page printed, in the order it printed them.
   *
   * Taken off the console argument rather than out of its text: Chromium formats an object argument for
   * a human to read, and a reading parsed back out of that preview would be a reading of the formatter.
   * `jsonValue()` hands back the object the app actually logged.
   */
  const readings: Record<string, unknown>[] = [];
  /**
   * How many `[voice:trim]` messages the page has printed, counted apart from `readings`.
   *
   * A count is not the same claim as a parse: a message whose argument arrived as something other than an
   * object would leave `readings` empty while the page had still printed it, and the criterion that has to
   * hold is about the printing. It is also what makes "0 of them" assertable at all — an empty `readings`
   * is equally what a listener that never fired looks like.
   */
  let trimMessages = 0;
  /**
   * How many `[voice] identifier fidelity` messages the page has printed.
   *
   * Counted here because that reading is deliberately NOT behind the switch (GOAL-005 / AC-114): its
   * arrival is the proof that a capture travelled the chain to the point where the readings are taken,
   * which is what a count of `[voice:trim]` messages has to be read against. Its presence is also its own
   * criterion — an absence of trim readings is only interesting if the unconditional one still fires.
   */
  let fidelityMessages = 0;
  /**
   * The sentence the stand-in answers the next upload with, when a leg needs one of its own.
   *
   * `UTTERANCES` is indexed by request order, which is a property of the run rather than of any one
   * criterion: a leg that ran earlier in the same file has already consumed its entries, so an index is
   * not a stable way to say "this leg is answered with this sentence". A leg that asserts something about
   * a particular sentence — rather than about the chain in general — names it here, and the override is
   * consumed by the request it was set for.
   */
  let nextAnswer: string | null = null;

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
        // The Nth upload is the Nth leg, so each leg can only be satisfied by its own transcription. The last
        // sentence is the answer for every upload after the last leg, so a leg that uploaded twice fails on the
        // request count rather than on a missing utterance. A leg that named its own answer takes precedence,
        // and the name is spent on this one request.
        const answer = nextAnswer ?? UTTERANCES[Math.min(requests.length, UTTERANCES.length - 1)];
        nextAnswer = null;
        requests.push({
          url: request.url ?? '',
          method: request.method ?? '',
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body: Buffer.concat(chunks),
          answer,
        });

        if (!(request.url ?? '').endsWith('/audio/transcriptions')) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'unexpected path' }));
          return;
        }

        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ text: answer }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  };

  /** The composer's textarea, the one place the transcript from a recording lands. */
  const composer = () => page.locator('[data-slot="prompt-input-textarea"]');

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

  /**
   * Loads `url` (which is how a leg switches the trim), opens the seeded session's composer, and empties it.
   *
   * Emptying is what makes the assertion after a recording a transition rather than a state: the composer keeps
   * a draft per session, so the previous leg's sentence would otherwise already be sitting there.
   */
  const openComposer = async (url: string) => {
    await page.goto(url);
    await expandProject();
    await sessionLink().click();
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
    // The same wait and the same budget as any other `toBeVisible` here; only what a timeout *says* changes.
    // The composer's absence is the far end of several unrelated causes and a bare locator timeout names none
    // of them — it reports "element(s) not found" for a client still building its module graph, for a proxy
    // that answered 500, and for a page the dev server cut off mid-load alike. The last of those is the one
    // this file's cold-load retry cannot see: it happens after onboarding, on a later `page.goto`, and it does
    // not blank the page — it renders the app's own error boundary in place of the chat interface, so the
    // sidebar and the shell all look right. The boundary's text and the console errors are what tell these
    // apart, so both are attached to the failure instead of being left in a log the gate's excerpt truncates.
    try {
      await expect(composer()).toBeVisible({ timeout: 15_000 });
    } catch {
      const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
      const errors = voiceTraffic.filter((line) => line.startsWith('console.error'));
      throw new Error(
        `the composer never rendered at ${url}; the page shows: ${JSON.stringify(shown.slice(0, 300))}`
          + `\n  console errors: ${errors.length > 0 ? errors.slice(0, 3).join(' | ') : '<none>'}`,
      );
    }
    await composer().fill('');
    await expect(composer()).toHaveValue('');
  };

  /**
   * Waits for `expected` to land in the composer, and reports the voice call's traffic when it never does.
   *
   * A bare `toHaveValue` timeout costs its whole budget and answers nothing beyond "the box is empty" — and an
   * empty box is what a recorder that captured nothing, a decode that threw, and a proxy that answered 500 all
   * look like. The traffic collected by the page listeners is what tells them apart, so it is attached to the
   * failure instead of being left in a log the gate's excerpt does not print.
   */
  const expectTranscript = async (expected: string, leg: string) => {
    try {
      await expect(composer()).toHaveValue(expected, { timeout: 10_000 });
    } catch {
      const value = await composer().inputValue().catch(() => '<unreadable>');
      // The hook reports every failure it knows about through `onError`, and the composer shows those as text
      // rather than as a status code — so the sentence, not the socket, is where "the recording was too short"
      // and "the transcription failed" are told apart.
      const shown = await page.locator('body').innerText().catch(() => '');
      const reported = VOICE_ERRORS.filter((message) => shown.includes(message));
      throw new Error(
        `${leg}: the composer never took the transcript.\n`
          + `  composer=${JSON.stringify(value)}\n`
          + `  recogniser requests=${requests.length}\n`
          + `  app reported=${reported.length > 0 ? reported.join(' | ') : '<none>'}\n`
          + `  page traffic=${voiceTraffic.length > 0 ? voiceTraffic.join(' | ') : '<none>'}`,
      );
    }
  };

  /**
   * Records one pass of the fixture and returns the sentence the recogniser answered this capture with.
   *
   * The answer is read off the run's own request rather than named from `UTTERANCES`: which entry the
   * stand-in picks is a property of how many legs ran before this one, so a leg that restated an index
   * would be asserting about its own position in the file rather than about the chain. The recogniser is
   * the one stand-in here, and what it answered is the input the rest of the chain is judged on.
   */
  const recordCapture = async (leg: string): Promise<string> => {
    const before = requests.length;
    await recordOnce();
    await expect.poll(
      () => requests.length,
      { timeout: 15_000, message: `${leg}: the recording never reached the recogniser` },
    ).toBe(before + 1);
    return requests[before].answer;
  };

  /**
   * Records one pass of the fixture through the app's voice button.
   *
   * There is no event to wait on for "the recorder has captured enough" — the upload does not exist until the
   * stop — so the wait is the capture duration itself, which is also what makes the untrimmed upload's length
   * the fixture's length.
   */
  const recordOnce = async () => {
    const record = page.getByRole('button', { name: 'Voice input' });
    await expect(record).toBeVisible({ timeout: 15_000 });
    await record.click();

    // Recording really started: the button renames itself for as long as the recorder is running.
    const stop = page.getByRole('button', { name: 'Stop recording' });
    await expect(stop).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(CAPTURE_MS);
    await stop.click();
  };

  /**
   * The hidden `<input type="file">` the upload entry owns.
   *
   * Located by what it accepts rather than by position: the composer's attachment picker is a file
   * input too, so `input[type=file]` alone would be ambiguous. It is hidden — the button beside the
   * microphone is the control — which is not something `setInputFiles` minds.
   */
  const uploadInput = () => page.locator('input[type="file"][accept="audio/*"]');

  /** The button that opens the file dialog, named the way `VoiceUploadButton` names it. */
  const uploadEntry = () => page.getByRole('button', { name: 'Upload audio file' });

  /**
   * Waits for the page to print a reading past `before`, and returns the first new one.
   *
   * The reading is logged as the chain decides what to upload, so it is already there by the time the
   * request the caller is waiting for arrives; polling rather than reading `readings[before]` keeps the
   * assertion from depending on which of the two the browser happened to deliver first.
   */
  const nextReading = async (before: number): Promise<Record<string, unknown>> => {
    await expect.poll(
      () => readings.length,
      { timeout: 10_000, message: 'the chain printed no [voice:trim] reading for this capture' },
    ).toBeGreaterThan(before);
    return readings[before];
  };

  /**
   * Submits the fixture through the upload entry, and waits for the request it produced.
   *
   * The wait is on the recogniser rather than on a timer, which is the difference between an upload and
   * a recording: a recording is uploaded when the user lets go, an upload when the file is chosen, and
   * the request is the first thing that says it happened. A red here also names what the recogniser
   * would have been asked, since the request is where the chain's own body can be read.
   */
  const uploadFixture = async (leg: string): Promise<RecognizerRequest> => {
    const before = requests.length;
    await expect(uploadEntry()).toBeVisible({ timeout: 10_000 });
    await uploadInput().setInputFiles(AUDIO_FILE);

    await expect.poll(
      () => requests.length,
      { timeout: 15_000, message: `${leg}: the chosen file never reached the recogniser` },
    ).toBe(before + 1);

    const request = requests[before];
    await expectTranscript(request.answer, leg);
    return request;
  };

  test.beforeAll(async ({ browser }) => {
    // Onboarding plus the first project load outlasts the default per-test budget, but only as far as the
    // criterion's own ceiling allows: a hook that runs longer than that is killed from outside and reports
    // nothing, so the budget stops short of it and lets the failure above be the thing that is read.
    test.setTimeout(40_000);

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

    // The page's side of the voice call, so a red can say which link broke. `requestfailed` is the one that
    // catches a call the app made and the network refused; the console listener catches the app's own
    // `onError` path when it reports a failure the composer never shows.
    page.on('response', (response) => {
      if (!response.url().includes('/api/voice/transcribe')) return;
      void response.text().then(
        (body) => voiceTraffic.push(`transcribe -> ${response.status()} ${body.slice(0, 160)}`),
        () => voiceTraffic.push(`transcribe -> ${response.status()} <body unreadable>`),
      );
    });
    page.on('requestfailed', (request) => {
      voiceTraffic.push(`requestfailed ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') voiceTraffic.push(`console.error ${message.text().slice(0, 200)}`);
    });
    // The chain's own readings, collected whether or not a criterion is currently asking for them: what
    // the switch does is decide whether they are printed at all, and that is what the assertions read.
    page.on('console', (message) => {
      const text = message.text();
      // The unconditional reading (GOAL-005 / AC-114), counted separately from the one behind the switch:
      // `[voice:trim]` is not a substring of `[voice] identifier fidelity`, so the two filters below
      // cannot see each other's messages.
      if (text.includes('[voice] identifier fidelity')) fidelityMessages += 1;
      // By substring, not by prefix: a string argument arrives with the console's own quoting.
      if (!text.includes('[voice:trim]')) return;
      trimMessages += 1;
      const [, reading] = message.args();
      if (!reading) return;
      void reading.jsonValue().then(
        (value) => {
          if (value && typeof value === 'object') readings.push(value as Record<string, unknown>);
        },
        () => undefined,
      );
    });

    // First run on a fresh database: create the single account, then finish onboarding.
    await page.goto('/');
    // The account form is the app's first rendered screen, which also makes it the first thing a cold Vite dev
    // server can fail to produce. Two different blanks arrive here: a transform graph built on demand under load,
    // and — the one this run actually met — `504 Outdated Optimize Dep` on the pre-bundled dependencies, which is
    // what a dev server answers for a moment once its dependency cache has been re-optimized underneath it. That
    // cache is reached through this checkout's `node_modules` symlink, so a sibling run starting its own server is
    // enough to invalidate this one's hashes; the trace of a red run shows the entry chunk failing this way and no
    // page error at all. Neither blank throws on its own: the navigation succeeded, so nothing surfaces until the
    // wait for the form runs out. A reload clears both — it is what Vite's own client does after re-optimizing — so
    // it is retried, bounded, because this preamble is not what the criterion tests and must not eat the hook's
    // budget. The attempts below add up to less than the hook's own ceiling, so a real failure reports here, with
    // the page's text, rather than being killed from outside with nothing to say.
    let onboarded = await appears(page.locator('#username'), 8_000);
    for (let attempt = 0; !onboarded && attempt < 3; attempt += 1) {
      await page.reload();
      onboarded = await appears(page.locator('#username'), 4_000);
    }
    if (!onboarded) {
      const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
      // The console errors are what name the cause: a blank page is a blank page, but "504 Outdated Optimize
      // Dep" and "Failed to fetch dynamically imported module" are two different run environments.
      const errors = voiceTraffic.filter((line) => line.startsWith('console.error'));
      throw new Error(
        `the account form never rendered; the page shows: ${JSON.stringify(shown.slice(0, 300))}`
          + `\n  console errors: ${errors.length > 0 ? errors.slice(0, 3).join(' | ') : '<none>'}`,
      );
    }
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
    await expect(projectRow()).toBeVisible({ timeout: 12_000 });
  });

  test.afterAll(async () => {
    await context?.close();
    await new Promise<void>((resolve) => recognizer?.close(() => resolve()));
  });

  test('AC-119 the trimmed upload is shorter than the same recording uploaded untrimmed', async () => {
    // The whole criterion has to fit inside the goal gate's 60s, and a run killed at that ceiling reports nothing
    // about why. This body takes ~8s, so the budget is a few times that rather than the default minute: a runaway
    // leg fails here, with its own message, while the command is still this run's to explain.
    test.setTimeout(35_000);
    expect(FIXTURE_SEC).toBeGreaterThan(1);

    // The audio the fake device was pointed at, checked as audio. A path that does not resolve to a WAV is not
    // an error Chromium reports: it quietly plays its own fallback tone instead, which records and transcribes
    // exactly like the fixture — so a criterion that only looked at the composer could go green on a run where
    // nothing was injected at all. Its length is the reference the untrimmed upload is measured against, so it
    // is read out of the file rather than taken from the config that wrote it.
    const audio = fs.readFileSync(AUDIO_FILE);
    expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(audio.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wavDurationSec(audio)).toBeCloseTo(FIXTURE_SEC, 3);
    expect(audio.length).toBeGreaterThan(96_000); // 48kHz mono 16-bit: a second is 96kB, so this is seconds not a click

    // Leg 1 — the default. Trimming is on unless something turned it off.
    await openComposer('/');
    await recordOnce();
    // The transcript travelled the whole path back into the composer. The ceiling is deliberately short: a
    // regression here has to surface as this assertion rather than as an unattributable timeout.
    await expectTranscript(UTTERANCES[0], 'trimmed leg');
    // One upload so far, which is what makes the second leg's answer the second sentence rather than a repeat.
    expect(requests).toHaveLength(1);

    // Leg 2 — the switch named in the URL. Read at load, before the router rewrites the query string.
    await openComposer('/?voiceTrim=off');
    await recordOnce();
    await expectTranscript(UTTERANCES[1], 'untrimmed leg');
    expect(requests).toHaveLength(2);

    // Both uploads were the app's own call, made from the seeded settings, and carried real audio.
    for (const upload of requests) {
      expect(upload.method).toBe('POST');
      expect(upload.url.endsWith('/audio/transcriptions')).toBe(true);
      // The credential proves the request was built from the settings that were seeded, not from a default.
      expect(upload.authorization).toBe(`Bearer ${API_KEY}`);
      expect(upload.contentType).toContain('multipart/form-data');
      expect(upload.body.includes(Buffer.from(`name="model"`))).toBe(true);
      expect(upload.body.includes(Buffer.from(STT_MODEL))).toBe(true);
    }

    const trimmedUpload = uploadedFile(requests[0].body, requests[0].contentType);
    const plainUpload = uploadedFile(requests[1].body, requests[1].contentType);

    // Both durations come out of the container the upload is really in, never out of its byte count. A byte count
    // cannot stand in for this: the trimmed leg is PCM WAV and the untrimmed one webm/opus, so the shorter upload
    // is the larger one, and a comparison of sizes would read the encoding difference as the trim.
    const trimmedSec = containerDurationSec(trimmedUpload);
    const plainSec = containerDurationSec(plainUpload);
    // The pair is this criterion's reading, so it is printed rather than only asserted: a green run should say
    // what it measured, not just what it refused. Printed before the assertions so it is on the log either way.
    console.log(
      `[voice-trim] uploads: trimmed=${trimmedSec.toFixed(3)}s untrimmed=${plainSec.toFixed(3)}s fixture=${FIXTURE_SEC.toFixed(3)}s`,
    );

    // (1) The premise, asserted before the transition it is a premise for: "off" is really off. The untrimmed
    // upload is the whole capture, not a trim that failed to a shorter value of its own — which is what
    // separates a working switch from two failures that happen to agree.
    expect(
      Math.abs(plainSec - FIXTURE_SEC),
      `untrimmed upload was ${plainSec}s, the fixture is ${FIXTURE_SEC}s`,
    ).toBeLessThan(CAPTURE_TOLERANCE_SEC);

    // (2) The pair, from this one run: trimming removed audio. Checked against the capture the line above just
    // established, so it reads as the trim's own effect and not as a difference between two unrelated numbers.
    expect(plainSec - trimmedSec, `trimmed ${trimmedSec}s vs untrimmed ${plainSec}s`).toBeGreaterThan(MIN_SAVING_SEC);

    // (3) What the two uploads are, now that their durations have been read: the trimmed one is the WAV this repo
    // encoded, the untrimmed one the recorder's own stream. This is the reading that would name a trim which
    // quietly fell back to the recording — both legs would be in the same container.
    expect(trimmedUpload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(plainUpload.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    // ...and the trimmed one is not the fixture either, so it is not the untrimmed bytes under a WAV header.
    expect(trimmedSec).toBeLessThan(FIXTURE_SEC - MIN_SAVING_SEC);
  });

  /**
   * The voice path's other entry: a known piece of audio, chosen as a file.
   *
   * The fixture is the one the fake microphone already plays, and that is what makes these legs
   * readable. As a file it is decoded exactly rather than captured through a device, so the chain's own
   * reading of its length is the fixture's length — a number only these bytes can produce, which is
   * what makes "the request came from that file" an assertion about the audio and not about a filename.
   *
   * What the legs then show is that the upload is the same chain rather than a second one beside it.
   * With the trim at its default the bytes that reach the recogniser are shorter than the file by the
   * silence the trim exists to remove, read out of the container the upload really is in; with the trim
   * switched off they are the file itself, byte for byte. A third leg is the default install's: the
   * switch is off, so there is no entry at all — which is what makes "an extra control in everyone's
   * composer" a thing this avoided rather than a thing it intended.
   */
  test('AC-120 an uploaded audio file travels the same transcription chain', async () => {
    // Same budget as the criterion above and for the same reason: the goal gate kills the command at
    // 60s, and a run killed from outside says nothing about what it was doing.
    test.setTimeout(35_000);

    // The fixture, read as audio. A file the browser cannot decode is not a failure it reports: the
    // chain falls back to uploading what it was handed, so a criterion about the trim would be met by a
    // fixture that never reached the trim at all.
    const audio = fs.readFileSync(AUDIO_FILE);
    expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(audio.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wavDurationSec(audio)).toBeCloseTo(FIXTURE_SEC, 3);
    const requestsBefore = requests.length;

    // Leg 1 — the switch on, the trim at its default.
    const trimmedReadings = readings.length;
    // `voiceTrim=on` is named rather than left to the default: the switches are remembered across loads,
    // so a leg of the criterion above that turned the trim off is still in force here. A leg that states
    // both switches reads the same alone as it does after the others, which is what `-g` runs it as.
    await openComposer('/?voiceDebug=1&voiceTrim=on');
    const trimmedRequest = await uploadFixture('uploaded leg, trimmed');

    // The chain says which entry the audio came in through, and the reading's input length is the
    // fixture's own duration — a number that only decoding these bytes can produce.
    const trimmedReading = await nextReading(trimmedReadings);
    expect(trimmedReading.source).toBe('file');
    expect(
      trimmedReading.inputSec,
      `the chain measured no length for this upload: ${JSON.stringify(trimmedReading)}`,
    ).toBeCloseTo(FIXTURE_SEC, 1);
    expect(trimmedReading.fallback).toBe(false);

    // The uploaded bytes went through the trim the microphone's audio goes through: a WAV this repo
    // encoded, shorter than the file by the pause the trim removes, and as long as the reading says.
    const trimmedUpload = uploadedFile(trimmedRequest.body, trimmedRequest.contentType);
    expect(trimmedUpload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    const trimmedSec = containerDurationSec(trimmedUpload);
    expect(
      FIXTURE_SEC - trimmedSec,
      `the upload was ${trimmedSec}s of a ${FIXTURE_SEC}s file`,
    ).toBeGreaterThan(MIN_SAVING_SEC);
    expect(trimmedReading.outputSec).toBeCloseTo(trimmedSec, 2);
    // Printed before the assertions above so a green run says what it measured rather than only what it
    // refused. The composer's half — the recogniser's own sentence landing in the box — is waited on by
    // `uploadFixture`, so it is proven by the leg having got this far.
    console.log(
      `[voice-upload] trimmed: file=${FIXTURE_SEC.toFixed(3)}s uploaded=${trimmedSec.toFixed(3)}s source=${String(trimmedReading.source)}`,
    );

    // Leg 2 — the trim off. The upload is then the file itself, which is the reading that ties the
    // request to the bytes: a body built by the test, or a fixed one, cannot be this file.
    const plainReadings = readings.length;
    await openComposer('/?voiceTrim=off&voiceDebug=1');
    const plainRequest = await uploadFixture('uploaded leg, untrimmed');

    const plainReading = await nextReading(plainReadings);
    expect(plainReading.source).toBe('file');
    // Nothing was measured on this leg — the switch that trims is what decodes — which is the state the
    // byte comparison below needs: what arrived is the file, not a re-encode that agrees with it.
    expect(plainReading.fallback).toBe(true);

    const plainUpload = uploadedFile(plainRequest.body, plainRequest.contentType);
    expect(plainUpload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wavDurationSec(plainUpload)).toBeCloseTo(FIXTURE_SEC, 2);
    expect(plainUpload.equals(audio)).toBe(true);

    // Leg 3 — the default install. The switch is off, so the entry is not rendered; the microphone,
    // which was there before this task, still is.
    const requestsAtDefault = requests.length;
    await openComposer('/?voiceDebug=off');
    // The premise first: the footer really is rendered and its mic is there, so the absence below is the
    // switch's doing rather than a composer that has not painted yet. A zero count is satisfied by a blank
    // page, and a blank page is what a broken build answers with.
    await expect(page.getByRole('button', { name: 'Voice input' })).toBeVisible();
    await expect(uploadEntry()).toHaveCount(0);
    await expect(uploadInput()).toHaveCount(0);
    expect(requests).toHaveLength(requestsAtDefault);

    // Two legs, two uploads: no leg uploaded twice, and the third sent nothing at all.
    expect(requests.length).toBe(requestsBefore + 2);
  });

  /**
   * The reading of the trim, and the switch that decides whether anyone hears about it.
   *
   * The pair is the criterion. "Off prints nothing" alone is satisfied by a chain that never prints, and "on
   * prints a complete reading" alone is satisfied by a reading that is always printed — so a leg of each, in
   * one run, against the same fixture, is the only arrangement in which either claim means anything. The
   * unconditional `[voice] identifier fidelity` reading is what separates them: it is not behind the switch
   * (GOAL-005 / AC-114), so its arrival is the proof that a capture travelled to the point where readings are
   * taken — which is what a count of zero has to be read against.
   *
   * Three legs, because the switch has two halves. The first turns it off and records; the second turns it on
   * by URL and records; the third names it nowhere and uploads, which is the only way to see that the URL
   * half was *written back* — a page load re-evaluates the module, so a switch that only ever lived in the
   * previous page's memory cannot be in force here.
   *
   * ⚠️ Every leg names both switches in its URL. They are remembered across loads, so a leg that left one to
   * its default would be reading whichever value the leg before it wrote — which is the same leg under `-g`
   * and a different one in the full file.
   */
  test('AC-121 the trim reading is silent by default and complete when the switch is on', async () => {
    // The goal gate kills this command at 60s, so the budget is under the file's default: a runaway leg has
    // to fail here, with its own message, while the command is still this run's to explain.
    test.setTimeout(45_000);

    // The one file the seeded workspace holds, and the name the identifier half of the reading is measured
    // against. Read off the disk rather than restated, so a config that stopped seeding it would red this
    // criterion instead of quietly agreeing with the spec.
    const workspaceFiles = fs.readdirSync(WORKSPACE);
    const workspaceFile = workspaceFiles.find((name) => name.endsWith('.md'));
    expect(workspaceFile, `the seeded workspace holds no .md file: ${workspaceFiles.join(', ')}`).toBeTruthy();
    /** How the recogniser hears that name: the same name with one character dropped — one edit, the opening
     *  shared, the extension intact, which is the shape the repair's budget exists for. */
    const spokenFile = workspaceFile!.replace(
      /^(.*)\.([^.]+)$/,
      (_match, stem: string, extension: string) => `${stem.slice(0, -1)}.${extension}`,
    );
    expect(spokenFile, 'the fixture name has no character to drop').not.toBe(workspaceFile);
    const spokenSentence = `please open ${spokenFile} and read the notes`;
    const repairedSentence = `please open ${workspaceFile} and read the notes`;

    // ── Leg 1 — the switch off, on a real recording ────────────────────────────────────────────────────
    // Named rather than defaulted: off is the default, but the switches are remembered, so "the default"
    // here would be whatever the previous test left behind.
    await openComposer('/?voiceDebug=off&voiceTrim=on');
    const silentTrim = trimMessages;
    const silentFidelity = fidelityMessages;
    await expectTranscript(await recordCapture('switch-off leg'), 'switch-off leg');

    // The capture reached the end of the chain before the zero below is read. Without this the criterion
    // would be satisfied by a chain that never ran at all — a blank page, a refused recording, a dead
    // endpoint — which is the same state as a switch that works, seen from the console.
    await expect.poll(
      () => fidelityMessages,
      { timeout: 10_000, message: 'the switch-off leg never printed the unconditional fidelity reading, so it never reached the end of the chain' },
    ).toBeGreaterThan(silentFidelity);
    expect(trimMessages, 'the switch was off and the chain printed a trim reading anyway').toBe(silentTrim);

    // ── Leg 2 — the switch on, named in the URL ────────────────────────────────────────────────────────
    await openComposer('/?voiceDebug=1&voiceTrim=on');
    // The URL is how a switch is set; storage is where it lives. That this load left something naming the
    // switch behind is asserted here — what the app does with it is leg 3, which names it nowhere.
    const writtenBack = await page.evaluate(() => {
      const found: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index) ?? '';
        const value = window.localStorage.getItem(key) ?? '';
        if (key.toLowerCase().includes('voicedebug') || value.toLowerCase().includes('voicedebug')) {
          found.push(`${key}=${value}`);
        }
      }
      return found;
    });
    expect(writtenBack.length, 'the URL-named switch was never written back to localStorage').toBeGreaterThan(0);

    const loudTrim = trimMessages;
    const loudReadings = readings.length;
    // This leg is answered with a name the workspace really has, mis-heard by one character, so the
    // identifier half of the reading has something to measure. What lands in the composer is the repaired
    // sentence: the criterion is about the reading, but a reading of a chain that did not repair would be a
    // reading of a different chain.
    nextAnswer = spokenSentence;
    // The name really is spent on this leg's request — the stand-in is the one thing here that could answer
    // something else, and if it did, everything read off the composer below would be about that instead.
    expect(await recordCapture('switch-on leg'), 'the stand-in did not answer with this leg\'s sentence').toBe(spokenSentence);
    await expectTranscript(repairedSentence, 'switch-on leg');

    const reading = await nextReading(loudReadings);
    expect(trimMessages, 'the switch-on capture printed more than one trim reading').toBe(loudTrim + 1);

    // The field list, checked as paths rather than as a count of keys: a reading that renamed one of them or
    // nested it elsewhere is not the reading the criterion names. Each of these is a way to red this: there is
    // no ordering here that a partial reading satisfies.
    const FIELDS = [
      'source',
      'inputSec',
      'outputSec',
      'savedSec',
      'savedRatio',
      'vadSegments',
      'speechKeptRatio',
      'fallback',
      'identifiers.before.rate',
      'identifiers.after.rate',
      'repairHits',
    ];
    for (const field of FIELDS) {
      expect(reading, `the reading carries no ${field}: ${JSON.stringify(reading)}`).toHaveProperty(field);
    }

    // ...and the values are this capture's own, not placeholders that satisfy the paths above. The input
    // length is the fixture's, the saving is the difference between the two lengths, and the ratio is that
    // difference over the input — a reading of audio the chain really measured.
    const identifiers = reading.identifiers as
      | { before: { rate: number | null }; after: { rate: number | null } }
      | undefined;
    expect(reading.source).toBe('mic');
    expect(reading.fallback).toBe(false);
    expect(
      Math.abs((reading.inputSec as number) - FIXTURE_SEC),
      `the chain measured ${String(reading.inputSec)}s of a ${FIXTURE_SEC}s capture`,
    ).toBeLessThan(CAPTURE_TOLERANCE_SEC);
    expect(reading.outputSec).toBeGreaterThan(0);
    expect(reading.savedSec).toBeCloseTo((reading.inputSec as number) - (reading.outputSec as number), 3);
    expect(reading.savedRatio).toBeCloseTo(1 - (reading.outputSec as number) / (reading.inputSec as number), 3);
    expect(reading.vadSegments).toBeGreaterThanOrEqual(1);
    expect(reading.speechKeptRatio).toBeGreaterThan(0);
    expect(reading.speechKeptRatio).toBeLessThanOrEqual(1);

    // The identifier half, on the sentence this leg was answered with. `before` is the recogniser's answer
    // scored against itself — 1, because nothing had touched it yet — and `after` is that same answer scored
    // against the repaired text, 0, because the name the recogniser said is the one the repair replaced. Only
    // a repair that really fired produces that pair, and `repairHits` is the same event counted the other way:
    // one identifier span the repaired text carries that the chain's own text did not.
    expect(identifiers?.before.rate).toBe(1);
    expect(identifiers?.after.rate).toBe(0);
    expect(reading.repairHits).toBe(1);

    // ── Leg 3 — the switch remembered, and the other entry into the chain ──────────────────────────────
    // A full page load with the switch named nowhere: the document is new, the module is evaluated again, and
    // nothing that only ever lived in the previous page's memory is readable here. A reading on this leg is
    // the switch having been written to storage by leg 2 and read back by this load. `voiceTrim` IS named —
    // it is the other half of the same storage, and leg 2 is not the only leg that ever set it.
    const rememberedTrim = trimMessages;
    const rememberedReadings = readings.length;
    await openComposer('/?voiceTrim=on');
    const uploaded = await uploadFixture('remembered-switch leg');

    const uploadedReading = await nextReading(rememberedReadings);
    expect(trimMessages, 'the remembered-switch capture printed more than one trim reading').toBe(rememberedTrim + 1);
    expect(uploadedReading.source).toBe('file');
    expect(uploadedReading.fallback).toBe(false);
    expect(uploadedReading.inputSec).toBeCloseTo(FIXTURE_SEC, 1);
    // The output length is the bytes that really reached the recogniser, read out of the container they are
    // in. A reading that reported a number of its own would have to agree with this upload by accident.
    expect(uploadedReading.outputSec).toBeCloseTo(
      containerDurationSec(uploadedFile(uploaded.body, uploaded.contentType)),
      2,
    );
    // ...and the switch reaches the file's half of the identifier reading too: this sentence carries no name,
    // so the metric's own "nothing to measure" is what it reports, and nothing was repaired. Read beside the
    // leg above, where the same three fields carry 1 / 0 / 1, this is the control that makes them a reading
    // rather than a constant.
    expect(uploadedReading.identifiers).toHaveProperty('before.rate', null);
    expect(uploadedReading.identifiers).toHaveProperty('after.rate', null);
    expect(uploadedReading.repairHits).toBe(0);

    // The tally over the whole run, taken last so a stray extra print has nowhere left to arrive after it:
    // the capture with the switch off printed nothing, and the two with it on printed one reading each.
    expect(trimMessages).toBe(silentTrim + 2);
  });

  /**
   * The recording slot's two replays: the audio as it was recorded, and the audio as it was uploaded.
   *
   * What the criterion is about is that the slot offers *both*. One replay of the upload would leave "what
   * did the trim cut?" unanswerable from the UI, which is the whole reason the pair exists — and the pair is
   * told apart by what is behind the two controls, not by what they are called. The object URL a control
   * carries proves nothing on its own: two `createObjectURL` calls over the same bytes are two URLs. So the
   * bytes each control would play are fetched back out of the page and measured as containers, which is the
   * same reading `AC-119` takes of the two uploads, one layer further out.
   *
   * ⚠️ One clause of the criterion as it was written cannot hold, and this leg does not pretend otherwise:
   * "the trimmed one's byte count is strictly smaller than the recording's". The trimmed replay is the WAV
   * this repo encodes — 48 kHz mono 16-bit PCM, 96 kB/s — and the recording is the recorder's own webm/opus
   * at roughly a tenth of that, so the *shorter* audio is the *larger* body. The measured pair is printed
   * below and the sizes are asserted to be different rather than ordered; what is asserted about the trimmed
   * one is the invariant the size was standing in for — it is a different audio object, in the container the
   * trim produced, and strictly shorter — which is falsified by the same fake form (two controls over one
   * source carry one duration).
   *
   * The mutex is read off the audio elements rather than off the controls, because a control's name only says
   * what the app believes: two elements sounding at once with the labels left consistent is a state a build
   * can reach, and it is the state the clause is about.
   */
  test('AC-122 the recording is replayable beside the trimmed upload, one at a time', async () => {
    // The goal gate kills the command at 60s, so the budget is under the file's default: a runaway leg has
    // to fail here, with its own message, while the command is still this run's to explain. One leg, so the
    // same budget the single-leg criterion above uses.
    test.setTimeout(35_000);
    expect(FIXTURE_SEC).toBeGreaterThan(1);

    // ⚠️ Both switches are named. They are remembered across loads, so a leg that left one to its default
    // would be reading whatever value the criterion above wrote — the same leg under `-g` and a different
    // one in the full file. The trim has to be on for the slot to gain a second track at all.
    // Before the page that records: the clip elements are made with `new Audio()` and never attached to the
    // document, so nothing in the DOM shows what is really sounding — a control's label says only what the
    // app believes. Wrapping the constructor here, before the app's own scripts run, is what makes the
    // mutex readable as audio rather than as a pair of labels that agree with each other.
    await context.addInitScript(() => {
      const registry: HTMLAudioElement[] = [];
      const NativeAudio = window.Audio;
      function WrappedAudio(...args: unknown[]) {
        const element = new NativeAudio(...(args as []));
        registry.push(element);
        return element;
      }
      WrappedAudio.prototype = NativeAudio.prototype;
      window.Audio = WrappedAudio as unknown as typeof Audio;
      (window as unknown as { clipAudio?: () => { src: string; paused: boolean }[] }).clipAudio = () =>
        registry.map((element) => ({ src: element.src, paused: element.paused }));
    });

    await openComposer('/?voiceTrim=on&voiceDebug=off');
    const recorded = await recordCapture('two-replay leg');
    await expectTranscript(recorded, 'two-replay leg');

    // (1) Two controls, named apart, both in the composer's tool row. The second is the one that only
    // exists because the chain decided what it uploaded is not the recording. The wait is generous: the
    // transcript lands as soon as the recogniser answers, while the trim's own output is attached on the
    // way in and the pair is rendered from one state update.
    const originalControl = page.getByRole('button', { name: 'Replay original' });
    const trimmedControl = page.getByRole('button', { name: 'Replay trimmed' });
    await expect(originalControl).toBeVisible({ timeout: 10_000 });
    await expect(
      trimmedControl,
      'the recording slot offers no replay of the trimmed upload: the trim happened and cannot be heard',
    ).toBeVisible({ timeout: 10_000 });

    // (2) Two sources. The URL is where the bytes are read from, so it is taken first and fetched second.
    const originalUrl = await originalControl.getAttribute('data-clip-url');
    const trimmedUrl = await trimmedControl.getAttribute('data-clip-url');
    expect(originalUrl, 'the original replay carries no source to read').toBeTruthy();
    expect(trimmedUrl, 'the trimmed replay carries no source to read').toBeTruthy();
    expect(trimmedUrl).not.toBe(originalUrl);

    /** The bytes behind one of the two object URLs, as the page itself would hand them to its audio element. */
    const readBack = (url: string) =>
      page.evaluate(async (source) => {
        const bytes = new Uint8Array(await (await fetch(source)).arrayBuffer());
        const chunks: string[] = [];
        for (let at = 0; at < bytes.length; at += 8192) {
          chunks.push(String.fromCharCode(...bytes.subarray(at, at + 8192)));
        }
        return btoa(chunks.join(''));
      }, url);

    const originalBytes = Buffer.from(await readBack(originalUrl!), 'base64');
    const trimmedBytes = Buffer.from(await readBack(trimmedUrl!), 'base64');
    const originalSec = containerDurationSec(originalBytes);
    const trimmedSec = containerDurationSec(trimmedBytes);
    // The pair, printed rather than only asserted: a green run should say what it measured. The size note
    // is the amendment above, written where the numbers are — the sizes are the reason it was made.
    console.log(
      `[voice-replay] original=${originalSec.toFixed(3)}s/${originalBytes.length}B`
        + ` trimmed=${trimmedSec.toFixed(3)}s/${trimmedBytes.length}B`
        + ' (the trimmed replay is the larger body: PCM WAV against the recorder\'s opus)',
    );

    // (3) The first control replays the recording. The container is the recorder's own stream and its length
    // is the whole capture — the premise the second line is a comparison against. Without it the pair could
    // be two takes of a trim and still satisfy everything below.
    expect(originalBytes.subarray(0, 4).toString('hex'), 'the original replay is not the recorder\'s stream').toBe('1a45dfa3');
    expect(
      Math.abs(originalSec - FIXTURE_SEC),
      `the original replay is ${originalSec}s, the capture was ${FIXTURE_SEC}s`,
    ).toBeLessThan(CAPTURE_TOLERANCE_SEC);

    // ...and the second replays what was uploaded, not the recording under a second name: a WAV this repo
    // encoded, carrying different bytes, shorter by the pause the trim removes.
    expect(trimmedBytes.subarray(0, 4).toString('ascii'), 'the trimmed replay is not the encoded WAV').toBe('RIFF');
    expect(originalBytes.equals(trimmedBytes), 'the two replays are the same bytes').toBe(false);
    expect(
      originalSec - trimmedSec,
      `the trimmed replay is ${trimmedSec}s of a ${originalSec}s recording`,
    ).toBeGreaterThan(MIN_SAVING_SEC);
    // ...and it is not the whole fixture either, so it is not the recording's audio in a WAV header.
    expect(trimmedSec).toBeLessThan(FIXTURE_SEC - MIN_SAVING_SEC);

    // (4) Replay leaves the composer alone. Read before the controls are pressed and after: the box holds
    // this capture's own transcript, so "unchanged" is a transition rather than an empty box agreeing with
    // an empty box.
    expect(await composer().inputValue()).toBe(recorded);

    // (5) One at a time. Read twice over, because the two readings answer different questions: a control
    // renames itself for as long as its track is *said* to be sounding, and the registry from the page says
    // which element really is. A build that stopped its own audio but left the pair's state consistent would
    // satisfy the labels alone; a build that started the second track without stopping the first satisfies
    // the labels too, which is exactly why the audio is what the last assertion is about.
    /** The sources of the slot's elements that are really sounding right now. */
    const sounding = () =>
      page.evaluate(() =>
        ((window as unknown as { clipAudio?: () => { src: string; paused: boolean }[] }).clipAudio?.() ?? [])
          .filter((element) => !element.paused)
          .map((element) => element.src),
      );

    await originalControl.click();
    await expect(
      page.getByRole('button', { name: 'Stop original playback' }),
      'the recording never started sounding',
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(sounding, { message: 'the recording is announced as sounding but no element is playing it' })
      .toEqual([originalUrl]);
    // The premise for the pair of assertions below: the trimmed control is still there and still offering to
    // play, so what the next click shows is the recording being stopped by the trimmed track starting — not
    // a control that vanished.
    await expect(trimmedControl).toBeVisible();

    await page.getByRole('button', { name: 'Replay trimmed' }).click();
    await expect(
      page.getByRole('button', { name: 'Stop trimmed playback' }),
      'the trimmed audio never started sounding',
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(sounding, {
        message: 'the recording and the trimmed audio were sounding at once',
        timeout: 10_000,
      })
      .toEqual([trimmedUrl]);
    await expect(
      page.getByRole('button', { name: 'Stop original playback' }),
      'the recording was still announced as sounding while the trimmed audio played',
    ).toHaveCount(0);

    // The pair is still a pair afterwards, and neither press touched the box.
    await expect(page.getByRole('button', { name: 'Replay original' })).toBeVisible();
    expect(await composer().inputValue()).toBe(recorded);

    // (6) ...and a capture the chain did *not* trim gets no second control at all. This is the one thing a
    // fabricated pair would do: a control named "trimmed" over the recording's own bytes, claiming a trim
    // that never ran. The trim is switched off rather than defaulted, and the premise is asserted on the
    // upload — the body really is the recorder's container — so the absence below cannot be a trim that ran
    // and happened to remove nothing.
    const beforeFallback = requests.length;
    await openComposer('/?voiceTrim=off&voiceDebug=off');
    const untrimmed = await recordCapture('untrimmed leg');
    await expectTranscript(untrimmed, 'untrimmed leg');
    expect(
      uploadedFile(requests[beforeFallback].body, requests[beforeFallback].contentType)
        .subarray(0, 4)
        .toString('hex'),
      'the untrimmed leg did not upload the recording, so its slot is not the case this asserts about',
    ).toBe('1a45dfa3');
    await expect(page.getByRole('button', { name: 'Replay original' })).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('button', { name: 'Replay trimmed' }),
      'the capture was uploaded as it was recorded, and the slot offers a trimmed replay of it anyway',
    ).toHaveCount(0);
  });
});
