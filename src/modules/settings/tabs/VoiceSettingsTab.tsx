import type { InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useVoiceConfig } from '@/modules/settings/hooks/useVoiceConfig';
import { useVoiceProviderOptions } from '@/modules/settings/hooks/useVoiceProviderOptions';
import { isVoiceConfigField, readVoiceConfigField } from '@/shared/voiceConfig';

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function Field({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <input className={inputClass} {...props} />
    </label>
  );
}

/** What one declared credential field is FOR, which is all this form knows about it. */
type DeclaredFieldRole = 'endpoint' | 'apiKey' | 'model';

/**
 * The inputs a provider's own declaration asks for, in the order its declaration names them.
 *
 * The three roles are the three halves of `AsrCredentialFields`, chosen from the declaration's
 * own slots rather than from the field's name — the form decides an input's type, label and
 * placeholder from the SLOT a field occupies, so a provider that renames `dashscopeApiKey` to
 * something else still gets a password input and still gets the credential label.
 */
function declaredEntries(declaration: { endpointField: string; apiKeyField: string; modelField?: string }) {
  const entries: { field: string; role: DeclaredFieldRole }[] = [
    { field: declaration.endpointField, role: 'endpoint' },
    { field: declaration.apiKeyField, role: 'apiKey' },
  ];
  if (declaration.modelField) {
    entries.push({ field: declaration.modelField, role: 'model' });
  }
  // A name this build does not store is dropped rather than rendered: `updateVoiceConfig` accepts
  // only the fields this module knows, so an input bound to anything else would silently discard
  // what the user typed into it. See `isVoiceConfigField`.
  return entries.filter((entry) => isVoiceConfigField(entry.field));
}

/** Rendered by Settings for the "voice" tab, covering speech-to-text provider credentials. */
export default function VoiceSettingsTab() {
  const { t } = useTranslation('settings');
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();
  const { config, update } = useVoiceConfig();
  const { providers } = useVoiceProviderOptions();
  const voiceEnabled = preferences.voiceEnabled;

  // WHICH PROVIDER THE FORM IS ABOUT: the user's stored choice, or — before they have made one —
  // the first row the server would fall back to. The stored value is never second-guessed: an id
  // the payload does not list still selects the row `providerId` already holds, because a form
  // that quietly re-pointed the user at another service is the failure this precedence exists to
  // avoid. The server refuses an id no adapter claims, so it is not this form's job to guess.
  const selectedId = config.providerId || providers[0]?.id || '';
  const selected = providers.find((provider) => provider.id === selectedId) ?? null;
  const options = providers.length > 0
    ? providers
    : (selectedId ? [{ id: selectedId, label: selectedId, configured: false, credentialFields: null }] : []);

  const declaration = selected?.credentialFields ?? null;
  const declared = declaration ? declaredEntries(declaration) : [];
  const providerLabel = selected?.label ?? selectedId;

  return (
    <div className="space-y-8">
      <SettingsSection title={t('voiceSettings.title')} description={t('voiceSettings.description')}>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="pr-3">
            <div className="text-sm font-medium text-foreground">{t('voiceSettings.enable')}</div>
            <div className="text-xs text-muted-foreground">{t('voiceSettings.enableDescription')}</div>
          </div>
          <SettingsToggle
            checked={voiceEnabled}
            onChange={(v) => setPreference('voiceEnabled', v)}
            ariaLabel={t('voiceSettings.enable')}
          />
        </div>
      </SettingsSection>

      {voiceEnabled && (
        <SettingsSection title={t('voiceSettings.backendTitle')} description={t('voiceSettings.backendDescription')}>
          <div className="space-y-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">{t('voiceSettings.provider')}</span>
              <select
                name="providerId"
                className={inputClass}
                value={selectedId}
                onChange={(e) => update({ providerId: e.target.value })}
              >
                {options.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                ))}
              </select>
              <span className="block text-xs text-muted-foreground">{t('voiceSettings.providerDescription')}</span>
            </label>

            {declared.length > 0 && (
              <div className="space-y-4 rounded-lg border border-border p-3" data-testid="voice-provider-fields">
                <div className="text-sm font-medium text-foreground">
                  {t('voiceSettings.providerCredentials', { provider: providerLabel })}
                </div>
                {declared.map(({ field, role }) => (
                  <Field
                    key={field}
                    // The declaration's own name, on the element: it is what ties a rendered
                    // input to the slot the server will read it from, and it is what lets a
                    // reader of the page (a test, an accessibility tool) say which stored
                    // setting a box edits.
                    name={field}
                    type={role === 'apiKey' ? 'password' : undefined}
                    autoComplete={role === 'apiKey' ? 'off' : undefined}
                    placeholder={role === 'model' ? t('voiceSettings.providerModelPlaceholder') : undefined}
                    label={t(
                      role === 'apiKey'
                        ? 'voiceSettings.providerApiKey'
                        : role === 'model'
                          ? 'voiceSettings.providerModel'
                          : 'voiceSettings.providerEndpoint',
                    )}
                    value={readVoiceConfigField(config, field)}
                    onChange={(e) => update({ [field]: e.target.value })}
                  />
                ))}
                {declaration?.modelField && (
                  <p className="text-xs text-muted-foreground">{t('voiceSettings.providerModelHelp')}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('voiceSettings.providerNotice', { provider: providerLabel })}
                </p>
              </div>
            )}

            <div className="space-y-4">
              <div className="text-sm font-medium text-foreground">{t('voiceSettings.sharedFields')}</div>
              <Field
                name="baseUrl"
                label={t('voiceSettings.baseUrl')}
                placeholder="https://api.openai.com/v1"
                value={config.baseUrl}
                onChange={(e) => update({ baseUrl: e.target.value })}
              />
              <Field
                name="apiKey"
                label={t('voiceSettings.apiKey')}
                type="password"
                autoComplete="off"
                placeholder="sk-…"
                value={config.apiKey}
                onChange={(e) => update({ apiKey: e.target.value })}
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
                <Field
                  name="sttModel"
                  label={t('voiceSettings.sttModel')}
                  placeholder="whisper-1"
                  value={config.sttModel}
                  onChange={(e) => update({ sttModel: e.target.value })}
                />
                <Field
                  name="ttsModel"
                  label={t('voiceSettings.ttsModel')}
                  placeholder="tts-1"
                  value={config.ttsModel}
                  onChange={(e) => update({ ttsModel: e.target.value })}
                />
                <Field
                  name="ttsVoice"
                  label={t('voiceSettings.voice')}
                  placeholder="alloy"
                  value={config.ttsVoice}
                  onChange={(e) => update({ ttsVoice: e.target.value })}
                />
                <Field
                  name="ttsFormat"
                  label={t('voiceSettings.format')}
                  placeholder="mp3"
                  value={config.ttsFormat}
                  onChange={(e) => update({ ttsFormat: e.target.value })}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('voiceSettings.note')}</p>
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
