/**
 * The transcription seam's contract board: the five invariant groups of ADR-004 §L3(b), written
 * ONCE and driven by both runners.
 *
 * `src/shared/asr/tests/asrContractInvariants.test.ts` drives it as suite readings and
 * `scripts/asr-contract-invariants-check.mjs` drives it as an operator command. Neither holds an
 * invariant of its own: a probe written in the checker and a probe written in the suite would be
 * two implementations of one contract, and a green checker could disagree with a red suite about
 * what "the invariants hold" means.
 *
 * THE BOARD IS PARAMETERISED BY THE REGISTRY, not by a provider list written here. Every group
 * runs against every adapter the caller hands it, so a provider added to `asrRegistry.ts`
 * tomorrow is measured by this file the day it is registered. That is why the group subject is an
 * `AsrAdapter` and not this repository's adapter: the contract is the thing under test, and a
 * board that could only measure one shape could not tell a second shape's declaration from a
 * comment.
 *
 * AN EMPTY BOARD IS NOT A GREEN BOARD. A registry that resolved to zero providers, or a group
 * that produced zero readings, is `empty` — never `pass`. An exit code 0 from a glob that matched
 * nothing is a shape this repository has already paid for, so `readings.length === 0` is scored
 * as loudly as a disagreement is.
 *
 * ENVIRONMENT NEUTRALITY is the same machine property `./asrRegistry.ts` documents: this file is
 * compiled by the root configuration (`lib: ES2020 + DOM`, `types: ["vite/client"]`) AND by
 * `server/tsconfig.json` (`lib: ES2022`, NodeNext, `types: ["node"]`). So it uses no Node built-in
 * and no ES2021+ library feature, and every environment dependency travels in as a parameter.
 * Relative specifiers end in `.js` because NodeNext demands it.
 */
import type {
  AsrAdapter,
  AsrCapabilities,
  AsrErrorCode,
  AsrHints,
  AsrInvocation,
  AsrRequest,
  AsrResult,
} from './asrRegistry.js';

export const INVARIANT_GROUP_IDS = [
  'request-construction',
  'error-mapping',
  'size-layering',
  'redaction',
  'mime-gate',
] as const;

export type InvariantGroupId = (typeof INVARIANT_GROUP_IDS)[number];

/** One measurement, and what it was compared against. */
export type InvariantReading = {
  group: InvariantGroupId;
  /** Stable across runs: `<probe>.<reading>` with the provider appended for per-provider probes. */
  id: string;
  provider: string;
  observed: string;
  expected: string;
  verdict: 'pass' | 'fail';
  /** What the reading asserts and — on a failure — why it disagrees. Never carries a needle. */
  detail: string;
};

export type InvariantGroupVerdict = {
  group: InvariantGroupId;
  verdict: 'pass' | 'fail' | 'unmeasured';
  readings: number;
  /** The ids that disagreed, so "this group is red" reads as *which reading* is red. */
  failing: string[];
};

export type InvariantReport = {
  /** `empty` whenever nothing was measured, including a board with no readings at all. */
  verdict: 'pass' | 'fail' | 'empty';
  groups: InvariantGroupVerdict[];
  readings: InvariantReading[];
  /**
   * Every line a runner would print for this report, already canonicalised: the recorded request
   * reading carries the audio payload as a token, never as bytes, so the board cannot print what
   * the contract says must not leak. The redaction group scans exactly these lines.
   */
  logs: string[];
};

// ── the recorded fixture ─────────────────────────────────────────────────────────────────────

/** The fixture audio is ASCII so its bytes, its text and its encoding are all one recorded fact. */
export const INVARIANT_AUDIO_TEXT = 'ASR-INVARIANT-AUDIO-c41d';

/**
 * The standard base64 of `INVARIANT_AUDIO_TEXT`, computed independently of the adapter's encoder
 * (`python3 -c "import base64; print(base64.b64encode(b'ASR-INVARIANT-AUDIO-c41d').decode())"`).
 * Independent on purpose: a constant copied out of the adapter would agree with a wrong encoder.
 */
export const INVARIANT_AUDIO_BASE64 = 'QVNSLUlOVkFSSUFOVC1BVURJTy1jNDFk';

export const INVARIANT_API_KEY = 'ASR-INVARIANT-KEY-9f3c2b7a';
export const INVARIANT_PROMPT = 'summarise the invoice';
export const INVARIANT_CONTEXT = 'the invariant context';
export const INVARIANT_TRANSCRIPT = 'the invariant transcript';
export const INVARIANT_BASE_URL = 'https://asr.invalid';
export const INVARIANT_MODEL = 'invariant-model';

/** The URL the fixture's base URL and model resolve to, recorded rather than re-derived. */
export const INVARIANT_ENDPOINT = 'https://asr.invalid/v1beta/models/invariant-model:generateContent';

/** The audio payload's canonical form inside a recorded body reading. */
export const INVARIANT_AUDIO_TOKEN = '<AUDIO>';

