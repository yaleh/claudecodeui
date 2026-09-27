import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent,MarkSessionIdle,MarkSessionProcessing,PendingPermissionRequest,ProjectSession,LLMProvider,NormalizedMessage,CommandLifecycleState } from '@/shared/types';
import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '@/shared/utils';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

/**
 * How long a session's deltas are coalesced before its row is refreshed.
 *
 * A render budget, not a correctness knob. A reply arrives as hundreds of
 * one-token frames and the store keeps exactly one row per turn, so this
 * decides how often that row is rewritten — every flush redraws the transcript
 * around it, markdown pipeline included.
 */
const STREAM_FLUSH_INTERVAL_MS = 100;

/**
 * The queue states this client can draw, as a value rather than only a type.
 *
 * The wire carries `commandState` as an unvalidated string, and the store's
 * `applyCommandLifecycle` takes the union — so something has to narrow one to
 * the other, and the list has to name every member
 * {@link CommandLifecycleState} has. A frame naming a state this build has no
 * word for normalizes to nothing rather than being guessed at: `queued` and
 * `started` are what the withdrawal button's presence depends on, and a
 * misspelled state treated as "not queued" would silently take the button away.
 */
const COMMAND_LIFECYCLE_STATES: readonly CommandLifecycleState[] = [
  'queued',
  'started',
  'cancelled',
  'completed',
];

function readCommandLifecycleState(value: unknown): CommandLifecycleState | null {
  return typeof value === 'string' && (COMMAND_LIFECYCLE_STATES as readonly string[]).includes(value)
    ? (value as CommandLifecycleState)
    : null;
}

