/**
 * What the activity dock should say, derived from two independent readings.
 *
 * The dock is the one surface that must never lie about a turn: it reads the
 * client's local "a turn is running" table *and* the freshness of the server's
 * evidence, and speaks about whichever is more honest. This module is that
 * decision, kept pure — it takes the local activity, the liveness the freshness
 * machine last computed, and the server-derived elapsed time, and returns the
 * state, the elapsed seconds to draw, and whether the stop control is operable.
 *
 * The rule it encodes: **a turn with no fresh evidence is `unreachable`, not
 * `in-turn`**. The benign default — keep showing the turn because the local
 * table still has it — is exactly what let a dead server keep the dock
 * "thinking". The elapsed reading is passed through untouched and is never
 * recomputed from a local clock here; when the caller freezes it (because the
 * server's `asOf` stopped advancing), it stays frozen.
 *
 * Used by chat's activity dock (`ActivityIndicator`) and, for the composer's
 * stop entry, by `ChatComposer`; its criterion is
 * `src/modules/chat/tests/activityDockUnreachable.test.tsx`.
 */

import type { ActivityDockState, SessionActivity } from '@/shared/types';
import type { ActivityLiveness } from '@/modules/chat/utils/activityFreshness';

/** The i18n key (chat namespace) that explains why the stop is unavailable. */
export const UNREACHABLE_STOP_REASON_KEY = 'claudeStatus.unreachable.stopReason';

/** Everything `deriveActivityDockView` needs, each from the source that owns it. */
export type ActivityDockInput = {
  /** The session's local "processing" entry, or null when the table has none. */
  activity: SessionActivity | null;
  /** Whether the client's last liveness reading was fresh or unreachable. */
  liveness: ActivityLiveness;
  /** Server-derived elapsed time of the turn in ms, or null when unknown. */
  elapsedMs: number | null;
  /** True while the freshness machine still holds a turn anchor for this session. */
  hasTurnAnchor: boolean;
  /**
   * True when the dock is wired to a liveness channel at all. Without one the
   * client cannot assert unreachability, so the dock keeps the legacy reading
   * of the local activity — this is the only branch that does not degrade.
   */
  wired: boolean;
  /**
   * True when this surface owns an interrupt handler. The tab does; the inline
   * line does not, so it never draws a stop and can never report one disabled.
   */
  hasAbort: boolean;
  /**
   * True when the last send was never taken — the socket was gone, or no answer
   * came back inside the send deadline. It only speaks while there is no turn
   * to speak about: a session the local table still reports as running has a
   * turn, and that reading is what the dock owes the user. This is also what
   * makes the failure honest — a retained "processing" mark (the defect this
   * state exists to replace) leaves the turn branch in force and the dock never
   * reaches here.
   */
  sendFailed?: boolean;
};

/** The dock's decision: which state to publish and what the controls may do. */
export type ActivityDockView = {
  state: ActivityDockState;
  /** Server-derived elapsed in ms; null when there is nothing honest to show. */
  elapsedMs: number | null;
  /** Whole seconds of `elapsedMs`, for the elapsed label; null when unknown. */
  elapsedSeconds: number | null;
  /** Whether the dock draws a stop control at all for this state. */
  showStop: boolean;
  /** Whether that control must be disabled (unreachable only, today). */
  stopDisabled: boolean;
  /** i18n key explaining a disabled stop; null when the stop is operable. */
  stopReasonKey: string | null;
};

const HIDDEN: ActivityDockView = {
  state: 'hidden',
  elapsedMs: null,
  elapsedSeconds: null,
  showStop: false,
  stopDisabled: false,
  stopReasonKey: null,
};

/** The failed-send reading: a state of its own, and deliberately no turn. */
const SEND_FAILED: ActivityDockView = {
  state: 'send-failed',
  elapsedMs: null,
  elapsedSeconds: null,
  showStop: false,
  stopDisabled: false,
  stopReasonKey: null,
};

/** The elapsed fields both visible states share. */
const elapsedFields = (elapsedMs: number | null) => {
  const elapsed = elapsedMs !== null && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null;
  return {
    elapsedMs: elapsed,
    elapsedSeconds: elapsed === null ? null : Math.floor(elapsed / 1000),
  };
};

/**
 * Decide what the dock shows. Pure: same input, same output, no clock of its own.
 */
export const deriveActivityDockView = (input: ActivityDockInput): ActivityDockView => {
  const { activity, liveness, elapsedMs, hasTurnAnchor, wired, hasAbort, sendFailed = false } = input;
  const elapsed = elapsedFields(elapsedMs);

  // Nothing to speak about: no local turn and no anchor the server ever confirmed.
  // A send that was never taken is the one thing there is to say in that void —
  // reporting the failure is the honest reading, not staying silent as the old
  // indicator did while the message was already gone.
  if (activity === null && !hasTurnAnchor) {
    return sendFailed ? SEND_FAILED : HIDDEN;
  }

  // A wired dock with no fresh evidence reports the connection, not the turn. The
  // stop stays on screen where this surface owns one, so it says "I cannot reach
  // the server" with a greyed control rather than silently dropping the affordance.
  if (wired && liveness === 'unreachable') {
    return {
      state: 'unreachable',
      ...elapsed,
      showStop: hasAbort,
      stopDisabled: hasAbort,
      stopReasonKey: hasAbort ? UNREACHABLE_STOP_REASON_KEY : null,
    };
  }

  // Fresh (or unwired, where no liveness claim can be made): the turn is the story.
  return {
    state: 'in-turn',
    ...elapsed,
    showStop: hasAbort && (activity?.canInterrupt ?? true),
    stopDisabled: false,
    stopReasonKey: null,
  };
};
