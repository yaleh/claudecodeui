/**
 * Runtime switches for the voice pipeline.
 *
 * Two things about the voice path have to be drivable from outside the app: whether a recording is
 * trimmed before it is uploaded, and whether the trim's own readings are printed. Neither can be a
 * build-time constant — `import.meta.env.DEV` is false in the bundle an end-to-end run loads, which
 * is exactly the artifact whose behaviour has to be judged — so both are named in the URL
 * (`?voiceTrim=off`, `?voiceDebug=1`) and remembered in `localStorage`.
 *
 * The URL is how a switch is *set*; storage is where it *lives*. A switch the URL names is written
 * back on load, so it survives the reload and the route changes that follow — a value that only
 * ever existed in the query string would be dropped the moment the router rewrote the URL.
 *
 * The query string is read once, when this module is first evaluated. That is the moment the
 * document still carries it, and an SPA route change afterwards must not unset a switch somebody
 * asked for.
 */

/** Where the remembered switches live. One JSON object, so a switch is never half-written. */
const STORAGE_KEY = 'voiceDebugFlags';

/**
 * The switches this module knows how to read. A key outside this set — in the URL or in storage —
 * is ignored rather than remembered, so a typo cannot quietly become a setting.
 */
const KNOWN_FLAGS = ['voiceDebug', 'voiceTrim'] as const;

type VoiceFlagName = (typeof KNOWN_FLAGS)[number];

/**
 * The values that switch a flag off. Everything else that is set, including an empty value, is on:
 * `?voiceDebug=` and `?voiceDebug=1` mean the same thing, and only an explicit off does not.
 */
const OFF_VALUES = ['off', '0', 'false'];

const isFlagName = (key: string): key is VoiceFlagName =>
  (KNOWN_FLAGS as readonly string[]).includes(key);

/** The switches the document's URL names, or none outside a browser. */
function flagsFromUrl(): Partial<Record<VoiceFlagName, string>> {
  const found: Partial<Record<VoiceFlagName, string>> = {};
  if (typeof window === 'undefined') return found;
  for (const [key, value] of new URLSearchParams(window.location.search)) {
    if (isFlagName(key)) found[key] = value;
  }
  return found;
}

/**
 * The remembered switches. Storage can be unavailable — private browsing, storage disabled, a
 * document whose origin is opaque — and the voice path must not fail because of it: with no
 * storage there is simply nothing remembered, and the defaults apply.
 */
function flagsFromStorage(): Partial<Record<VoiceFlagName, string>> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const found: Partial<Record<VoiceFlagName, string>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isFlagName(key) && typeof value === 'string') found[key] = value;
    }
    return found;
  } catch {
    // Unreadable or unparseable: treated as "nothing remembered" rather than as an error, for the
    // same reason a refused write below is. A switch is a debugging affordance, not user data.
    return {};
  }
}

function rememberFlags(flags: Partial<Record<VoiceFlagName, string>>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch {
    /* Storage refused the write; the switch still applies to this load. */
  }
}

/**
 * The switches in force for this page: what the URL named, over what was remembered.
 *
 * Written back when the URL named anything, out of the same two halves the read used, so a load
 * that sets one switch keeps the other one's remembered value instead of wiping it.
 */
const ACTIVE_FLAGS: Partial<Record<VoiceFlagName, string>> = (() => {
  const fromUrl = flagsFromUrl();
  const active = { ...flagsFromStorage(), ...fromUrl };
  if (Object.keys(fromUrl).length > 0) rememberFlags(active);
  return active;
})();

function readFlag(name: VoiceFlagName): string | undefined {
  return ACTIVE_FLAGS[name];
}

/**
 * Whether a recording should have its silence trimmed before it is uploaded.
 *
 * On unless something turned it off: the trim is the shipped behaviour, and a switch that has to be
 * set for the normal path is a switch that can be forgotten. The caller reads this per recording
 * rather than caching it, so a route change that follows a load cannot leave it stale.
 */
export function isVoiceTrimEnabled(): boolean {
  const value = readFlag('voiceTrim');
  return value === undefined || !OFF_VALUES.includes(value.trim().toLowerCase());
}

/**
 * Whether the voice path's own affordances are on show: the audio-file upload entry beside the
 * microphone, and the readings the chain prints about what it did with the audio.
 *
 * Off unless something turned it on, which is the opposite default to the trim's and for the same
 * reason: the trim is the shipped behaviour and this is the instrumentation for it. A switch that has
 * to be set for the normal path is a switch that can be forgotten; an extra entry in everyone's
 * composer and a reading in everyone's console is not something to make the normal path carry.
 *
 * The value is the one the flags above resolved, so `?voiceDebug=1` turns it on for this load and
 * remembers it — which is what lets an end-to-end run name the switch in the URL and then navigate.
 */
export function isVoiceDebugEnabled(): boolean {
  const value = readFlag('voiceDebug');
  return value !== undefined && !OFF_VALUES.includes(value.trim().toLowerCase());
}
