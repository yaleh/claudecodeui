import express from 'express';
import type { Request, Response } from 'express';

import type { IProviderHostDriver } from '@/shared/interfaces.js';
import type {
  HostCloseReason,
  HostLease,
  HostMode,
  LifecycleModeErrorCode,
  LLMProvider,
  ProcessHost,
  SessionBinding,
} from '@/shared/types.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import type { SessionHostManager } from './session-host-manager.service.js';

/**
 * One host as the listing endpoint reports it.
 *
 * A projection rather than the manager's own record, for two reasons. The
 * record's `bindings` is a `Map`, which `JSON.stringify` would flatten to `{}`
 * — the one shape a browser cannot read — and the record carries fields
 * (`closeDetail`, `quietDeadlineAt`, `quietWindowStartAt`) whose meaning is the
 * state machine's internal bookkeeping. What a client is owed is the host's
 * identity, what it is, whether it is still there, and who is on it.
 *
 * `closeReason` is null on a host that is still open, which is also the only
 * way a reader can tell "still running" from "closed" without a second field:
 * a closed host always has a reason (`closeHost` sets the two together).
 */
type HostView = {
  hostId: string;
  provider: LLMProvider;
  mode: ProcessHost['mode'];
  state: ProcessHost['state'];
  /** The child process id, or null for a host that was never given one. */
  pid: number | null;
  startedAt: number;
  closeReason: ProcessHost['closeReason'];
  /**
   * The extra fact `closeReason` carries, or null when it carries none.
   *
   * Published because it is the only thing that tells a process that exited
   * from one that was stopped: `closeReason: 'exited'` says the process ended on
   * its own, and this says whether it was killed for memory (`oom`), died of a
   * signal, or failed — which is the difference between a banner the user can
   * act on and one that only reports. It travels with `closeReason` in the
   * manager's own record (set together, never one without the other), so
   * projecting it here does not invent a state the host can be in.
   */
  closeDetail: ProcessHost['closeDetail'];
  bindings: BindingView[];
};

/** One session on a host, as the listing endpoint reports it. */
type BindingView = {
  appSessionId: string;
  providerSessionId: string | null;
  state: SessionBinding['state'];
  leases: HostLease[];
  lastActivityAt: number;
  /**
   * The address this conversation's process answers to, or null when it has
   * none. Published because it is the one fact about a resident process that
   * cannot be derived from anything the client already holds: the name is
   * registered inside the process, so a reader that wants to send to this
   * session has nowhere else to read it from.
   */
  peerName: string | null;
};

/**
 * One session's host state, as the listing endpoint reports it — including the
 * sessions no host is serving.
 *
 * `hosts` answers "what processes are there"; this answers "what should be
 * running, and isn't". The two are different questions and neither is a subset
 * of the other: a host can exist for a session whose row is gone, and after a
 * restart every resident session has no host at all. Reporting only the first
 * was what made a restart indistinguishable from a fresh install.
 *
 * `lifecycleMode` is the stored preference, which is why it survives the
 * restart that `hosts` does not.
 */
type SessionHostStateView = {
  appSessionId: string;
  provider: LLMProvider;
  lifecycleMode: HostMode;
  /** True while a live (not closed) host holds this session. */
  running: boolean;
  /**
   * Why a resident session has no process, or null when the question does not
   * apply — a running session, or a per-run one, whose process is its turn's
   * and whose absence between turns means nothing.
   */
  reason: string | null;
};

/**
 * What one route needs to know about a session, and nothing else.
 *
 * The `/start` route cannot answer its own question from the host layer — a
 * session that has never been started has no host to look up — so it asks the
 * module that owns session rows for the two facts that decide the request: the
 * provider whose driver would serve it, and the mode the user asked for. Narrow
 * on purpose: a route that received the whole row could be tempted to branch on
 * a field that is not its business, and the mode read has to come through
 * `getSessionLifecycleMode` (the reader that supplies `per-run` for a row that
 * has never been written) rather than off the raw column.
 */
