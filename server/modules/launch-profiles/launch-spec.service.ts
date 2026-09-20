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
