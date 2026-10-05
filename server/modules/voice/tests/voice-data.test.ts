import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import type { VoiceSettings } from '@/shared/types.js';

import { createVoiceDataStore } from '../voice-data.js';
import { createVoiceRouter } from '../voice.routes.js';
import { createVoiceService, createVoiceSettingsService } from '../voice.service.js';

/**
 * D1's user-data store: the local-only recordings, default ON.
 *
 * THE READINGS ARE TAKEN ON REAL BYTES ON A REAL DIRECTORY. Every case drives the SHIPPING service
 * (`createVoiceService`) with the SHIPPING store (`createVoiceDataStore`) pointed at a throwaway
 * directory, so "a transcription wrote a record" is a fact about the filesystem rather than about a
 * private function: the record's own JSON is read back, the audio file beside it is stat'ed, and the
 * modes are read off the files themselves. The store is a separate module from the diagnostic
 * capture (`voice-capture.ts`), and nothing here sets `VOICE_CAPTURE` — that the two coexist without
 * changing each other is the isolation criterion's reading, which lives with the capture tests.
 *
 * THE SERVICE IS DRIVEN DIRECTLY rather than through the router for the write cases, and the ONE
 * route reading (the `DELETE`) goes through a real express app so "the route answers with a count"
 * is a real HTTP answer. `voice.capture` is never wired, so a case that accidentally depended on the
 * diagnostic seam would fail rather than pass quietly.
 */

const defaults = {
  baseUrl: 'https://voice.example/v1',
  apiKey: 'server-key',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

/** A user who has never saved anything: no key, so recording takes the default (ON). */
const EMPTY_SETTINGS: VoiceSettings = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
  providerId: '',
  dashscopeEndpoint: '',
  dashscopeApiKey: '',
  dashscopeModel: '',
};

/** A sentinel credential, so a leak into a record's bytes is attributable rather than imagined. */
const SENTINEL_API_KEY = 'sk-sentinel-must-not-be-stored';

/** The one audio buffer every write case transcribes; a small but non-empty body. */
const AUDIO = Buffer.from('RIFF....WAVEfmt ');

/** A temporary parent, removed by the caller when the case ends. */
function makeTempParent(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'voice-data-criterion-'));
}

/** The directory the store uses under a temp parent — resolved but not created until a write. */
function dataDir(parent: string): string {
  return path.join(parent, 'voice-data');
}

/**
 * The one transcription body every case answers with.
 *
 * It carries `tokens`, so the record's own token passthrough is exercised rather than assumed: the
 * service's envelope forwards whatever the recogniser produced, and the store keeps it verbatim.
 */
