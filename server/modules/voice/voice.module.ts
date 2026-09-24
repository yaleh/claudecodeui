import multer from 'multer';

import { voiceSettingsDb } from '@/modules/database/index.js';
import type { VoiceLogPort } from '@/shared/types.js';

// The provider address book, read here for the one figure the transport layer can know without
// knowing which provider will serve the request: the ceiling above every declared budget.
import { listProviders } from '../../../shared/asr/asrRegistry.js';

import { announceVoiceCapture, createVoiceCapture } from './voice-capture.js';
import { createVoiceRouter } from './voice.routes.js';
import { createVoiceService, createVoiceSettingsService } from './voice.service.js';

/**
 * Where this deployment's own voice lines go.
 *
 * Resolved ONCE, here, because the start-up line below and every attempt line after it have to reach
 * the same place: a process that announced its recording mode on one stream and wrote its attempts
 * to another would have made the announcement unreadable to exactly the reader who needs it. The
 * service keeps its own `console` fallback for callers that wire no port (tests, probes, the
 * invariant board), so this binding changes nothing for them.
 */
const voiceLog: VoiceLogPort = console;

/**
 * THE ONE READ of `VOICE_CAPTURE` in this process, and the one place it is announced.
 *
 * Read at start-up and never per request, because the mode is a property of the DEPLOYMENT rather
 * than of a user or a request: a value re-read on the request path could change what is recorded
 * halfway through a recording, which is precisely the reading nobody could reconstruct afterwards.
 * An unrecognised value comes back as `off` with a warning, and the warning is written here rather
 * than swallowed — see `resolveVoiceCaptureMode` for why a misspelling fails closed.
 *
 * The resolution announced here IS the one injected below, so "the mode the process says it is in"
 * and "the mode it records in" cannot disagree.
 */
const voiceCapture = announceVoiceCapture(process.env.VOICE_CAPTURE, voiceLog);

const DEFAULT_VOICE_TIMEOUT_MS = 300_000;
const parsedTimeoutMs = Number(process.env.VOICE_TIMEOUT_MS);
const voiceTimeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
  ? parsedTimeoutMs
  : DEFAULT_VOICE_TIMEOUT_MS;

const voiceService = createVoiceService({
  defaults: {
    // The server-controlled URL is intentional: frontend-configured custom
    // backends are called directly by the browser and never become SSRF input.
    baseUrl: (process.env.VOICE_API_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.VOICE_API_KEY || '',
    sttModel: process.env.VOICE_STT_MODEL || 'whisper-1',
    ttsModel: process.env.VOICE_TTS_MODEL || 'tts-1',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'alloy',
    // The deployment's preferred recogniser. Empty — the usual case — means the registry's
    // first entry, so a deployment that never sets this variable keeps working across a
    // provider being renamed. An id no adapter claims is refused, not replaced.
    providerId: (process.env.VOICE_PROVIDER_ID || '').trim(),
  },
  timeoutMs: voiceTimeoutMs,
  // The recording seam, built from the mode this process resolved above. It is ALWAYS injected —
  // including for `off`, where the port records nothing — so that the decision to record lives in
  // one place inside the service rather than in a ternary here: a root that omitted the port for
  // `off` would leave "the service is off" untested by the only deployment shape that matters.
  //
  // The audio sink is deliberately not wired: the mode is resolved and gated, and a deployment that
  // records rows puts nothing on disk until the audio half (the write, the directory, its
  // permissions) supplies a sink. See `VoiceCaptureAudioSink`.
  capture: createVoiceCapture({ mode: voiceCapture.mode, log: voiceLog }),
  logger: voiceLog,
  fetchBackend: async (url, options) => {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), voiceTimeoutMs);
    try {
      return await fetch(url, {
        redirect: 'manual',
        ...options,
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  },
});

/**
 * The transport ceiling: the largest upload ANY registered provider declares it can take.
 *
 * Derived from the registry rather than written as a number, because the two figures in this
 * layering must not be able to disagree. A literal here would be a second source of truth about
 * how big an upload may be, and the day a provider's budget moved it would silently become the
 * binding one — the provider would be handed a truncated read, or a request it could have served
 * would be refused by a parser that never knew which provider it was for.
 *
 * Because this is the maximum over the registry, it can never be smaller than the selected
 * provider's own budget, so the effective limit for one request is `min(this, that budget)` — and
 * the provider-level gate is the one that computes it, since only it knows the provider. Multer
 * runs before the handler and therefore before any provider is known; that is why this layer can
 * only be a ceiling and not the limit itself.
 *
 * An empty registry leaves the ceiling at zero, which refuses every upload rather than admitting
 * an unbounded one: nothing can serve a request in that state, so accepting bytes for it would be
 * buffering work with no destination.
 */
function transportCeilingBytes(): number {
  let ceiling = 0;
  for (const adapter of listProviders()) {
    ceiling = Math.max(ceiling, adapter.capabilities.maxInlineRequestBytes);
  }
  return ceiling;
}

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: transportCeilingBytes() },
});

// The settings the user saved, read and written through the Voice settings
// routes. Stored per user so a key no longer lives only in one browser profile.
const voiceSettingsService = createVoiceSettingsService(voiceSettingsDb);

/** Voice router assembled for the server entrypoint. */
export const voiceRoutes = createVoiceRouter({
  voiceService,
  voiceSettingsService,
  parseAudioUpload: audioUpload.single('audio'),
});
