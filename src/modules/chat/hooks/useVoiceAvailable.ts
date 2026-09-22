import { useEffect, useState } from 'react';

import type { AsrCapabilities } from '@shared/asr/asrRegistry';

import { api, setVoiceProviderProfile } from '@/shared/api';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { readVoiceConfig, VOICE_CONFIG_SYNC_EVENT, whenVoiceConfigReady } from '@/shared/voiceConfig';

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

        if (readVoiceConfig().baseUrl.trim()) {
          setAvailable(true);
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
