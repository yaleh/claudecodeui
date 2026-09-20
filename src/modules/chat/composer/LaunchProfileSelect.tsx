import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '@/shared/api';
import type { LaunchProfile } from '@/shared/types';

type LaunchProfileSelectProps = {
  value: string | null;
  onChange: (launchProfileId: string | null) => void;
};

/** Used by ChatComposer to let the user pick the launch profile a session's messages are sent under; renders nothing when no profiles exist. */
export default function LaunchProfileSelect({ value, onChange }: LaunchProfileSelectProps) {
  const { t } = useTranslation('chat');
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);

  useEffect(() => {
    let cancelled = false;
    authenticatedFetch('/api/launch-profiles')
      .then(async (response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const list = Array.isArray(payload) ? payload : payload?.profiles;
        if (!cancelled && Array.isArray(list)) setProfiles(list as LaunchProfile[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (profiles.length === 0) return null;

  const label = t('launchProfile.label', { defaultValue: 'Launch profile' });

  return (
    <select
      aria-label={label}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      className="h-8 max-w-[10rem] rounded-md border border-border bg-background px-2 text-xs text-foreground"
    >
      {/* Empty value = no explicit profile: the server resolves one through its default chain. */}
      <option value="">{t('launchProfile.default', { defaultValue: 'Default profile' })}</option>
      {profiles.map((profile) => (
        <option key={profile.id} value={profile.id}>{profile.name}</option>
      ))}
    </select>
  );
}