export type InvariantFixture = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  audioText: string;
  mimeType: string;
  fileName: string;
  prompt: string;
  context: string;
  transcript: string;
};

export const INVARIANT_FIXTURE: InvariantFixture = {
  baseUrl: INVARIANT_BASE_URL,
  model: INVARIANT_MODEL,
  apiKey: INVARIANT_API_KEY,
  timeoutMs: 250,
  audioText: INVARIANT_AUDIO_TEXT,
  // A container with parameters: the gate has to match on the base type, which is the half of
  // `acceptsMime` a naive `indexOf(whole-string)` implementation gets wrong.
  mimeType: 'audio/webm;codecs=opus',
  fileName: 'clip.webm',
  prompt: INVARIANT_PROMPT,
  context: INVARIANT_CONTEXT,
  transcript: INVARIANT_TRANSCRIPT,
};

/** The fixture's audio, as bytes. ASCII, so the text and the bytes are the same recorded fact. */
export function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/** The fixture request: a hinted upload, so "which hints reached the wire" is answerable. */
export function invariantRequest(overrides?: {
  bytes?: Uint8Array;
  mimeType?: string;
  hints?: AsrHints;
}): AsrRequest {
  const fixture = INVARIANT_FIXTURE;
  const hints: AsrHints =
    overrides !== undefined && overrides.hints !== undefined
      ? overrides.hints
      : { prompt: fixture.prompt, context: fixture.context };
  return {
    audio: {
      bytes:
        overrides !== undefined && overrides.bytes !== undefined
          ? overrides.bytes
          : asciiBytes(fixture.audioText),
      mimeType:
        overrides !== undefined && overrides.mimeType !== undefined
          ? overrides.mimeType
          : fixture.mimeType,
      fileName: fixture.fileName,
    },
    hints,
  };
}

/** The service's answer envelope, as this seam's response reader expects it. */
export function envelope(text: string): unknown {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

// ── the injected transport ───────────────────────────────────────────────────────────────────

/**
 * What the transport does when it is reached. The board never touches the network: every probe
 * runs on one of these, so "zero platform fetch" is a property of the run rather than a promise
 * about the adapter.
 */
export type InvariantStep =
  | { kind: 'json'; status?: number; payload: unknown }
  | { kind: 'raw'; status?: number; body: string }
  | { kind: 'reject'; mode: 'transport' | 'timeout' };

/** One request as it was actually written, with the credential reduced to its presence. */
export type RecordedRequest = {
  method: string;
  url: string;
  contentType: string | null;
  /** `present`/`absent` and never the value: a board that recorded the key would leak it itself. */
  authorization: 'present' | 'absent';
  body: string;
};

export type RecordedTransport = {
  calls: number;
  requests: RecordedRequest[];
};

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return null;
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (String(entry[0]).toLowerCase() === wanted) return String(entry[1]);
    }
    return null;
  }
  const asHeaders = headers as { get?: (key: string) => string | null };
  if (typeof asHeaders.get === 'function') {
    const value = asHeaders.get(name);
    return value === null ? null : String(value);
  }
  const record = headers as Record<string, string>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) return String(record[key]);
  }
  return null;
}

function recordRequest(url: string, init: RequestInit | undefined): RecordedRequest {
  const authorization = headerOf(init, 'authorization');
  return {
    method: String(init?.method ?? 'GET'),
    url,
    contentType: headerOf(init, 'content-type'),
    authorization: authorization === null || authorization === '' ? 'absent' : 'present',
    body: typeof init?.body === 'string' ? init.body : '',
  };
}

/** The error an aborted fetch rejects with, built rather than read off a platform object. */
function abortError(): Error {
  const error = new Error('the request was aborted');
  error.name = 'AbortError';
  return error;
}

function responseFor(step: InvariantStep): Response {
  if (step.kind === 'json') {
    return new Response(JSON.stringify(step.payload), { status: step.status ?? 200 });
  }
  if (step.kind === 'raw') {
    return new Response(step.body, { status: step.status ?? 200 });
  }
  throw new Error('a reject step is answered by the transport, not by a response');
}

/** The stub transport and the log of what it was asked to send. */
export function makeTransport(step: InvariantStep): {
  fetchImpl: AsrInvocation['fetchImpl'];
  transport: RecordedTransport;
} {
  const transport: RecordedTransport = { calls: 0, requests: [] };
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    transport.calls += 1;
    transport.requests.push(recordRequest(String(url), init));
    if (step.kind === 'reject') {
      if (step.mode === 'transport') return Promise.reject(new Error('the transport is down'));
      // A timeout is the honest shape: the invocation's own signal aborts and the transport
      // rejects the way a real aborted fetch does, rather than a stub inventing an AbortError.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(abortError());
          return;
        }
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    return Promise.resolve(responseFor(step));
  };
  return { fetchImpl: fetchImpl as unknown as AsrInvocation['fetchImpl'], transport };
}

