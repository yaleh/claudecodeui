/**
 * The client's per-session background-work store: the task table and schedule
 * table a session's activity snapshot carries, and the hooks that read them.
 *
 * Why a store rather than component state. The two readings this module serves —
 * the dock's summary (`ActivityIndicator`) and a transcript card's live state
 * (`SubagentPanel` / `BashCommandDisplay`) — live in unrelated parts of the tree,
 * and both must react to the *same* frame. A store keyed by session id, written
 * once by the realtime handler and read through `useSyncExternalStore`, is what
 * makes the frame the one source: neither reader derives a state of its own.
 *
 * Where the data comes from. The server pushes a whole snapshot on
 * `activity.snapshot` (to a joiner, before any change) and again on every
 * `activity.upsert` (one revision per change). Both are the same shape, so a
 * frame *replaces* the session's view rather than patching it — a missed frame is
 * harmless because the next one carries everything. Nothing here polls
 * `/api/session-hosts`: the background panel is drawn from these frames, which is
 * the whole difference AC-194 pins.
 *
 * The task-by-tool-use-id lookup is deliberately cross-session: a `tool_use` id
 * is globally unique, and a transcript card knows only the id on its own row, so
 * scanning the held sessions is how a card joins its task without threading a
 * session id down through the transcript renderer.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { fetchSessionActivity } from '@/shared/api';
import type { ActivityScheduleView, ActivityTaskView } from '@/shared/types';

/** One session's background-work view, as the last snapshot/upsert frame left it. */
export type SessionActivityView = {
  rev: number;
  tasks: ActivityTaskView[];
  schedules: ActivityScheduleView[];
};

/** The view a session with no frame yet reads: present, empty, stable by reference. */
const EMPTY_VIEW: SessionActivityView = { rev: 0, tasks: [], schedules: [] };

const views = new Map<string, SessionActivityView>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * Applies one whole activity frame for a session, replacing its view.
 *
 * The frame's `tasks`/`schedules` are validated as arrays here so a malformed or
 * partial frame cannot put a non-array into the store and crash a reader that
 * maps over it. A missing array reads as empty, exactly as the server's own
 * snapshot defaults would.
 */
export function applyActivityFrame(input: {
  sessionId?: string | null;
  rev?: unknown;
  tasks?: unknown;
  schedules?: unknown;
}): void {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  if (!sessionId) {
    return;
  }

  views.set(sessionId, {
    rev: typeof input.rev === 'number' && Number.isFinite(input.rev) ? input.rev : 0,
    tasks: Array.isArray(input.tasks) ? (input.tasks as ActivityTaskView[]) : [],
    schedules: Array.isArray(input.schedules) ? (input.schedules as ActivityScheduleView[]) : [],
  });
  emit();
}

/** The session's current view, or the stable empty view when it has none. */
export function readSessionActivityView(sessionId?: string | null): SessionActivityView {
  if (!sessionId) {
    return EMPTY_VIEW;
  }
  return views.get(sessionId) ?? EMPTY_VIEW;
}

/** The task whose `tool_use` block is `toolUseId`, from any held session, or null. */
export function findTaskByToolUseId(toolUseId?: string | null): ActivityTaskView | null {
  if (!toolUseId) {
    return null;
  }
  for (const view of views.values()) {
    const task = view.tasks.find((candidate) => candidate.toolUseId === toolUseId);
    if (task) {
      return task;
    }
  }
  return null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Sessions whose REST snapshot has already been fetched. A one-shot per session
 * per page life: the socket pushes every later change, so re-reading on each
 * mount would be a poll.
 */
const snapshotFetched = new Set<string>();

/**
 * The join read: fetch the session's snapshot over REST once, so a page that
 * mounts with no socket frame yet still restores the background panel from the
 * server's own snapshot. A failure is silent — the socket's own `activity.snapshot`
 * remains the primary path, and this is only the pre-socket anchor.
 */
function ensureSnapshotFetched(sessionId?: string | null): void {
  if (!sessionId || snapshotFetched.has(sessionId)) {
    return;
  }
  snapshotFetched.add(sessionId);
  void fetchSessionActivity(sessionId)
    .then((frame) => {
      if (frame) {
        applyActivityFrame(frame);
      }
    })
    .catch(() => undefined);
}

/** The session's background-work view, re-rendering the caller when a frame arrives. */
export function useSessionActivity(sessionId?: string | null): SessionActivityView {
  useEffect(() => {
    ensureSnapshotFetched(sessionId);
  }, [sessionId]);

  return useSyncExternalStore(
    subscribe,
    () => readSessionActivityView(sessionId),
    () => readSessionActivityView(sessionId),
  );
}

/**
 * The task behind one transcript card, read live.
 *
 * This is the reading AC-194's card requirement turns on: the card's state comes
 * from the task entity (by `toolUseId`), never from whether a folded row happens
 * to carry a result. When the task is not in any held session the hook answers
 * null and the card falls back to the transcript's own status.
 */
export function useTaskByToolUseId(toolUseId?: string | null): ActivityTaskView | null {
  return useSyncExternalStore(
    subscribe,
    () => findTaskByToolUseId(toolUseId),
    () => findTaskByToolUseId(toolUseId),
  );
}

/** Drops every session's view. Test-only; production never clears this. */
export function resetSessionActivityStore(): void {
  views.clear();
  snapshotFetched.clear();
  emit();
}