type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamRef: MutableRefObject<string>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  sessionStore: SessionStore;
};

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  streamTimerRef,
  accumulatedStreamRef,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  /**
   * The text each session's reply has streamed so far, and that session's
   * pending flush timer.
   *
   * Keyed by session and never shared. One socket carries the deltas of every
   * running session interleaved, so a single buffer holds two replies' text at
   * once and whichever row is flushed from it receives both; a bucket per
   * session is what makes one session's deltas unable to reach another
   * session's row.
   *
   * Every session accumulates here, not only the one on screen. A reply nobody
   * is watching still has to fold into a single row — the deltas of a turn are
   * one message, and the row is what that turn *is* — and the bucket is also
   * what carries its text across a view change in either direction: the reader
   * may switch into a reply mid-flight, or away from one.
   */
  const streamBuffersRef = useRef(new Map<string, string>());
  const streamFlushTimersRef = useRef(new Map<string, number>());

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    /**
     * Write a session's accumulated text into the row that session is
     * streaming into, and drop its pending flush.
     *
     * `updateStreaming` is handed the text of the turn *so far* and selects the
     * row by session and kind, so a flush reuses the row the previous flush
     * made rather than adding one. That reuse is the whole fix: a background
     * session's reply is one row at any moment, no matter how many frames it
     * arrived in.
     */
    const flushStreamBuffer = (sessionId: string) => {
      const timer = streamFlushTimersRef.current.get(sessionId);
      if (timer !== undefined) {
        clearTimeout(timer);
        streamFlushTimersRef.current.delete(sessionId);
      }
      // Read the text here rather than closing over it, so a flush that fires
      // after the turn settled — its pending timer outliving it — finds an
      // empty bucket and is a no-op instead of writing a stale body.
      const accumulated = streamBuffersRef.current.get(sessionId);
      if (!accumulated) {
        return;
      }
      if (sessionId === activeViewSessionIdRef.current) {
        accumulatedStreamRef.current = accumulated;
      }
      sessionStore.updateStreaming(sessionId, accumulated, provider);
    };

    /**
     * Coalesce a session's next flush.
     *
     * The viewed session keeps flushing on the parent's timer ref, because that
     * is the handle the parent clears when the view moves on; every other
     * session is out of the parent's sight and gets a timer of its own. Both
     * callbacks read the session's bucket, so a timer that outlives its turn
     * cannot write anything stale.
     */
    const scheduleStreamFlush = (sessionId: string) => {
      if (sessionId === activeViewSessionIdRef.current) {
        if (streamTimerRef.current !== null) {
          return;
        }
        streamTimerRef.current = window.setTimeout(() => {
          streamTimerRef.current = null;
          flushStreamBuffer(sessionId);
        }, STREAM_FLUSH_INTERVAL_MS);
        return;
      }
      if (streamFlushTimersRef.current.has(sessionId)) {
        return;
      }
      streamFlushTimersRef.current.set(sessionId, window.setTimeout(() => {
        flushStreamBuffer(sessionId);
      }, STREAM_FLUSH_INTERVAL_MS));
    };

    const accumulateStreamDelta = (sessionId: string, text: string) => {
      const accumulated = (streamBuffersRef.current.get(sessionId) ?? '') + text;
      streamBuffersRef.current.set(sessionId, accumulated);
      if (sessionId === activeViewSessionIdRef.current) {
        // Mirror of the viewed session's turn, kept for the parent that reads
        // and clears it when the view moves on.
        accumulatedStreamRef.current = accumulated;
      }
      scheduleStreamFlush(sessionId);
    };

    /**
     * The turn is over. Write its last text into the row, settle the row in
     * place — the id it settles with is the id the transcript keys it by, so
     * this must not mint a new one — and forget the bucket.
     */
    const settleStream = (sessionId: string) => {
      flushStreamBuffer(sessionId);
      streamBuffersRef.current.delete(sessionId);
      if (sessionId === activeViewSessionIdRef.current) {
        accumulatedStreamRef.current = '';
        if (streamTimerRef.current !== null) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
      }
      sessionStore.finalizeStreaming(sessionId);
    };

    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // Record replay progress for every sequenced live event.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'history_truncated': {
          // An already-sent message was replaced. Every client watching this
          // session drops the superseded turns before the replacement streams
          // in, so a second tab does not end up showing the question twice.
          if (sid && typeof msg.anchorId === 'string') {
            sessionStore.truncateAt(sid, msg.anchorId);
          }
          return;
        }

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            onSessionIdle?.(sid);
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: accumulate per session, one row per turn ---
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text || !sid) return;
        accumulateStreamDelta(sid, text);
        return;
      }

      if (msg.kind === 'stream_end') {
        if (sid) {
          settleStream(sid);
        }
        return;
      }

      // A command the resident process is holding, and where it is now. It has
      // no text of its own and is not a message: it is the host's answer about
      // the one row this client is holding for it, so it updates that row
      // instead of being appended as one of its own. A row for a command this
      // client never drew (another client pushed it) matches nothing and is
      // dropped, which is the same reading `withoutServedLifecycleRows` gives
      // the same event when it comes back over REST.
      if (msg.kind === 'command_lifecycle') {
        const state = readCommandLifecycleState(msg.commandState);
        if (sid && typeof msg.commandUuid === 'string' && state) {
          sessionStore.applyCommandLifecycle(sid, { commandUuid: msg.commandUuid, state });
        }
        return;
      }

      // The control-plane's acknowledgement of a withdrawal. Deliberately
      // dropped: it is not the reading either side of the wire treats as the
      // withdrawal having happened. The client's evidence is the `cancelled`
      // lifecycle event above — the one fact the process publishes after it has
      // actually taken the command back — while this frame can arrive, by
      // design, at any timing or not at all (§9.2: `cancel_async_message`
      // receives no `control_response`). Drawing the row gone on an
      // acknowledgement would make the UI's state a claim about a request
      // rather than about the host's queue, and appending it as a message would
      // put a wire verb in the transcript.
      if (msg.kind === 'queued_input_cancel_result') {
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_resolved'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state — this session's own, read
          // from its bucket: a run that ends while the reader is elsewhere
          // must not be settled with the viewed session's text.
          if (sid) {
            settleStream(sid);
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void requestLatestMessages(sid, isActiveRef.current);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        // `permission_resolved` arrives when any client answers the prompt: it
        // retracts a replayed `permission_request` after a mid-run refresh and
        // clears the prompt in other tabs watching the same run.
        case 'permission_resolved':
        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            // The counter shows the viewed session's context; budgets from
            // other concurrently running sessions must not overwrite it.
            if (sid === activeViewSessionId) {
              setTokenBudget(msg.tokenBudget as Record<string, unknown>);
            }
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  ]);
}