/** The invocation the fixture runs under: everything the adapter needs, injected. */
export function invariantInvocation(overrides?: {
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}): AsrInvocation {
  const fixture = INVARIANT_FIXTURE;
  const signal =
    overrides !== undefined && overrides.signal !== undefined
      ? overrides.signal
      : new AbortController().signal;
  return {
    baseUrl:
      overrides !== undefined && overrides.baseUrl !== undefined ? overrides.baseUrl : fixture.baseUrl,
    apiKey:
      overrides !== undefined && overrides.apiKey !== undefined ? overrides.apiKey : fixture.apiKey,
    model: fixture.model,
    timeoutMs: fixture.timeoutMs,
    // A signal is always supplied, so the adapter never has to reach for a platform timer to make
    // one; the timeout probe below is the abort that actually fires.
    signal,
    fetchImpl: (() => Promise.reject(new Error('no transport was injected'))) as unknown as AsrInvocation['fetchImpl'],
  };
}

type Driven = { result: AsrResult; transport: RecordedTransport };

/** Runs one transcription against a stub transport and keeps what it sent. */
async function drive(
  provider: AsrAdapter,
  request: AsrRequest,
  step: InvariantStep,
  invocationOverrides?: { apiKey?: string; baseUrl?: string },
): Promise<Driven> {
  const { fetchImpl, transport } = makeTransport(step);
  const controller = new AbortController();
  const invocation = invariantInvocation({
    ...(invocationOverrides?.apiKey !== undefined ? { apiKey: invocationOverrides.apiKey } : {}),
    ...(invocationOverrides?.baseUrl !== undefined ? { baseUrl: invocationOverrides.baseUrl } : {}),
    signal: controller.signal,
  });
  const pending = provider.transcribe(request, { ...invocation, fetchImpl });
  if (step.kind === 'reject' && step.mode === 'timeout') controller.abort();
  const result = await pending;
  return { result, transport };
}

// ── readings ─────────────────────────────────────────────────────────────────────────────────

function reading(
  group: InvariantGroupId,
  id: string,
  provider: string,
  observed: string,
  expected: string,
  detail: string,
): InvariantReading {
  return {
    group,
    id,
    provider,
    observed,
    expected,
    verdict: observed === expected ? 'pass' : 'fail',
    // The cause of a failure is the observed/expected pair, which every runner prints; repeating it
    // here would print it twice and put the disagreement in a string that a reader has to parse.
    detail,
  };
}

/** A result and the request count that produced it, as one comparable string. */
function outcome(result: AsrResult, requests: number): string {
  const head = result.ok ? `ok:${result.text}` : result.code;
  return `${head} requests=${requests}`;
}

/** The recorded body with the audio payload replaced by its token, so no reading carries bytes. */
function canonicaliseBody(body: string): string {
  return body.split(`"data":"${INVARIANT_AUDIO_BASE64}"`).join(`"data":"${INVARIANT_AUDIO_TOKEN}"`);
}

/**
 * The body the declaration promises for the fixture, composed from recorded fragments.
 *
 * Composed rather than computed: a body builder called here would agree with itself. The
 * fragments are recorded constants and the only thing read off the adapter is the declaration the
 * wire is supposed to follow — so a provider whose body disagrees with its own declaration reds.
 */
export function goldenBody(capabilities: AsrCapabilities): string {
  const audioPart = `{"inlineData":{"mimeType":"audio/webm","data":"${INVARIANT_AUDIO_TOKEN}"}}`;
  const contextPart = `{"text":"${INVARIANT_CONTEXT}"}`;
  const parts = capabilities.honors.context ? [audioPart, contextPart] : [audioPart];
  const contents = `{"contents":[{"parts":[${parts.join(',')}]}]`;
  if (!capabilities.honors.prompt) return `${contents}}`;
  return `${contents},"systemInstruction":{"parts":[{"text":"${INVARIANT_PROMPT}"}]}}`;
}

type PromptReading = 'no-prompt-part' | 'empty-prompt-part' | 'prompt-part-present' | 'unexpected-prompt-text';

function promptPart(body: string): PromptReading {
  if (!body.includes('"systemInstruction"')) return 'no-prompt-part';
  if (body.includes('"text":""')) return 'empty-prompt-part';
  if (body.includes(`"text":"${INVARIANT_PROMPT}"`)) return 'prompt-part-present';
  return 'unexpected-prompt-text';
}

type ContextReading = 'text-part-present' | 'no-context-part' | 'unexpected-context-text';

function contextPart(body: string): ContextReading {
  if (body.includes(`"text":"${INVARIANT_CONTEXT}"`)) return 'text-part-present';
  return body.includes('"text":') ? 'unexpected-context-text' : 'no-context-part';
}

