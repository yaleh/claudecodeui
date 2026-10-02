import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, render, within } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { ActivityConnection, ServerEvent, SessionActivity } from '@/shared/types';

/**
 * The dock's honest reading when the server stops answering.
 *
 * These cases drive the freshness machine through the dock's own in-memory
 * liveness channel — no socket, no network — and read what the surface
 * publishes: `data-activity-state`, the text, the stop control's `disabled`
 * attribute, and the server-derived elapsed reading. The browser criterion
 * (`e2e/activity-dock-truthful.spec.ts`) proves the same shape against a real
 * server; this file is the fast feedback that pins the decisions without the
 * twenty-second boot.
 *
 * The positive control matters as much as the negative: an in-turn dock must
 * still carry one of the six rotating action words, or "the word is gone when
 * unreachable" would pass against a dock that never drew a word at all.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_ROOT = path.resolve(HERE, '../../i18n/locales');

/** The six rotating action words, in every locale the app ships; the dock must drop all of them. */
const SIX_WORDS = [...new Set(
  fs.readdirSync(LOCALES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = path.join(LOCALES_ROOT, entry.name, 'chat.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        claudeStatus?: { actions?: Record<string, string> };
      };
      return Object.values(parsed.claudeStatus?.actions ?? {});
    })
    .filter((word): word is string => typeof word === 'string' && word.length > 0),
)];

const START = Date.parse('2026-01-01T00:00:00.000Z');
const SESSION_ID = 'session-a';
const UNREACHABLE_AFTER_MS = 900;
/** The hook's own one-second poll is what carries a threshold crossing back into React. */
const POLL_STEP_MS = 1_000;

/** `statusText: null` so the label falls through to the rotating word — the thing this file reads. */
const ACTIVITY: SessionActivity = { statusText: null, canInterrupt: true, startedAt: START };

const DOCK = '[data-activity-dock]';

/** An in-memory liveness channel, so the case can hand the hook frames with no socket. */
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

const subscribedFrame = (overrides: Partial<ServerEvent> = {}): ServerEvent => ({
  kind: 'chat_subscribed',
  sessionId: SESSION_ID,
  isProcessing: true,
  bootId: 'boot-1',
  rev: 1,
  unreachableAfterMs: UNREACHABLE_AFTER_MS,
  timestamp: new Date(START).toISOString(),
  ...overrides,
});

const heartbeatFrame = (timestamp: number): ServerEvent => ({
  kind: 'activity.heartbeat',
  sessionId: SESSION_ID,
  bootId: 'boot-1',
  rev: 1,
  timestamp: new Date(timestamp).toISOString(),
});

const dockOf = (view: { container: HTMLElement }) => {
  const dock = view.container.querySelector<HTMLElement>(DOCK);
  assert.ok(dock, `the dock must be on screen (${DOCK}); DOM: ${view.container.innerHTML.slice(0, 400)}`);
  return dock;
};

