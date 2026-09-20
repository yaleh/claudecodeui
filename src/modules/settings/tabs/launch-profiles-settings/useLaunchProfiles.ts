import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '@/shared/api';
import type { LaunchProfile } from '@/shared/types';

const LAUNCH_PROFILES_URL = '/api/launch-profiles';

/** The editable fields of a profile as the form collects them; mapped onto the server's `config` object on save. */
export type LaunchProfileDraft = {
  name: string;
  model: string;
  baseUrl: string;
  authMode: 'none' | 'envVar';
  authEnvVarName: string;
  contextWindow: string;
};

// The REST layer may answer with a bare array or wrap it as `{ profiles }`.
const parseProfiles = (payload: unknown): LaunchProfile[] => {
  const list = Array.isArray(payload) ? payload : (payload as { profiles?: unknown } | null)?.profiles;
  return Array.isArray(list) ? (list as LaunchProfile[]) : [];
};

const asString = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

/** Reads a profile's config back into form fields. */
export function draftFromProfile(profile?: LaunchProfile): LaunchProfileDraft {
  const config = profile?.config ?? {};
  return {
    name: profile?.name ?? '',
    model: asString(config.defaultModel) || (profile?.model ?? ''),
    baseUrl: asString(config.baseUrl),
    authMode: config.authMode === 'envVar' ? 'envVar' : 'none',
    authEnvVarName: asString(config.authEnvVarName),
    contextWindow: asString(config.contextWindow),
  };
}

/** Builds the request body; blank optional fields are omitted and other config keys of an edited profile are preserved. */
function toRequestBody(draft: LaunchProfileDraft, existing?: LaunchProfile) {
  const config: Record<string, unknown> = { ...(existing?.config ?? {}) };
  const assign = (key: string, value: unknown) => {
    if (value === '' || value === undefined) delete config[key];
    else config[key] = value;
  };
  assign('defaultModel', draft.model.trim());
  assign('baseUrl', draft.baseUrl.trim());
  assign('authMode', draft.authMode === 'envVar' ? 'envVar' : '');
  assign('authEnvVarName', draft.authMode === 'envVar' ? draft.authEnvVarName.trim() : '');
  const windowSize = Number(draft.contextWindow);
  assign('contextWindow', draft.contextWindow.trim() && Number.isFinite(windowSize) ? windowSize : '');
  return {
    provider: existing?.provider ?? 'claude',
    name: draft.name.trim(),
    deployment: 'gateway',
    config,
  };
}

/** Loads launch profiles from the REST API and creates or updates one; used by LaunchProfilesSettingsTab. */
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

  /** Creates (no `existing`) or updates (PUT) a profile; resolves true and refreshes the local list on success. */
  const saveProfile = useCallback(async (draft: LaunchProfileDraft, existing?: LaunchProfile) => {
    try {
      const response = await authenticatedFetch(
        existing ? `${LAUNCH_PROFILES_URL}/${encodeURIComponent(existing.id)}` : LAUNCH_PROFILES_URL,
        { method: existing ? 'PUT' : 'POST', body: JSON.stringify(toRequestBody(draft, existing)) },
      );
      if (!response.ok) return false;
      const saved = (await response.json()) as LaunchProfile;
      setProfiles((previous) =>
        existing
          ? previous.map((profile) => (profile.id === existing.id ? saved : profile))
          : [...previous, saved],
      );
      return true;
    } catch {
      return false;
    }
  }, []);

  return { profiles, isLoading, loadError, saveProfile };
}
