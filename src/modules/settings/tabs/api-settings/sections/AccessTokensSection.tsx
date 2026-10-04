import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '@/shared/ui';
import type { AccessTokenItem } from '@/shared/types';

/** The only lifetimes a personal access token may be created with; the server rejects anything else. */
const EXPIRY_DAY_OPTIONS = [7, 30, 90] as const;

type AccessTokensSectionProps = {
  accessTokens: AccessTokenItem[];
  showNewTokenForm: boolean;
  newTokenName: string;
  newTokenExpiryDays: number;
  onShowNewTokenFormChange: (value: boolean) => void;
  onNewTokenNameChange: (value: string) => void;
  onNewTokenExpiryChange: (days: number) => void;
  onCreateAccessToken: () => void;
  onCancelCreateAccessToken: () => void;
  onRevokeAccessToken: (tokenId: number) => void;
};

/** Rendered by CredentialsSettingsTab to list, create and revoke personal access tokens. */
export default function AccessTokensSection({
  accessTokens,
  showNewTokenForm,
  newTokenName,
  newTokenExpiryDays,
  onShowNewTokenFormChange,
  onNewTokenNameChange,
  onNewTokenExpiryChange,
  onCreateAccessToken,
  onCancelCreateAccessToken,
  onRevokeAccessToken,
}: AccessTokensSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          <h3 className="text-lg font-semibold">{t('accessTokens.title')}</h3>
        </div>
        <Button size="sm" onClick={() => onShowNewTokenFormChange(!showNewTokenForm)}>
          <Plus className="mr-1 h-4 w-4" />
          {t('accessTokens.newButton')}
        </Button>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t('accessTokens.description')}</p>

      {showNewTokenForm && (
        <div className="mb-4 rounded-lg border bg-card p-4">
          <Input
            placeholder={t('accessTokens.form.namePlaceholder')}
            value={newTokenName}
            onChange={(event) => onNewTokenNameChange(event.target.value)}
            className="mb-2"
          />
          <label className="mb-2 block text-sm text-muted-foreground">
            {t('accessTokens.form.expiryLabel')}
            <select
              data-testid="access-token-expiry"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              value={newTokenExpiryDays}
              onChange={(event) => onNewTokenExpiryChange(Number(event.target.value))}
            >
              {EXPIRY_DAY_OPTIONS.map((days) => (
                <option key={days} value={days}>
                  {t('accessTokens.form.expiryOption', { days })}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <Button onClick={onCreateAccessToken}>{t('accessTokens.form.createButton')}</Button>
            <Button variant="outline" onClick={onCancelCreateAccessToken}>
              {t('accessTokens.form.cancelButton')}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {accessTokens.length === 0 ? (
          <p className="text-sm italic text-muted-foreground">{t('accessTokens.list.empty')}</p>
        ) : (
          accessTokens.map((token) => {
            const isRevoked = token.revokedAt !== null;
            return (
              <div
                key={token.id}
                data-testid="access-token-row"
                data-token-id={token.id}
                data-token-prefix={token.tokenPrefix}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{token.name || t('accessTokens.list.unnamed')}</div>
                  <code className="text-xs text-muted-foreground">{token.tokenPrefix}</code>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('accessTokens.list.expires')} {new Date(token.expiresAt).toLocaleDateString()}
                    {` - ${t('accessTokens.list.lastUsed')} `}
                    {token.lastUsed ? new Date(token.lastUsed).toLocaleDateString() : t('accessTokens.list.never')}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {isRevoked ? t('accessTokens.list.revoked') : t('accessTokens.list.active')}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isRevoked}
                    aria-label={t('accessTokens.list.revokeButton')}
                    onClick={() => onRevokeAccessToken(token.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('accessTokens.list.revokeButton')}
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
