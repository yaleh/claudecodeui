/**
 * `GET /api/voice/health` with the on-host recogniser selected (AC3 of
 * `gap-voice-sensevoice-server-adapter`).
 *
 * WHAT IS BEING READ. This is the first provider in the seam whose availability is not a property of
 * the user's stored settings. Whether a remote recogniser is ready is answered by reading the
 * document the user saved; whether THIS one is ready is answered by the machine the server runs on,
 * and the health route is where that answer has to reach a caller BEFORE an upload is attempted. Two
 * readings, then, and they are the criterion's own:
 *
 *   1. with `sensevoice-local` selected and the engine built, the payload carries the runtime's own
 *      state and the build id the deployment is pinned to;
 *   2. with the weights absent, the route answers the stable `ENGINE_UNAVAILABLE` envelope — the
 *      status the vocabulary table holds for that code, with the remedy named in the sentence — and
 *      NOT a 200 with a quietly unusable provider, and not a crash.
 *
 * WHAT THE THIRD READING IS FOR (the control). A refusal that fires for every provider is not a
 * reading about this one: the last case selects a REMOTE recogniser while the on-host engine is in
 * its unavailable state and requires the ordinary 200. Without it, an implementation that failed
 * closed for the whole registry would look exactly like one that failed closed for the engine.
 *
 * HOW IT IS DRIVEN. The shipping router, invoked as the middleware function it is, over the shipping
 * service — no socket, no port, no `express()` app — which is the shape `voice-error-contract.test.ts`
 * keeps for the same reason: a bound port on a shared host reports the platform's ephemeral-port
 * lottery on the runs where it goes red.
 *
 * WHAT THE COMPOSITION ROOT DOES NOT DO HERE, said plainly because the boundary is deliberate:
 * `voice.module.ts` is NOT imported. It is the module that reads the `SENSEVOICE_*` variables and
 * builds the engine, and importing it would also open the settings store, resolve the data
 * directories and start the capture sink at module evaluation — side effects a route criterion must
 * not perform on the tree it is measuring. What this file does instead is what that module does with
 * those variables: `readSensevoiceManifest` for the shipped pins, `createSensevoiceWorker` over the
 * real `nodeSensevoiceSpawn`, and `installSensevoiceEngine`. The engine instance is the only
 * substituted thing, and it is substituted exactly as the composition root substitutes it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// REGISTRY FIRST, for the reason recorded in `voice-sensevoice-adapter.test.ts`: this seam's modules
// form one cycle, and a module that enters through an ADAPTER rather than through the registry reads
// the registry's bindings while they are still in their temporal dead zone. The import is also
// load-bearing here — the payload's rows are compared against the registry, and the control case
// takes a remote provider id from it rather than naming one.
import { listProviders } from '../../../../shared/asr/asrRegistry.js';
import {
  installSensevoiceEngine,
  type SensevoiceEnginePort,
} from '../../../../shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.js';
import type { VoiceSettings, VoiceSettingsService } from '../../../shared/types.js';
import {
  createSensevoiceWorker,
  nodeSensevoiceSpawn,
  readSensevoiceManifest,
  unavailableSensevoiceEngine,
  type SensevoiceManifest,
  type SensevoiceWorkerOptions,
} from '../sensevoice-worker.js';
import { createVoiceRouter } from '../voice.routes.js';
import { createVoiceService, PROVIDER_ERROR_STATUS } from '../voice.service.js';

// ── where things are ──────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repository this test belongs to; `server/modules/voice/tests/` is four levels down. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'sensevoice', 'manifest.json');

const manifest: SensevoiceManifest = readSensevoiceManifest(MANIFEST_PATH);

/**
 * The interpreter and worker this criterion names, and why they are deliberately NOT the real ones.
 *
 * THE ROUTE MUST NEVER BOOT THE ENGINE, and a reading of "it answered 200" cannot tell that apart
 * from "it answered 200 after paying for a model load". Pointing the engine at an interpreter that
 * does not exist makes the difference visible: the settings below are one `ensureReady()` away from
 * the `ENGINE_UNAVAILABLE` the last case in this file actually measures, so a health route that
 * started anything would answer the unavailable envelope instead of the runtime state.
 */
