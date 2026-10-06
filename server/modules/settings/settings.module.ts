import {
  accessTokensDb,
  credentialsDb,
  mcpAuditLogDb,
  notificationPreferencesDb,
  oauthClientsDb,
  pushSubscriptionsDb,
} from '@/modules/database/index.js';
import {
  createMcpAuditReader,
  MCP_GATEWAY_PATH,
  readMcpGatewayGate,
} from '@/modules/mcp-gateway/index.js';
import {
  createNotificationEvent,
  getPublicKey,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';
import { createAccessTokensService } from '@/modules/oauth/index.js';

import { createSettingsRouter } from './settings.routes.js';
import { createSettingsService } from './settings.service.js';

const accessTokensService = createAccessTokensService({ now: () => new Date() });

const settingsService = createSettingsService({
  credentials: {
    list: (userId, type) => credentialsDb.getCredentials(userId, type),
    create: (userId, name, type, value, description) =>
      credentialsDb.createCredential(userId, name, type, value, description),
    remove: (userId, credentialId) => credentialsDb.deleteCredential(userId, credentialId),
    toggle: (userId, credentialId, isActive) =>
      credentialsDb.toggleCredential(userId, credentialId, isActive),
  },
  notifications: {
    getPreferences: (userId) => notificationPreferencesDb.getPreferences(userId),
    updatePreferences: (userId, preferences) =>
      notificationPreferencesDb.updatePreferences(userId, preferences),
    createEnabledEvent: () => createNotificationEvent({
      provider: 'system', kind: 'info', code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' }, severity: 'info',
    }),
    notifyUser: (userId, event) => notifyUserIfEnabled({ userId, event }),
  },
  pushSubscriptions: {
    save: (userId, endpoint, p256dh, auth) =>
      pushSubscriptionsDb.saveSubscription(userId, endpoint, p256dh, auth),
    remove: (endpoint) => pushSubscriptionsDb.removeSubscription(endpoint),
  },
  getVapidPublicKey: getPublicKey,
  // The gate is read through the mcp-gateway module's own reader and the path
  // comes from that module too, so settings never re-parses `MCP_ENABLED` and
  // the reported path cannot drift from the one the transport mounts at.
  mcpGateway: {
    readGate: () => readMcpGatewayGate(),
    path: MCP_GATEWAY_PATH,
    publicBaseUrl: () => process.env.PUBLIC_BASE_URL?.trim() || null,
  },
  accessTokens: {
    list: (userId) => accessTokensDb.listByUser(userId),
    findById: (tokenId) => accessTokensDb.findById(tokenId),
    issue: (input) => accessTokensService.issueToken(input),
    revoke: (tokenId) => accessTokensService.revokeToken(tokenId),
  },
  // The MCP-audit readback (AC-304): the reader owns ownership + the write-only
  // default; these are the production seams it reads. A user's rows are the rows
  // of that user's token ids (the audit table has no user_id column), and a row's
  // client name comes from the OAuth client when it has one, else the PAT's own
  // name (a PAT has a null `client_id`).
  mcpAudit: createMcpAuditReader({
    listTokenIdsForUser: (userId) => accessTokensDb.listByUser(userId).map((token) => token.id),
    listRowsForTokens: (tokenIds, limit, excludeTools) =>
      mcpAuditLogDb.listForTokens(tokenIds, { limit, excludeTools }),
    resolveClientName: (row) =>
      row.client_id !== null
        ? (oauthClientsDb.findById(row.client_id)?.client_name ?? 'mcp client')
        : row.token_id !== null
          ? (accessTokensDb.findById(row.token_id)?.name ?? 'personal access token')
          : null,
  }),
});

/** Settings router assembled for the authenticated server mount. */
export const settingsRoutes = createSettingsRouter(settingsService);