/** Six seconds of local time, far past any server frame this case sends. */
const LOCAL_STEP_MS = 6_000;

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the activity dock under a partition', () => {
  test('unreachable: the six words are gone, the clock is frozen, and the stop is disabled with a reason', () => {
    const readings: string[] = [];
    const onAbort = vi.fn();
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
        onAbort,
      }),
    );

    // With fresh evidence the dock is the running turn, and it does carry a word.
    push(subscribedFrame());
    const freshDock = dockOf(view);
    const freshText = freshDock.textContent ?? '';
    readings.push(`fresh: state=${freshDock.getAttribute('data-activity-state')} text="${freshText}"`);
    assert.equal(
      freshDock.getAttribute('data-activity-state'),
      'in-turn',
      `a fresh frame must read in-turn; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      SIX_WORDS.some((word) => freshText.includes(word)),
      `positive control: an in-turn dock must carry one of the six words; readings: ${readings.join(' | ')}`,
    );

    // No frame arrives. Past the server's announced threshold the dock must stop speaking for the turn.
    act(() => {
      vi.advanceTimersByTime(UNREACHABLE_AFTER_MS + POLL_STEP_MS);
    });

    const dock = dockOf(view);
    const text = dock.textContent ?? '';
    const state = dock.getAttribute('data-activity-state');
    const hits = SIX_WORDS.filter((word) => text.includes(word));
    readings.push(`unreachable: state=${state} text="${text}" hits=${JSON.stringify(hits)}`);
    assert.equal(state, 'unreachable', `silence past the threshold must read unreachable; readings: ${readings.join(' | ')}`);
    assert.deepEqual(
      hits,
      [],
      `no rotating action word may survive into the unreachable dock (any locale); readings: ${readings.join(' | ')}`,
    );

    // The elapsed reading is frozen: local time moves, the number does not.
    const frozenBefore = dock.getAttribute('data-activity-elapsed-ms');
    const textBefore = text.match(/\d+s|\d+m \d+s/)?.[0] ?? '<none>';
    act(() => {
      vi.advanceTimersByTime(LOCAL_STEP_MS);
    });
    const frozenAfter = dockOf(view).getAttribute('data-activity-elapsed-ms');
    const textAfter = (dockOf(view).textContent ?? '').match(/\d+s|\d+m \d+s/)?.[0] ?? '<none>';
    readings.push(`frozen: before=${frozenBefore}ms after=${frozenAfter}ms text "${textBefore}" -> "${textAfter}"`);
    assert.notEqual(frozenBefore, null, `an unreachable turn must still report its last server-derived elapsed; readings: ${readings.join(' | ')}`);
    assert.equal(
      frozenAfter,
      frozenBefore,
      `the elapsed reading must be frozen while unreachable, not re-driven by the local clock; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      textAfter,
      textBefore,
      `the elapsed text must read the same across local time; readings: ${readings.join(' | ')}`,
    );

    // The stop stays on screen, disabled, with a non-empty reason.
    const stop = within(dock).getByRole('button', { name: /stop/i });
    const reason = stop.getAttribute('title') ?? '';
    readings.push(`stop: disabled=${stop.hasAttribute('disabled')} reason="${reason}"`);
    assert.ok(
      stop.hasAttribute('disabled'),
      `the stop must carry the disabled attribute while unreachable; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      reason.trim().length > 0,
      `the disabled stop must explain itself; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      text.includes(enChat.claudeStatus.unreachable.stopReason),
      `the reason must be visible in the dock's text; readings: ${readings.join(' | ')}`,
    );
    assert.equal(onAbort.mock.calls.length, 0, 'a disabled stop must not fire');
  });

  test('a failed send is a state of its own, and a live turn is never relabelled by it', () => {
    const readings: string[] = [];

    // Nothing is running and the send failed: the dock speaks the failure. This
    // is the reading the browser criterion takes — and the one a retained local
    // "processing" mark would keep out of reach.
    const failedView = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: SESSION_ID,
        connection: makeConnection().connection,
        sendFailed: true,
      }),
    );
    const failedDock = dockOf(failedView);
    const failedState = failedDock.getAttribute('data-activity-state');
    const failedText = failedDock.textContent ?? '';
    const failedHits = SIX_WORDS.filter((word) => failedText.includes(word));
    readings.push(`send-failed: state=${failedState} text="${failedText}" hits=${JSON.stringify(failedHits)}`);
    assert.equal(
      failedState,
      'send-failed',
      `a failed send with no turn must publish its own state; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      failedText.trim().length > 0,
      `the failed-send dock must say something, not draw an empty element; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      failedText.includes(enChat.claudeStatus.sendFailed.title),
      `the dock must carry the shipped failure wording; readings: ${readings.join(' | ')}`,
    );
    assert.deepEqual(
      failedHits,
      [],
      `a failed send is not a turn: no rotating action word may appear; readings: ${readings.join(' | ')}`,
    );

    // A session the local table still reports as running is NOT relabelled: the
    // turn reading wins, so keeping the send-time mark (the defect) leaves the
    // dock claiming a turn instead of reporting the failure.
    const markedView = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection: makeConnection().connection,
        sendFailed: true,
      }),
    );
    const markedState = dockOf(markedView).getAttribute('data-activity-state');
    readings.push(`retained-mark: state=${markedState}`);
    assert.notEqual(
      markedState,
      'send-failed',
      `a retained processing mark must keep the dock off the failed-send state; readings: ${readings.join(' | ')}`,
    );
  });

  test('recovery: a frame after the partition returns the dock to the turn, with the clock carried forward', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
        onAbort: () => undefined,
      }),
    );

    push(subscribedFrame());
    act(() => {
      vi.advanceTimersByTime(UNREACHABLE_AFTER_MS + POLL_STEP_MS);
    });
    assert.equal(
      dockOf(view).getAttribute('data-activity-state'),
      'unreachable',
      `premise: the partition must have degraded the dock; readings: ${readings.join(' | ')}`,
    );

    // A heartbeat after the gap: the turn's anchor survived, so the elapsed is the whole span,
    // not a clock restarted at the moment the frame arrived.
    const RESTART_MS = 30_000;
    push(heartbeatFrame(START + RESTART_MS));
    const dock = dockOf(view);
    const elapsed = Number(dock.getAttribute('data-activity-elapsed-ms'));
    readings.push(`recovered: state=${dock.getAttribute('data-activity-state')} elapsed=${elapsed}ms restart-would-be=0ms`);
    assert.equal(
      dock.getAttribute('data-activity-state'),
      'in-turn',
      `a frame must restore the turn; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      elapsed,
      RESTART_MS,
      `the elapsed must be measured from the turn's first anchor, not from the recovery frame; readings: ${readings.join(' | ')}`,
    );
    assert.notEqual(
      elapsed,
      0,
      `a clock restarted at recovery would read 0; readings: ${readings.join(' | ')}`,
    );
  });
});
