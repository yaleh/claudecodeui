export { initializeDatabase } from '@/modules/database/init-db.js';
// runMigrations: the chain behind initializeDatabase, exported so a criterion in
// another module can drive migrations against a database it built by hand. The
// module boundary rule is why it is here rather than imported by file path.
export { runMigrations } from '@/modules/database/migrations.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { notificationChannelEndpointsDb } from '@/modules/database/repositories/notification-channel-endpoints.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
// providerModelsDb: used by Providers to persist user-managed custom model rows.
export { providerModelsDb } from '@/modules/database/repositories/provider-models.js';
// projectsDb: used by Projects, Worktrees, Git, WebSocket, and notification modules to persist and resolve project records.
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
// sessionDraftsDb: used by User for drafts and Scheduled Messages for server-owned queued turns.
export { sessionDraftsDb } from '@/modules/database/repositories/session-drafts.db.js';
export type {
  QueuedSessionMessageRecord,
  SessionDraftRecord,
} from '@/modules/database/repositories/session-drafts.db.js';
export {
  isSelfAssignedSessionName,
  sessionsDb,
  stripSelfAssignedSuffix,
} from '@/modules/database/repositories/sessions.db.js';
export type { SessionNameHiddenByFilterJson, SessionNameSource, SessionNameVisibility } from '@/modules/database/repositories/sessions.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
// userPreferencesDb: used by the User module to persist the settings that used to live in browser localStorage.
export { userPreferencesDb } from '@/modules/database/repositories/user-preferences.db.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
// voiceSettingsDb: used by the Voice module to serve the per-user voice backend settings that used to live in browser localStorage.
export { voiceSettingsDb } from '@/modules/database/repositories/voice-settings.db.js';
export { scheduledMessagesDb } from './repositories/scheduled-messages.db.js';
export type { ScheduledMessageRow, ScheduledMessageStatus } from './repositories/scheduled-messages.db.js';