const ABSENT_PYTHON = '/nonexistent/sensevoice-python3';
const ABSENT_WORKER = '/nonexistent/scripts/sensevoice/worker.py';

/** The deployment's own configuration, as `voice.module.ts` reads it from the environment. */
const DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

/** A user whose stored selection is the provider named; every other field is empty. */
function settingsFor(providerId: string): VoiceSettings {
  return {
    baseUrl: '',
    apiKey: '',
    sttModel: '',
    ttsModel: '',
    ttsVoice: '',
    ttsFormat: '',
    providerId,
    dashscopeEndpoint: '',
    dashscopeApiKey: '',
    dashscopeModel: '',
  };
}

/** A directory holding the pinned file NAMES — which is the whole of what the cheap check reads. */
function weightsDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sensevoice-health-weights-'));
  for (const file of manifest.model.files) {
    writeFileSync(path.join(directory, file.name), 'not the real weights; only the name is read here');
  }
  return directory;
}

/** An engine built the way the composition root builds it, over whatever model directory it is given. */
function engineOver(modelDir: string | null): SensevoiceEnginePort {
  const options: SensevoiceWorkerOptions = {
    manifest,
    modelDir,
    python: ABSENT_PYTHON,
    pythonPath: null,
    workerPath: ABSENT_WORKER,
    concurrency: 1,
    timeoutMs: 1_000,
    spawn: nodeSensevoiceSpawn,
    log: { info: () => undefined, warn: () => undefined },
  };
  return createSensevoiceWorker(options);
}

/** The health payload as this criterion reads it, in the fields the route's callers branch on. */
type Runtime = { available?: unknown; state?: unknown; buildId?: unknown; reason?: unknown };
type ProviderRow = { id?: unknown; configured?: unknown; runtime?: Runtime };
type HealthBody = { configured?: unknown; provider?: unknown; providers?: ProviderRow[] };

type Outcome = { status: number; body: HealthBody };

/**
 * One `GET /health` through the shipping router.
 *
 * The parser stubs are inert — `/health` never reads an upload — but they are passed rather than
 * omitted because the dependency type requires them, and a test that reached the route through a
 * cast would stop being a reading of the shape the composition root actually builds.
 */
