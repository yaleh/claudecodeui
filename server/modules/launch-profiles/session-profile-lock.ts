export type SessionProfileLockDecision = {
  /** The launch profile id the run must use; undefined when none is set. */
  effectiveId: string | undefined;
  /** True when the client's id should be persisted as the session's first lock. */
  shouldPersist: boolean;
  /** True when the client asked for a different profile than the locked one. */
  profileLocked: boolean;
};

function normalizeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Decides which launch profile a send runs with. The first send locks the
 * session to the client's profile; afterwards the stored value always wins.
 * A conflicting client value is reported via `profileLocked` instead of being
 * rejected, so the run continues. Never throws.
 */
// Consumed by the websocket module's chat gateway (dispatchRun) on every send.
export function resolveSessionProfileLock(
  storedId: unknown,
  clientId: unknown,
): SessionProfileLockDecision {
  const stored = normalizeId(storedId);
  const client = normalizeId(clientId);

  if (!stored) {
    return { effectiveId: client, shouldPersist: client !== undefined, profileLocked: false };
  }
  return { effectiveId: stored, shouldPersist: false, profileLocked: client !== undefined && client !== stored };
}
