import { normalizeAccessTokenScopes } from '@/modules/oauth/index.js';
import { AppError } from '@/shared/utils.js';

type NotificationPreferences = Record<string, unknown> & {
  channels?: Record<string, unknown> & { webPush?: boolean };
};

/**
 * A persisted access-token row as the token store returns it. `token_hash` is
 * present because it is the storage form; the settings projection deliberately
 * omits it so a list response can never leak the hash.
 */
type StoredAccessToken = {
  id: number;
  user_id: number;
  token_prefix: string;
  name: string | null;
  scopes: string;
  expires_at: string;
  created_at: string | null;
  last_used: string | null;
  revoked_at: string | null;
};

/**
 * The token-store operations Settings delegates to. Satisfied by the OAuth
 * module's `AccessTokensService` (issue/revoke) plus the access-token repository
 * (list/find); the settings service owns the projection and the ownership check
 * so this module never imports the OAuth implementation directly.
 */
type AccessTokensPort = {
  list(userId: number): StoredAccessToken[];
  findById(tokenId: number): StoredAccessToken | undefined;
  issue(input: {
    userId: number;
    name?: string | null;
    scopes: string[];
    expiresInDays?: number | null;
  }):
    | { ok: true; token: { id: number; token: string; tokenPrefix: string; expiresAt: string } }
    | { ok: false; reason: string };
  /** Stamps `revoked_at`; true only when a live row matched. Ownership is checked by the caller. */
  revoke(tokenId: number): boolean;
};

type SettingsDependencies = {
  credentials: {
    list(userId: number, credentialType: string | null): unknown[];
    create(
      userId: number,
      name: string,
      type: string,
      value: string,
      description: string | null,
    ): unknown;
    remove(userId: number, credentialId: number): boolean;
    toggle(userId: number, credentialId: number, isActive: boolean): boolean;
  };
  notifications: {
    getPreferences(userId: number): NotificationPreferences | undefined;
    updatePreferences(userId: number, preferences: NotificationPreferences): unknown;
    createEnabledEvent(): unknown;
    notifyUser(userId: number, event: unknown): void | Promise<void>;
  };
  pushSubscriptions: {
    save(userId: number, endpoint: string, p256dh: string, auth: string): void;
    remove(endpoint: string): void;
  };
  getVapidPublicKey(): string | null;
  accessTokens: AccessTokensPort;
};

/** The only lifetimes a personal access token may request, in days. */
const ALLOWED_TOKEN_EXPIRY_DAYS: readonly number[] = [7, 30, 90];

/** Lifetime applied when the caller omits `expiresInDays`. */
const DEFAULT_TOKEN_EXPIRY_DAYS = 30;

/** Scopes applied when the caller omits them; the read scope is the required baseline. */
const DEFAULT_TOKEN_SCOPES: readonly string[] = ['cloudcli:read'];

/**
 * Projects a stored row to the client-facing token shape. Written as an
 * allowlist: `token_hash` is never copied, so the hash cannot reach a response
 * even if the storage row grows new secret columns.
 */