/**
 * The peak a declared budget cannot be guessed at, only derived: base64 turns 3 bytes into 4, so
 * an audio of `ceil((budget + 1) / 4) * 3` bytes encodes to at least one byte past the budget.
 * Derived from the DECLARATION, which is why a declaration that shrinks or grows carries these
 * probes with it instead of leaving them silently on one side of the line.
 */
export function overBudgetAudioBytes(budget: number): number {
  return Math.ceil((budget + 1) / 4) * 3;
}

/** An audio that leaves room for the request skeleton inside the budget, with a margin to spare. */
export function affordableAudioBytes(budget: number): number {
  return Math.floor((budget * 3) / 4) - 4096;
}

// ── group 1: request construction ────────────────────────────────────────────────────────────

/** Everything the adapter was asked to send, per method, URL, headers and body. */
export async function probeRequestConstruction(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'request-construction';
  const readings: InvariantReading[] = [];
  const capabilities = provider.capabilities;
  const step: InvariantStep = { kind: 'json', payload: envelope(INVARIANT_TRANSCRIPT) };

  const sent = await drive(provider, invariantRequest(), step);
  const first = sent.transport.requests[0];
  const body = first?.body ?? '';

  readings.push(
    reading(group, `request.count[${provider.id}]`, provider.id, String(sent.transport.calls), '1',
      'one transcription sends exactly one request'),
    reading(group, `request.method[${provider.id}]`, provider.id, first?.method ?? 'no-request', 'POST',
      'the request is a POST'),
    reading(group, `request.url[${provider.id}]`, provider.id, first?.url ?? 'no-request', INVARIANT_ENDPOINT,
      'the base URL and the model compose the recorded endpoint'),
    reading(group, `request.content-type[${provider.id}]`, provider.id, first?.contentType ?? 'no-header',
      'application/json', 'the body is announced as JSON'),
    reading(group, `request.authorization[${provider.id}]`, provider.id, first?.authorization ?? 'no-request',
      'present', 'a configured credential reaches the wire as an Authorization header'),
    reading(group, `request.body.golden[${provider.id}]`, provider.id, canonicaliseBody(body),
      goldenBody(capabilities),
      'the recorded request body, byte for byte, with the audio payload carried as its token'),
    reading(group, `request.audio-encoding[${provider.id}]`, provider.id,
      body.includes(`"data":"${INVARIANT_AUDIO_BASE64}"`) ? 'match' : 'mismatch', 'match',
      `the encoded payload is the independently computed base64 of the fixture bytes (${INVARIANT_AUDIO_BASE64.length} characters)`),
    reading(group, `request.context.honored[${provider.id}]`, provider.id, contextPart(body),
      capabilities.honors.context ? 'text-part-present' : 'no-context-part',
      capabilities.honors.context
        ? 'the declaration acknowledges the context, so the context is on the wire — the positive control for hint handling'
        : 'the declaration does not acknowledge the context, so it is off the wire'),
    reading(group, `request.prompt.unsupported-omitted[${provider.id}]`, provider.id, promptPart(body),
      capabilities.honors.prompt ? 'prompt-part-present' : 'no-prompt-part',
      capabilities.honors.prompt
        ? 'the declaration acknowledges the prompt, so the prompt is on the wire'
        : 'a prompt the declaration does not acknowledge is left off the wire — not sent empty, not sent at all'),
  );

  // The credential is optional, so its ABSENCE has to be read too: a board that only ever saw a
  // configured key could not tell "the adapter omits an empty credential" from "the adapter always
  // writes one".
  const keyless = await drive(provider, invariantRequest(), step, { apiKey: '' });
  const trailingSlash = await drive(provider, invariantRequest(), step, {
    baseUrl: `${INVARIANT_BASE_URL}/`,
  });
  // The other half of the prompt rule, and the reason it needs its own reading: "not sent" and
  // "sent empty" are different behaviours that produce the same downstream effect, so an adapter
  // that forwarded an empty prompt would be indistinguishable from a correct one if only the
  // declared-unhonored case were measured.
  const emptyPrompt = await drive(provider, invariantRequest({ hints: { prompt: '' } }), step);
  readings.push(
    reading(group, `request.authorization-absent[${provider.id}]`, provider.id,
      keyless.transport.requests[0]?.authorization ?? 'no-request', 'absent',
      'an empty credential is not announced rather than announced empty'),
    reading(group, `request.url-trailing-slash[${provider.id}]`, provider.id,
      trailingSlash.transport.requests[0]?.url ?? 'no-request', INVARIANT_ENDPOINT,
      'a base URL with a trailing slash joins the path with no doubled slash'),
    reading(group, `request.prompt.empty-hint-omitted[${provider.id}]`, provider.id,
      promptPart(emptyPrompt.transport.requests[0]?.body ?? ''), 'no-prompt-part',
      'an empty prompt is left off the wire rather than sent as an empty text part'),
  );

  return readings;
}

// ── group 2: error mapping ───────────────────────────────────────────────────────────────────

