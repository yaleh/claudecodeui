import express from 'express';
import type { Request, Response } from 'express';

import type { HostCloseReason, HostLease, LLMProvider, ProcessHost, SessionBinding } from '@/shared/types.js';
import { createApiSuccessResponse } from '@/shared/utils.js';

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
  bindings: BindingView[];
};

/** One session on a host, as the listing endpoint reports it. */
type BindingView = {
  appSessionId: string;
  providerSessionId: string | null;
  state: SessionBinding['state'];
  leases: HostLease[];
  lastActivityAt: number;
};

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
 * The HTTP face of the host layer: `GET /api/session-hosts`, and
 * `POST /api/session-hosts/:sessionId/close`.
 *
 * Exported as a factory rather than as a ready-made router because the manager
 * is a dependency, not a module-level constant: `server/index.ts` mounts it
 * over the process-wide singleton, and a criterion mounts it over a manager it
 * built and drove itself, so the listing it reads is the same table the
 * dispatch under test wrote.
 *
 * The listing does one thing — read the manager's snapshot, project it, wrap it
 * in the standard envelope — and deliberately does not import `chatRunRegistry`
 * or touch the database. That is not stylistic: the hosts are the host layer's
 * own state, and a listing built from the run registry would silently omit the
 * hosts that exist *after* their run ended (a `lingering` process, a held-stdin
 * window), which is exactly the state this endpoint exists to show.
 *
 * The close route is the same principle from the other side: it addresses a host
 * by the *session* it serves (which is what a client knows), finds it in the
 * snapshot, and relays a decision the manager records. It does not terminate
 * anything itself — ending the process is the driver's answer to being closed,
 * and for a resident host that answer is stdin EOF. It is also the only route
 * here that is mode-restricted, and deliberately so: a `per-run` host's life is
 * its turn's, and a caller closing one would be reaching past the run that owns
 * it.
 */
export function createSessionHostsRouter({
  sessionHostManager,
}: {
  sessionHostManager: SessionHostManager;
}) {
  const router = express.Router();

  router.get('/', (_request: Request, response: Response) => {
    const hosts = sessionHostManager.snapshot().map(toHostView);
    response.json(createApiSuccessResponse({ hosts }));
  });

  router.post('/:sessionId/close', (request: Request, response: Response) => {
    const sessionId = routeParameter(request.params.sessionId);
    const host = liveHostForSession(sessionHostManager, sessionId);

    if (!host) {
      response.status(404).json({
        success: false,
        error: `Session "${sessionId}" is not served by a live host.`,
      });
      return;
    }

    if (host.mode !== 'resident') {
      response.status(409).json({
        success: false,
        error: `Session "${sessionId}" runs in "${host.mode}" mode; only a resident host can be closed on demand.`,
      });
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
  });

  return router;
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
    bindings: [...host.bindings.values()].map(toBindingView),
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
  };
}
