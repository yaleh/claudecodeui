import { useCallback, useSyncExternalStore } from 'react';

import { api, readApiJson } from '@/shared/api';
import type {
  ResidentProcessState,
  SessionHostBindingView,
  SessionHostLeaseKind,
  SessionHostStateView,
  SessionHostView,
  SessionHostsSnapshot,
} from '@/shared/types';

/**
 * The resident-process snapshot, shared by every reader on the page.
 *
 * Consumed by the sidebar (the mark beside a session's provider logo), by the
 * chat transcript (the status bar and its popover) and by the composer (which
 * needs the session's stored lifecycle mode to know what its stop button means).
 * They all read one store rather than polling for themselves: three components
 * each holding their own copy would let the sidebar and the status bar disagree
 * about the same host for as long as their intervals were out of step, and the
 * readings that matter here are exactly the comparisons between them.
 *
 * Polling, not push, because the server publishes no event for this: host state
 * changes as turns start and end, and `GET /api/session-hosts` is the only face
 * that reports it. The interval is short enough that a state change is visible
 * within a beat of happening and long enough not to hammer the endpoint; it is
 * suspended while the tab is hidden, since nothing is looking at the result.
 */

/** How often the snapshot is re-read while the tab is visible. */
const REFRESH_INTERVAL_MS = 1000;

type SessionHostsStoreState = {
  /** The last snapshot read, or null before the first answer. */
  snapshot: SessionHostsSnapshot | null;
  /** The message from the last failed read, or null when the last read succeeded. */
  error: string | null;
  /** True while a read is in flight and no snapshot has ever been read. */
  loading: boolean;
};

let state: SessionHostsStoreState = { snapshot: null, error: null, loading: false };

const listeners = new Set<() => void>();

/** The one poller, started by the first subscriber and stopped by the last. */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** The in-flight read, so overlapping refreshes collapse into one request. */
let inFlight: Promise<void> | null = null;

