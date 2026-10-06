/**
 * The on-device recogniser's engine: the Web Worker that owns onnxruntime-web and the cached int8
 * model, the main-thread port that drives it, and the routing policy that decides when to leave the
 * device.
 *
 * WHY ONE FILE HOLDS ALL THREE. The worker is not a general-purpose host: it exists to answer one
 * port (`WasmEnginePort`, in `shared/asr/list/sensevoice-wasm/`) and it is spawned by the same module
 * that parses its replies, so the protocol has exactly two ends and both of them are here. A separate
 * protocol module would be a third file whose only content is a type the two already agree on.
 *
 * WHY THE MODEL RUNS IN A WORKER AT ALL. Inference on a 239 MB int8 checkpoint is a long synchronous
 * stretch of WASM; run on the main thread it would freeze the composer, the recorder's level meter
 * and the trim UI for the whole of it. The worker keeps the main thread free, and it also keeps the
 * model bytes (a quarter of a gigabyte) out of the page's heap — the bytes are fetched, verified and
 * unpacked where they are used.
 *
 * THE WIRE IS 16 kHz PCM AND THAT IS A CONTRACT, NOT A CONVENTION. SenseVoice's front end takes
 * 16 kHz mono; the recorder produces 48 kHz webm/opus and the segmenter hands over WAV at the capture
 * rate. The main thread (`prepareSixteenKhzWav`) decodes and resamples with the same `audioDecode`
 * helpers the upload path already uses — WebAudio is a page API, not a worker one — and the worker
 * REFUSES anything whose WAV header does not say 16 000 Hz rather than resampling it a second time. A
 * wrong rate reaching the front end produces confident nonsense, so it is named (`AUDIO_REJECTED`)
 * instead of being smoothed over.
 *
 * NOTHING HERE IS AN IMPORT-TIME SIDE EFFECT ON THE MAIN THREAD. `startVoiceClientAsrWorker`
 * self-starts only inside a worker scope; on the main thread this module exports the port factory, and
 * it is installed by the caller that wants it (`installVoiceClientAsrEngine`). That is what lets a
 * test import this module in jsdom, install a fake engine, and exercise the routing with no worker, no
 * WASM and no network.
 *
 * THE ROUTING POLICY IS THE LAST SECTION, AND IT IS THE ONLY PLACE THAT MAY DECIDE TO LEAVE THE
 * DEVICE. The adapter itself never falls back — it cannot see the user's choice — so the caller does,
 * on exactly two readings: the engine could not serve the request at all (`engine-unavailable`), or
 * one segment took longer than its own length to recognise (`segment-too-slow`, a realtime factor over
 * `VOICE_CLIENT_RTF_THRESHOLD`). Every fallback is announced on `window` as
 * `voice-client-asr:fallback`, because "your audio just went to a server" is not something a user
 * should have to infer from a delay.
 */

import type { AsrInvocation, AsrRequest, AsrResult, AsrRuntimeStatus, AsrToken } from '@shared/asr/asrRegistry';
import {
  id as wasmProviderId,
  installWasmEngine,
  transcribe as wasmTranscribe,
  type WasmEngineAnswer,
  type WasmEnginePort,
  type WasmEngineRequest,
} from '@shared/asr/list/sensevoice-wasm/sensevoice-wasm.asr-provider';
import { decodeVoiceBlob, downsampleVoice, encodeWavBlob, UPLOAD_SAMPLE_RATE } from '@/modules/chat/utils/audioDecode';
import {
  VOICE_CLIENT_MODEL_CACHE_NAME,
  loadVoiceModel,
  subtleSha256Hex,
  type VoiceClientModelSpec,
  type VoiceModelCacheEnv,
  type VoiceModelProgress,
} from '@/modules/chat/utils/voiceModelCache';
import {
  VOICE_CLIENT_PROBE_VERSION,
  decodeLogits,
  fbank,
  lfrCmvn,
  parseOnnxMetadata,
  parseWav,
} from '@/shared/voiceClientFrontend';

// ── the pinned artifacts ─────────────────────────────────────────────────────────────────────

/**
 * The checkpoint this client path is built for, and the two facts that make it THE checkpoint rather
 * than one like it.
 *
 * THE BYTE COUNT AND THE HASH ARE BOTH PINNED, on purpose. The length catches a truncated download
 * for free, and the hash catches what the length cannot: a file of exactly the right size that is not
 * the model. `docs/experiments/2026-10-06-voice-client-asr-probe.md` §2 records where these came from;
 * they are the numbers the probe took its readings against, so a reading taken here and a reading
 * taken there are readings of the same artifact.
 */
export const VOICE_CLIENT_MODEL_NAME = 'sensevoice-small-int8-2024-07-17';
export const VOICE_CLIENT_MODEL_BYTES = 239_233_841;
export const VOICE_CLIENT_MODEL_SHA256 =
  'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51';

/** The ort-web build the front end was validated against; the deployment serves this version. */
export const VOICE_CLIENT_ORT_VERSION = '1.30.0';

/** The rate the model's front end requires. Anything else is refused, not resampled. */
export const VOICE_CLIENT_SAMPLE_RATE = 16_000;

/** The mel filterbank width the checkpoint was trained with. */
export const VOICE_CLIENT_FBANK_BINS = 80;

/**
 * Milliseconds per stacked frame.
 *
 * Two hops compose: the fbank advances 160 samples (10 ms) per raw frame, and the LFR window shift is
 * 6 raw frames, so one row of the model's input is 60 ms. A token's `t` is an index into THOSE rows,
 * which is why the conversion to `AsrToken.startMs` multiplies by this rather than by the fbank hop.
 */
export const VOICE_CLIENT_LFR_FRAME_MS = 60;

/** The LFR window the checkpoint's metadata declares, and the only one this pipeline implements. */
export const VOICE_CLIENT_LFR_WINDOW_SIZE = 7;
export const VOICE_CLIENT_LFR_WINDOW_SHIFT = 6;

/**
 * The identity recorded with every recognition this engine produces.
 *
 * A local model's output is a property of the ARTIFACTS — the runtime build, the checkpoint, this
 * front end's version — so the sentence names all three plus the first 16 hex characters of the
 * checkpoint's hash. The truncated hash tells two checkpoints apart by eye and stays readable; the
 * FULL hash is what the download is verified against, above.
 */
export function voiceClientAsrBuildId(ortVersion: string = VOICE_CLIENT_ORT_VERSION): string {
  return (
    `ort-web ${ortVersion} | ${VOICE_CLIENT_MODEL_NAME} | ${VOICE_CLIENT_PROBE_VERSION} `
    + `| sha256:${VOICE_CLIENT_MODEL_SHA256.slice(0, 16)}`
  );
}

// ── deployment configuration ─────────────────────────────────────────────────────────────────