function projectAccessToken(row: StoredAccessToken) {
  return {
    id: row.id,
    tokenPrefix: row.token_prefix,
    name: row.name,
    scopes: JSON.parse(row.scopes) as string[],
    expiresAt: row.expires_at,
    lastUsed: row.last_used,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function requiredString(value: unknown, fieldName: string, code: string): string {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedValue) {
    throw new AppError(`${fieldName} is required`, { code, statusCode: 400 });
  }
  return normalizedValue;
}

function assertFound(found: boolean, resourceName: string, code: string): void {
  if (!found) {
    throw new AppError(`${resourceName} not found`, { code, statusCode: 404 });
  }
}

/** Creates settings workflows with repositories and notification effects injected. */
export function createSettingsService(dependencies: SettingsDependencies) {
  return {
    listCredentials(userId: number, credentialType: string | null) {
      return { credentials: dependencies.credentials.list(userId, credentialType) };
    },
    createCredential(userId: number, input: Record<string, unknown>) {
      const credentialName = requiredString(
        input.credentialName,
        'Credential name',
        'CREDENTIAL_NAME_REQUIRED',
      );
      const credentialType = requiredString(
        input.credentialType,
        'Credential type',
        'CREDENTIAL_TYPE_REQUIRED',
      );
      const credentialValue = requiredString(
        input.credentialValue,
        'Credential value',
        'CREDENTIAL_VALUE_REQUIRED',
      );
      const description = typeof input.description === 'string'
        ? input.description.trim() || null
        : null;
      return {
        success: true,
        credential: dependencies.credentials.create(
          userId,
          credentialName,
          credentialType,
          credentialValue,
          description,
        ),
      };
    },
    deleteCredential(userId: number, credentialId: number) {
      assertFound(
        dependencies.credentials.remove(userId, credentialId),
        'Credential',
        'CREDENTIAL_NOT_FOUND',
      );
      return { success: true };
    },
    toggleCredential(userId: number, credentialId: number, isActive: unknown) {
      if (typeof isActive !== 'boolean') {
        throw new AppError('isActive must be a boolean', {
          code: 'INVALID_ACTIVE_STATE',
          statusCode: 400,
        });
      }
      assertFound(
        dependencies.credentials.toggle(userId, credentialId, isActive),
        'Credential',
        'CREDENTIAL_NOT_FOUND',
      );
      return { success: true };
    },
    listAccessTokens(userId: number) {
      return { tokens: dependencies.accessTokens.list(userId).map(projectAccessToken) };
    },
    createAccessToken(userId: number, input: Record<string, unknown>) {
      const name = requiredString(input.name, 'Token name', 'TOKEN_NAME_REQUIRED');
      const requestedDays = input.expiresInDays === undefined
        ? DEFAULT_TOKEN_EXPIRY_DAYS
        : input.expiresInDays;
      if (typeof requestedDays !== 'number' || !ALLOWED_TOKEN_EXPIRY_DAYS.includes(requestedDays)) {
        throw new AppError('expiresInDays must be one of 7, 30, 90', {
          code: 'INVALID_EXPIRES_IN',
          statusCode: 400,
        });
      }
      // An omitted scope list keeps the read baseline; anything explicit must
      // be a non-empty subset of the known vocabulary, deduplicated. An
      // explicit `[]` is rejected rather than defaulted.
      let scopes: string[];
      if (input.scopes === undefined) {
        scopes = [...DEFAULT_TOKEN_SCOPES];
      } else {
        const normalized = normalizeAccessTokenScopes(input.scopes);
        if (!normalized.ok) {
          throw new AppError('scopes must be a non-empty subset of known scopes', {
            code: 'INVALID_SCOPE',
            statusCode: 400,
          });
        }
        scopes = normalized.scopes;
      }

      const issued = dependencies.accessTokens.issue({ userId, name, scopes, expiresInDays: requestedDays });
      if (!issued.ok) {
        // The whitelist above rejects every lifetime the token store refuses, so
        // reaching here means the store and the settings policy disagree.
        throw new AppError('Access token could not be issued', {
          code: 'ACCESS_TOKEN_ISSUE_FAILED',
          statusCode: 500,
        });
      }
      const row = dependencies.accessTokens.findById(issued.token.id);
      return {
        token: {
          id: issued.token.id,
          name,
          tokenPrefix: issued.token.tokenPrefix,
          scopes,
          expiresAt: issued.token.expiresAt,
          lastUsed: row?.last_used ?? null,
          createdAt: row?.created_at ?? null,
          plaintext: issued.token.token,
        },
      };
    },
    revokeAccessToken(userId: number, tokenId: number) {
      const token = dependencies.accessTokens.findById(tokenId);
      assertFound(Boolean(token) && token?.user_id === userId, 'Access token', 'ACCESS_TOKEN_NOT_FOUND');
      assertFound(dependencies.accessTokens.revoke(tokenId), 'Access token', 'ACCESS_TOKEN_NOT_FOUND');
      return { success: true };
    },
    getNotificationPreferences(userId: number) {
      return { success: true, preferences: dependencies.notifications.getPreferences(userId) };
    },
    updateNotificationPreferences(userId: number, preferences: NotificationPreferences) {
      return {
        success: true,
        preferences: dependencies.notifications.updatePreferences(userId, preferences),
      };
    },
    getVapidPublicKey() {
      return { publicKey: dependencies.getVapidPublicKey() };
    },
    subscribeToPush(userId: number, input: Record<string, unknown>) {
      const endpoint = requiredString(input.endpoint, 'Endpoint', 'PUSH_SUBSCRIPTION_REQUIRED');
      const keys = typeof input.keys === 'object' && input.keys !== null
        ? input.keys as Record<string, unknown>
        : {};
      const p256dh = requiredString(keys.p256dh, 'p256dh', 'PUSH_SUBSCRIPTION_REQUIRED');
      const auth = requiredString(keys.auth, 'auth', 'PUSH_SUBSCRIPTION_REQUIRED');
      dependencies.pushSubscriptions.save(userId, endpoint, p256dh, auth);

      const currentPreferences = dependencies.notifications.getPreferences(userId);
      if (!currentPreferences?.channels?.webPush) {
        dependencies.notifications.updatePreferences(userId, {
          ...currentPreferences,
          channels: { ...currentPreferences?.channels, webPush: true },
        });
      }
      const event = dependencies.notifications.createEnabledEvent();
      void dependencies.notifications.notifyUser(userId, event);
      return { success: true };
    },
    unsubscribeFromPush(userId: number, endpointInput: unknown) {
      const endpoint = requiredString(endpointInput, 'Endpoint', 'PUSH_ENDPOINT_REQUIRED');
      dependencies.pushSubscriptions.remove(endpoint);
      const currentPreferences = dependencies.notifications.getPreferences(userId);
      if (currentPreferences?.channels?.webPush) {
        dependencies.notifications.updatePreferences(userId, {
          ...currentPreferences,
          channels: { ...currentPreferences.channels, webPush: false },
        });
      }
      return { success: true };
    },
  };
}