type ErrorScenario = { id: string; step: InvariantStep; expected: string; detail: string };

/** A code as the group compares it: the shape of a failed outcome, one request spent. */
function failedWith(code: AsrErrorCode): string {
  return `${code} requests=1`;
}

/**
 * Every way the transport can fail, and the semantic code each one must reach.
 *
 * The point of the table is that the codes DIFFER: a board whose rows all expected one code would
 * pass on an adapter that collapsed everything onto it. `status-500` and `status-400` expecting
 * the same code as each other is the same statement read the other way — the mapping has to be a
 * mapping, not a constant.
 *
 * Every row here reaches the transport, so every row spends exactly one request: the two guards
 * that refuse BEFORE the transport are the size and mime groups' subject, not this one's.
 */
export const ERROR_SCENARIOS: ErrorScenario[] = [
  { id: 'error.status-401', step: { kind: 'json', status: 401, payload: { error: 'unauthorized' } }, expected: failedWith('UNAUTHORIZED'), detail: 'a rejected credential is its own code' },
  { id: 'error.status-403', step: { kind: 'json', status: 403, payload: { error: 'forbidden' } }, expected: failedWith('UNAUTHORIZED'), detail: 'a forbidden credential is the credential code, not a generic upstream failure' },
  { id: 'error.status-429', step: { kind: 'json', status: 429, payload: { error: 'slow down' } }, expected: failedWith('RATE_LIMITED'), detail: 'a throttled upstream is its own code, because the caller retries it differently' },
  { id: 'error.status-500', step: { kind: 'json', status: 500, payload: { error: 'boom' } }, expected: failedWith('UPSTREAM_ERROR'), detail: 'an upstream fault is the generic upstream code' },
  { id: 'error.status-503', step: { kind: 'json', status: 503, payload: { error: 'unavailable' } }, expected: failedWith('UPSTREAM_ERROR'), detail: 'an unavailable upstream follows the same rule as any other 5xx' },
  { id: 'error.status-400', step: { kind: 'json', status: 400, payload: { error: 'bad request' } }, expected: failedWith('UPSTREAM_ERROR'), detail: 'a request the upstream rejects is not the credential code' },
  { id: 'error.transport', step: { kind: 'reject', mode: 'transport' }, expected: failedWith('UNREACHABLE'), detail: 'a transport that never answered is unreachable, not a timeout' },
  { id: 'error.timeout', step: { kind: 'reject', mode: 'timeout' }, expected: failedWith('TIMEOUT'), detail: 'an aborted request is a timeout, and is read from the abort itself' },
  { id: 'error.body-not-json', step: { kind: 'raw', body: '<html>502 Bad Gateway</html>' }, expected: failedWith('UPSTREAM_ERROR'), detail: 'a gateway page is neither a transcript nor a crash' },
  { id: 'error.envelope-without-text', step: { kind: 'json', payload: { candidates: [{ content: { parts: [] } }] } }, expected: failedWith('NO_SPEECH_DETECTED'), detail: 'an answer carrying no text part is an empty answer, not a success with empty text' },
  { id: 'error.transcript-arrives', step: { kind: 'json', payload: envelope(INVARIANT_TRANSCRIPT) }, expected: `ok:${INVARIANT_TRANSCRIPT} requests=1`, detail: 'a well-formed envelope reaches the caller as its text, in one request' },
];

/** One reading per failure shape, so "the error mapping changed" reads as which row moved. */
export async function probeErrorMapping(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'error-mapping';
  const readings: InvariantReading[] = [];
  for (const scenario of ERROR_SCENARIOS) {
    const driven = await drive(provider, invariantRequest(), scenario.step);
    readings.push(
      reading(group, `${scenario.id}[${provider.id}]`, provider.id,
        outcome(driven.result, driven.transport.calls), scenario.expected, scenario.detail),
    );
  }
  return readings;
}

// ── group 3: size layering ───────────────────────────────────────────────────────────────────

