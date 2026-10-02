import { useCallback, useSyncExternalStore } from 'react';

import { api, readApiJson } from '@/shared/api';
import type {
  ResidentProcessState,
  SessionHostBindingView,
  SessionHostLeaseKind,
  SessionHostStateView,
  SessionHostView,
  SessionHostsSnapshot,
  SessionOccupiedBy,
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
    // The previous snapshot is kept *as data* — a single failed poll is not
    // evidence that every process went away, and throwing the listing out would
    // make the next successful read rebuild it from nothing. It is not kept as
    // the *reading*, though: the `error` on this state is what
    // `readResidentProcessState` folds into `unknown`, so a consumer sees "not
    // known" rather than the stale word the kept snapshot would otherwise
    // repeat. Re-emitting the same message would re-render every subscriber for
    // nothing, so it is not.
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

/**
 * Whether a live host is running a turn for one of the sessions it holds.
 *
 * Asked per *binding*, not per host, because one host can serve several sessions
 * and only some of them can be busy: a driver that declares `multiplexedHost`
 * puts every resident session of one provider on a single process, and a turn
 * opened for one of them is a lease on that binding alone — the others are held
 * open with nothing to do. A host-level rule would answer "running" for all of
 * them the moment any one was, which is exactly the number the badge must not
 * print: it would count a resident session between turns as one being worked on,
 * and the two groups below could not be disjoint.
 *
 * The turn lease is read directly rather than through `binding.state`, which the
 * server derives from the same list — one rule, stated once, in the place the
 * answer is used.
 */
function isRunningBinding(host: SessionHostView, binding: SessionHostBindingView): boolean {
  if (binding.leases.some((lease) => lease.kind === 'turn')) {
    return true;
  }

  // `starting` is the moment before any lease exists: the manager holds it from
  // the moment a process is asked for until it has answered, and the session
  // that asked is the one the user is waiting on — the same reason
  // `readResidentProcessState` folds it into `busy`. It is a host-level state,
  // so it is only read while the host holds the one binding it was started for:
  // a host is opened for a session and reused by later ones, so a shared host is
  // never `starting`, and a rule that did not say so would make the first
  // session's start read as every later session's too.
  //
  // `closing` does not count: a host on its way out has finished the work it was
  // doing, and counting it would make the badge hold a number for a process that
  // is already gone.
  return host.state === 'starting' && host.bindings.length === 1;
}

/** Every `(host, binding)` pair a live host is serving, in listing order. */
function liveBindings(
  snapshot: SessionHostsSnapshot | null,
): Array<{ host: SessionHostView; binding: SessionHostBindingView }> {
  const pairs: Array<{ host: SessionHostView; binding: SessionHostBindingView }> = [];
  for (const host of snapshot?.hosts ?? []) {
    if (host.state === 'closed') {
      continue;
    }
    for (const binding of host.bindings) {
      pairs.push({ host, binding });
    }
  }
  return pairs;
}

/**
 * The sessions a live host is running a turn for — the sidebar badge's whole
 * count, and the Running view's first group.
 *
 * Read from the host listing rather than from this page's own busy set, which is
 * the difference the badge exists to draw: a resident process between turns is
 * still a process, and a client-side set of in-flight turns cannot tell a
 * session that is being worked on from one that is merely being held open. Both
 * are "not finished", and only one of them is running.
 *
 * Every lifecycle mode is here, not only resident ones. A per-run session's
 * process lives exactly as long as its turn does, so a per-run host that is busy
 * *is* a session being worked on; excluding it would answer a narrower question
 * than the badge asks and would silently drop the turns the view was built to
 * show.
 */
export function listRunningSessionIds(snapshot: SessionHostsSnapshot | null): string[] {
  return liveBindings(snapshot)
    .filter(({ host, binding }) => isRunningBinding(host, binding))
    .map(({ binding }) => binding.appSessionId);
}

/**
 * The resident sessions held open between turns — the Running view's second
 * group, and the sessions the badge must NOT count.
 *
 * Restricted to `mode === 'resident'` hosts, because "held open with nothing to
 * do" is a state only a resident process can be in: a per-run host has no life
 * between turns to describe, so one that is not busy is on its way out and
 * belongs in neither group.
 *
 * Per binding, like the group above it: a resident host that is running a turn
 * for one of the sessions it holds is holding every other one of them idle, and
 * those are exactly the rows this group exists to list — a rule that skipped a
 * busy host's bindings wholesale would hide the one row a reader most wants to
 * close while something else is running.
 */
export function listResidentIdleSessionIds(snapshot: SessionHostsSnapshot | null): string[] {
  return liveBindings(snapshot)
    .filter(({ host, binding }) => host.mode === 'resident' && !isRunningBinding(host, binding))
    .map(({ binding }) => binding.appSessionId);
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

/**
 * The background job holding one conversation, or null when it is free.
 *
 * The single reading behind every read-only affordance on the page — the
 * composer's disabled input and its notice, the status bar's missing Start
 * button, the send path's refusal — so those three cannot disagree about which
 * sessions are held. It is `null` for a snapshot that has not arrived yet, which
 * is the fail-open direction on purpose: nothing has said the session is
 * occupied, and a composer that disabled itself while the first poll was in
 * flight would be unusable on every page load.
 *
 * Read through `findSessionHostState` rather than off the array, so a session
 * the listing does not mention at all (a brand-new one, before its row reaches
 * the listing) answers null instead of throwing.
 */
export function findSessionOccupancy(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string | null,
): SessionOccupiedBy | null {
  if (!appSessionId) {
    return null;
  }
  return findSessionHostState(snapshot, appSessionId)?.occupiedBy ?? null;
}

/** The shape drawn for each process state — the marks §15.1 of the proposal pins. */
export const RESIDENT_MARK_SHAPES: Record<ResidentProcessState, string> = {
  unstarted: 'hollow',
  idle: 'solid',
  busy: 'solid+spinner',
  exited: 'exited',
  // Neither a spinner nor a solid dot: a busy-looking mark for a state nothing
  // has confirmed is the exact "pretending to think" this vocabulary exists to
  // stop. It is drawn as an outline of its own so it cannot be read as `idle`'s
  // solid dot or `unstarted`'s plain hollow either.
  unknown: 'unknown',
};

/**
 * The UI's word for the state a host is in, or `unstarted` when there is no host.
 *
 * The host's own state machine has six members and the UI has five, so the two
 * have to be reconciled somewhere; this is the only place that happens, and
 * every reader of a process state goes through it. A closed host is kept out of
 * "is it running" but not out of "what happened to it": its `closeReason` is the
 * difference between a session the user closed — which is back to not running —
 * and one whose process died on its own, which keeps the exited state until
 * something restarts it.
 *
 * `lastReadFailed` is the poll's *own* result, not the host's, and it is folded
 * in here rather than checked by each consumer so the mark and the bar cannot
 * disagree about it. When the last read threw, the snapshot on hand is the one
 * from before it — a host that was `busy` a moment ago — and reporting that word
 * as if it were current is a claim nothing is backing: the endpoint that would
 * have said the turn ended is exactly the one that failed. So every host state
 * reads as `unknown` until a read succeeds, at which point the real word returns
 * on the next render. The parameter is optional and defaults to false, so the
 * many existing callers and fakes that pass only a host keep their reading.
 *
 * Total by construction: `idle`, `lingering` and `closing` all land on `idle`,
 * because in none of them is a turn in flight. A lease held open by background
 * work is exactly the case that must not read as busy.
 */
export function readResidentProcessState(
  host: SessionHostView | null,
  lastReadFailed = false,
): ResidentProcessState {
  if (lastReadFailed) {
    return 'unknown';
  }

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
 * caller can show it rather than silently doing nothing. Nothing is checked here
 * — `readApiJson` inside `api.sessionHosts` is what turns a refusal into a throw,
 * and the re-read below it simply does not run when one was thrown.
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
