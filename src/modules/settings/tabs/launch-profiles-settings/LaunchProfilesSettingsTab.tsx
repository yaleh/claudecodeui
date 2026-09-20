import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import { useLaunchProfiles } from '@/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles';
import type { LaunchProfile } from '@/shared/types';

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

type ProfileEditorProps = {
  profile: LaunchProfile;
  onSave: (id: string, changes: Pick<LaunchProfile, 'name' | 'model'>) => Promise<boolean>;
};

function ProfileEditor({ profile, onSave }: ProfileEditorProps) {
  const { t } = useTranslation('settings');
  const [name, setName] = useState(profile.name);
  const [model, setModel] = useState(profile.model ?? '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'failed'>('idle');

  const handleSave = async () => {
    setStatus('saving');
    const ok = await onSave(profile.id, { name, model });
    setStatus(ok ? 'idle' : 'failed');
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">{t('launchProfiles.name')}</span>
        <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">{t('launchProfiles.model')}</span>
        <input className={inputClass} value={model} onChange={(event) => setModel(event.target.value)} />
      </label>
      {/* Credentials are shown by reference name only; the plaintext never reaches the UI. */}
      {profile.credentialRef && (
        <div className="text-xs text-muted-foreground">
          {t('launchProfiles.credentialRef')}: <code>{profile.credentialRef}</code>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={status === 'saving'}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {status === 'saving' ? t('launchProfiles.saving') : t('launchProfiles.save')}
        </button>
        {status === 'failed' && <span className="text-xs text-destructive">{t('launchProfiles.saveFailed')}</span>}
      </div>
    </SettingsCard>
  );
}

/** Rendered by Settings for the "profiles" tab, listing and editing launch profiles. */
export default function LaunchProfilesSettingsTab() {
  const { t } = useTranslation('settings');
  const { profiles, isLoading, loadError, saveProfile } = useLaunchProfiles();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('launchProfiles.title')} description={t('launchProfiles.description')}>
        {isLoading && <div className="text-sm text-muted-foreground">{t('launchProfiles.loading')}</div>}
        {loadError && <div className="text-sm text-destructive">{t('launchProfiles.loadFailed')}</div>}
        {!isLoading && !loadError && profiles.length === 0 && (
          <div className="text-sm text-muted-foreground">{t('launchProfiles.empty')}</div>
        )}
        <div className="space-y-3">
          {profiles.map((profile) => (
            <ProfileEditor key={profile.id} profile={profile} onSave={saveProfile} />
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