function callHealth(settings: VoiceSettings): Promise<Outcome> {
  const service = createVoiceService({
    defaults: { ...DEFAULTS },
    timeoutMs: 1_000,
    fetchBackend: async () => {
      throw new Error('the health reading must not call anything');
    },
  });

  const settingsService: VoiceSettingsService = {
    getSettings: () => settings,
    saveSettings: () => ({ ok: false, status: 400, error: 'unused' }),
    maskForReadback: (document) => document,
  };

  const inertParser = (_request: unknown, _response: unknown, callback: (error?: unknown) => void) => {
    callback(undefined);
  };

  const router = createVoiceRouter({
    voiceService: service,
    voiceSettingsService: settingsService,
    lexiconService: {
      observeSentText: () => {},
      importFromHistory: async () => ({ importedMessages: 0, tokenCount: 0 }),
      list: () => [],
      clear: () => {},
    },
    parseAudioUpload: inertParser,
    parseRawAudioUpload: inertParser,
  });

  return new Promise<Outcome>((resolve, reject) => {
    // Express's default is 200: a handler that calls `json` without naming a status answers it, so the
    // harness starts there rather than at 0 — otherwise every un-named success would read as a refusal.
    let status = 200;
    const request = {
      method: 'GET',
      url: '/health',
      headers: {},
      user: { id: 1 },
    };
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: HealthBody) {
        resolve({ status, body: payload });
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        resolve({ status, body: {} });
      },
    };
    router(
      request as never,
      response as never,
      (error?: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

/** The row the payload carries for one provider id. */
function rowFor(body: HealthBody, id: string): ProviderRow {
  const row = (body.providers ?? []).find((provider) => provider.id === id);
  assert.ok(row, `the payload carries no row for '${id}': ${JSON.stringify(body.providers?.map((p) => p.id) ?? [])}`);
  return row;
}

// ── the readings ─────────────────────────────────────────────────────────────────────────────

test('AC3 an available engine is reported with its runtime state and the pinned build id', async () => {
  const directory = weightsDirectory();
  try {
    installSensevoiceEngine(engineOver(directory));
    const outcome = await callHealth(settingsFor('sensevoice-local'));

    assert.equal(outcome.status, 200, `the health reading refused an available engine: ${JSON.stringify(outcome.body)}`);
    assert.equal(outcome.body.provider, 'sensevoice-local', 'the reading is about the provider the user selected');

    const row = rowFor(outcome.body, 'sensevoice-local');
    const runtime = row.runtime;
    assert.ok(runtime, 'the row for an on-host recogniser must carry a runtime reading');
    assert.equal(runtime.available, true);
    // `stopped` IS THE READING, not a placeholder: it says the deployment is configured and loadable
    // and that no process is up — which, with an interpreter that does not exist, is only reachable if
    // the route asked the engine's configuration rather than starting it.
    assert.equal(runtime.state, 'stopped', `expected a configuration reading, got state ${String(runtime.state)}`);
    assert.equal(runtime.buildId, manifest.buildId, 'the reported build must be the one the manifest pins');

    // The runtime reading belongs to the provider that declares one, and to no other row: the remote
    // rows say so by ABSENCE rather than by a null-valued key, which is the shape the client branches on.
    const remote = listProviders().filter((adapter) => adapter.runtime === undefined).map((adapter) => adapter.id);
    assert.ok(remote.length > 0, 'the registry has no provider without a runtime, so this control reads nothing');
    for (const id of remote) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(rowFor(outcome.body, id), 'runtime'),
        false,
        `'${id}' declares no runtime, so its row must not carry the key at all`,
      );
    }

    // And the rows are the registry's own, in its own order — the payload republishes the table.
    assert.deepEqual(
      outcome.body.providers?.map((provider) => provider.id),
      listProviders().map((adapter) => adapter.id),
    );
  } finally {
    installSensevoiceEngine(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AC3 a model directory without the weights answers ENGINE_UNAVAILABLE, naming the file', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'sensevoice-health-empty-'));
  try {
    // The vocabulary's own row for the code, read rather than restated: a criterion holding its own
    // `503` would go on passing after the table moved, which is exactly the drift this reading is for.
    const owedStatus = PROVIDER_ERROR_STATUS['ENGINE_UNAVAILABLE'];
    assert.ok(owedStatus !== undefined, 'the vocabulary no longer holds ENGINE_UNAVAILABLE');

    installSensevoiceEngine(engineOver(empty));
    const outcome = await callHealth(settingsFor('sensevoice-local'));
    assert.equal(outcome.status, owedStatus);
    assert.equal((outcome.body as { code?: unknown }).code, 'ENGINE_UNAVAILABLE');
    assert.match(
      String((outcome.body as { error?: unknown }).error ?? ''),
      /does not hold 'model\.int8\.onnx'/,
      'the refusal has to name the artifact the operator is missing',
    );
  } finally {
    installSensevoiceEngine(null);
    rmSync(empty, { recursive: true, force: true });
  }
});

test('AC3 no configured model directory at all answers the same code, naming the variable', async () => {
  // The ordinary case for a deployment that does not use this recogniser: `SENSEVOICE_MODEL_DIR` unset
  // is a state, not a fault, and the sentence has to say which variable to set.
  installSensevoiceEngine(engineOver(null));
  try {
    const outcome = await callHealth(settingsFor('sensevoice-local'));
    assert.equal(outcome.status, PROVIDER_ERROR_STATUS['ENGINE_UNAVAILABLE']);
    assert.equal((outcome.body as { code?: unknown }).code, 'ENGINE_UNAVAILABLE');
    assert.match(String((outcome.body as { error?: unknown }).error ?? ''), /SENSEVOICE_MODEL_DIR/);
  } finally {
    installSensevoiceEngine(null);
  }
});

test('AC3 an engine that could not even be described is reported with its own sentence', async () => {
  // The third unavailable shape, and the one the composition root installs when the manifest cannot be
  // read: an engine whose identity is unknown may not report a build, so it is installed in its
  // unavailable form carrying the failure verbatim. Nothing about the route changes for it.
  const reason = 'the SenseVoice manifest at /tmp/none.json could not be read: Unexpected token';
  installSensevoiceEngine(unavailableSensevoiceEngine(reason));
  try {
    const outcome = await callHealth(settingsFor('sensevoice-local'));
    assert.equal(outcome.status, PROVIDER_ERROR_STATUS['ENGINE_UNAVAILABLE']);
    assert.equal((outcome.body as { code?: unknown }).code, 'ENGINE_UNAVAILABLE');
    assert.equal((outcome.body as { error?: unknown }).error, reason, 'the reason travels verbatim');
  } finally {
    installSensevoiceEngine(null);
  }
});

test('AC3 control: a remote provider still reads as healthy while the on-host engine is unavailable', async () => {
  // The refusal above is about the provider the user SELECTED. A registry-wide failure would answer the
  // same 503 here — which is why this case exists: without it, the criterion above would be satisfied
  // by an implementation that failed closed for everything.
  const remote = listProviders().find((adapter) => adapter.capabilities.locality === 'remote');
  assert.ok(remote, 'the registry has no remote provider, so this control reads nothing');

  installSensevoiceEngine(engineOver(null));
  try {
    const outcome = await callHealth(settingsFor(remote.id));
    assert.equal(outcome.status, 200, `a remote provider must be unaffected: ${JSON.stringify(outcome.body)}`);
    assert.equal(outcome.body.provider, remote.id);
    assert.equal(Object.prototype.hasOwnProperty.call(rowFor(outcome.body, remote.id), 'runtime'), false);
  } finally {
    installSensevoiceEngine(null);
  }
});

test('AC3 control: the interpreter this deployment names really is absent, so `stopped` was not a running engine', async () => {
  // The positive control for the first case's `stopped`. That reading says "configured and loadable,
  // no process up"; it would be worthless if the engine could not have come up at all for some OTHER
  // reason. So the same engine is asked to come up, and it must refuse BY NAME OF THE INTERPRETER —
  // which makes "the health route did not start it" a measurement rather than an inference.
  const directory = weightsDirectory();
  try {
    const engine = engineOver(directory);
    const status = await engine.ensureReady();

    // THE WHOLE ASSERTION OF THIS CASE IS THAT IT REACHED THIS LINE. Node reports a spawn failure on
    // the child's `'error'` event, and an `'error'` with no listener is re-thrown as an uncaught
    // exception — so a seam that ignored it would have taken this test process down rather than
    // returned a status, and there would be no assertion to fail. Reaching `assert.equal` at all is
    // the reading; it is also the one the DoD asks for by name ("缺模型 / 缺 Python 时的失败是可行动
    // 的稳定错误码，不是崩溃").
    assert.equal(status.available, false, 'a missing interpreter is a state, not a rejection');
    // The remedy travels as far as the sentence, so an operator reading the health payload knows which
    // command to repair: the interpreter is named, and the reason says what could not be done with it.
    assert.match(status.available === false ? status.reason : '', /could not be started/);
    assert.match(status.available === false ? status.reason : '', /nonexistent\/sensevoice-python3/);

    // And it is the SAME stable code on the work path, not a second failure shape. An upload attempted
    // against this engine is refused in the seam's vocabulary rather than throwing out of `transcribe`.
    const answer = await engine.transcribe({
      bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      mimeType: 'audio/wav',
      fileName: 'control.wav',
      timeoutMs: 1_000,
    });
    assert.equal(answer.ok, false, 'a request against an engine that never started cannot succeed');
    assert.equal(answer.ok === false ? answer.code : '', 'ENGINE_UNAVAILABLE');
    assert.match(answer.ok === false ? answer.message : '', /could not be started/);

    // Sticky, like every other provisioning failure: the second question does not re-attempt the spawn.
    // Without this, a caller polling health would fork a fresh doomed process on every poll.
    const again = await engine.ensureReady();
    assert.equal(again.available, false);
    assert.equal(again.available === false ? again.reason : '', status.available === false ? status.reason : '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
