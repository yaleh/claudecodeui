/** Default context window used when neither a profile nor CONTEXT_WINDOW supplies one. */
const DEFAULT_CONTEXT_WINDOW = 160_000;

function toPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// Consumed by providers (claude-runtime.provider.js, provider-token-usage.service.ts) so the token
// usage `total` follows the active launch profile: profile.contextWindow, then the CONTEXT_WINDOW
// env value, then 160000. Invalid (non-positive / non-numeric) values fall through to the next tier.
export function resolveContextWindow(
  profileContextWindow?: number | string | null,
  envValue: string | undefined = process.env.CONTEXT_WINDOW,
): number {
  return toPositiveInteger(profileContextWindow) ?? toPositiveInteger(envValue) ?? DEFAULT_CONTEXT_WINDOW;
}

const ALLOWED_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AUTOCOMPACT_'];
const ALLOWED_ENV_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ENABLE_TOOL_SEARCH', 'DISABLE_TELEMETRY']);
// Rejected even when a key also matches an allowed prefix.
const DENIED_ENV_KEYS = new Set([
  'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'SHELL', 'IFS',
  'PYTHONPATH', 'CLAUDE_CLI_PATH', 'CLAUDE_CONFIG_DIR',
]);

// Consumed by launch-profiles.service.ts (write and compile paths) as the single env key allowlist.
export function isAllowedLaunchEnvKey(key: string): boolean {
  if (DENIED_ENV_KEYS.has(key) || key.startsWith('DYLD_')) {
    return false;
  }
  return ALLOWED_ENV_KEYS.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}
