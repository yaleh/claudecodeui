import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import type {
  ChatRunSource,
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `runId`: opaque identity for this run, minted once in `startRun`. `seq` is
 *   numbered per run, so it is the `runId` that tells a reconnecting client
 *   whether its cursor still belongs to the run now in flight: the same id
 *   means `seq > lastSeq`, a different one means the cursor predates this run
 *   and replay must start at its first event.
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 * - `source`: who asked for the run. Fixed at `startRun` and never rewritten,
 *   because it describes an origin that existed before the run did; it is what
 *   lets a run opened by the host layer (`unattended`) be told apart from one
 *   a timer fired (`scheduled`) even though neither has a socket attached.
 */
type ChatRun = {
  appSessionId: string;
  runId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  source: ChatRunSource;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

function evictRunLater(appSessionId: string): void {
  const timer = setTimeout(() => {
    const run = runs.get(appSessionId);
    if (run && run.status === 'completed') {
      runs.delete(appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps, and stamp the
 *    run's `runId` so a client can tell which run that `seq` belongs to.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
    runId: run.runId,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    evictRunLater(run.appSessionId);
  }

  run.events.push(outbound);
  if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
  }

  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastSessionUpserted(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   *
   * `supersedeRunning` is the one exception, and it is not a weakening of that
   * contract: it is how a second turn that is genuinely accepted while the
   * first is still running gets a run of its own. A resident session has no
   * reason to refuse a busy send — the CLI queues it and runs it as its own
   * turn — but the run registry is keyed one run per session, so the newer turn
   * must replace the older one *as the session's current run* or its frames
   * would be attributed to a run that already ended its own conversation.
   *
   * The replaced run is not marked completed by the replacement, and that is
   * the load-bearing half: its own turn is still running, and its terminal
   * `complete` is written through its own writer when that turn ends
   * (`ClaudeResidentHostDriver` sends it through the round's writer, not through
   * whichever round was armed last). Marking it completed here would hand it to
   * `decorateAndRecordEvent`'s exactly-one-complete rule, so the ending of a
   * turn that was genuinely running would be dropped and every client watching
   * the session would be left waiting on a run that never reports itself over.
   * Status tracks the run's *own* turn; the map slot is what "the session's
   * current run" means, and the newer run simply takes it.
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    /**
     * The socket that asked for this run, or `null` for one nobody is watching
     * — a scheduled message fires with no browser attached. The writer's event
     * buffer still records everything, so a client that subscribes later
     * replays the run from its start.
     */
    connection: RealtimeClientConnection | null;
    userId: string | number | null;
    /**
     * Who asked for this run. Optional so every existing call site keeps its
     * current meaning without being touched: a run with a connection is a
     * `user` turn, and one without is a `scheduled` turn, which is exactly what
     * the two production paths (`chat.send` and `runDetachedChatTurn`) already
     * are. A caller that knows better — the host layer opening a turn nobody
     * asked for — states `unattended` explicitly.
     */
    source?: ChatRunSource;
    /**
     * Whether an already-running run is replaced by this one instead of
     * refusing this one. Only ever set by a caller that has established the
     * session's provider will really run this turn concurrently — see above.
     */
    supersedeRunning?: boolean;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running' && !input.supersedeRunning) {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      runId: randomUUID(),
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      source: input.source ?? (input.connection ? 'user' : 'scheduled'),
      status: 'running',
      lastSeq: 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    runs.set(input.appSessionId, run);
    return run;
  },

  /**
   * Opens a run for a turn the *host* layer detected, with nobody watching.
   *
   * The one thing this adds over `startRun` is the pair of facts a host caller
   * cannot state: `connection: null` and `source: 'unattended'`. Both are true
   * by construction here rather than by the caller's word — an unattended turn
   * is one no socket asked for, so there is no connection to attach, and the
   * source is what tells it apart from the `scheduled` turns that share the
   * no-connection shape.
   *
   * Returns the run's writer, or `null` when a run is already in flight for the
   * session: the caller (a resident host driver) treats that as "carry on as
   * before" rather than as a failure, because a turn that arrives while the
   * session is busy is a real sequence, not an error. Only the writer is
   * handed back — a driver has no business reading `seq`, `events` or the run's
   * status, and the frames it sends through the writer are what maintain them.
   */
  openUnattendedRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    userId: string | number | null;
    /**
     * Accepted and unused: the run record is keyed by the app session id and
     * carries no display name. It is part of the shape because the host layer
     * holds it on the same reading that produced the rest, and splitting the
     * shape in two so this caller could drop one field would be the seam
     * inventing a distinction the call site does not have.
     */
    sessionName?: string | null;
  }): { writer: ChatSessionWriter } | null {
    const run = this.startRun({
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      connection: null,
      userId: input.userId,
      source: 'unattended',
    });
    return run ? { writer: run.writer } : null;
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },
  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
      }));
  },

  /**
   * Adds a websocket connection to a run's live audience.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   *
   * Subscribing does not take the stream away from sockets that were already
   * watching — a session open in two places stays live in both, and the
   * refreshed tab's abandoned socket is dropped when the next event finds it
   * closed. Replay stays per-connection because each client sends its own
   * `lastSeq` with `chat.subscribe`.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * `runId` is the run the caller's `afterSeq` was recorded against. `seq` is
   * numbered per run, so a cursor recorded against a *different* run than the
   * one currently in flight means nothing here: `afterSeq` is ignored and the
   * run replays from its first event. A matching `runId`, or none at all (a
   * client that predates run ids, or an internal caller), keeps the plain
   * `seq > afterSeq` rule.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number, runId?: string): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    const effectiveAfterSeq = runId !== undefined && runId !== run.runId ? 0 : afterSeq;
    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > effectiveAfterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run.
   */
  clearAll(): void {
    runs.clear();
  },
};
