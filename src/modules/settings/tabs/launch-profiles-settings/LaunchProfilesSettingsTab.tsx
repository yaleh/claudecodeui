import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import { draftFromProfile, useLaunchProfiles } from '@/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles';
import type { LaunchProfileDraft } from '@/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles';
import type { LaunchProfile } from '@/shared/types';

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

type ProfileEditorProps = {
  profile?: LaunchProfile;
  onSave: (draft: LaunchProfileDraft, existing?: LaunchProfile) => Promise<boolean>;
};

/** Edits an existing profile, or (without `profile`) collects a new one. */
function ProfileEditor({ profile, onSave }: ProfileEditorProps) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState<LaunchProfileDraft>(() => draftFromProfile(profile));
  const [status, setStatus] = useState<'idle' | 'saving' | 'failed'>('idle');

  const update = (changes: Partial<LaunchProfileDraft>) => setDraft((previous) => ({ ...previous, ...changes }));

  const handleSave = async () => {
    setStatus('saving');
    const ok = await onSave(draft, profile);
    setStatus(ok ? 'idle' : 'failed');
    // A created profile appears as its own editor row, so the create form starts over.
    if (ok && !profile) setDraft(draftFromProfile());
  };

  return (
    <SettingsCard className="space-y-3 p-4">
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">{t('launchProfiles.name')}</span>
        <input className={inputClass} value={draft.name} onChange={(event) => update({ name: event.target.value })} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">{t('launchProfiles.model')}</span>
        <input className={inputClass} value={draft.model} onChange={(event) => update({ model: event.target.value })} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">{t('launchProfiles.baseUrl')}</span>
        <input className={inputClass} value={draft.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">{t('launchProfiles.authMode')}</span>
        <select
          className={inputClass}
          value={draft.authMode}
          onChange={(event) => update({ authMode: event.target.value as LaunchProfileDraft['authMode'] })}
        >
          <option value="none">{t('launchProfiles.authNone')}</option>
          <option value="envVar">{t('launchProfiles.authEnvVar')}</option>
        </select>
      </label>
      {draft.authMode === 'envVar' && (
        <label className="block space-y-1">
          <span className="text-sm font-medium text-foreground">{t('launchProfiles.authEnvVarName')}</span>
          <input
            className={inputClass}
            value={draft.authEnvVarName}
            onChange={(event) => update({ authEnvVarName: event.target.value })}
          />
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">{t('launchProfiles.contextWindow')}</span>
        <input
          className={inputClass}
          inputMode="numeric"
          value={draft.contextWindow}
          onChange={(event) => update({ contextWindow: event.target.value })}
        />
      </label>
      {/* Credentials are shown by reference name only; the plaintext never reaches the UI. */}
      {profile?.credentialRef && (
        <div className="text-xs text-muted-foreground">
          {t('launchProfiles.credentialRef')}: <code>{profile.credentialRef}</code>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={status === 'saving' || !draft.name.trim()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {status === 'saving' ? t('launchProfiles.saving') : profile ? t('launchProfiles.save') : t('launchProfiles.create')}
        </button>
        {status === 'failed' && <span className="text-xs text-destructive">{t('launchProfiles.saveFailed')}</span>}
      </div>
    </SettingsCard>
  );
}

/** Rendered by Settings for the "profiles" tab, listing, creating and editing launch profiles. */
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
      <SettingsSection title={t('launchProfiles.newTitle')}>
        <ProfileEditor onSave={saveProfile} />
      </SettingsSection>
    </div>
  );
}
