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
import {
  capabilities as openaiCompatibleCapabilities,
  id as openaiCompatibleId,
  transcribe as openaiCompatibleTranscribe,
} from './list/openai-compatible/openai-compatible.asr-provider.js';

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
  meta?: {
    model?: string;
    latencyMs?: number;
    usage?: Record<string, number>;
    /**
     * Which version of a recogniser's own frozen prompt produced this text, for the services that
     * carry one (`dashscope-omni`). A value the adapter holds, not a derivation: the point of
     * recording it is that a prompt which changed on purpose can be told apart in a reading from
     * one that changed by accident.
     */
    promptVersion?: string;
    /**
     * Set to `1` when a `style: 'written'` recogniser could not produce its rewrite and returned
     * the transcription instead.
     *
     * WHY THIS IS A FIELD AND NOT A STYLE. The result is genuinely verbatim — the text is the
     * words as they were spoken, `style` and `transformations` say so — but "the service did not do
     * what it was asked" is exactly the kind of thing a caller must be able to notice without
     * diffing the text, and the UI and the metrics select on it (ADR-004 decision 5's envelope
     * carries `style` for what the text IS, this for why). Absent means the rewrite happened.
     *
     * A number rather than a boolean so a future second degradation reason has somewhere to go
     * without changing this field's type under callers that already read it.
     */
    writtenFallback?: number;
  };
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

/**
 * The request shape an adapter speaks, as a name the contract suite can select its expectations by.
 *
 * WHY THIS IS DECLARED RATHER THAN SNIFFED OFF THE REQUEST. A probe that read the shape off the
 * recorded request would score an adapter against whatever it happened to send, which is the one
 * thing a contract check must not do: an adapter that stopped base64-encoding its audio would
 * simply be measured as a different wire and stay green. Declared here, the tag is a CLAIM — the
 * suite pins the request against it, so `wire: 'multipart'` answered by a JSON body is a red
 * reading rather than a silently different set of expectations. It is the same discipline
 * `AsrCapabilities` follows: the table is under test, not documentation.
 *
 *   · `'multipart'` — the shipped `/audio/transcriptions` shape: a `FormData` body carrying the
 *     audio as a file part and the model as a field, the service's own JSON answer read back
 *     (`shared/asr/transcriptionWire.ts`, the single implementation of it).
 *   · `'inline-json'` — the multimodal shape: the audio base64-encoded into a JSON generation
 *     request, the transcript read out of the generation envelope.
 *   · `'chat-audio'` — the chat-completions shape: a JSON chat body whose user turn carries the
 *     recording as an `input_audio` data URI beside a text part, the answer read out of the
 *     assistant turn (`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`). It is the
 *     third shape rather than a variant of the second because neither of the two above can express
 *     it: the form posts no JSON, and the generation request's parts are `inlineData` blocks.
 *
 * OMITTED MEANS `'inline-json'`, and that default is deliberately not a convenience: the tag was
 * added when the second adapter was already registered, and a module that predates the tag speaks
 * the inline shape. Reading an absent tag as anything else would have made that adapter's readings
 * move under a change it did not make.
 */
export type AsrWire = 'chat-audio' | 'inline-json' | 'multipart';

/** What a provider module must supply to be registered. */
export type AsrAdapter = {
  id: AsrProviderId;
  capabilities: AsrCapabilities;
  /** The request shape this adapter speaks. Absent means `'inline-json'` (see `AsrWire`). */
  wire?: AsrWire;
  transcribe(request: AsrRequest, invocation: AsrInvocation): Promise<AsrResult>;
};

// ── the container rule, read off a declaration ───────────────────────────────────────────────

