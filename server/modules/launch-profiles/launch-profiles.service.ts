import { launchProfilesDb } from '@/modules/database/index.js';
import type { LaunchProfileInput, LaunchProfileRecord } from '@/modules/database/index.js';
// Transitional cross-module imports: the compile layer shared by the model library and this
// profile service now lives in the providers module. The launch-profiles teardown deletes this
// service, and these imports with it.
//
// The two values name the providers service file instead of the providers barrel on purpose. The
// barrel transitively reaches this module's own launch-profiles.module.js (the Claude runtime
// imports `resolveLaunchSpec` from the launch-profiles barrel, and the barrel re-exports
// launchProfilesRoutes from that module), whose body reads `launchProfilesService` while this file
// is still evaluating. Entering the barrel from here would close that cycle and deadlock on the
// binding (`ReferenceError: Cannot access 'launchProfilesService' before initialization`).
// launch-spec.service.js is a dependency leaf, so naming it re-enters nothing.
//
// The boundaries rule is knowingly waived for this one line. Its barrel form is unavailable for as
// long as the providers module still reaches this module (the Claude runtime imports
// `resolveLaunchSpec` from the launch-profiles barrel), and both halves of that edge — this import
// and that one — are removed by the launch-profiles teardown. Waived here rather than there because
// the illegal edge is inbound-to-providers: keeping it inside the file that dies leaves the
// providers barrel and runtime free of exceptions.
// eslint-disable-next-line boundaries/dependencies
import { isAllowedLaunchEnvKey, resolveContextWindow } from '@/modules/providers/services/launch-spec.service.js';
// The guard seam is a type: erased at compile time, so it can come from the barrel.
import type { LaunchSpecGuards } from '@/modules/providers/index.js';
import type { LLMProvider, ResolvedLaunchSpec } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const MODEL_ALIAS_ENV: Record<string, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

const DEFAULT_AUTH_TARGET = 'ANTHROPIC_AUTH_TOKEN';

// Re-exported for this module's tests (env-injection-closed.test.ts) so the type's move to the
// providers module does not ripple into them; transitional, removed with this service.
export type { LaunchSpecGuards };

/** Seam for the write-path key check; tests substitute a lax one to prove the guard is load-bearing. */
export type LaunchProfilesGuards = { isAllowedKey: (key: string) => boolean };

const DEFAULT_GUARDS = { isAllowedKey: isAllowedLaunchEnvKey };

function compileGatewayEnv(config: Record<string, unknown>, warnings: string[]): Record<string, string> {
  const env: Record<string, string> = {};

  if (typeof config.baseUrl === 'string' && config.baseUrl) {
    env.ANTHROPIC_BASE_URL = config.baseUrl;
  }

  if (config.authMode === 'envVar' && typeof config.authEnvVarName === 'string' && config.authEnvVarName) {
    const value = process.env[config.authEnvVarName];
    const target = typeof config.authEnvVarTarget === 'string' && config.authEnvVarTarget
      ? config.authEnvVarTarget
      : DEFAULT_AUTH_TARGET;
    if (value) {
      env[target] = value;
    } else {
      warnings.push(`Environment variable ${config.authEnvVarName} is not set; the gateway credential is missing`);
    }
  }

  const aliases = config.modelAliases;
  if (aliases && typeof aliases === 'object') {
    for (const [alias, envName] of Object.entries(MODEL_ALIAS_ENV)) {
      const model = (aliases as Record<string, unknown>)[alias];
      if (typeof model === 'string' && model) {
        env[envName] = model;
      }
    }
  }

  Object.assign(env, compileContextEnv(config, warnings));

  // Precedence: typed fields above (baseUrl, auth target, modelAliases, context fields) win over a same-named
  // config.env key. Allowlist filtering of the merged env happens in resolveLaunchSpec.
  const extra = config.env;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        warnings.push(`Environment variable ${key} in config.env must be a string and was dropped`);
      } else if (key in env) {
        warnings.push(`Environment variable ${key} in config.env is overridden by a typed profile field`);
      } else {
        env[key] = value;
      }
    }
  }

  return env;
}

/**
 * Typed context fields export the real CLI variables so the CLI behaves like the displayed window.
 * Best-effort: CLAUDE_CODE_MAX_CONTEXT_TOKENS and CLAUDE_CODE_AUTO_COMPACT_WINDOW are not in the
 * official env-vars docs (only CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is); they work but are unpublished.
 * Unset fields export nothing; invalid values are dropped with a warning.
 */