/** The declared budget decides who is refused, and a refusal costs no request at all. */
export async function probeSizeLayering(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'size-layering';
  const readings: InvariantReading[] = [];
  const capabilities = provider.capabilities;
  const budget = capabilities.maxInlineRequestBytes;
  const step: InvariantStep = { kind: 'json', payload: envelope(INVARIANT_TRANSCRIPT) };

  const affordable = affordableAudioBytes(budget);
  const overBudget = overBudgetAudioBytes(budget);

  const oversize = await drive(provider, invariantRequest({ bytes: new Uint8Array(overBudget), hints: {} }), step);
  const fitting = await drive(provider, invariantRequest({ bytes: new Uint8Array(affordable), hints: {} }), step);
  const pushedOver = await drive(
    provider,
    invariantRequest({ bytes: new Uint8Array(affordable), hints: { context: 'x'.repeat(budget) } }),
    step,
  );

  readings.push(
    reading(group, `size.oversize-declared[${provider.id}]`, provider.id, capabilities.oversize, 'reject',
      'the first version declares rejection as the only oversize policy'),
    reading(group, `size.audio-alone-over-limit[${provider.id}]`, provider.id,
      outcome(oversize.result, oversize.transport.calls), `OVERSIZE requests=0`,
      `an audio of ${overBudget} B encodes past the declared ${budget} B budget: refused, and with zero requests the audio was never put on the wire`),
    reading(group, `size.audio-alone-affordable[${provider.id}]`, provider.id,
      outcome(fitting.result, fitting.transport.calls), `ok:${INVARIANT_TRANSCRIPT} requests=1`,
      `an audio of ${affordable} B encodes inside the declared ${budget} B budget: sent — the guard is a line, not a wall`),
    reading(group, `size.context-pushes-over-limit[${provider.id}]`, provider.id,
      outcome(pushedOver.result, pushedOver.transport.calls), `OVERSIZE requests=0`,
      'the SAME audio as the accepted case, plus a long context: the budget is the whole request, so the context is what pushed it over'),
  );

  return readings;
}

// ── group 4: redaction ───────────────────────────────────────────────────────────────────────

/** A needle's shape inside a scanned line, so a finding can be reported without printing it. */
export type NeedleHit = { line: number; needle: string };

/**
 * The needles the answer surface must not carry: the credential, the audio's own bytes, and the
 * audio's encoding as it is written on the wire.
 *
 * Both payload needles are RECORDED CONSTANTS, computed independently of the adapter
 * (`python3 -c "import base64; print(base64.b64encode(...))"`). Deriving them from the recorded
 * request body instead would defeat the purpose twice over: a scanner that re-uses the adapter's
 * encoder agrees with it by construction and so cannot report it as wrong, and the body's shape is
 * not a source of needles at all — a long JSON field name is indistinguishable from a payload
 * token, so a heuristic over the body reports structural names (`systemInstruction`, 17
 * characters, is a legal base64 run) as leaks. The encoding reading in the request-construction
 * group is what pins the wire's payload against this same constant.
 */
export function redactionNeedles(): { credential: string; payload: string[] } {
  return { credential: INVARIANT_API_KEY, payload: [INVARIANT_AUDIO_TEXT, INVARIANT_AUDIO_BASE64] };
}

/** Where each needle was found, position only: naming the line would quote the leak. */
export function scanLines(lines: string[], needles: string[]): NeedleHit[] {
  const hits: NeedleHit[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    for (const needle of needles) {
      if (needle.length > 0 && lines[index].includes(needle)) hits.push({ line: index, needle });
    }
  }
  return hits;
}

/** `<n> line(s), first at line <i>` — never the matched text. */
function describeHits(hits: NeedleHit[]): string {
  if (hits.length === 0) return 'absent';
  return `leaked(${hits.length} hit(s), first at line ${hits[0].line})`;
}

/**
 * The credential and the audio must not come back out of the answer surface.
 *
 * The scanner is shown to fire before it is trusted: a planted credential and a planted payload
 * token are both required to be found, and a clean line is required to produce nothing. Without
 * that pair, "no leaks found" and "the scanner cannot find anything" are the same reading.
 */
