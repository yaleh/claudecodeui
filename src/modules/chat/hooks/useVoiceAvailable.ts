import { useEffect, useState } from 'react';

import type { AsrCapabilities } from '@shared/asr/asrRegistry';

import { installVoiceClientAsrEngine } from '@/modules/chat/audio/voiceClientAsrWorker';
import { api, setVoiceProviderProfile } from '@/shared/api';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import {
  isVoiceClientAsrSelected,
  readVoiceConfig,
  VOICE_CONFIG_SYNC_EVENT,
  whenVoiceConfigReady,
} from '@/shared/voiceConfig';

// Voice UI is gated on the `voiceEnabled` UI preference (toggled in Quick Settings /
// the Settings modal) and a configured voice backend.
let healthRequest: Promise<boolean> | null = null;

/**
 * Hands the health reading's effective provider to the shared API module, which is where the
 * direct path decides which endpoint a recording takes.
 *
 * The payload is read leniently and never throws: a response from an older server, or one
 * whose provider list is missing, must leave the previous profile in place cleared rather than
 * break a hook whose job is only to answer whether the microphone is available.
 */
function publishEffectiveProvider(payload: unknown): void {
  const health = (payload ?? {}) as { provider?: unknown; providers?: unknown };
  const providerId = typeof health.provider === 'string' ? health.provider : '';
  const providers = Array.isArray(health.providers) ? health.providers : [];
  const entry = providers.find(
    (candidate) => providerId !== '' && (candidate as { id?: unknown } | null)?.id === providerId,
  ) as { capabilities?: AsrCapabilities } | undefined;

  setVoiceProviderProfile(
    entry?.capabilities ? { id: providerId, capabilities: entry.capabilities } : null,
  );
}

function checkVoiceHealth(): Promise<boolean> {
  if (healthRequest) return healthRequest;
  const request = api.voice.health()
    .then(async (response) => {
      if (!response.ok) throw new Error(`Voice health check failed (${response.status})`);
      const data = await response.json();
      publishEffectiveProvider(data);
      return data?.configured === true;
    })
    .finally(() => {
      healthRequest = null;
    });
  healthRequest = request;
  return request;
}

export function useVoiceAvailable(): boolean {
  // Read through the shared preferences owner. This used to re-parse the
  // preferences blob and register its own storage + sync listeners, once per
  // assistant message row.
  const { voiceEnabled: enabled } = useUiPreferences();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    let requestId = 0;

    const check = async () => {
      if (!enabled) {
        setAvailable(false);
        return;
      }
      const id = ++requestId;
      try {
        // The settings load from the server now, so "no base URL" is only a
        // real answer once they have arrived. Deciding earlier would hide the
        // microphone on every load for a user who configured their own backend,
        // which is the failure this whole move exists to remove.
        await whenVoiceConfigReady();
        if (!active || id !== requestId) return;

        // The client path answers for itself. A tab whose selected recogniser runs HERE has a working
        // microphone whether or not a backend is configured, because the recognition never leaves the
        // device — and it has one BEFORE the model has been downloaded, which is why the reading is
        // the engine's own `available` and not its readiness: an engine that is configured but not yet
        // loaded will answer (by loading, or by falling back), while one that is unavailable will not.
        //
        // Installing here is what makes the engine exist at all, and it is safe on every render of the
        // effect: the installer is memoised, and a deployment with no configuration gets the port that
        // answers `ENGINE_UNAVAILABLE`, so this reads `false` and the microphone stays hidden until the
        // user picks a recogniser that can serve them. The download's progress and notices have no
        // consumer in this hook on purpose — it is a boolean — and
        // `observeVoiceClientAsrEngine` is where the surface that can show them attaches.
        if (isVoiceClientAsrSelected()) {
          setAvailable(installVoiceClientAsrEngine().status().available);
          return;
        }

        if (readVoiceConfig().baseUrl.trim()) {
          setAvailable(true);
          // The health reading is asked for on this path too, even though its answer is not what
          // decides availability here. It is what PUBLISHES the effective provider, and that
          // publication is the only place the client learns what the recogniser declares — the
          // container gate and the trim gate both read it. Returning without asking left an
          // install with its own endpoint, which is the shipped shape, holding no declaration at
          // all: `effectivePauseCuesDeclaration()` answered `null`, and the trim gate reads `null`
          // as "this recogniser's pauses are worth keeping".
          //
          // Awaited rather than fired and forgotten, so a capture started immediately still sees
          // the declaration; its failure is swallowed rather than folded into `available`, because
          // a user whose own endpoint answers must keep their microphone whether or not this
          // server can be reached. A server that cannot answer leaves the profile unpublished,
          // which is the "do not trim" answer this path gave before — never a broken mic.
          await checkVoiceHealth().catch(() => {});
          return;
        }

        const result = await checkVoiceHealth();
        if (active && id === requestId) setAvailable(result);
      } catch {
        if (active && id === requestId) setAvailable(false);
      }
    };

    void check();
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    return () => {
      active = false;
      window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    };
  }, [enabled]);

  return enabled && available;
}
