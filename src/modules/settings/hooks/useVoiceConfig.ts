import { useCallback, useEffect, useState } from 'react';

import type { VoiceConfig } from '@/shared/voiceConfig';
import {
  readVoiceConfig,
  updateVoiceConfig,
  VOICE_CONFIG_DEFAULTS,
  VOICE_CONFIG_SYNC_EVENT,
  whenVoiceConfigReady,
} from '@/shared/voiceConfig';

/**
 * Backs the voice settings form with the shared in-memory configuration.
 *
 * The settings themselves live in `shared/voiceConfig` — one copy for the whole
 * app, loaded from the server and saved on a debounce — so this hook only
 * mirrors it into React state: a field typed here, a hydration that lands after
 * mount, or a change made in another tab all arrive through the same sync event.
 */
export function useVoiceConfig() {
  const [config, setConfig] = useState<VoiceConfig>(() =>
    typeof window === 'undefined' ? { ...VOICE_CONFIG_DEFAULTS } : readVoiceConfig(),
  );

  useEffect(() => {
    const sync = () => setConfig(readVoiceConfig());
    // Read once on mount in case the store changed between render and effect,
    // then wait for the server's copy: a form opened before the fetch resolved
    // would otherwise sit on the empty defaults until the user typed.
    sync();
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, sync);
    void whenVoiceConfigReady().then(sync);
    return () => window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, sync);
  }, []);

  const update = useCallback((patch: Partial<VoiceConfig>) => {
    updateVoiceConfig(patch);
  }, []);

  return { config, update };
}