export async function probeRedaction(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'redaction';
  const readings: InvariantReading[] = [];
  const step: InvariantStep = { kind: 'json', payload: envelope(INVARIANT_TRANSCRIPT) };

  const sent = await drive(provider, invariantRequest(), step);
  const body = sent.transport.requests[0]?.body ?? '';
  const needles = redactionNeedles();

  const plantedCredential = [`the adapter said ${INVARIANT_API_KEY} out loud`];
  const plantedPayload = [`the adapter said ${INVARIANT_AUDIO_BASE64} out loud`];
  const clean = ['the adapter said nothing it should not have'];

  readings.push(
    reading(group, `redaction.scan.detects-planted-credential[${provider.id}]`, provider.id,
      scanLines(plantedCredential, [needles.credential]).length > 0 ? 'detects' : 'misses', 'detects',
      'a planted credential is found — the scanner is not a function that always returns clean'),
    reading(group, `redaction.scan.detects-planted-payload[${provider.id}]`, provider.id,
      scanLines(plantedPayload, needles.payload).length > 0 ? 'detects' : 'misses', 'detects',
      'a planted payload token is found — the scanner is not a function that always returns clean'),
    reading(group, `redaction.scan.ignores-clean-line[${provider.id}]`, provider.id,
      scanLines(clean, [needles.credential, ...needles.payload]).length === 0 ? 'clean' : 'false-positive',
      'clean', 'a line carrying neither needle is reported as carrying neither'),
  );

  // The two results below are the surfaces a leak would appear on, and the two readings above them
  // are what make their absence meaningful: the request DID carry both, so "not in the answer" is
  // a discrimination rather than a statement about a credential that was never used.
  readings.push(
    reading(group, `redaction.credential.reaches-the-wire[${provider.id}]`, provider.id,
      sent.transport.requests[0]?.authorization ?? 'no-request', 'present',
      'the credential is on the request, so its absence from the answer surface says something'),
    reading(group, `redaction.payload.reaches-the-wire[${provider.id}]`, provider.id,
      body.includes(INVARIANT_AUDIO_BASE64) ? 'present' : 'absent', 'present',
      'the encoded audio is on the request, so its absence from the answer surface says something'),
  );

  const scenarios: InvariantStep[] = [
    step,
    { kind: 'json', status: 500, payload: { error: 'boom' } },
    { kind: 'json', status: 429, payload: { error: 'slow down' } },
    { kind: 'reject', mode: 'transport' },
    { kind: 'reject', mode: 'timeout' },
  ];
  const results: string[] = [];
  const messages: string[] = [];
  for (const scenario of scenarios) {
    const driven = await drive(provider, invariantRequest(), scenario);
    results.push(JSON.stringify(driven.result));
    if (!driven.result.ok) messages.push(driven.result.message);
  }

  const credentialHits = (lines: string[]) => describeHits(scanLines(lines, [needles.credential]));
  const payloadHits = (lines: string[]) => describeHits(scanLines(lines, needles.payload));

  readings.push(
    reading(group, `redaction.credential.absent-from-result[${provider.id}]`, provider.id, credentialHits(results), 'absent',
      'no returned result carries the credential'),
    reading(group, `redaction.credential.absent-from-message[${provider.id}]`, provider.id, credentialHits(messages), 'absent',
      'no failure message carries the credential'),
    reading(group, `redaction.payload.absent-from-result[${provider.id}]`, provider.id, payloadHits(results), 'absent',
      'no returned result carries the audio or its encoding'),
    reading(group, `redaction.payload.absent-from-message[${provider.id}]`, provider.id, payloadHits(messages), 'absent',
      'no failure message carries the audio or its encoding'),
  );

  return readings;
}

/**
 * The log surface, scanned after the rest of the board has been written down.
 *
 * It runs as its own probe because it needs something no other probe has: the lines themselves.
 * The lines it produces are the only ones not covered by it, which is why they report a count and a
 * line number and never the text they matched.
 */
export async function probeLogRedaction(
  provider: AsrAdapter,
  lines: string[],
  needles: { credential: string; payload: string[] },
): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'redaction';
  return [
    reading(group, `redaction.log-lines-present[${provider.id}]`, provider.id,
      lines.length > 0 ? 'lines-present' : 'no-lines', 'lines-present',
      'the board printed lines to scan — an empty log surface is not a clean one'),
    reading(group, `redaction.credential.absent-from-logs[${provider.id}]`, provider.id,
      describeHits(scanLines(lines, [needles.credential])), 'absent',
      'no printed line carries the credential'),
    reading(group, `redaction.payload.absent-from-logs[${provider.id}]`, provider.id,
      describeHits(scanLines(lines, needles.payload)), 'absent',
      'no printed line carries the audio or its encoding'),
  ];
}

// ── group 5: mime gate ───────────────────────────────────────────────────────────────────────

/** An undeclared container is refused before a request exists, not after the service rejects it. */
export async function probeMimeGate(provider: AsrAdapter): Promise<InvariantReading[]> {
  const group: InvariantGroupId = 'mime-gate';
  const readings: InvariantReading[] = [];
  const step: InvariantStep = { kind: 'json', payload: envelope(INVARIANT_TRANSCRIPT) };

  const withParameters = await drive(provider, invariantRequest({ mimeType: 'audio/webm;codecs=opus' }), step);
  const upperCase = await drive(provider, invariantRequest({ mimeType: 'AUDIO/WEBM' }), step);
  const outside = await drive(provider, invariantRequest({ mimeType: 'audio/x-m4a' }), step);
  const unset = await drive(provider, invariantRequest({ mimeType: 'application/octet-stream' }), step);

  readings.push(
    reading(group, `mime.accept.base-type-with-parameters[${provider.id}]`, provider.id,
      outcome(withParameters.result, withParameters.transport.calls), `ok:${INVARIANT_TRANSCRIPT} requests=1`,
      'a declared base type carrying parameters is accepted, so the gate matches the base type'),
    reading(group, `mime.accept.case-insensitive-base-type[${provider.id}]`, provider.id,
      outcome(upperCase.result, upperCase.transport.calls), `ok:${INVARIANT_TRANSCRIPT} requests=1`,
      'the base type is matched case-insensitively'),
    reading(group, `mime.reject.outside-declaration[${provider.id}]`, provider.id,
      outcome(outside.result, outside.transport.calls), 'UNSUPPORTED_MIME requests=0',
      'a container outside the declaration is refused with no request, so nothing undeclared is ever uploaded'),
    reading(group, `mime.reject.unset-container[${provider.id}]`, provider.id,
      outcome(unset.result, unset.transport.calls), 'UNSUPPORTED_MIME requests=0',
      'an unset container is refused rather than sent as a guess'),
  );

  const declared = provider.capabilities.acceptsMime;
  const parameterised = declared.filter((entry) => entry.indexOf(';') !== -1);
  readings.push(
    reading(group, `mime.declared-set-holds-base-types[${provider.id}]`, provider.id,
      parameterised.length === 0 ? 'base-types-only' : `parameters-in-declaration(${parameterised.length})`,
      'base-types-only',
      'every declared entry is a base type: an entry carrying parameters could never match a stripped input, so it could never fire'),
  );

  return readings;
}