const CONTEXT_ENV_FIELDS: Array<{ field: string; envName: string; max: number }> = [
  { field: 'contextWindow', envName: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', max: Number.MAX_SAFE_INTEGER },
  { field: 'autoCompactWindow', envName: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', max: Number.MAX_SAFE_INTEGER },
  { field: 'autoCompactPct', envName: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', max: 100 },
];

function compileContextEnv(config: Record<string, unknown>, warnings: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { field, envName, max } of CONTEXT_ENV_FIELDS) {
    const raw = config[field];
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
    if (Number.isSafeInteger(value) && value > 0 && value <= max) {
      env[envName] = String(value);
    } else {
      warnings.push(`Profile field ${field} must be an integer between 1 and ${max} and was not exported`);
    }
  }
  return env;
}

/** Shell-path CLI flags from the profile's model settings; credentials never appear in argv. */
function compileArgv(config: Record<string, unknown>): string[] {
  const argv: string[] = [];
  if (typeof config.defaultModel === 'string' && config.defaultModel) {
    argv.push('--model', config.defaultModel);
  }
  if (typeof config.fallbackModel === 'string' && config.fallbackModel) {
    argv.push('--fallback-model', config.fallbackModel);
  }
  return argv;
}

/**
 * Resolves the launch spec for a provider run.
 * Consumed by the Claude SDK runtime and the shell websocket service so both
 * launch points share one env compilation step. Without a profile (passthrough)
 * env/argv overrides are empty; a gateway profile compiles to the endpoint,
 * the credential read from the host env var it names, and model aliases.
 */
export function resolveLaunchSpec(
  profileId: string | null,
  _provider: LLMProvider,
  guards: LaunchSpecGuards = DEFAULT_GUARDS,
): ResolvedLaunchSpec {
  const warnings: string[] = [];
  const profile = profileId ? launchProfilesDb.get(profileId) : null;
  if (profileId && !profile) {
    warnings.push(`Launch profile "${profileId}" was not found; running without a profile`);
  }

  // Re-validated on every compile so a row written around the service never reaches a spawn.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile ? compileGatewayEnv(profile.config, warnings) : {})) {
    if (guards.isAllowedKey(key)) {
      env[key] = value;
    } else {
      warnings.push(`Environment variable ${key} is not allowed in a launch profile and was dropped`);
    }
  }

  return {
    env,
    argv: profile ? compileArgv(profile.config) : [],
    contextWindow: resolveContextWindow(profile?.config.contextWindow as number | string | undefined),
    warnings,
  };
}

/** Payload keys that would carry an inline credential value; never persisted. */
const INLINE_SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'authtoken',
  'auth_token',
  'token',
  'secret',
  'password',
]);

/** Recursively finds an inline credential key so the value can never reach `config_json`. */
function findInlineSecretKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (INLINE_SECRET_KEYS.has(key.toLowerCase())) {
      return key;
    }
    const nested = findInlineSecretKey(child);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function assertConfigAllowed(config: Record<string, unknown>, guards: LaunchProfilesGuards): void {
  const offending = findInlineSecretKey(config);
  if (offending) {
    throw new AppError(
      `Launch profile config must not contain inline credential "${offending}"; reference an environment variable via authEnvVarName instead`,
      { code: 'LAUNCH_PROFILE_INLINE_CREDENTIAL', statusCode: 400 },
    );
  }
  const env = config.env;
  if (env !== undefined && env !== null) {
    if (typeof env !== 'object' || Array.isArray(env)) {
      throw new AppError('Launch profile config.env must be an object', {
        code: 'LAUNCH_PROFILE_ENV_KEY_DENIED',
        statusCode: 400,
      });
    }
    for (const key of Object.keys(env)) {
      if (!guards.isAllowedKey(key)) {
        throw new AppError(`Environment variable ${key} is not allowed in a launch profile`, {
          code: 'LAUNCH_PROFILE_ENV_KEY_DENIED',
          statusCode: 400,
        });
      }
    }
  }
  const target = config.authEnvVarTarget;
  if (typeof target === 'string' && target && !guards.isAllowedKey(target)) {
    throw new AppError(`Environment variable ${target} is not allowed in a launch profile`, {
      code: 'LAUNCH_PROFILE_ENV_KEY_DENIED',
      statusCode: 400,
    });
  }
}

// launchProfilesService: consumed by launch-profiles routes and tests; credentials are referenced only via `authEnvVarName`.
export const launchProfilesService = {
  /** Persists a profile, rejecting any payload that carries an inline credential value. */
  createProfile(input: LaunchProfileInput, guards: LaunchProfilesGuards = DEFAULT_GUARDS): void {
    assertConfigAllowed(input.config, guards);
    launchProfilesDb.create(input);
  },

  listProfiles(provider?: string): LaunchProfileRecord[] {
    return launchProfilesDb.list(provider);
  },

  getProfile(id: string): LaunchProfileRecord {
    const profile = launchProfilesDb.get(id);
    if (!profile) {
      throw new AppError(`Launch profile "${id}" not found`, { code: 'LAUNCH_PROFILE_NOT_FOUND', statusCode: 404 });
    }
    return profile;
  },

  /** Merges the submitted fields over the stored profile (absent fields are preserved) with the same validation as create. */
  updateProfile(
    id: string,
    patch: Partial<Omit<LaunchProfileInput, 'id'>>,
    guards: LaunchProfilesGuards = DEFAULT_GUARDS,
  ): void {
    const existing = launchProfilesService.getProfile(id);
    if (patch.config !== undefined) {
      assertConfigAllowed(patch.config, guards);
    }
    const { id: _id, ...current } = existing;
    const merged = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
    if (!launchProfilesDb.update(id, merged)) {
      throw new AppError(`Launch profile "${id}" not found`, { code: 'LAUNCH_PROFILE_NOT_FOUND', statusCode: 404 });
    }
  },

  deleteProfile(id: string): void {
    if (!launchProfilesDb.delete(id)) {
      throw new AppError(`Launch profile "${id}" not found`, { code: 'LAUNCH_PROFILE_NOT_FOUND', statusCode: 404 });
    }
  },
};