function transcriptionResponse(): Response {
  return new Response(
    JSON.stringify({
      text: '你好世界',
      tokens: [
        { text: '你好', confidence: 0.91 },
        { text: '世界', confidence: 0.88 },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * The shipping service with the shipping store, driven against one temp parent.
 *
 * `settings` is what `createVoiceService`'s `transcribe` lets the store see, so the recording gate
 * and the capacity ceiling are read from the same document the route would pass.
 */
function makeService(parent: string, directory = dataDir(parent)) {
  const store = createVoiceDataStore({ directory });
  const service = createVoiceService({
    defaults,
    timeoutMs: 1_000,
    fetchBackend: async () => transcriptionResponse(),
    voiceData: store,
  });
  return { service, store, directory };
}

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

const filesWith = (directory: string, extension: string): string[] =>
  readdirSync(directory).filter((name) => name.endsWith(extension)).sort();

/** The bytes of every regular file under the directory, the figure the ceiling bounds. */
function directoryBytes(directory: string): number {
  return readdirSync(directory).reduce((total, name) => {
    const stats = statSync(path.join(directory, name));
    return stats.isFile() ? total + stats.size : total;
  }, 0);
}

test('a default-settings transcription writes one record and its segment audio, 0700/0600', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);

    const result = await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: { ...EMPTY_SETTINGS, apiKey: SENTINEL_API_KEY },
    });

    assert.equal(result.ok, true, 'the transcription itself must succeed');
    assert.ok(result.ok && typeof result.value.recordId === 'string' && result.value.recordId.length > 0,
      'the response carries the record id a later task writes the final text back with');

    // The directory and both files exist, with the modes D1 promises — read off the files, not the
    // umask the test process happens to run under (the store chmods explicitly).
    assert.equal(statSync(directory).mode & 0o777, 0o700, 'the directory is 0700');
    const records = filesWith(directory, '.json');
    const audio = filesWith(directory, '.wav');
    assert.equal(records.length, 1, 'exactly one record');
    assert.equal(audio.length, 1, 'exactly one segment audio file');
    assert.equal(statSync(path.join(directory, records[0])).mode & 0o777, 0o600, 'the record is 0600');
    assert.equal(statSync(path.join(directory, audio[0])).mode & 0o777, 0o600, 'the audio is 0600');

    // The record is the shape the later tasks read: an id, a timestamp, the provider, and one
    // segment naming the audio file beside it.
    const record = readJson(path.join(directory, records[0]));
    assert.equal(record.recordId, result.ok ? result.value.recordId : null);
    assert.equal(typeof record.ts, 'number');
    assert.equal(typeof record.providerId, 'string');
    assert.ok((record.providerId as string).length > 0);
    const segments = record.segments as Array<Record<string, unknown>>;
    assert.equal(segments.length, 1);
    assert.equal(segments[0].index, 0);
    assert.equal(segments[0].audioFile, audio[0]);
    assert.equal(segments[0].text, '你好世界');
    // Whatever the recogniser produced is what was kept — no second reading, no dropped envelope.
    // The seam's richer `tokens` rides beyond the wire's declared `{ text, recordId }`, so it is
    // read through a narrow cast rather than widened on the shared type for this one test's sake.
    const returnedTokens = result.ok ? ((result.value as { tokens?: unknown }).tokens ?? null) : null;
    assert.deepEqual(segments[0].tokens ?? null, returnedTokens);

    // The reserved keys belong to later tasks and are NOT written here.
    assert.ok(!('finalText' in record), 'finalText is reserved, not written by this task');
    assert.ok(!('labels' in record), 'labels is reserved, not written by this task');
    assert.ok(!('flagStats' in record), 'flagStats is reserved, not written by this task');

    // The credential never becomes a record's bytes: the sentinel key was on the settings document
    // and nowhere on disk. (The audio/text are the user's own; the key is not.)
    assert.ok(!readFileSync(path.join(directory, records[0]), 'utf8').includes(SENTINEL_API_KEY));
    assert.ok(!readFileSync(path.join(directory, audio[0]), 'latin1').includes(SENTINEL_API_KEY));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('recording off writes nothing; the same user turning it on writes (paired negative control)', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);

    const off = await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: { ...EMPTY_SETTINGS, voiceDataRecording: false },
    });
    assert.equal(off.ok, true, 'turning recording off must not fail the transcription');
    assert.equal(off.ok && off.value.recordId, undefined, 'no record id when nothing was kept');
    assert.equal(existsSync(directory), false, 'no directory and no files for an off user');

    // The SAME service and the SAME directory: the only thing that changed is the setting, so the
    // write below is attributable to it rather than to a fresh fixture.
    const on = await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: { ...EMPTY_SETTINGS, voiceDataRecording: true },
    });
    assert.equal(on.ok, true);
    assert.ok(on.ok && typeof on.value.recordId === 'string', 'the same user with recording on keeps a record');
    assert.equal(filesWith(directory, '.json').length, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearVoiceData removes every record and answers the count; a missing directory answers 0', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);
    for (let index = 0; index < 3; index += 1) {
      await service.transcribe({
        audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: `segment-${index + 1}.wav` },
        overrides: {},
        settings: EMPTY_SETTINGS,
      });
    }
    assert.equal(filesWith(directory, '.json').length, 3);

    const cleared = service.clearVoiceData?.();
    assert.deepEqual(cleared, { deleted: 3 }, 'the count is the records, not the files');
    assert.deepEqual(readdirSync(directory), [], 'no record and no audio is left behind');

    // A directory that was never created — a user who turned recording off — clears to zero rather
    // than failing: "nothing here to clear" is a clear that succeeded.
    const never = makeService(parent, path.join(parent, 'never-created'));
    assert.deepEqual(never.service.clearVoiceData?.(), { deleted: 0 });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('the capacity ceiling trims the OLDEST records, and the directory ends within the bound', async () => {
  const parent = makeTempParent();
  try {
    const CAP_BYTES = 50 * 1024;
    const { service, directory } = makeService(parent);
    // ~20 KiB of audio per record, so three records (~60 KiB) overrun the 50 KiB ceiling.
    const bigAudio = Buffer.alloc(20 * 1024, 7);

    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      // A few milliseconds apart, so each record's `ts` is distinct and "oldest" is a fact about the
      // records rather than a tie the eviction order would have to break by mtime.
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const result = await service.transcribe({
        audio: { bytes: bigAudio, mimeType: 'audio/wav', fileName: `segment-${index + 1}.wav` },
        overrides: {},
        settings: { ...EMPTY_SETTINGS, voiceDataMaxBytes: CAP_BYTES },
      });
      assert.equal(result.ok, true);
      assert.ok(result.ok && typeof result.value.recordId === 'string');
      ids.push(result.ok ? result.value.recordId : '');
    }

    assert.ok(directoryBytes(directory) <= CAP_BYTES, 'the directory is within its ceiling');
    const remaining = new Set(filesWith(directory, '.json'));
    // The oldest records are the ones that went; the newest — the one just written — is still there.
    assert.ok(!remaining.has(`${ids[0]}.json`), 'the oldest record was evicted first');
    assert.ok(remaining.has(`${ids[2]}.json`), 'the newest record survives the trim');
    assert.ok(filesWith(directory, '.wav').length < 3, 'audio went with the evicted record');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('DELETE /api/voice/data answers the deleted count over HTTP, and 200/0 for no directory', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);

    await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: EMPTY_SETTINGS,
    });
    assert.equal(filesWith(directory, '.json').length, 1);

    // The settings service is the shipping one over a tiny in-memory store: the DELETE route does
    // not read settings, but the router needs a real one and a fake would not prove the route.
    const settingsStore = {
      getSettings: () => EMPTY_SETTINGS,
      saveSettings: () => undefined,
    };
    const app = express();
    app.use(createVoiceRouter({
      voiceService: service,
      voiceSettingsService: createVoiceSettingsService(settingsStore),
      lexiconService: {
        observeSentText: () => undefined,
        importFromHistory: async () => ({ importedMessages: 0, tokenCount: 0 }),
        list: () => [],
        clear: () => undefined,
      },
      parseAudioUpload: (_request, _response, next) => next(),
      parseRawAudioUpload: (_request, _response, next) => next(),
    }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = (address as { port: number }).port;

    const call = (): Promise<{ status: number; body: unknown }> => new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/data', method: 'DELETE' }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
        });
      });
      request.on('error', reject);
      request.end();
    });

    try {
      const first = await call();
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, { deleted: 1 });
      assert.deepEqual(readdirSync(directory), []);

      // The directory is now gone; a second clear — the "nothing to clear" case — is still a 200
      // with a zero count rather than an error.
      const second = await call();
      assert.equal(second.status, 200);
      assert.deepEqual(second.body, { deleted: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('the store module carries no transport import: nothing here leaves the machine', () => {
  // Read the SHIPPING module's own source and require the transport vocabulary to be absent. This
  // is the "does not leave this machine" half of D1 as a reading rather than a promise, and it is
  // scoped to the one file so it cannot match this test's own text.
  const source = readFileSync(new URL('../voice-data.ts', import.meta.url), 'utf8');
  const forbidden = /fetch\(|https?\.request|axios|undici/;
  assert.equal(forbidden.test(source), false, 'voice-data.ts must not name a transport');
  // The positive control: the same predicate DOES match a file that does, so the reading is not
  // vacuous on a pattern that could never match anything.
  assert.equal(forbidden.test("await fetch('https://example.test')"), true);
  // A second control: the module's own imports are the node builtins it is allowed to have.
  assert.ok(source.includes("from 'node:fs'"));
  assert.ok(source.includes("from 'node:crypto'"));
});
