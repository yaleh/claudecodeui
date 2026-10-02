/**
 * The browser's liveness reading for one session's activity dock.
 *
 * This is the wiring AC-183 deliberately left out: it feeds the pure freshness
 * machine from the app's own socket — the `chat_subscribed` hello and the
 * `activity.heartbeat` beat — so the dock has an authoritative "is the server
 * still there" reading instead of a local table nothing on a dead server can
 * clear.
 *
 * The mapping is deliberately conservative. Only the two gateway frames that
 * carry the activity contract count as evidence; provider messages do not,
 * because a replayed message's `timestamp` is when it was produced, not when
 * the server last spoke, and folding it in would move the elapsed anchor
 * backwards. The silence threshold is the one the server announced
 * (`unreachableAfterMs`) — never a client constant.
 *
 * Used by chat's `ActivityIndicator` and `ChatComposer`; the decision it feeds
 * is `deriveActivityDockView`, and its criterion is
 * `src/modules/chat/tests/activityDockUnreachable.test.tsx`.
 */

import { useContext, useEffect, useReducer, useRef } from 'react';

import WebSocketContext from '@/shared/context/WebSocketContext';
import type { ActivityConnection, ServerEvent } from '@/shared/types';
import {
  createActivityFreshness,
  type ActivityFreshness,
  type ActivityLiveness,
} from '@/modules/chat/utils/activityFreshness';

/** What the dock needs to know about liveness, with nothing transport-shaped in it. */
export type ActivityFreshnessReading = {
  /** Fresh while frames keep arriving; unreachable once the silence budget is spent. */
  liveness: ActivityLiveness;
  /** Server-derived elapsed ms of the turn, frozen while unreachable; null when unknown. */
  elapsedMs: number | null;
  /** True while the machine still holds a turn anchor the server confirmed. */
  hasTurnAnchor: boolean;
  /** True when a liveness channel exists at all; without one no unreachability can be claimed. */
  wired: boolean;
};

/** One session's machine plus the last threshold the server announced. */
type MachineSlot = {
  sessionId: string | null | undefined;
  machine: ActivityFreshness;
  staleAfter: number | null;
};

/** A server time reading from either an ISO string or an epoch-milliseconds number. */
const parseServerTime = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

/** A strictly positive finite number, or null — the guard the threshold fields need. */
const positiveNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

export const useActivityFreshness = (
  sessionId?: string | null,
  connection?: ActivityConnection | null,
): ActivityFreshnessReading => {
  // The context is read directly rather than through `useWebSocket` so a unit
  // test can render the dock with no provider and hand it its own channel.
  const contextConnection = useContext(WebSocketContext);
  const activeConnection = connection ?? contextConnection;
  const subscribe = activeConnection?.subscribe;
  const isConnected = activeConnection?.isConnected ?? false;
  const wired = Boolean(activeConnection);

  // The machine mutates outside React, so every frame and connection change is
  // answered with one forced render — the dock never depends on a parent commit.
  const [, forceRender] = useReducer((count: number) => count + 1, 0);

  const slotRef = useRef<MachineSlot | null>(null);
  if (slotRef.current === null || slotRef.current.sessionId !== sessionId) {
    // A navigation to another session starts from no evidence again: the old
    // machine's timers are dropped so they cannot fire against an unused slot.
    slotRef.current?.machine.dispose();
    slotRef.current = { sessionId, machine: createActivityFreshness(), staleAfter: null };
  }
  const slot = slotRef.current;

  useEffect(() => {
    if (!subscribe) {
      return undefined;
    }

    const listener = (event: ServerEvent) => {
      const { machine } = slot;

      if (event.kind === 'chat_subscribed') {
        if (sessionId && event.sessionId !== sessionId) return;

        const asOf = parseServerTime(event.timestamp);
        if (asOf === null) return;
        // The hello is where a threshold is announced; remember it for the
        // heartbeats, which are bare and carry no timings of their own.
        const announced = positiveNumber(event.unreachableAfterMs);
        if (announced !== null) {
          slot.staleAfter = announced;
        }
        if (slot.staleAfter === null) return;

        const bootId = typeof event.bootId === 'string' ? event.bootId : '';
        const rev = typeof event.rev === 'number' ? event.rev : 0;
        const snapshot = machine.getSnapshot();
        // Carry the turn's anchor across a re-subscribe while the same server
        // process is in force, so a reconnect does not restart the clock. A new
        // boot identity voids it: that turn belonged to a process that is gone.
        const sameIdentity = snapshot.bootId !== null && snapshot.bootId === bootId;
        const carriedStart = sameIdentity && snapshot.turnStartedAt !== null ? snapshot.turnStartedAt : asOf;
        const turn = event.isProcessing === true ? { startedAt: carriedStart } : { startedAt: null };

        machine.onFrame({ bootId, rev, asOf, staleAfter: slot.staleAfter, turn });
        forceRender();
        return;
      }

      if (event.kind === 'activity.heartbeat') {
        if (sessionId && event.sessionId !== sessionId) return;
        // A heartbeat before any hello has no threshold to judge against.
        if (slot.staleAfter === null) return;

        const asOf = parseServerTime(event.timestamp);
        if (asOf === null) return;

        machine.onFrame({
          bootId: typeof event.bootId === 'string' ? event.bootId : '',
          rev: typeof event.rev === 'number' ? event.rev : 0,
          asOf,
          staleAfter: slot.staleAfter,
        });
        forceRender();
      }
    };

    return subscribe(listener);
  }, [subscribe, sessionId, slot, forceRender]);

  useEffect(() => {
    if (isConnected) {
      return;
    }
    // The socket is gone; degrade now rather than waiting the budget out. This
    // leaves the turn and its anchor untouched, so the elapsed reading freezes.
    slot.machine.onSocketClose();
    forceRender();
  }, [isConnected, slot, forceRender]);

  // A live one-second tick keeps the dock mounted even when no frame is arriving.
  // It cannot make the elapsed reading advance: that comes from the server's
  // `asOf`, so an unreachable turn keeps the same number across every tick.
  useEffect(() => {
    const timer = setInterval(() => forceRender(), 1_000);
    return () => clearInterval(timer);
  }, [forceRender]);

  const snapshot = slot.machine.getSnapshot();

  return {
    liveness: snapshot.liveness,
    elapsedMs: slot.machine.getElapsedMs(),
    hasTurnAnchor: snapshot.turnStartedAt !== null,
    wired,
  };
};