function emit(next: SessionHostsStoreState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

async function readSnapshot(): Promise<void> {
  try {
    const response = await api.sessionHosts.list();
    const body = await readApiJson<{ data?: SessionHostsSnapshot }>(response);
    emit({ snapshot: body.data ?? { hosts: [], sessions: [] }, error: null, loading: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The previous snapshot is kept: a single failed poll is not evidence that
    // every process went away, and clearing the marks on a blip would make the
    // UI claim a host has stopped when nothing said so. Re-emitting the same
    // message would re-render every subscriber for nothing, so it is not.
    if (message !== state.error) {
      emit({ ...state, error: message, loading: false });
    }
  }
}

/** Re-reads the snapshot. Concurrent callers share one request. */
function refreshSessionHosts(): Promise<void> {
  if (!inFlight) {
    inFlight = readSnapshot().finally(() => {
      inFlight = null;
    });
  }

  return inFlight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (listeners.size === 1) {
    void refreshSessionHosts();
    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      void refreshSessionHosts();
    }, REFRESH_INTERVAL_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}

function readState(): SessionHostsStoreState {
  return state;
}

/**
 * Finds the live host holding one session, or null.
 *
 * A closed host is skipped rather than returned: its record stays in the
 * listing for a retention window, and a reader treating it as a live process
 * would answer the opposite of what the process's own existence says.
 */
export function findLiveHost(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string,
): SessionHostView | null {
  if (!snapshot) {
    return null;
  }

  for (const host of snapshot.hosts) {
    if (host.state === 'closed') {
      continue;
    }
    if (host.bindings.some((binding) => binding.appSessionId === appSessionId)) {
      return host;
    }
  }

  return null;
}

/**
 * The host that most recently served one session, closed or not.
 *
 * Unlike {@link findLiveHost} this keeps a closed record, because the two
 * questions a reader asks about a resident session need opposite answers from
 * the same listing: "is it running" must not count a host that has already
 * closed, while "what happened to it" can only be answered by the record that
 * closed — its `closeReason` and `closeDetail` are the whole content of the
 * exited state. The last match wins, so a session that was restarted reads as
 * its newest host rather than its oldest.
 */
export function findSessionHost(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string,
): SessionHostView | null {
  if (!snapshot) {
    return null;
  }

  let found: SessionHostView | null = null;
  for (const host of snapshot.hosts) {
    if (host.bindings.some((binding) => binding.appSessionId === appSessionId)) {
      found = host;
    }
  }

  return found;
}

/** The binding one session has on a host, or null when no live host holds it. */
export function findBinding(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string,
): SessionHostBindingView | null {
  const host = findLiveHost(snapshot, appSessionId);
  return host?.bindings.find((binding) => binding.appSessionId === appSessionId) ?? null;
}

/** How many leases of one kind a binding holds. */
export function countLeases(binding: SessionHostBindingView | null, kind: SessionHostLeaseKind): number {
  return binding ? binding.leases.filter((lease) => lease.kind === kind).length : 0;
}

/**
 * The stored state of one session: its lifecycle mode, whether a live host is
 * holding it, and — for a resident session with no host — why not.
 *
 * This is the reading that survives a restart, which is why the sidebar's mark
 * for a resident session nobody has started comes from here and not from the
 * (absent) host: "should be running and isn't" is a different fact from "is
 * running", and only this half reports it.
 */
export function findSessionHostState(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string,
): SessionHostStateView | null {
  return snapshot?.sessions.find((session) => session.appSessionId === appSessionId) ?? null;
}

/** The shape drawn for each process state — the marks §15.1 of the proposal pins. */
export const RESIDENT_MARK_SHAPES: Record<ResidentProcessState, string> = {
  unstarted: 'hollow',
  idle: 'solid',
  busy: 'solid+spinner',
  exited: 'exited',
};

/**
 * The UI's word for the state a host is in, or `unstarted` when there is no host.
 *
 * The host's own state machine has six members and the UI has four, so the two
 * have to be reconciled somewhere; this is the only place that happens, and
 * every reader of a process state goes through it. A closed host is kept out of
 * "is it running" but not out of "what happened to it": its `closeReason` is the
 * difference between a session the user closed — which is back to not running —
 * and one whose process died on its own, which keeps the exited state until
 * something restarts it.
 *
 * Total by construction: `idle`, `lingering` and `closing` all land on `idle`,
 * because in none of them is a turn in flight. A lease held open by background
 * work is exactly the case that must not read as busy.
 */
export function readResidentProcessState(host: SessionHostView | null): ResidentProcessState {
  if (!host) {
    return 'unstarted';
  }

  if (host.state === 'closed') {
    return host.closeReason === 'exited' ? 'exited' : 'unstarted';
  }

  if (host.state === 'busy' || host.state === 'starting') {
    return 'busy';
  }

  return 'idle';
}

export type UseSessionHostsResult = {
  snapshot: SessionHostsSnapshot | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Asks the server to start the session's resident process. */
  start: (appSessionId: string) => Promise<void>;
  /** Asks the server to close it. Destructive: the process ends. */
  close: (appSessionId: string) => Promise<void>;
};

/**
 * Subscribes to the shared snapshot and returns it with the two lifecycle verbs.
 *
 * The verbs re-read the snapshot on success so a caller's next render already
 * sees the state its own request produced; on failure they re-throw the server's
 * refusal (a session that is not resident, a session that does not exist) so a
 * caller can show it rather than silently doing nothing.
 */
export function useSessionHosts(): UseSessionHostsResult {
  const store = useSyncExternalStore(subscribe, readState, readState);

  const start = useCallback(async (appSessionId: string): Promise<void> => {
    await api.sessionHosts.start(appSessionId);
    await refreshSessionHosts();
  }, []);

  const close = useCallback(async (appSessionId: string): Promise<void> => {
    await api.sessionHosts.close(appSessionId);
    await refreshSessionHosts();
  }, []);

  return {
    snapshot: store.snapshot,
    error: store.error,
    loading: store.loading,
    refresh: refreshSessionHosts,
    start,
    close,
  };
}
