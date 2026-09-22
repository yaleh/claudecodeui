import multer from 'multer';

import { voiceSettingsDb } from '@/modules/database/index.js';

import { createVoiceRouter } from './voice.routes.js';
import { createVoiceService, createVoiceSettingsService } from './voice.service.js';

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

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
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