/**
 * Where the four files come from, read from the build environment.
 *
 * WHY THESE ARE ENVIRONMENT VARIABLES AND NOT CONSTANTS. `npm run build` produces one bundle for every
 * deployment, and none of these is ours to host: the runtime is a vendored ort-web distribution (which
 * must be served beside its own `.wasm` and worker files), the model and the token list are the
 * checkpoint's own files. Baking a path in would make the bundle wrong for everyone who serves them
 * somewhere else, and would put a URL in the tree that nothing in this repo can verify.
 * `import.meta.env` is the channel this front end already uses for exactly this kind of
 * deployment-time value (`src/shared/utils.ts`, `sendDelivery.ts`).
 *
 * MISSING CONFIGURATION IS NOT AN ERROR, IT IS A READING: a deployment that has not set these has no
 * on-device recogniser, the adapter answers `ENGINE_UNAVAILABLE` with a sentence naming the missing
 * variables, and the caller's routing takes the audio to the server it would have used anyway. That is
 * the same fail-closed shape the server's `SENSEVOICE_MODEL_DIR` has, one level down.
 */
export const VOICE_CLIENT_MODEL_URL_ENV = 'VITE_VOICE_CLIENT_MODEL_URL';
export const VOICE_CLIENT_TOKENS_URL_ENV = 'VITE_VOICE_CLIENT_TOKENS_URL';
export const VOICE_CLIENT_ORT_SCRIPT_URL_ENV = 'VITE_VOICE_CLIENT_ORT_SCRIPT_URL';
export const VOICE_CLIENT_ORT_WASM_PATHS_ENV = 'VITE_VOICE_CLIENT_ORT_WASM_PATHS';

/** The four resolved URLs, or the names of the variables that are still unset. */
export type VoiceClientAsrConfig =
  | {
      ready: true;
      modelUrl: string;
      tokensUrl: string;
      ortScriptUrl: string;
      ortWasmPaths: string;
    }
  | { ready: false; missing: string[] };

/** Reads one build-time variable, or null when it is absent or blank. */
function readEnv(name: string): string | null {
  const raw = import.meta.env?.[name];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/**
 * Resolves the deployment's configuration.
 *
 * ALL FOUR OR NOTHING. A deployment that set the model URL and forgot the runtime script has not
 * half-enabled the feature; it has a path that would fetch 239 MB and then fail to run it, which is
 * worse for the user than not offering the mode. Every missing name is collected, so the sentence the
 * user sees is a checklist rather than a first failure.
 *
 * The values are read per call and never cached in a module constant, so a test can drive both
 * branches by stubbing `import.meta.env` without reloading the module.
 */
export function readVoiceClientAsrConfig(): VoiceClientAsrConfig {
  const modelUrl = readEnv(VOICE_CLIENT_MODEL_URL_ENV);
  const tokensUrl = readEnv(VOICE_CLIENT_TOKENS_URL_ENV);
  const ortScriptUrl = readEnv(VOICE_CLIENT_ORT_SCRIPT_URL_ENV);
  const ortWasmPaths = readEnv(VOICE_CLIENT_ORT_WASM_PATHS_ENV);

  const missing: string[] = [];
  if (modelUrl === null) missing.push(VOICE_CLIENT_MODEL_URL_ENV);
  if (tokensUrl === null) missing.push(VOICE_CLIENT_TOKENS_URL_ENV);
  if (ortScriptUrl === null) missing.push(VOICE_CLIENT_ORT_SCRIPT_URL_ENV);
  if (ortWasmPaths === null) missing.push(VOICE_CLIENT_ORT_WASM_PATHS_ENV);
  if (missing.length > 0) return { ready: false, missing };

  return {
    ready: true,
    modelUrl: modelUrl as string,
    tokensUrl: tokensUrl as string,
    ortScriptUrl: ortScriptUrl as string,
    ortWasmPaths: ortWasmPaths as string,
  };
}

/** The sentence owed a deployment whose configuration is incomplete, naming every missing variable. */
export function missingConfigReason(missing: readonly string[]): string {
  return (
    'this deployment has no on-device recogniser configured; set '
    + `${missing.join(', ')} to the files' URLs.`
  );
}

/** The spec the cache module is handed: the pinned URL plus the facts the download must match. */
function modelSpec(config: Extract<VoiceClientAsrConfig, { ready: true }>): VoiceClientModelSpec {
  return {
    url: config.modelUrl,
    sha256: VOICE_CLIENT_MODEL_SHA256,
    bytes: VOICE_CLIENT_MODEL_BYTES,
    buildId: voiceClientAsrBuildId(),
  };
}

// ── the onnxruntime-web slice this engine uses ───────────────────────────────────────────────

/**
 * The slice of onnxruntime-web's surface this engine touches, written out here.
 *
 * WHY A HAND-WRITTEN TYPE AND A DYNAMIC IMPORT. `onnxruntime-web` is deliberately NOT a dependency of
 * this repo: the runtime is a deployment artifact (see the configuration block), it is megabytes of
 * WASM glue that must be served beside its own `.wasm` and worker files, and a deployment that does
 * not ship the client recogniser should not carry it. So the module is loaded by URL at run time, with
 * `@vite-ignore` because the URL is a value Vite cannot analyse. The cost is that there is no import
 * to hang types on, and the answer is this declaration of what is used — which has the side benefit of
 * making the coupling visible: needing more of the runtime's surface means growing this type.
 */
type OrtTensor = { data: Float32Array | Int32Array; dims: readonly number[] };

type OrtSession = {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
};

type OrtModule = {
  env: { wasm: { numThreads: number; simd: boolean; wasmPaths?: string } };
  Tensor: new (
    type: 'float32' | 'int32',
    data: Float32Array | Int32Array,
    dims: readonly number[],
  ) => OrtTensor;
  InferenceSession: {
    create(
      bytes: Uint8Array,
      options: { executionProviders: readonly string[]; graphOptimizationLevel?: string },
    ): Promise<OrtSession>;
  };
};

/** How the runtime module is obtained. A parameter, so the inference path is testable without WASM. */
export type OrtLoader = (scriptUrl: string) => Promise<OrtModule>;

/**
 * The production loader: a run-time `import()` of the deployment's ort-web script.
 *
 * `@vite-ignore` is required and correct — the specifier is a value, not a literal, so Vite cannot
 * pre-bundle it and must not try. The cast is the price of having no dependency to type against, and
 * it is confined to this one line: everything downstream sees `OrtModule`.
 */
const importOrt: OrtLoader = async (scriptUrl) => (await import(/* @vite-ignore */ scriptUrl)) as unknown as OrtModule;

/**
 * The thread count for the WASM backend.
 *
 * Multi-threaded WASM needs `crossOriginIsolated` (the deployment's COOP/COEP headers); without it
 * ort-web falls back to one thread. Constraint 6 of the probe's §0 already established that one thread
 * suffices for this model, so extra threads are a free win where the headers exist and never a
 * prerequisite.
 */
function wasmThreadCount(): number {
  if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
    return Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1));
  }
  return 1;
}

