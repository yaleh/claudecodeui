/**
 * The ASR provider seam: the contract every adapter satisfies, and the address book that hands
 * one out by id.
 *
 * WHY THE CONTRACT AND THE REGISTRY SHARE A FILE. ADR-004 §L1 sketches the contract in its own
 * `shared/asr/asrContract.ts`. That module would be a third file both compiler configurations
 * compile, and it is not part of this task's declared write surface, so the types live here next
 * to the table that hands providers out. Splitting them later is a pure move with no behaviour in
 * it; the ordering that matters is the one this file keeps, which is that a provider cannot be
 * registered without satisfying the contract — the `AsrAdapter` annotation on the table below is
 * what enforces it.
 *
 * TWO COMPILER CONFIGURATIONS COMPILE THIS FILE, and that is a machine property rather than a
 * style choice: the root configuration compiles it with `lib: ES2020 + DOM` and
 * `types: ["vite/client"]`, `server/tsconfig.json` compiles it with `lib: ES2022`, NodeNext and
 * `types: ["node"]`. So it may use neither Node built-ins nor ES2021+ library features, and every
 * environment dependency (fetch, credentials, base URL, model) is injected at the call site
 * rather than read from the environment here. `npm run typecheck` compiling this one file under
 * both configurations is the reading that says so.
 *
 * UNKNOWN IDS ARE FAIL-CLOSED. The id is stored in user-level configuration, so a typo or a
 * version skew makes an unregistered id a reachable state. `resolve` throws rather than falling
 * back to a default provider: a silent fallback's worst case is a user who believes they are
 * transcribing with the service they chose while the previous one answers. `tryResolve` is the
 * non-throwing form for callers that want to report that state instead of catching it.
 */

import {
  capabilities as multimodalCapabilities,
  id as multimodalId,
  transcribe as multimodalTranscribe,
} from './list/multimodal/multimodal.asr-provider.js';

/** A provider id, as it is written in user-level configuration. */
export type AsrProviderId = string;

/**
 * What a recogniser says about itself. Every field corresponds to a measured effect recorded in
 * ADR-004 §二 rather than to a guess about what a future provider might need.
 */
export type AsrCapabilities = {
  /** Accepted container/coding types. Drives the recording container and the upload whitelist. */
  acceptsMime: string[];
  /**
   * The inline budget of ONE REQUEST, in bytes — prompt, context and every file together, not the
   * audio's own size. A multimodal service's published figure is a whole-request maximum, which is
   * why an implementation that sizes the request by its audio alone under-counts: it will send a
   * request the service rejects.
   */
  maxInlineRequestBytes: number;
  /** What happens past that budget. The first version only allows 'reject' (ADR-004 §缺口②.5). */
  oversize: 'reject' | 'files-api';
  /**
   * Which hint parameters the service acknowledges. `false` means "sending it achieves nothing":
   * the adapter must leave it off the wire rather than forward it and hope.
   */
  honors: { prompt: boolean; language: boolean; context: boolean };
  /** Billing unit. Decides how a saved-second reading converts into money. */
  billing: 'audio-seconds' | 'audio-tokens' | 'request';
  /** What trimming does to this recogniser's accuracy: pauses are punctuation cues (ADR-004 §二). */
  pauseCues: 'destructive' | 'neutral' | 'useful';
  /** Output-style ability. A service that can write up its answer declares 'written' (ADR-004 D3). */
  style: 'verbatim' | 'written';
  /** One-shot or streaming. The first version only allows one-shot. */
  oneShot: boolean;
};

/** The audio half of a request. Bytes travel as a `Uint8Array` so the browser and Node agree. */
export type AsrAudio = {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  durationSec?: number;
};

/**
 * The caller's hints. A hint is a request, not an instruction: an adapter puts one on the wire
 * only when its own `honors` declaration says the service acknowledges it.
 */
export type AsrHints = {
  prompt?: string;
  language?: string;
  context?: string;
};

export type AsrRequest = {
  audio: AsrAudio;
  hints?: AsrHints;
};

/** What the recogniser did to the text, so the UI and the metrics can select an axis. */
export type AsrTransformation =
  | 'punctuate'
  | 'de-disfluency'
  | 'written-style'
  | 'markdown'
  | 'identifier-canonicalized'
  | 'self-correction-applied';

/**
 * The semantic error vocabulary. Adapters translate their upstream's transport-level failure into
 * one of these, so the route above them does a mechanical code-to-HTTP mapping instead of
 * re-deriving meaning from a status number that several services use differently.
 */
export type AsrErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_BASE_URL'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UNREACHABLE'
  | 'OVERSIZE'
  | 'UNSUPPORTED_MIME'
  | 'NO_SPEECH_DETECTED'
  | 'UPSTREAM_ERROR';

export type AsrSuccess = {
  ok: true;
  /** Already processed according to `style`; the composer can use it as it stands. */
  text: string;
  style: 'verbatim' | 'written';
  transformations: AsrTransformation[];
  providerId: AsrProviderId;
  meta?: { model?: string; latencyMs?: number; usage?: Record<string, number> };
};

export type AsrFailure = {
  ok: false;
  code: AsrErrorCode;
  message: string;
  status?: number;
};

export type AsrResult = AsrSuccess | AsrFailure;

/**
 * Everything one invocation needs from its environment, injected rather than read. This is what
 * makes the same adapter runnable in the browser's direct path, in the server's proxy path and
 * from the command line — and what makes it testable against a stand-in transport.
 */
export type AsrInvocation = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
};

/** What a provider module must supply to be registered. */
export type AsrAdapter = {
  id: AsrProviderId;
  capabilities: AsrCapabilities;
  transcribe(request: AsrRequest, invocation: AsrInvocation): Promise<AsrResult>;
};

/** Thrown by `resolve` for an id no adapter claims. */
export class UnknownAsrProviderError extends Error {
  readonly providerId: AsrProviderId;

  constructor(providerId: AsrProviderId) {
    super(`no ASR adapter is registered for provider id '${providerId}'`);
    this.name = 'UnknownAsrProviderError';
    this.providerId = providerId;
  }
}

/**
 * Every registered adapter. The `AsrAdapter` annotation is load-bearing: a provider whose
 * capability declaration or `transcribe` signature does not satisfy the contract fails to compile
 * here rather than at the first call.
 */
const REGISTERED: readonly AsrAdapter[] = [
  { id: multimodalId, capabilities: multimodalCapabilities, transcribe: multimodalTranscribe },
];

/** The registered adapters, in registration order. */
export function listProviders(): readonly AsrAdapter[] {
  return REGISTERED;
}

/** The adapter for `providerId`, or `null` when nothing claims it. Never a default. */
export function tryResolve(providerId: AsrProviderId): AsrAdapter | null {
  return REGISTERED.find((adapter) => adapter.id === providerId) ?? null;
}

/** The adapter for `providerId`; throws `UnknownAsrProviderError` when nothing claims it. */
export function resolve(providerId: AsrProviderId): AsrAdapter {
  const adapter = tryResolve(providerId);
  if (adapter === null) throw new UnknownAsrProviderError(providerId);
  return adapter;
}
