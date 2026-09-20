import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '@/shared/api';
import type { LaunchProfile } from '@/shared/types';

const LAUNCH_PROFILES_URL = '/api/launch-profiles';

// The REST layer may answer with a bare array or wrap it as `{ profiles }`.
const parseProfiles = (payload: unknown): LaunchProfile[] => {
  const list = Array.isArray(payload) ? payload : (payload as { profiles?: unknown } | null)?.profiles;
  return Array.isArray(list) ? (list as LaunchProfile[]) : [];
};

/** Loads launch profiles from the REST API and saves edits to one profile; used by LaunchProfilesSettingsTab. */
export function useLaunchProfiles() {
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authenticatedFetch(LAUNCH_PROFILES_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseProfiles(await response.json());
      })
      .then((loaded) => {
        if (!cancelled) setProfiles(loaded);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** PUTs the editable fields; resolves true and updates the local list on success. */
  const saveProfile = useCallback(async (id: string, changes: Pick<LaunchProfile, 'name' | 'model'>) => {
    try {
      const response = await authenticatedFetch(`${LAUNCH_PROFILES_URL}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(changes),
      });
      if (!response.ok) return false;
      setProfiles((previous) => previous.map((profile) => (profile.id === id ? { ...profile, ...changes } : profile)));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { profiles, isLoading, loadError, saveProfile };
}