/**
 * The base type of a media type header: everything before the first `;`, trimmed and lower-cased.
 *
 * WHY THE PARAMETERS HAVE TO COME OFF. The browser's preferred recording type is
 * `audio/webm;codecs=opus` — the shipped recorder's own output (ADR-004 §缺口①.3) — while every
 * published figure is a base type. Comparing a raw header against a published list therefore
 * refuses the very recording the app produced, which is a whitelist that rejects its own input.
 * The comparison is case-insensitive for the same reason: `AUDIO/WEBM` is the same container.
 *
 * Both compiler configurations compile this file (see the module comment), so this is written
 * with ES5 string operations only.
 */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Whether `capabilities` declares `mimeType` acceptable, matched on the base type.
 *
 * The declaration is a PARAMETER and not read from this module's registry: the caller has already
 * selected the provider the request will use, and a rule that re-resolved the provider itself
 * could answer about a different one than the request is served by. Every consumer of a
 * declaration — the browser's direct path, the server's proxy path, the adapter's own guard —
 * asks this one function, so "which containers are allowed" has one answer per declaration
 * instead of one per call site.
 *
 * Used by `server/modules/voice/voice.service.ts` (the proxy path) and `src/shared/api.ts` (the
 * browser's direct path), which is what makes one refusal code mean the same thing on both.
 */
export function declaredAcceptsMime(capabilities: AsrCapabilities, mimeType: string): boolean {
  const base = baseMimeType(mimeType);
  // An unlabelled container is not a refused one. `Blob` defaults its type to the empty string, so
  // a file the user picked that carries no media type arrives naming no container at all — and
  // there is nothing for a declaration to be compared against. Refusing it would repeat the fault
  // the base-type match above removes: turning an upload away for something that is not its
  // container. The server's route reads an absent header the same way, defaulting it to
  // `audio/webm` rather than refusing an upload that never made a claim.
  if (!base) {
    return true;
  }

  return capabilities.acceptsMime.indexOf(base) !== -1;
}

// ── the address book ─────────────────────────────────────────────────────────────────────────

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
 *
 * THE SHIPPED RECOGNISER IS FIRST, AND THE ORDER IS LOAD-BEARING RATHER THAN COSMETIC. A
 * deployment that names no provider — the shipped default, since `VOICE_PROVIDER_ID` defaults to
 * the empty string and the user-level configuration carries no provider id — resolves its
 * effective provider as the first row (`server/modules/voice/voice.service.ts`). With only the
 * multimodal adapter registered, that deployment reported itself as `multimodal` while its audio
 * went to the OpenAI-compatible endpoint, so every question asked of "the effective provider" was
 * answered about a service the audio never reached. Registering the shipped recogniser first makes
 * the reported identity and the wire the same thing again; the order is the fix, not a detail of
 * it, which is why it is written here instead of left to the reader.
 */
const REGISTERED: readonly AsrAdapter[] = [
  {
    id: openaiCompatibleId,
    capabilities: openaiCompatibleCapabilities,
    wire: 'multipart',
    transcribe: openaiCompatibleTranscribe,
  },
  {
    id: multimodalId,
    capabilities: multimodalCapabilities,
    wire: 'inline-json',
    transcribe: multimodalTranscribe,
  },
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

// ── the pause-cue declaration, as an identity plus its value ──────────────────────────────────

/**
 * One registered provider's own declaration of what trimming does to its pauses, carrying the
 * provider id beside the value.
 *
 * WHY THE ID TRAVELS WITH THE VALUE. `AsrCapabilities.pauseCues` is a bare value; a caller that
 * carries it around on its own loses which recogniser it was read from, and two abilities read
 * from two providers become two interchangeable strings. Everything downstream that has to say
 * *whose* capability it acted on — a reading, a log line, an error — needs the pair.
 *
 * The field is `capability` rather than a repeat of the capability's name so that the CLIENT side
 * has no text of the form `pauseCues: <value>` anywhere in it: the declaration lives on the
 * provider side (in `AsrCapabilities`), and a client that spelled the vocabulary again — even to
 * re-publish a value it was handed — is the second table this seam exists to not have.
 */
export type PauseCuesDeclaration = {
  provider: AsrProviderId;
  /** The provider's own `AsrCapabilities.pauseCues`, verbatim. */
  capability: AsrCapabilities['pauseCues'];
  /** The paired experiment a non-default value rests on (ADR-004 decision 1). */
  evidence?: string;
};

/**
 * The paired experiment each registered provider's declaration rests on, keyed by provider id.
 *
 * A declared value that is not the shipped default is a CLAIM: ADR-004 decision 1 lets a provider
 * change what gets uploaded, but only on the strength of that provider's own paired measurement,
 * so the record is named beside the declaration rather than left implicit in a commit message.
 * The lookups that read it — `scripts/asr-pause-cues-source-check.mjs` and
 * `scripts/asr-trim-capability-check.mjs` — require the named file to exist.
 *
 * ONE ROW PER PROVIDER, AND NOT THE SAME RECORD TWICE. Decision 1 is an obligation on the provider,
 * so a row that names a record measured against a *different* service satisfies the existence check
 * while leaving the claim itself unmeasured — the check cannot tell the two apart, which is why the
 * distinction has to be kept here. The two rows below name two different runs on purpose: the
 * whisper-family record for the multipart recogniser, and the Gemini record `multimodal` was
 * actually measured in, for the one that declares `pauseCues: 'useful'`.
 */
const PAUSE_CUES_EVIDENCE: Readonly<Record<string, string>> = {
  [openaiCompatibleId]: 'docs/experiments/2026-09-22-voice-provider-paired-quality.md',
  [multimodalId]: 'docs/experiments/2026-09-23-gemini.md',
};

/**
 * The pause-cue declaration of the adapter registered under `providerId`, or `null` when nothing
 * is registered under it.
 *
 * THIS IS A LOOKUP, NOT A TABLE. The value returned is the adapter's own `capabilities.pauseCues`,
 * read off the declaration the adapter module exports, so there is exactly one place a provider's
 * answer to 裁不裁 can be written down and no way for a caller to hold a different one.
 *
 * `null` RATHER THAN A DEFAULT ROW, deliberately, and the difference matters: a default row makes
 * an id nobody registered answerable — a caller that mistyped a provider id, or read one from a
 * version that had since changed, would get the shipped behaviour and never learn it was asking
 * about a provider that does not exist. The caller decides what an unnameable provider means for
 * its own action; for a trim the only safe answer is "do not change the audio".
 */
export function pauseCuesDeclarationFor(providerId: AsrProviderId): PauseCuesDeclaration | null {
  const adapter = tryResolve(providerId);
  if (adapter === null) {
    return null;
  }
  return {
    provider: adapter.id,
    capability: adapter.capabilities.pauseCues,
    evidence: PAUSE_CUES_EVIDENCE[adapter.id],
  };
}