// ── the board ────────────────────────────────────────────────────────────────────────────────

export type InvariantRunOptions = {
  /** The adapters to measure: every provider the registry hands out. */
  providers: readonly AsrAdapter[];
  /** Narrow the board. A narrowed board is scored against the groups it ran, never the others. */
  groups?: readonly InvariantGroupId[];
};

/** The runners' line for one reading: id, value and — on a failure — the disagreement. */
function lineFor(entry: InvariantReading): string {
  const mark = entry.verdict === 'fail' ? 'FAIL' : 'ok';
  return `${mark} ${entry.id} observed=${entry.observed} expected=${entry.expected} — ${entry.detail}`;
}

function groupVerdict(
  group: InvariantGroupId,
  readings: InvariantReading[],
): InvariantGroupVerdict {
  const own = readings.filter((entry) => entry.group === group);
  const failing = own.filter((entry) => entry.verdict === 'fail').map((entry) => entry.id);
  return {
    group,
    verdict: own.length === 0 ? 'unmeasured' : failing.length > 0 ? 'fail' : 'pass',
    readings: own.length,
    failing,
  };
}

/**
 * Runs the selected groups against every provider.
 *
 * Three properties are load-bearing here:
 *   · a provider list of zero is `empty`, never `pass` — the empty reading is a verdict with its
 *     own name;
 *   · a probe that throws is a red reading in its own group rather than an exception that takes the
 *     whole board down, because a board that cannot report is a board that cannot be trusted;
 *   · the log surface is scanned by a probe that runs last, so it sees every line the other probes
 *     produced.
 */
export async function runAsrContractInvariants(
  options: InvariantRunOptions,
): Promise<InvariantReport> {
  const providers = options.providers;
  const selected: InvariantGroupId[] =
    options.groups === undefined ? [...INVARIANT_GROUP_IDS] : [...options.groups];

  if (providers.length === 0) {
    const groups = selected.map((group) => ({
      group,
      verdict: 'unmeasured' as const,
      readings: 0,
      failing: [] as string[],
    }));
    return { verdict: 'empty', groups, readings: [], logs: [] };
  }

  const readings: InvariantReading[] = [];
  for (const group of selected) {
    if (group === 'redaction') continue;
    for (const provider of providers) {
      try {
        readings.push(...(await PROBES[group](provider)));
      } catch (error) {
        readings.push(
          reading(group, `${group}.probe-threw[${provider.id}]`, provider.id, reasonFor(error),
            'the probe completes', 'the probe threw instead of measuring, so this group is red'),
        );
      }
    }
  }

  const redactionSelected = selected.indexOf('redaction') !== -1;
  if (redactionSelected) {
    for (const provider of providers) {
      try {
        readings.push(...(await probeRedaction(provider)));
      } catch (error) {
        readings.push(
          reading('redaction', `redaction.probe-threw[${provider.id}]`, provider.id, reasonFor(error),
            'the probe completes', 'the probe threw instead of measuring, so this group is red'),
        );
      }
    }
    // Second phase: the lines only exist once every behavioural probe has written its readings
    // down, so the log surface is scanned by a probe that runs after them. The three readings it
    // adds are the only lines it cannot cover, which is why they report a count and a line number
    // and never the text they matched.
    const provisional = readings.map(lineFor);
    const needles = redactionNeedles();
    for (const provider of providers) {
      readings.push(...(await probeLogRedaction(provider, provisional, needles)));
    }
  }

  const logs = readings.map(lineFor);
  const groups = selected.map((group) => groupVerdict(group, readings));
  const failing = readings.filter((entry) => entry.verdict === 'fail').length;
  const unmeasured = groups.filter((entry) => entry.verdict === 'unmeasured').length;
  const verdict = failing > 0 ? 'fail' : readings.length === 0 || unmeasured > 0 ? 'empty' : 'pass';
  return { verdict, groups, readings, logs };
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PROBES: Record<Exclude<InvariantGroupId, 'redaction'>, (provider: AsrAdapter) => Promise<InvariantReading[]>> = {
  'request-construction': probeRequestConstruction,
  'error-mapping': probeErrorMapping,
  'size-layering': probeSizeLayering,
  'mime-gate': probeMimeGate,
};