export type SessionLifecycleReading = {
  provider: LLMProvider;
  mode: HostMode;
};

/**
 * Resolves the host driver a provider mounts, or null when it mounts none.
 *
 * A dependency rather than an import because the driving module
 * (`providers`) already imports this one: reaching back for
 * `providerRegistry` here would close an import cycle, which is the same reason
 * `provider.registry` keeps its own consumers at arm's length. `server/index.ts`
 * — the composition root, which imports both — supplies the real one.
 */
export type HostDriverResolver = (provider: LLMProvider) => IProviderHostDriver | null;

/**
 * What a session's own row says about whether a host *should* be serving it.
 *
 * The listing needs one fact the host layer cannot hold: a session's stored
 * lifecycle mode. Hosts are derived state — they exist exactly as long as a
 * process does — so after a restart the host table is empty and every resident
 * session is indistinguishable from a session that never ran. The mode is on
 * the row, which is why the composition root reads it there.
 */
export type SessionHostStateReading = {
  appSessionId: string;
  provider: LLMProvider;
  mode: HostMode;
};

/**
 * Reads the sessions the listing reports state for.
 *
 * A dependency for the same reason {@link HostDriverResolver} is one: the rows
 * belong to the sessions module, and this module cannot import it (providers
 * imports this one, so the edge back would close a cycle). `server/index.ts`
 * supplies the real reader.
 *
 * Optional, and an absent reader means "no sessions to report" rather than a
 * refusal: the two criteria that mount this router over a manager they drove
 * themselves care about hosts, and a listing that answered `sessions: []` for
 * them is the honest answer — they never told it about any session.
 */
export type SessionReader = () => SessionHostStateReading[];

/**
 * The reason a resident session carries when no host is serving it.
 *
 * Derived, never stored — which is the whole reason it is a constant here and
 * not a column. `lifecycle_mode` says a session *wants* a long-lived process;
 * only the host layer knows whether one is there right now, and that answer is
 * true for as long as the process is. Persisting it would mean writing a row on
 * every host open and close, and would still be wrong after a SIGKILL — the one
 * case it exists for — because nothing survives to write it.
 *
 * The text names both of the ways a resident session can be hostless, because
 * the listing cannot tell them apart: a process closed by the server's own stop
 * path and one that was never started look identical after a restart, and a
 * client that needs the difference has the transcript for it.
 */
export const RESIDENT_NOT_RUNNING_REASON =
  'No resident host is running for this session; the last server stop or restart dropped it.';

/**
 * The HTTP face of the host layer: `GET /api/session-hosts`,
 * `POST /api/session-hosts/:sessionId/start`, and
 * `POST /api/session-hosts/:sessionId/close`.
 *
 * Exported as a factory rather than as a ready-made router because the manager
 * is a dependency, not a module-level constant: `server/index.ts` mounts it
 * over the process-wide singleton, and a criterion mounts it over a manager it
 * built and drove itself, so the listing it reads is the same table the
 * dispatch under test wrote.
 *
 * The listing does one thing — read the manager's snapshot and the injected
 * session reader, project both, wrap them in the standard envelope — and
 * deliberately does not import `chatRunRegistry` or touch the database. That is
 * not stylistic: the hosts are the host layer's own state, and a listing built
 * from the run registry would silently omit the hosts that exist *after* their
 * run ended (a `lingering` process, a held-stdin window), which is exactly the
 * state this endpoint exists to show. The session reader is a seam for the same
 * reason, from the other side: the rows are the sessions module's, so they
 * arrive as a value rather than as an import, and this module still reads no
 * database of its own.
 *
 * The listing reports two arrays for that one reason. `hosts` alone cannot show
 * a session whose process is gone, and "the server restarted and dropped my
 * resident sessions" is precisely a statement about a process that is *not*
 * there — a client could not tell it from "the session never existed", because
 * after a restart both look like an empty host table.
 *
 * The close route is the same principle from the other side: it addresses a host
 * by the *session* it serves (which is what a client knows), finds it in the
 * snapshot, and relays a decision the manager records. It does not terminate
 * anything itself — ending the process is the driver's answer to being closed,
 * and for a resident host that answer is stdin EOF. It is also the only route
 * here that is mode-restricted, and deliberately so: a `per-run` host's life is
 * its turn's, and a caller closing one would be reaching past the run that owns
 * it.
 *
 * `/start` is that restriction's mirror image. A resident session's process is
 * opened lazily — on the first turn, or when the user asks for it here — so the
 * route resolves the driver and hands the session to `bindSession`, which is
 * the manager's own "put this session on a process" entry point rather than a
 * second way to open one. Both mode-restricted verbs answer with a named
 * `LifecycleModeErrorCode` in the body, so a client tells "this session is not
 * resident" from "there is no such session" from "nothing is running for it"
 * without reading prose.
 */
