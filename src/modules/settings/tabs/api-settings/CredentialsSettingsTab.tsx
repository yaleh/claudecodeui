import { useTranslation } from 'react-i18next';

import { useCredentialsSettings } from '@/modules/settings/hooks/useCredentialsSettings';
import AccessTokensSection from '@/modules/settings/tabs/api-settings/sections/AccessTokensSection';
import GithubCredentialsSection from '@/modules/settings/tabs/api-settings/sections/GithubCredentialsSection';
import McpGatewaySection from '@/modules/settings/tabs/api-settings/sections/McpGatewaySection';
import NewAccessTokenAlert from '@/modules/settings/tabs/api-settings/sections/NewAccessTokenAlert';

/** Rendered by Settings for the "api" tab, managing CloudCLI personal access tokens and GitHub credentials. */
export default function CredentialsSettingsTab() {
  const { t } = useTranslation('settings');
  const {
    accessTokens,
    githubCredentials,
    loading,
    showNewTokenForm,
    setShowNewTokenForm,
    newTokenName,
    setNewTokenName,
    newTokenExpiryDays,
    setNewTokenExpiryDays,
    newlyCreatedToken,
    copiedToken,
    createAccessToken,
    revokeAccessToken,
    mcpGatewayStatus,
    newTokenScopes,
    toggleNewTokenScope,
    showNewGithubForm,
    setShowNewGithubForm,
    newGithubName,
    setNewGithubName,
    newGithubToken,
    setNewGithubToken,
    newGithubDescription,
    setNewGithubDescription,
    showToken,
    createGithubCredential,
    deleteGithubCredential,
    toggleGithubCredential,
    copyTokenToClipboard,
    dismissNewlyCreatedToken,
    cancelNewAccessTokenForm,
    cancelNewGithubForm,
    toggleNewGithubTokenVisibility,
  } = useCredentialsSettings({
    confirmRevokeAccessTokenText: t('accessTokens.list.revokeConfirm'),
    confirmDeleteGithubCredentialText: t('apiKeys.github.confirmDelete'),
  });

  if (loading) {
    return <div className="text-muted-foreground">{t('apiKeys.loading')}</div>;
  }

  return (
    <div className="space-y-8">
      {newlyCreatedToken && (
        <NewAccessTokenAlert
          token={newlyCreatedToken}
          copied={copiedToken}
          onCopy={copyTokenToClipboard}
          onDismiss={dismissNewlyCreatedToken}
        />
      )}

      <McpGatewaySection status={mcpGatewayStatus} />

      <AccessTokensSection
        accessTokens={accessTokens}
        showNewTokenForm={showNewTokenForm}
        newTokenName={newTokenName}
        newTokenExpiryDays={newTokenExpiryDays}
        newTokenScopes={newTokenScopes}
        onShowNewTokenFormChange={setShowNewTokenForm}
        onNewTokenNameChange={setNewTokenName}
        onNewTokenExpiryChange={setNewTokenExpiryDays}
        onToggleNewTokenScope={toggleNewTokenScope}
        onCreateAccessToken={createAccessToken}
        onCancelCreateAccessToken={cancelNewAccessTokenForm}
        onRevokeAccessToken={revokeAccessToken}
      />

      <GithubCredentialsSection
        githubCredentials={githubCredentials}
        showNewGithubForm={showNewGithubForm}
        showNewTokenPlainText={Boolean(showToken.new)}
        newGithubName={newGithubName}
        newGithubToken={newGithubToken}
        newGithubDescription={newGithubDescription}
        onShowNewGithubFormChange={setShowNewGithubForm}
        onNewGithubNameChange={setNewGithubName}
        onNewGithubTokenChange={setNewGithubToken}
        onNewGithubDescriptionChange={setNewGithubDescription}
        onToggleNewTokenVisibility={toggleNewGithubTokenVisibility}
        onCreateGithubCredential={createGithubCredential}
        onCancelCreateGithubCredential={cancelNewGithubForm}
        onToggleGithubCredential={toggleGithubCredential}
        onDeleteGithubCredential={deleteGithubCredential}
      />

    </div>
  );
}
