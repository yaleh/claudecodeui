import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, describe, test, vi } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { classifyRunningSessions } from '@/shared/hooks/useSessionHosts';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type {
  ActivityConnection,
  ServerEvent,
  SessionActivity,
  SessionHostsSnapshot,
} from '@/shared/types';

/**
 * One dock, and one answer about a session — in milliseconds.
 *
 * The page used to give four answers to "is this session working": a tab-shaped
 * strip hanging off the composer, a compact line at the end of the transcript,
 * the resident status bar's own busy/idle word (read off a one-second
 * `/api/session-hosts` poll), and the sidebar's running view, badge and send
 * button. Every pair of them could disagree, and the pair that actually did was
 * the dock against everything downstream of that poll.
 *
 * This file pins the two halves of the consolidation that a browser run would
 * take a minute to say, and pins them as *readings that could have gone the other
 * way*:
 *
 *   - exactly one `[data-activity-dock]` exists, and the two markers the old
 *     surfaces published (the `.chat-activity-tab` class and the
 *     `chat-activity-inline` slot) match nothing at all;
 *   - the dock's reading and the sidebar's classification of the same session are
 *     the same answer, in both directions — turn in flight and turn over. The
 *     second arm is the control: without it, a page that drew no dock and
 *     classified nothing as running would satisfy the first.
 *
 * What this cannot prove is that a *real* server's frames drive both — that is
 * `e2e/activity-dock-truthful.spec.ts -g "AC-188"`, on a real page against a real
 * debug-agent turn. Here the frame source is in memory, which is the point:
 * milliseconds, and the reason named when it goes red.
 */

const SESSION_ID = 'session-consolidation';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const EXIT_ANIMATION_MS = 220;

/** The turn these cases are about: a real one, from the client's activity table. */
const ACTIVITY: SessionActivity = {
  statusText: 'Reviewing',
  canInterrupt: true,
  startedAt: START,
};

/** An in-memory liveness channel, so the dock runs without a socket. */
const makeConnection = () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  const connection: ActivityConnection = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isConnected: true,
  };
  const push = (event: ServerEvent) => {
    act(() => {
      for (const listener of [...listeners]) listener(event);
    });
  };
  return { connection, push };
};

/** The hello the server sends a subscriber: it is the frame that asserts a turn. */
const subscribedFrame = (isProcessing: boolean): ServerEvent => ({
  kind: 'chat_subscribed',
  sessionId: SESSION_ID,
  isProcessing,
  bootId: 'boot-1',
  rev: 1,
  unreachableAfterMs: 60_000,
  timestamp: new Date(START).toISOString(),
});

/** A host listing holding one resident session, so the classification has a second group to place. */
const HOST_LISTING: SessionHostsSnapshot = {
  hosts: [
    {
      hostId: 'host-consolidation',
      provider: 'claude',
      mode: 'resident',
      state: 'idle',
      pid: 4242,
      startedAt: START,
      closeReason: null,
      closeDetail: null,
      bindings: [
        {
          appSessionId: SESSION_ID,
          providerSessionId: 'provider-consolidation',
          state: 'idle',
          leases: [],
          lastActivityAt: START,
          peerName: 'resident@host',
        },
      ],
    },
  ],
  sessions: [
    {
      appSessionId: SESSION_ID,
      provider: 'claude',
      lifecycleMode: 'resident',
      running: false,
      reason: null,
    },
  ],
} as unknown as SessionHostsSnapshot;

const DOCK = '[data-activity-dock]';
/** The two markers the pre-consolidation surfaces published. Neither may match anything. */
const LEGACY_MARKERS = ['.chat-activity-tab', '[data-slot="chat-activity-inline"]'] as const;

const dockState = (container: HTMLElement): string | null =>
  container.querySelector(DOCK)?.getAttribute('data-activity-state') ?? null;

const legacyHits = (container: HTMLElement): string[] =>
  LEGACY_MARKERS.filter((marker) => container.querySelector(marker) !== null);

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  return () => vi.useRealTimers();
});

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