export function createSessionHostsRouter({
  sessionHostManager,
  readSession,
  resolveHostDriver,
  listSessions,
}: {
  sessionHostManager: SessionHostManager;
  /**
   * Reads the session a lifecycle verb addresses, or null when no row exists.
   *
   * Optional, and fail-closed when absent: a route with no reader cannot tell
   * "not resident" from "no such session", so it refuses rather than guessing.
   * That keeps the listing router (which never reads a session) constructible
   * with the manager alone, which is how the routes criterion and the resident
   * criterion both mount it.
   */
  readSession?: (appSessionId: string) => SessionLifecycleReading | null;
  /** See {@link HostDriverResolver}; absent means "no provider has a driver". */
  resolveHostDriver?: HostDriverResolver;
  /** See {@link SessionReader}; absent means the listing reports no sessions. */
  listSessions?: SessionReader;
}) {
  const router = express.Router();

  router.get('/', (_request: Request, response: Response) => {
    const hosts = sessionHostManager.snapshot();

    // "Running" is read off the same snapshot the hosts array is projected
    // from, so the two halves of this payload cannot disagree: a session is
    // running here exactly when a host in this response is holding it. A closed
    // host is not running — its record stays in the snapshot for a retention
    // window, and a client reading it as a live process would get the opposite
    // answer from the process's own /proc entry.
    const running = new Set<string>();
    for (const host of hosts) {
      if (host.state === 'closed') {
        continue;
      }
      for (const appSessionId of host.bindings.keys()) {
        running.add(appSessionId);
      }
    }

    const sessions = (listSessions?.() ?? []).map((session) =>
      toSessionHostStateView(session, running),
    );

    response.json(createApiSuccessResponse({ hosts: hosts.map(toHostView), sessions }));
  });

  /**
   * Starts the resident host for one session, or refuses and says why.
   *
   * The refusals are ordered by how much they say about the request, cheapest
   * first: a session that does not exist, a host already serving it in the wrong
   * mode, a session whose stored preference is not residential, and finally a
   * resident session whose provider mounts no driver. Only the last one is about
   * the provider rather than the session, which is why `LIFECYCLE_MODE_HOST_UNAVAILABLE`
   * is the one refusal a provider can make true on its own.
   *
   * A session that already has a live resident host is a success, not a
   * `session-already-bound` refusal: "start" is a request for a state, and the
   * state is already the one asked for. The manager would refuse the second bind
   * (the binding index is single-writer), which is the right answer to a second
   * *bind* and the wrong answer to a second *start*.
   */
  router.post(
    '/:sessionId/start',
    asyncHandler(async (request: Request, response: Response) => {
      const sessionId = routeParameter(request.params.sessionId);
      const session = readSession?.(sessionId) ?? null;

      if (!session) {
        sendRefusal(response, 404, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`);
        return;
      }

      const running = liveHostForSession(sessionHostManager, sessionId);
      if (running) {
        if (running.mode !== 'resident') {
          sendRefusal(
            response,
            409,
            'LIFECYCLE_MODE_NOT_RESIDENT',
            `Session "${sessionId}" already runs in "${running.mode}" mode; only a resident host can be started on demand.`,
          );
          return;
        }

        response.json(
          createApiSuccessResponse({
            hostId: running.hostId,
            sessionId,
            mode: running.mode,
            pid: running.pid,
          }),
        );
        return;
      }

      if (session.mode !== 'resident') {
        sendRefusal(
          response,
          409,
          'LIFECYCLE_MODE_NOT_RESIDENT',
          `Session "${sessionId}" is stored as "${session.mode}"; only a resident session can be started on demand.`,
        );
        return;
      }

      const driver = resolveHostDriver?.(session.provider) ?? null;
      if (!driver) {
        sendRefusal(
          response,
          409,
          'LIFECYCLE_MODE_HOST_UNAVAILABLE',
          `Provider "${session.provider}" mounts no host driver, so session "${sessionId}" cannot be started.`,
        );
        return;
      }

      const bound = await sessionHostManager.bindSession({
        provider: session.provider,
        appSessionId: sessionId,
        driver,
      });

      if (!bound.ok) {
        // The manager refused to place the session on a process. The code it
        // answered with is a bind-refusal vocabulary (`session-already-bound` /
        // `host-not-multiplexed`), not a lifecycle one, so it travels in the
        // message and the response keeps the code a lifecycle client branches
        // on: nothing was started, which is what `HOST_UNAVAILABLE` says.
        sendRefusal(
          response,
          409,
          'LIFECYCLE_MODE_HOST_UNAVAILABLE',
          `Session "${sessionId}" could not be bound to a host (${bound.code}).`,
        );
        return;
      }

      const host = liveHostForSession(sessionHostManager, sessionId);
      response.json(
        createApiSuccessResponse({
          hostId: bound.hostId,
          sessionId,
          mode: 'resident' satisfies HostMode,
          pid: host?.pid ?? null,
        }),
      );
    }),
  );

  router.post('/:sessionId/close', (request: Request, response: Response) => {
    const sessionId = routeParameter(request.params.sessionId);
    const host = liveHostForSession(sessionHostManager, sessionId);

    if (host) {
      if (host.mode !== 'resident') {
        sendRefusal(
          response,
          409,
          'LIFECYCLE_MODE_NOT_RESIDENT',
          `Session "${sessionId}" runs in "${host.mode}" mode; only a resident host can be closed on demand.`,
        );
        return;
      }

      // The reason is the one the vocabulary already has for this: the user closed
      // the host (`HostCloseReason.user`). The manager records the close, detaches
      // the binding, and relays it to the driver — for a resident host the driver
      // answers by ending its input queue, which is the CLI's stdin EOF. The
      // response therefore reports the decision rather than the process's death:
      // the death is the process's to produce, and a client that needs it reads
      // `/proc/<pid>` or the listing's `closeReason`, both of which the manager has
      // already made true.
      sessionHostManager.closeHost(host.hostId, 'user');

      response.json(
        createApiSuccessResponse({
          hostId: host.hostId,
          sessionId,
          mode: host.mode,
          closeReason: 'user' satisfies HostCloseReason,
        }),
      );
      return;
    }

    // Nothing is serving the session, so there is nothing to close. Which
    // *kind* of nothing decides the answer, and only the session row can tell
    // them apart: a per-run session is refused (the verb is resident-only, and
    // a client asking about one has misread the mode), a resident one is told
    // there is no host, and an unknown id is told there is no session.
    const session = readSession?.(sessionId) ?? null;
    if (!session) {
      sendRefusal(response, 404, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`);
      return;
    }

    if (session.mode !== 'resident') {
      sendRefusal(
        response,
        409,
        'LIFECYCLE_MODE_NOT_RESIDENT',
        `Session "${sessionId}" is stored as "${session.mode}"; only a resident session can be closed on demand.`,
      );
      return;
    }

    sendRefusal(
      response,
      404,
      'SESSION_HOST_NOT_FOUND',
      `Session "${sessionId}" is resident but no live host is serving it.`,
    );
  });

  return router;
}

/**
 * One refusal, in the shape the application's error middleware produces.
 *
 * Written here rather than thrown as an `AppError` because this router is
 * mounted on its own by criteria that add no error middleware — the listing
 * criterion mounts the production error handler after it, but the resident
 * criterion mounts only `express.json()` — so a thrown error would reach a
 * client as an unhandled stack. Answering in place makes the refusal readable
 * wherever the router is mounted, and the object shape is deliberate: the code
 * is the part a client branches on, and a string body would leave it to prose.
 */
function sendRefusal(
  response: Response,
  status: number,
  code: LifecycleModeErrorCode,
  message: string,
): void {
  response.status(status).json({ success: false, error: { code, message } });
}

/**
 * One path parameter as a string.
 *
 * Express types a route parameter as `string | string[]` (a repeated parameter
 * arrives as a list), and a session id is never a list here — the route names one
 * segment. Taking the first element is the same reading the plugins router makes
 * of its own parameters; an empty string then falls through to the same "no such
 * host" answer as an unknown id.
 */
function routeParameter(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

/**
 * The live host serving one application session, as the manager reports it.
 *
 * Read through `snapshot()` for the same reason the listing is: that is the
 * manager's read port, and a route that reached into the internal index would be
 * reading state the manager has already decided not to publish (a closed host
 * past its retention window, a record mid-transition). `closed` hosts are
 * skipped rather than found, so closing twice answers "not served by a live
 * host" rather than re-recording a close that already happened.
 */
function liveHostForSession(
  sessionHostManager: SessionHostManager,
  appSessionId: string,
): ProcessHost | null {
  return (
    sessionHostManager
      .snapshot()
      .find((host) => host.state !== 'closed' && host.bindings.has(appSessionId)) ?? null
  );
}

/** Projects one manager record into the wire shape above. */
function toHostView(host: ProcessHost): HostView {
  return {
    hostId: host.hostId,
    provider: host.provider,
    mode: host.mode,
    state: host.state,
    pid: host.pid,
    startedAt: host.startedAt,
    closeReason: host.closeReason,
    closeDetail: host.closeDetail ?? null,
    bindings: [...host.bindings.values()].map(toBindingView),
  };
}

/**
 * Projects one session and whether anything is serving it.
 *
 * The reason is filled only for the one combination that is a *finding* — a
 * session stored as resident with nothing running it. Everything else is null,
 * and each null says something different: a running session's question does not
 * arise, and a per-run session's process belongs to its turn, so its absence
 * between turns is the design rather than news. Filling the field for those
 * cases would make it non-empty on every row and therefore worth nothing to a
 * client trying to find the sessions a restart dropped.
 */
function toSessionHostStateView(
  session: SessionHostStateReading,
  running: Set<string>,
): SessionHostStateView {
  const isRunning = running.has(session.appSessionId);

  return {
    appSessionId: session.appSessionId,
    provider: session.provider,
    lifecycleMode: session.mode,
    running: isRunning,
    reason: !isRunning && session.mode === 'resident' ? RESIDENT_NOT_RUNNING_REASON : null,
  };
}

/** Projects one session on a host. Leases are copied by `snapshot()` already. */
function toBindingView(binding: SessionBinding): BindingView {
  return {
    appSessionId: binding.appSessionId,
    providerSessionId: binding.providerSessionId,
    state: binding.state,
    leases: binding.leases,
    lastActivityAt: binding.lastActivityAt,
    peerName: binding.peerName,
  };
}
