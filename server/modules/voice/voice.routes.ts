import { Readable } from 'node:stream';

import express from 'express';

import type {
  VoiceRequestOverrides,
  VoiceService,
  VoiceServiceResult,
  VoiceSettingsService,
} from '@/shared/types.js';
import { asyncHandler } from '@/shared/utils.js';

type VoiceRouterDependencies = {
  voiceService: VoiceService;
  voiceSettingsService: VoiceSettingsService;
  parseAudioUpload: express.RequestHandler;
};

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

/**
 * Reads the authenticated user id the auth middleware attached.
 *
 * The whole `/api/voice` router is mounted behind `authenticateToken`, so a
 * request that reaches a handler always has one; `Number(undefined)` would be
 * `NaN` and match no row, which fails closed rather than serving another user's
 * settings.
 */
function readUserId(request: express.Request): number {
  return Number((request as AuthenticatedRequest).user?.id);
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  const normalizedValue = Array.isArray(value) ? value[0] : value;
  const trimmedValue = normalizedValue?.trim();
  return trimmedValue || undefined;
}

function parseVoiceOverrides(request: express.Request): VoiceRequestOverrides {
  return {
    apiKey: readHeaderValue(request.headers['x-voice-api-key']),
    sttModel: readHeaderValue(request.headers['x-voice-stt-model']),
    ttsModel: readHeaderValue(request.headers['x-voice-tts-model']),
    ttsVoice: readHeaderValue(request.headers['x-voice-tts-voice']),
    ttsFormat: readHeaderValue(request.headers['x-voice-tts-format']),
  };
}

function sendFailure<TValue>(
  response: express.Response,
  result: VoiceServiceResult<TValue>,
): result is Extract<VoiceServiceResult<TValue>, { ok: false }> {
  if (result.ok) {
    return false;
  }

  response.status(result.status).json({ error: result.error });
  return true;
}

/**
 * Creates the transport-only router used by the Voice composition root. It is
 * exported for Voice route tests; other modules consume only the composed
 * router exposed from the Voice barrel.
 */
export function createVoiceRouter(dependencies: VoiceRouterDependencies): express.Router {
  const router = express.Router();

  router.get('/health', (_request, response) => {
    response.json(dependencies.voiceService.getHealth());
  });

  // The user's own backend settings. Reading them back is what lets a second
  // device (or the same device on another origin) pick up a configuration the
  // user saved somewhere else, instead of starting from nothing.
  router.get('/config', (request, response) => {
    response.json(dependencies.voiceSettingsService.getSettings(readUserId(request)));
  });

  // A whole-document PUT rather than a patch: the settings tab always has all
  // six fields on screen, and an empty string is the explicit "clear this".
  router.put('/config', (request, response) => {
    const result = dependencies.voiceSettingsService.saveSettings(readUserId(request), request.body);
    if (sendFailure(response, result)) {
      return;
    }

    response.json(result.value);
  });

  router.post('/transcribe', (request, response, next) => {
    dependencies.parseAudioUpload(request, response, (uploadError?: unknown) => {
      if (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
        response.status(400).json({ error: message });
        return;
      }

      // Multer uses a callback API, so bridge its parsed request into the async
      // service call and forward unexpected rejections to Express middleware.
      void (async () => {
        if (!request.file) {
          response.status(400).json({ error: 'No audio uploaded' });
          return;
        }

        const result = await dependencies.voiceService.transcribe({
          audio: {
            bytes: request.file.buffer,
            mimeType: request.file.mimetype || 'audio/webm',
            fileName: request.file.originalname || 'recording.webm',
          },
          overrides: parseVoiceOverrides(request),
        });

        if (sendFailure(response, result)) {
          return;
        }

        response.json(result.value);
      })().catch(next);
    });
  });

  router.post('/tts', asyncHandler(async (request, response) => {
    const text = request.body?.text;
    if (typeof text !== 'string' || !text.trim()) {
      response.status(400).json({ error: 'text required' });
      return;
    }

    const result = await dependencies.voiceService.synthesizeSpeech({
      text,
      overrides: parseVoiceOverrides(request),
    });
    if (sendFailure(response, result)) {
      return;
    }

    response.setHeader('Content-Type', result.value.contentType);
    response.setHeader('Cache-Control', 'no-store');
    if (!result.value.body) {
      response.end();
      return;
    }

    Readable.fromWeb(result.value.body).on('error', (error) => response.destroy(error)).pipe(response);
  }));

  return router;
}