describe('one dock, and one classification of the session', () => {
  test('with a turn in flight: one dock, no legacy surface, and the sidebar says running too', () => {
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
        onAbort: () => undefined,
        persistWhenIdle: true,
      }),
    );
    push(subscribedFrame(true));

    const docks = view.container.querySelectorAll(DOCK);
    const legacy = legacyHits(view.container);
    const state = dockState(view.container);
    const { running, residentIdle } = classifyRunningSessions(new Set([SESSION_ID]), HOST_LISTING);
    console.log(
      `turn: docks=${docks.length} legacy=${JSON.stringify(legacy)} dock.state=${state} `
      + `sidebar.running=${JSON.stringify(running)} sidebar.residentIdle=${JSON.stringify(residentIdle)}`,
    );

    assert.equal(docks.length, 1, 'a session draws exactly one dock, however many surfaces it has');
    assert.deepEqual(
      legacy,
      [],
      'neither of the pre-consolidation markers may match: the tab class and the inline slot are gone, '
        + 'not merely hidden',
    );
    assert.equal(state, 'in-turn', 'the dock reads the server\'s own frame as a turn');
    assert.deepEqual(running, [SESSION_ID], 'and the sidebar classifies the same session as running');
    assert.deepEqual(residentIdle, [], 'and not as a resident process held open — the two groups are disjoint');

    view.unmount();
  });

  test('with the turn over: the dock is still there and reads idle, and so does the sidebar', () => {
    // The positive control, and the arm the old page failed. The dock is *drawn* —
    // it is not passing by having rendered nothing — and it reads idle from the same
    // activity table the classification reads, at the same instant. A page whose
    // sidebar still consulted the one-second host poll would, here, classify the
    // session as running off the poll's lease while the dock had already seen the
    // turn end: `sidebar.running` would be `["session-consolidation"]` against
    // `dock.state=idle`. That is the window `e2e/activity-dock-truthful.spec.ts`
    // opens on a real server; this is the same disagreement in the small.
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: SESSION_ID,
        connection,
        persistWhenIdle: true,
      }),
    );
    // A resident session with nothing in flight: the hello itself says so.
    push(subscribedFrame(false));
    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS);
    });

    const docks = view.container.querySelectorAll(DOCK);
    const state = dockState(view.container);
    const legacy = legacyHits(view.container);
    const { running, residentIdle } = classifyRunningSessions(new Set<string>(), HOST_LISTING);
    console.log(
      `idle: docks=${docks.length} legacy=${JSON.stringify(legacy)} dock.state=${state} `
      + `sidebar.running=${JSON.stringify(running)} sidebar.residentIdle=${JSON.stringify(residentIdle)}`,
    );

    assert.equal(docks.length, 1, 'a resident session keeps its dock between turns — the facts are reachable');
    assert.deepEqual(legacy, [], 'and still nothing publishes the old markers');
    assert.equal(
      state,
      'idle',
      'the dock says idle, and says it as a *reading* — an absent dock would be indistinguishable from a broken one',
    );
    assert.deepEqual(running, [], 'the sidebar counts no turn in flight, from the same activity table');
    assert.deepEqual(residentIdle, [SESSION_ID], 'and places the held-open process in the other group');

    view.unmount();
  });

  test('a non-resident session that is idle draws no dock at all', () => {
    // The flag's own control: without it the same props draw nothing, which is what
    // makes the two docks above readings of the resident case rather than of a
    // component that always renders something.
    const view = render(
      React.createElement(ActivityIndicator, { activity: null, sessionId: SESSION_ID, persistWhenIdle: false }),
    );
    console.log(`idle.nonResident: docks=${view.container.querySelectorAll(DOCK).length}`);
    assert.equal(
      view.container.querySelectorAll(DOCK).length,
      0,
      'an idle session with no resident facts to hold open has nothing to draw',
    );
    view.unmount();
  });
});