// ── the worker protocol ──────────────────────────────────────────────────────────────────────

/**
 * What the main thread asks the worker to do.
 *
 * `init` and `run` are both here, and `run` will pay a load if `init` has not. `init` exists so the
 * caller can pay the eight-to-ten-minute first download where the user can SEE it — behind a progress
 * line, before they record — instead of inside their first recognition, where the only visible symptom
 * would be a very slow segment that then falls back. `run` pays it anyway rather than failing, because
 * a caller that reached a recognition has already decided it wants this engine, and losing one segment
 * to an ordering mistake is a bug the user would experience as flakiness.
 */
export type VoiceClientWorkerRequest =
  | { kind: 'status'; requestId: number }
  | { kind: 'init'; requestId: number }
  | {
      kind: 'run';
      requestId: number;
      /** A 16 kHz mono 16-bit PCM WAV. See `prepareSixteenKhzWav`. */
      bytes: ArrayBuffer;
      durationSec?: number;
    };

/**
 * What the worker answers.
 *
 * `notice` is separate from `answer` because the two are about different things: an answer is the
 * result of a request, while a notice is a fact about the engine the user should know whether or not
 * the request succeeded — today, that the model could not be kept in the browser's storage and will be
 * downloaded again next visit (`voiceModelCache`'s degradation sentences). Folding it into the answer
 * would lose it on the failure paths, which are exactly the paths where the user is already being told
 * something.
 */
export type VoiceClientWorkerReply =
  | { kind: 'status'; requestId: number; status: AsrRuntimeStatus }
  | { kind: 'progress'; requestId: number; progress: VoiceModelProgress }
  | { kind: 'notice'; requestId: number; message: string }
  | { kind: 'answer'; requestId: number; answer: WasmEngineAnswer };

/**
 * The worker's side of the message channel, as this module uses it.
 *
 * A structural type rather than a cast to `DedicatedWorkerGlobalScope`, for the reason every port in
 * this repo is a type: a test can drive the whole worker body with an object that has these two
 * methods, so the protocol is exercised without a browser.
 */
export type VoiceClientWorkerScope = {
  postMessage(message: VoiceClientWorkerReply): void;
  addEventListener(type: 'message', handler: (event: { data: VoiceClientWorkerRequest }) => void): void;
};

/**
 * The main thread's side of the same channel. `Worker` satisfies it structurally, and so does a fake.
 */
export type VoiceClientWorkerHandle = {
  postMessage(message: VoiceClientWorkerRequest): void;
  addEventListener(type: 'message', handler: (event: { data: VoiceClientWorkerReply }) => void): void;
  terminate?(): void;
};

// ── the engine, inside the worker ────────────────────────────────────────────────────────────

/** What the model load needs beyond the config, injected so the worker body is testable. */
export type VoiceClientEngineDeps = {
  /** The Cache API environment; defaults to the worker's own globals. */
  cacheEnv?: Partial<VoiceModelCacheEnv>;
  /** The runtime loader; defaults to `importOrt`. */
  loadOrt?: OrtLoader;
};

/**
 * The lifecycle of the one session this worker will ever have.
 *
 * WHY `failed` IS STICKY. Every way this engine fails to become ready is a way a retry would pay
 * 239 MB for the same answer — a wrong URL, a checkpoint that does not hash, a runtime the browser
 * refuses. If the state fell back to `unloaded`, every later segment would re-download the model before
 * falling back to the server: the user would get N stalls of unpredictable length instead of one clear
 * "this device cannot run it". Sticky-failed means the first segment costs the attempt and every later
 * one fails immediately, which is what makes the caller's fallback cheap enough to be the design it is
 * meant to be. A user who fixes the deployment reloads the page.
 */
type EngineState =
  | { kind: 'unloaded' }
  | { kind: 'loading' }
  | {
      kind: 'ready';
      ort: OrtModule;
      session: OrtSession;
      tokens: string[];
      negMean: Float32Array;
      invStddev: Float32Array;
      buildId: string;
    }
  | { kind: 'failed'; reason: string };

/** The loaded state, named so the load's return type and a run's parameter can both point at it. */
type ReadyState = Extract<EngineState, { kind: 'ready' }>;

/** The worker's engine: one load, many runs, and the state machine above. */
export type VoiceClientEngine = {
  status(): AsrRuntimeStatus;
  ensureReady(): Promise<AsrRuntimeStatus>;
  transcribe(request: WasmEngineRequest): Promise<WasmEngineAnswer>;
};

/**
 * The cache environment the worker's own globals provide: its `fetch`, its `caches`, its
 * `crypto.subtle` and its `navigator.storage`.
 *
 * `caches` is read through `typeof` rather than assumed, because an insecure context or a locked-down
 * profile has none — and `voiceModelCache` has a degradation sentence for exactly that, which is only
 * reachable if this reports the absence honestly.
 */
function workerCacheEnv(): VoiceModelCacheEnv {
  return {
    fetchImpl: (...args) => fetch(...args),
    cachesImpl: typeof caches === 'undefined' ? null : caches,
    sha256Hex: subtleSha256Hex,
    persist: async () => {
      if (typeof navigator === 'undefined' || navigator.storage === undefined) return false;
      if (typeof navigator.storage.persist !== 'function') return false;
      return navigator.storage.persist();
    },
  };
}

/**
 * Builds the engine. Everything expensive happens on the first `ensureReady()`/`transcribe()`.
 *
 * THE ORDER OF THE LOAD IS THE DEFECT FIX, one level up. `loadVoiceModel` verifies the bytes before
 * anything is cached; this function then parses the metadata out of the VERIFIED bytes, so a
 * checkpoint that hashes correctly but does not carry the LFR/CMVN metadata this pipeline requires is
 * refused before a runtime session is created around it. Handing the runtime an unverifiable model
 * would produce wrong text rather than an error, which is the one outcome this path must never have.
 */
