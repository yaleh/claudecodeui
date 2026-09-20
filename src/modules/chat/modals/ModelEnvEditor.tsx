import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';

import { Badge, Button, Input } from '@/shared/ui';
import type { ModelEnvStatus, ProviderModelEnvRowInput, ProviderModelPublicConfig } from '@/shared/types';

const ROW_KINDS: ProviderModelEnvRowInput['kind'][] = ['value', 'secret', 'envref', 'unset'];

/**
 * One editable env row. `secretStored` marks a secret the server already holds:
 * its value is never known here, so an empty `value` means "keep the stored one".
 */
export type ModelEnvEditorRow = {
  key: string;
  kind: ProviderModelEnvRowInput['kind'];
  value: string;
  secretStored: boolean;
};

/** "LLM gateway" template (ADR-002 decision 4): a pure frontend constant that pre-fills the Anthropic-compatible gateway variables. */
export const LLM_GATEWAY_TEMPLATE: ModelEnvEditorRow[] = [
  { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: '', secretStored: false },
  { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: '', secretStored: false },
  { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', kind: 'value', value: '', secretStored: false },
  { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', kind: 'value', value: '', secretStored: false },
  { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', kind: 'value', value: '', secretStored: false },
  { key: 'ANTHROPIC_API_KEY', kind: 'unset', value: '', secretStored: false },
];

/** Turns a model's server-side config into editor rows; a stored secret becomes an empty row flagged `secretStored`. */
export const toEditorRows = (config: ProviderModelPublicConfig | null | undefined): ModelEnvEditorRow[] => (
  (config?.env ?? []).map((row) => ({
    key: row.key,
    kind: row.kind,
    value: row.kind === 'value' || row.kind === 'envref' ? row.value ?? '' : '',
    secretStored: row.kind === 'secret',
  }))
);

/**
 * Builds the request rows. A stored secret left blank is sent without `value`
 * (the server keeps it); a blank new secret or blank value/envref row is
 * dropped so an unedited field never overwrites stored data.
 */
export const toRequestRows = (rows: ModelEnvEditorRow[]): ProviderModelEnvRowInput[] => {
  const request: ProviderModelEnvRowInput[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) {
      continue;
    }
    if (row.kind === 'unset') {
      request.push({ key, kind: 'unset' });
    } else if (row.kind === 'secret') {
      if (row.value) {
        request.push({ key, kind: 'secret', value: row.value });
      } else if (row.secretStored) {
        request.push({ key, kind: 'secret' });
      }
    } else if (row.value.trim()) {
      request.push({ key, kind: row.kind, value: row.value.trim() });
    }
  }
  return request;
};

type ModelEnvEditorProps = {
  rows: ModelEnvEditorRow[];
  envStatus: ModelEnvStatus;
  showGatewayTemplate: boolean;
  onChange: (rows: ModelEnvEditorRow[]) => void;
};

/** Used by ModelLibraryPanel to edit a custom model's env rows (value/secret/envref/unset) with masked secrets and live envref status. */
export default function ModelEnvEditor({ rows, envStatus, showGatewayTemplate, onChange }: ModelEnvEditorProps) {
  const { t } = useTranslation('settings');

  const updateRow = (index: number, patch: Partial<ModelEnvEditorRow>) => {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };

  // A compile warning: an envref row whose server variable is unset would silently send nothing.
  const warnings = rows
    .filter((row) => row.kind === 'envref' && row.value.trim() && envStatus[row.value.trim()] === false)
    .map((row) => t('modelLibrary.env.warningEnvrefUnset', { name: row.value.trim() }));

  return (
    <div className="mt-4" data-testid="model-env-editor">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-foreground">{t('modelLibrary.env.title')}</p>
        <div className="flex items-center gap-1">
          {showGatewayTemplate && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-lg text-[11px]"
              onClick={() => onChange([...rows.filter((row) => !LLM_GATEWAY_TEMPLATE.some((entry) => entry.key === row.key)), ...LLM_GATEWAY_TEMPLATE])}
            >
              {t('modelLibrary.env.gatewayTemplate')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-lg text-[11px]"
            onClick={() => onChange([...rows, { key: '', kind: 'value', value: '', secretStored: false }])}
          >
            <Plus className="h-3 w-3" />
            {t('modelLibrary.env.addRow')}
          </Button>
        </div>
      </div>

      {rows.length === 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">{t('modelLibrary.env.empty')}</p>
      )}

      <div className="mt-2 space-y-2">
        {rows.map((row, index) => {
          const refName = row.value.trim();
          return (
            <div key={index} className="rounded-xl border border-border/60 bg-background/60 p-2" data-testid="model-env-row">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={row.key}
                  onChange={(event) => updateRow(index, { key: event.target.value })}
                  aria-label={t('modelLibrary.env.key')}
                  placeholder="ANTHROPIC_BASE_URL"
                  spellCheck={false}
                  className="h-8 min-w-0 flex-1 rounded-lg font-mono text-xs"
                />
                <select
                  value={row.kind}
                  onChange={(event) => updateRow(index, {
                    kind: event.target.value as ModelEnvEditorRow['kind'],
                    value: '',
                    secretStored: false,
                  })}
                  aria-label={t('modelLibrary.env.kind')}
                  className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                >
                  {ROW_KINDS.map((kind) => (
                    <option key={kind} value={kind}>{t(`modelLibrary.env.kinds.${kind}`)}</option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  aria-label={t('modelLibrary.env.removeRow')}
                  onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              {row.kind === 'secret' && (
                <div className="mt-2 flex items-center gap-2">
                  {row.secretStored && !row.value && (
                    <Badge variant="secondary" className="rounded-full text-[10px]" data-testid="secret-set-badge">
                      {t('modelLibrary.env.secretSet')}
                    </Badge>
                  )}
                  {/* Secrets are write-only: the input is always empty and typing replaces the stored value. */}
                  <Input
                    type="password"
                    value={row.value}
                    onChange={(event) => updateRow(index, { value: event.target.value })}
                    aria-label={t('modelLibrary.env.secretValue')}
                    placeholder={row.secretStored ? t('modelLibrary.env.secretReplace') : t('modelLibrary.env.secretEnter')}
                    autoComplete="new-password"
                    className="h-8 min-w-0 flex-1 rounded-lg text-xs"
                  />
                </div>
              )}

              {(row.kind === 'value' || row.kind === 'envref') && (
                <Input
                  value={row.value}
                  onChange={(event) => updateRow(index, { value: event.target.value })}
                  aria-label={row.kind === 'envref' ? t('modelLibrary.env.envrefName') : t('modelLibrary.env.value')}
                  placeholder={row.kind === 'envref' ? 'MY_GATEWAY_TOKEN' : ''}
                  spellCheck={false}
                  className="mt-2 h-8 rounded-lg font-mono text-xs"
                />
              )}

              {row.kind === 'envref' && (
                <div className="mt-1.5 space-y-1">
                  {refName && envStatus[refName] !== undefined && (
                    <Badge
                      variant={envStatus[refName] ? 'secondary' : 'destructive'}
                      className="rounded-full text-[10px]"
                      data-testid="envref-status"
                    >
                      {envStatus[refName] ? t('modelLibrary.env.envrefSet') : t('modelLibrary.env.envrefUnset')}
                    </Badge>
                  )}
                  <p className="text-[11px] leading-4 text-muted-foreground">{t('modelLibrary.env.envrefHelp')}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {warnings.map((warning) => (
        <div
          key={warning}
          role="status"
          data-testid="model-env-warning"
          className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          {warning}
        </div>
      ))}
    </div>
  );
}