export function createVoiceClientEngine(
  config: Extract<VoiceClientAsrConfig, { ready: true }>,
  deps: VoiceClientEngineDeps = {},
  onNotice?: (message: string) => void,
): VoiceClientEngine {
  const loadOrt = deps.loadOrt ?? importOrt;
  const env: VoiceModelCacheEnv = { ...workerCacheEnv(), ...deps.cacheEnv };
  const spec = modelSpec(config);
  const buildId = spec.buildId;

  let state: EngineState = { kind: 'unloaded' };
  /** The load in flight, so two concurrent callers pay for one download rather than two. */
  let inFlight: Promise<ReadyState> | null = null;

  const load = async (onProgress?: (progress: VoiceModelProgress) => void): Promise<ReadyState> => {
    const model = await loadVoiceModel({
      spec,
      env,
      ...(onProgress === undefined ? {} : { onProgress }),
    });
    if (model.degraded !== null) onNotice?.(model.degraded);

    const meta = parseOnnxMetadata(model.modelBytes);
    const mismatch = metadataMismatch(meta);
    if (mismatch !== null) throw new Error(mismatch);

    const negMean = Float32Array.from((meta.neg_mean as string).split(',').map(Number));
    const invStddev = Float32Array.from((meta.inv_stddev as string).split(',').map(Number));
    const tokens = await loadTokens(config, env);

    const ort = await loadOrt(config.ortScriptUrl);
    ort.env.wasm.numThreads = wasmThreadCount();
    ort.env.wasm.simd = true;
    ort.env.wasm.wasmPaths = config.ortWasmPaths;

    const session = await ort.InferenceSession.create(new Uint8Array(model.modelBytes), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    return { kind: 'ready', ort, session, tokens, negMean, invStddev, buildId };
  };

  const statusOf = (): AsrRuntimeStatus => {
    switch (state.kind) {
      case 'ready':
        return { available: true, state: 'ready', buildId };
      case 'loading':
        return { available: true, state: 'starting', buildId };
      case 'unloaded':
        return { available: true, state: 'stopped', buildId };
      case 'failed':
        return { available: false, state: 'unavailable', reason: state.reason };
    }
  };

  /**
   * The session, paying for the one load if it has not been paid for; throws the load's own reason.
   *
   * THE IN-FLIGHT PROMISE IS THE `loading` STATE, rather than a flag beside it. Two callers can reach
   * here at once — a `run` arriving while an `init` is still downloading — and the thing they must
   * share is the promise, not a boolean: a second `load()` would fetch 239 MB a second time, and the
   * promise is what lets the second caller await the first one's work and get its result.
   */
  const ensureSession = async (onProgress?: (progress: VoiceModelProgress) => void): Promise<ReadyState> => {
    if (state.kind === 'ready') return state;
    if (state.kind === 'failed') throw new Error(state.reason);
    if (inFlight !== null) return inFlight;

    state = { kind: 'loading' };
    const attempt = load(onProgress);
    inFlight = attempt.then(
      (loaded) => {
        state = loaded;
        inFlight = null;
        return loaded;
      },
      (error: unknown) => {
        state = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
        inFlight = null;
        throw error;
      },
    );
    return inFlight;
  };

  return {
    status: statusOf,

    async ensureReady(): Promise<AsrRuntimeStatus> {
      try {
        await ensureSession();
      } catch {
        // The reason is already in `state`; a caller of `ensureReady` is asking what happened, not
        // asking to handle a throw, so the answer is the status either way.
      }
      return statusOf();
    },

    async transcribe(request: WasmEngineRequest): Promise<WasmEngineAnswer> {
      // `request.timeoutMs` is deliberately not read here. The deadline belongs to the main thread,
      // which is the only side that can abandon a run without killing the session that owns the model.
      let ready: ReadyState;
      try {
        ready = await ensureSession();
      } catch (error) {
        return {
          ok: false,
          code: 'ENGINE_UNAVAILABLE',
          message: error instanceof Error ? error.message : String(error),
        };
      }

      // Copied into a buffer this module owns: `parseWav` takes an `ArrayBuffer`, and the port's
      // `bytes` is a view whose backing store the caller may have typed as shared.
      const clip = new Uint8Array(request.bytes);
      let wav: ReturnType<typeof parseWav>;
      try {
        wav = parseWav(clip.buffer);
      } catch (error) {
        return {
          ok: false,
          code: 'AUDIO_REJECTED',
          message: `the clip could not be read as a 16-bit PCM WAV: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (wav.sampleRate !== VOICE_CLIENT_SAMPLE_RATE) {
        return {
          ok: false,
          code: 'AUDIO_REJECTED',
          message:
            `the clip is ${wav.sampleRate} Hz; the on-device front end only accepts `
            + `${VOICE_CLIENT_SAMPLE_RATE} Hz, and resampling is the caller's job (prepareSixteenKhzWav)`,
        };
      }

      const startedAt = Date.now();
      const features = fbank(wav.samples);
      const stacked = lfrCmvn(features.data, features.frames, features.bins, ready.negMean, ready.invStddev);

      const feeds: Record<string, OrtTensor> = {
        x: new ready.ort.Tensor('float32', stacked.data, [1, stacked.frames, stacked.dim]),
        x_length: new ready.ort.Tensor('int32', Int32Array.from([stacked.frames]), [1]),
        // The model's language slot, in the encoding the probe used: 0 means "let the model decide".
        language: new ready.ort.Tensor('int32', Int32Array.from([0]), [1]),
        // The model's text-normalisation slot; 14 is the value the probe shipped and the one its
        // readings were taken with, so a change here would invalidate every recorded token.
        text_norm: new ready.ort.Tensor('int32', Int32Array.from([14]), [1]),
      };

      let outputs: Record<string, OrtTensor>;
      try {
        outputs = await ready.session.run(feeds);
      } catch (error) {
        return {
          ok: false,
          code: 'ENGINE_UNAVAILABLE',
          message: `the on-device runtime failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const latencyMs = Date.now() - startedAt;

      // The model has one output; taking the first key rather than naming it is what the probe did and
      // what survives an export that renames it. An empty output map is a runtime that answered
      // nothing, which is named rather than decoded from an empty array.
      const first = Object.keys(outputs)[0];
      const logits = first === undefined ? undefined : outputs[first]?.data;
      if (!(logits instanceof Float32Array)) {
        return {
          ok: false,
          code: 'ENGINE_UNAVAILABLE',
          message: 'the on-device runtime returned no float32 logits',
        };
      }

      // The token list and the model must agree about the vocabulary, and this is the only reading
      // where both are in hand. `decodeLogits` slices the model's output by the TOKEN COUNT, so a
      // tokens.txt that is short or long would silently mis-slice the logits into a plausible-looking
      // sentence; comparing the two here turns that into a named failure instead.
      const vocab = ready.tokens.length;
      if (vocab === 0 || logits.length % vocab !== 0 || logits.length / vocab !== stacked.frames + 4) {
        return {
          ok: false,
          code: 'ENGINE_UNAVAILABLE',
          message:
            `the model output (${logits.length} values) does not match ${vocab} tokens over `
            + `${stacked.frames} frames; the tokens file and the checkpoint are not a pair`,
        };
      }

      const decoded = decodeLogits(logits, stacked.frames, ready.tokens);
      const text = decoded.text.trim();
      if (text === '') {
        return { ok: false, code: 'NO_SPEECH_DETECTED', message: 'no speech was recognised in the clip' };
      }

      const tokens: AsrToken[] = decoded.tokens.map((token) => ({
        text: token.tok,
        confidence: token.p,
        // The LFR index times the stacked-frame length; see `VOICE_CLIENT_LFR_FRAME_MS`.
        startMs: token.t * VOICE_CLIENT_LFR_FRAME_MS,
      }));

      return { ok: true, text, tokens, buildId: ready.buildId, latencyMs };
    },
  };
}

/**
 * Whether the checkpoint's `metadata_props` carry what this pipeline needs — the sentence naming the
 * first thing that is wrong, or null.
 *
 * The values arrive as strings (see `parseOnnxMetadata`), so each check parses before comparing rather
 * than testing truthiness: `'0'` is a string that is not false, and a metadata block that declared a
 * zero-length CMVN vector would otherwise sail through. The LFR window is checked because `lfrCmvn`
 * implements exactly one window — 7 frames every 6 — and a checkpoint that declared another would be
 * fed a stacking it was not trained on, silently.
 */
function metadataMismatch(meta: Record<string, string | null>): string | null {
  for (const key of ['neg_mean', 'inv_stddev', 'lfr_window_size', 'lfr_window_shift'] as const) {
    const value = meta[key];
    if (value === null || value === undefined || value.trim() === '') {
      return `the checkpoint carries no '${key}' metadata; it is not the model this engine implements`;
    }
  }

  if (Number(meta.lfr_window_size) !== VOICE_CLIENT_LFR_WINDOW_SIZE) {
    return (
      `the checkpoint declares an LFR window size of ${String(meta.lfr_window_size)}; this engine `
      + `implements ${VOICE_CLIENT_LFR_WINDOW_SIZE}`
    );
  }
  if (Number(meta.lfr_window_shift) !== VOICE_CLIENT_LFR_WINDOW_SHIFT) {
    return (
      `the checkpoint declares an LFR window shift of ${String(meta.lfr_window_shift)}; this engine `
      + `implements ${VOICE_CLIENT_LFR_WINDOW_SHIFT}`
    );
  }

  const neg = (meta.neg_mean as string).split(',');
  const inv = (meta.inv_stddev as string).split(',');
  const expected = VOICE_CLIENT_LFR_WINDOW_SIZE * VOICE_CLIENT_FBANK_BINS;
  if (neg.length !== expected || inv.length !== expected) {
    return (
      `the checkpoint's CMVN vectors are ${neg.length}/${inv.length} values; this engine's `
      + `${VOICE_CLIENT_LFR_WINDOW_SIZE}-frame window over ${VOICE_CLIENT_FBANK_BINS} bins needs ${expected}`
    );
  }
  if (neg.some((value) => !Number.isFinite(Number(value)))) {
    return "the checkpoint's neg_mean vector is not all numbers";
  }
  if (inv.some((value) => !Number.isFinite(Number(value)))) {
    return "the checkpoint's inv_stddev vector is not all numbers";
  }
  return null;
}

/**
 * The token list, from the cache when it is there and the network when it is not.
 *
 * WHY THIS IS NOT `loadVoiceModel`. That function exists to make a 239 MB download verifiable and
 * observable; the token list is tens of kilobytes, so the same machinery would be all cost and no
 * benefit. What it DOES share is the cache bucket, so one `clearVoiceClientModel` empties both and a
 * deployment that moves the file gets a fresh read rather than a stale one (the key is the URL).
 *
 * The line format is the file's own: `<symbol> <id>`, one per line. The symbol is everything before
 * the LAST space, because these symbols contain spaces — a SentencePiece piece that starts mid-word is
 * a bare space, and taking the first space would truncate every one of them.
 */
async function loadTokens(
  config: Extract<VoiceClientAsrConfig, { ready: true }>,
  env: VoiceModelCacheEnv,
): Promise<string[]> {
  const text = (await readCachedTokens(config.tokensUrl, env)) ?? (await fetchTokens(config.tokensUrl, env));
  const tokens = parseTokens(text);
  if (tokens.length === 0) throw new Error('the token list is empty');
  return tokens;
}

/** The cache bucket's key for the token list: same bucket as the model, keyed by its own URL. */
export function tokensCacheKey(url: string): string {
  return `/voice-client-asr/tokens/${url}`;
}

/** The cached token list, or null when there is none. A cache that fails is a cache miss, not an error. */
async function readCachedTokens(url: string, env: VoiceModelCacheEnv): Promise<string | null> {
  if (env.cachesImpl === null) return null;
  try {
    const store = await env.cachesImpl.open(VOICE_CLIENT_MODEL_CACHE_NAME);
    const entry = await store.match(tokensCacheKey(url));
    if (entry === undefined) return null;
    const text = await entry.arrayBuffer().then((buffer) => new TextDecoder().decode(buffer));
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/** Fetches the token list, storing it in the same bucket when it can. */
async function fetchTokens(url: string, env: VoiceModelCacheEnv): Promise<string> {
  const response = await env.fetchImpl(url);
  if (!response.ok) {
    throw new Error(`the token list could not be fetched: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  if (env.cachesImpl !== null) {
    try {
      const store = await env.cachesImpl.open(VOICE_CLIENT_MODEL_CACHE_NAME);
      await store.put(tokensCacheKey(url), new Response(text));
    } catch {
      // A token list that cannot be cached is re-fetched next visit and nothing else degrades: the
      // model, which is the expensive one, has its own path and reports its own degradation sentence.
    }
  }
  return text;
}

/** Splits the token file into its symbols, dropping blank lines and the trailing id. */
export function parseTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const at = line.lastIndexOf(' ');
    if (at <= 0) continue;
    tokens.push(line.slice(0, at));
  }
  return tokens;
}

// ── the worker body ──────────────────────────────────────────────────────────────────────────

/**
 * Serves the protocol until the scope goes away.
 *
 * ONE ENGINE PER WORKER, built on the first message that needs it, because the model load is the
 * expensive thing and there is nothing to gain from a second copy of it. A refusal is posted, never
 * thrown: a worker that threw would take its own global down and the main thread would see a dead port
 * rather than the reason.
 */
export function startVoiceClientAsrWorker(
  scope: VoiceClientWorkerScope,
  deps: VoiceClientEngineDeps = {},
): void {
  const config = readVoiceClientAsrConfig();
  const missing = config.ready ? null : config.missing;
  const engine: VoiceClientEngine | null = config.ready
    ? createVoiceClientEngine(config, deps, (message) => {
        // Notices are posted against the request in flight; `0` is the "no particular request" id,
        // which the main thread's handler routes to `onNotice`. A degradation during a `run` is still
        // about the engine, so it is not worth a correlation to deliver it.
        scope.postMessage({ kind: 'notice', requestId: 0, message });
      })
    : null;

  scope.addEventListener('message', (event) => {
    const request = event.data;
    void (async () => {
      if (missing !== null) {
        const reason = missingConfigReason(missing);
        scope.postMessage(
          request.kind === 'status'
            ? { kind: 'status', requestId: request.requestId, status: { available: false, state: 'unavailable', reason } }
            : { kind: 'answer', requestId: request.requestId, answer: { ok: false, code: 'ENGINE_UNAVAILABLE', message: reason } },
        );
        return;
      }
      if (engine === null) return;

      if (request.kind === 'status') {
        scope.postMessage({ kind: 'status', requestId: request.requestId, status: engine.status() });
        return;
      }

      if (request.kind === 'init') {
        // Progress is reported against the init request, so the panel can show the download moving.
        // A `run` that pays the load reports nothing, because the caller that skipped `init` has
        // nowhere to show it.
        scope.postMessage({ kind: 'status', requestId: request.requestId, status: await engine.ensureReady() });
        return;
      }

      const answer = await engine.transcribe({
        bytes: new Uint8Array(request.bytes),
        mimeType: 'audio/wav',
        fileName: 'segment.wav',
        ...(request.durationSec === undefined ? {} : { durationSec: request.durationSec }),
        // Not read by the engine: the deadline is the main thread's (see `createVoiceClientAsrEngine`).
        timeoutMs: 0,
      });
      scope.postMessage({ kind: 'answer', requestId: request.requestId, answer });
    })();
  });
}

/**
 * This module's global, when that global is a worker's.
 *
 * THE PREDICATE IS `importScripts`, because it is the one name that exists in every worker scope and
 * nowhere else: a page has `postMessage` and `addEventListener` too, and Node's global has neither a
 * `document` to rule it out reliably nor a version-stable `self`. Module workers have the function
 * defined even though calling it throws, which is exactly the marker wanted here — "this is a worker"
 * rather than "this worker can load classic scripts".
 *
 * THE NAME IS NOT SPELLED `WorkerGlobalScope` because it is not in the DOM lib this config compiles
 * against (it lives in the webworker lib, which this front end must not pull in wholesale: it
 * redeclares half the DOM's globals).
 */
function workerScopeGlobal(): VoiceClientWorkerScope | null {
  const global = globalThis as unknown as VoiceClientWorkerScope & { importScripts?: unknown };
  if (typeof global.importScripts !== 'function') return null;
  if (typeof global.postMessage !== 'function' || typeof global.addEventListener !== 'function') return null;
  return global;
}

/** Whether this module is being evaluated inside a worker, rather than on a page. */
export function inWorkerScope(): boolean {
  return workerScopeGlobal() !== null;
}

// The self-start. Guarded rather than conditional-compiled, so there is one module and the main
// thread's import of it is inert.
const hostScope = workerScopeGlobal();
if (hostScope !== null) startVoiceClientAsrWorker(hostScope);

// ── the main thread: the audio, prepared ─────────────────────────────────────────────────────

/**
 * The clip the worker will accept: a 16 kHz mono 16-bit PCM WAV.
 *
 * WHY THE MAIN THREAD DOES THIS. `decodeVoiceBlob` goes through WebAudio's `decodeAudioData`, which is
 * a page API — a worker cannot decode an arbitrary container — and the recorder's segments are exactly
 * that: webm/opus at the capture rate. So the main thread decodes, resamples with the same
 * anti-aliased `downsampleVoice` the upload path uses, and re-encodes as PCM WAV, the one container
 * the worker parses.
 *
 * THE FAST PATH IS NOT AN OPTIMISATION FOR ITS OWN SAKE. A clip that is already 16 kHz PCM WAV — a
 * picked file, or a re-run of a prepared segment — costs one `parseWav` and no WebAudio at all; and
 * going through `decodeAudioData` there would resample 16 kHz up to the context's 48 kHz and back, so
 * the fast path is also the one that spends no resamples on audio that needed none.
 *
 * A clip that cannot be decoded at all is `AUDIO_REJECTED`, the port's own code for "these bytes are
 * not audio this engine can read" — and the caller's routing keeps that answer on the client, since a
 * server would refuse the same container.
 */
export async function prepareSixteenKhzWav(blob: Blob): Promise<WasmEngineAnswer | ArrayBuffer> {
  const raw = await blob.arrayBuffer();
  try {
    if (parseWav(raw).sampleRate === VOICE_CLIENT_SAMPLE_RATE) return raw;
  } catch {
    // Not a WAV this module can read as-is; fall through to the decoder.
  }

  const decoded = await decodeVoiceBlob(blob);
  if (decoded === null) {
    return { ok: false, code: 'AUDIO_REJECTED', message: 'the recording could not be decoded into audio' };
  }
  const resampled = downsampleVoice(decoded.samples, decoded.sampleRate, UPLOAD_SAMPLE_RATE);
  return encodeWavBlob(resampled.samples, resampled.sampleRate).arrayBuffer();
}

/** Whether a preparation result is a refusal rather than bytes. */
function isRefusal(prepared: WasmEngineAnswer | ArrayBuffer): prepared is WasmEngineAnswer {
  return !(prepared instanceof ArrayBuffer);
}

// ── the main thread: the port ────────────────────────────────────────────────────────────────

/**
 * The engine's reporting sinks, as a mutable record.
 *
 * WRITABLE RATHER THAN COPIED OUT OF THE OPTIONS, because the engine is installed once and observed by
 * whoever cares at the time: the availability hook installs it while the settings panel is the party
 * that can show a download moving, and a memoised installer that kept only the FIRST caller's
 * callbacks would silently drop the one that had somewhere to put them. The fields are
 * `| undefined` rather than optional so this record can be assigned to and mutated freely.
 */
type Observers = {
  onProgress: ((progress: VoiceModelProgress) => void) | undefined;
  onNotice: ((message: string) => void) | undefined;
};

/** What the main thread's port needs, injected so the whole proxy is testable without a worker. */
export type VoiceClientEngineOptions = {
  /** Spawns the worker. Defaults to the module-worker spawn below. */
  spawn?: () => VoiceClientWorkerHandle;
  /** Receives the engine's non-fatal notices (today: the cache degradation sentences). */
  onNotice?: (message: string) => void;
  /** Receives model-download progress, for the panel that shows it. */
  onProgress?: (progress: VoiceModelProgress) => void;
  /** Reads the deployment configuration; defaults to `readVoiceClientAsrConfig`. */
  readConfig?: () => VoiceClientAsrConfig;
  /** Prepares the audio for the worker; defaults to `prepareSixteenKhzWav`. */
  prepare?: (blob: Blob) => Promise<WasmEngineAnswer | ArrayBuffer>;
};

/**
 * The default spawn: a module worker built from THIS file.
 *
 * The URL is a literal next to `import.meta.url`, which is the shape Vite's worker plugin recognises
 * and emits as a second entry chunk. It points at this same module on purpose — the worker's own body
 * is what `startVoiceClientAsrWorker` installs when it finds itself in a worker scope — so the two
 * ends of the protocol are compiled from one source and cannot drift.
 *
 * Called lazily, on the first request that needs it, so importing this module on a page with no
 * on-device recogniser configured never pays for a worker.
 */
function spawnVoiceClientAsrWorker(): VoiceClientWorkerHandle {
  return new Worker(new URL('./voiceClientAsrWorker.ts', import.meta.url), { type: 'module' });
}

type PendingRun = {
  resolve: (answer: WasmEngineAnswer) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * The main thread's end: a `WasmEnginePort` that speaks to the worker.
 *
 * WHAT THIS LAYER IS FOR, given the worker already implements the port. Three things the worker cannot
 * do for itself: prepare the audio (WebAudio is a page API), hold the CALLER'S deadline for one
 * request, and keep a status the UI can read synchronously without a round trip. So this is a thin
 * adapter — not a second engine — and its state is deliberately just a belief, fed by the worker's own
 * replies: `stopped` before a load is asked for, `starting` while one is in flight, `ready` once it
 * says so, `unavailable` with the worker's own sentence when it says that instead.
 */
export function createVoiceClientAsrEngine(
  options: VoiceClientEngineOptions = {},
): WasmEnginePort & { observers: Observers } {
  const readConfig = options.readConfig ?? readVoiceClientAsrConfig;
  const prepare = options.prepare ?? prepareSixteenKhzWav;
  const observers: Observers = { onProgress: options.onProgress, onNotice: options.onNotice };
  const config = readConfig();

  if (!config.ready) {
    // The unconfigured port is observed by nobody: there is no download to report and its one answer
    // is the same sentence every time.
    return { ...unavailableEngine(missingConfigReason(config.missing)), observers };
  }

  const buildId = voiceClientAsrBuildId();
  const spawn = options.spawn ?? spawnVoiceClientAsrWorker;
  let worker: VoiceClientWorkerHandle | null = null;
  let state: AsrRuntimeStatus = { available: true, state: 'stopped', buildId };
  let nextRequestId = 1;
  const runs = new Map<number, PendingRun>();
  const statusWaiters = new Map<number, () => void>();

  const ensureWorker = (): VoiceClientWorkerHandle => {
    if (worker !== null) return worker;
    const spawned = spawn();
    spawned.addEventListener('message', (event) => {
      const reply = event.data;
      if (reply.kind === 'progress') {
        observers.onProgress?.(reply.progress);
        return;
      }
      if (reply.kind === 'notice') {
        observers.onNotice?.(reply.message);
        return;
      }
      if (reply.kind === 'status') {
        state = reply.status;
        statusWaiters.get(reply.requestId)?.();
        statusWaiters.delete(reply.requestId);
        return;
      }
      const waiting = runs.get(reply.requestId);
      if (waiting === undefined) return;
      runs.delete(reply.requestId);
      if (waiting.timer !== undefined) clearTimeout(waiting.timer);
      waiting.resolve(reply.answer);
    });
    worker = spawned;
    return spawned;
  };

  return {
    status: () => state,

    ensureReady(): Promise<AsrRuntimeStatus> {
      return (async () => {
        const target = ensureWorker();
        state = { available: true, state: 'starting', buildId };
        const requestId = nextRequestId++;
        await new Promise<void>((resolve) => {
          // The waiter is keyed by request id, so two concurrent `ensureReady` calls cannot resolve
          // each other's promise — and there is deliberately no deadline, because the load this call
          // exists for is a 239 MB download the user is watching a progress line for.
          statusWaiters.set(requestId, resolve);
          target.postMessage({ kind: 'init', requestId });
        });
        return state;
      })();
    },

    transcribe(request: WasmEngineRequest): Promise<WasmEngineAnswer> {
      return (async () => {
        // Copied for the same reason the worker copies the clip: a `Blob` part must be backed by a
        // plain `ArrayBuffer`, and the port's view does not promise one.
        const blob = new Blob([new Uint8Array(request.bytes)], { type: request.mimeType });
        const prepared = await prepare(blob);
        if (isRefusal(prepared)) return prepared;

        const target = ensureWorker();
        // A run may pay the model load, so a main thread that believed the engine was `stopped` now
        // reports a start. A `ready` engine keeps its reading, which is the truthful one.
        if (state.available && state.state === 'stopped') {
          state = { available: true, state: 'starting', buildId };
        }

        const requestId = nextRequestId++;
        return await new Promise<WasmEngineAnswer>((resolve) => {
          const timer =
            request.timeoutMs > 0
              ? setTimeout(() => {
                  // The worker's run is NOT cancelled — WASM inference cannot be interrupted from
                  // outside — so the reply is discarded by request id instead. The slot is freed here
                  // so a late answer cannot resolve a request that has already given up.
                  runs.delete(requestId);
                  state = {
                    available: false,
                    state: 'unavailable',
                    reason:
                      `the on-device recogniser did not answer within ${request.timeoutMs} ms; `
                      + 'the clip was not recognised on this device',
                  };
                  resolve({
                    ok: false,
                    code: 'ENGINE_UNAVAILABLE',
                    message: `the on-device recogniser did not answer within ${request.timeoutMs} ms`,
                  });
                }, request.timeoutMs)
              : undefined;
          runs.set(requestId, { resolve, timer });
          target.postMessage({
            kind: 'run',
            requestId,
            bytes: prepared,
            ...(request.durationSec === undefined ? {} : { durationSec: request.durationSec }),
          });
        });
      })();
    },

    observers,
  };
}

/** A port for a tab that cannot run the model: every answer is the same fail-closed sentence. */
function unavailableEngine(reason: string): WasmEnginePort {
  const status: AsrRuntimeStatus = { available: false, state: 'unavailable', reason };
  return {
    status: () => status,
    ensureReady: async () => status,
    transcribe: async () => ({ ok: false, code: 'ENGINE_UNAVAILABLE', message: reason }),
  };
}

// ── the composition root ─────────────────────────────────────────────────────────────────────

/**
 * Installs this tab's engine on the adapter, once.
 *
 * MEMOISED AND IDEMPOTENT because its caller is a React hook: a hook body runs on every render, and
 * installing a fresh engine each time would leak a worker per render. The adapter reads the port
 * through a module-level slot, so this is the one write that makes `sensevoice-wasm` answerable at all.
 *
 * It is called by the hook that first needs the client path rather than at import: a page that never
 * selects this provider never spawns a worker, and a test that installs its own fake engine is not
 * fighting a real one installed behind its back.
 */
let installedEngine: (WasmEnginePort & { observers: Observers }) | null = null;

export function installVoiceClientAsrEngine(options: VoiceClientEngineOptions = {}): WasmEnginePort {
  if (installedEngine === null) {
    installedEngine = createVoiceClientAsrEngine(options);
    installWasmEngine(installedEngine);
  }
  return installedEngine;
}

/** The installed engine, or null. Exported so a caller can read its status without installing one. */
export function voiceClientAsrEngine(): WasmEnginePort | null {
  return installedEngine;
}

/**
 * Points the installed engine's progress and notice reporting at a caller, whenever that caller shows
 * up.
 *
 * SEPARATE FROM `installVoiceClientAsrEngine` BECAUSE THE TWO HAPPEN AT DIFFERENT TIMES. The engine is
 * installed by the first consumer that needs the recogniser to answer (the availability hook, on page
 * load); the consumer that can SHOW a download moving is the settings panel, which mounts later and
 * may not be open at all. Making the sinks addressable afterwards is what lets the requirement that a
 * first download be visible be met by whoever is in a position to meet it, instead of being lost to
 * whichever caller happened to install first.
 */
export function observeVoiceClientAsrEngine(observers: {
  onProgress?: (progress: VoiceModelProgress) => void;
  onNotice?: (message: string) => void;
}): void {
  if (installedEngine === null) return;
  if (observers.onProgress !== undefined) installedEngine.observers.onProgress = observers.onProgress;
  if (observers.onNotice !== undefined) installedEngine.observers.onNotice = observers.onNotice;
}

// ── the routing policy ───────────────────────────────────────────────────────────────────────

/**
 * The event a fallback announces, dispatched on `window`.
 *
 * WHY AN EVENT AND NOT A RETURN VALUE ALONE. The caller that routes the segment gets the reason back
 * and can act on it, but the fact the user needs — "that clip was recognised by a server, not by your
 * device" — outlives the call: it belongs next to the transcript, in a log, on a metrics counter. A
 * `CustomEvent` on `window` is the one channel all three can tap without this module importing any of
 * them, which keeps the policy free of UI.
 */
export const CLIENT_ASR_FALLBACK_EVENT = 'voice-client-asr:fallback';

/**
 * The realtime factor at which a segment is considered too slow to keep on the device.
 *
 * ONE, i.e. recognition that takes longer than the audio it recognised. Not a tuning knob picked for
 * feel: a client recogniser that cannot keep up with real time will fall further behind with every
 * segment, so the queue never drains and the user waits for a transcript of a conversation that ended
 * minutes ago. The probe's §0.7 records this as a design requirement rather than a measured
 * conclusion, and this is the threshold that implements it.
 */
export const VOICE_CLIENT_RTF_THRESHOLD = 1;

/** The shortest deadline a client-side segment may be given; see `clientAsrSegmentTimeoutMs`. */
export const VOICE_CLIENT_SEGMENT_TIMEOUT_FLOOR_MS = 30_000;

/**
 * The deadline one client-side segment is given, from its own length.
 *
 * TEN TIMES REAL TIME, with a floor for very short clips. The multiple is above the RTF threshold on
 * purpose: a segment that is merely slow must come back as an ANSWER so the routing can measure it and
 * fall back with a number in hand, and a deadline that fired first would turn that measurement into a
 * generic "the engine did not answer". What the deadline is actually for is the other failure — a
 * worker that hung, or a run that will never finish — where giving up and taking the clip to the
 * server is strictly better than a composer that waits forever.
 */
export function clientAsrSegmentTimeoutMs(durationSec: number): number {
  return Math.max(VOICE_CLIENT_SEGMENT_TIMEOUT_FLOOR_MS, durationSec * 10_000);
}

/** Why a segment left the device. */
export type VoiceClientFallbackReason = 'engine-unavailable' | 'segment-too-slow';

/** What the fallback event carries. */
export type VoiceClientFallbackDetail = {
  providerId: string;
  reason: VoiceClientFallbackReason;
  /** The engine's own sentence, or the measurement that tripped the threshold. */
  message: string;
  segmentIndex?: number;
  durationSec?: number;
  latencyMs?: number;
};

/**
 * Where a segment ended up.
 *
 * `client` CARRIES THE RESULT, SUCCESS OR FAILURE. A failure the client produced —
 * `NO_SPEECH_DETECTED` from the model, `AUDIO_REJECTED` for a container it cannot read, `OVERSIZE` for
 * a request past its budget — is an ANSWER, and re-asking a server would either get the same answer or,
 * worse, succeed where the user asked for the audio to stay put. Only the two named reasons leave the
 * device.
 */
export type VoiceClientRoute =
  | { to: 'client'; result: AsrResult }
  | { to: 'server'; reason: VoiceClientFallbackReason; message: string };

/** The default announcement: a `CustomEvent` on `window`, carrying the detail above. */
export function emitClientAsrFallback(detail: VoiceClientFallbackDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<VoiceClientFallbackDetail>(CLIENT_ASR_FALLBACK_EVENT, { detail }));
}

/** What one routing decision is made from. */
export type VoiceClientRouteInput = {
  request: AsrRequest;
  invocation: AsrInvocation;
  /** The segment's own length, for the realtime-factor reading. */
  durationSec: number;
  segmentIndex?: number;
  /** Where the fallback is announced; defaults to `emitClientAsrFallback` on `window`. */
  emit?: (detail: VoiceClientFallbackDetail) => void;
};

/**
 * Recognise one segment on the device, and say so if it does not stay there.
 *
 * THE TWO TRIGGERS, AND WHY THERE ARE ONLY TWO. `engine-unavailable` is the adapter's own fail-closed
 * answer — no engine installed, no configuration, a browser that cannot run WASM, a model that did not
 * verify, a runtime that threw, a run the caller gave up on. `segment-too-slow` is the measurement
 * above. Everything else the adapter can say is a result, and a result is kept. That is the whole
 * policy, and it is deliberately small: a policy with more branches is a policy whose behaviour on a
 * given clip a reader cannot predict.
 *
 * THE FALLBACK IS ANNOUNCED BEFORE THIS FUNCTION RETURNS, so a listener sees it in the same turn the
 * caller learns of it — the caller's own retry to the server starts after, never before, the interface
 * has been told.
 */
export async function routeClientAsrSegment(input: VoiceClientRouteInput): Promise<VoiceClientRoute> {
  const emit = input.emit ?? emitClientAsrFallback;

  const fallback = (
    reason: VoiceClientFallbackReason,
    message: string,
    latencyMs?: number,
  ): VoiceClientRoute => {
    emit({
      providerId: wasmProviderId,
      reason,
      message,
      ...(input.segmentIndex === undefined ? {} : { segmentIndex: input.segmentIndex }),
      durationSec: input.durationSec,
      ...(latencyMs === undefined ? {} : { latencyMs }),
    });
    return { to: 'server', reason, message };
  };

  const result = await wasmTranscribe(input.request, input.invocation);
  if (!result.ok) {
    // Only the fail-closed code leaves the device. Every other failure is an answer about THIS clip.
    if (result.code === 'ENGINE_UNAVAILABLE') return fallback('engine-unavailable', result.message);
    return { to: 'client', result };
  }

  const latencyMs = result.meta?.latencyMs;
  if (
    latencyMs !== undefined
    && input.durationSec > 0
    && latencyMs > input.durationSec * 1000 * VOICE_CLIENT_RTF_THRESHOLD
  ) {
    return fallback(
      'segment-too-slow',
      `recognising ${input.durationSec.toFixed(1)} s of audio took ${latencyMs} ms on this device`,
      latencyMs,
    );
  }

  return { to: 'client', result };
}
