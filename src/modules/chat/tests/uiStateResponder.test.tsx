import { act, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUiStateResponder, type UseUiStateResponderDeps } from '@/modules/chat/hooks/useUiStateResponder';
import { getDeviceId, getTabId } from '@/shared/utils/deviceIdentity';
import type { ServerEvent } from '@/shared/types';

/**
 * The browser half of the `ui_visible_context` round trip.
 *
 * A `ui.state_request` arrives on the shared websocket and this device must answer
 * it at once with its own identifiers and ranges — no message body, no user
 * selection, no panel content. Every leg below drives the real
 * `useUiStateResponder` over a subscription the test dispatches frames into and a
 * `sendMessage` that records the reply, so the frame read here is the frame the app
 * would put on the wire.
 *
 * The `visibility`/`hasFocus`/`panel` readings come from the real `document`/DOM,
 * stubbed only where jsdom cannot model them (a background tab, keyboard focus),
 * and the policy and name are read from the same `localStorage` keys the settings
 * section writes.
 */

/** Every key a `ui.state_response` is allowed to carry — the whitelist, and nothing else. */
const RESPONSE_KEYS = [
  'type',
  'requestId',
  'deviceId',
  'tabId',
  'deviceName',
  'navigationPolicy',
  'visibility',
  'hasFocus',
  'lastFocusedAt',
  'panel',
  'selectedProject',
  'selectedSession',
  'visibleMessages',
  'pendingApprovals',
  'queuedMessages',
].sort();

type SentFrame = Record<string, unknown>;

type Rig = {
  sent: SentFrame[];
  listeners: Set<(event: ServerEvent) => void>;
  deps: UseUiStateResponderDeps;
  dispatch: (frame: SentFrame) => Promise<void>;
  reply: () => SentFrame;
};

/** Mounts the hook with nothing to render; the frame it sends is the whole observable. */
function Harness(props: UseUiStateResponderDeps) {
  useUiStateResponder(props);
  return null;
}

/** One test's doubles: a subscription set, a recorder, and the chat-state values the hook is handed. */
function buildRig(overrides: Partial<Omit<UseUiStateResponderDeps, 'subscribe' | 'sendMessage'>> = {}): Rig {
  const sent: SentFrame[] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const deps: UseUiStateResponderDeps = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sendMessage: (message) => {
      sent.push(message as SentFrame);
    },
    selectedProject: 'project-7',
    selectedSession: 'session-9',
    pendingApprovals: 0,
    queuedMessages: 0,
    ...overrides,
  };

  const dispatch = async (frame: SentFrame) => {
    await act(async () => {
      for (const listener of [...listeners]) {
        listener(frame as ServerEvent);
      }
    });
  };

  return {
    sent,
    listeners,
    deps,
    dispatch,
    reply: () => {
      const frame = sent[sent.length - 1];
      if (!frame) {
        throw new Error('no reply frame was sent');
      }
      return frame;
    },
  };
}

/** One `ui.state_request` with a fresh id; the server always sends one. */
const requestFrame = (requestId = 'req-abc'): SentFrame => ({ type: 'ui.state_request', requestId });

/** Saves and restores the two `document` readers jsdom models differently from a real browser. */
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function stubVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalVisibility) {
    Object.defineProperty(document, 'visibilityState', originalVisibility);
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
});

describe('a ui.state_request is answered with this tab’s visible context', () => {
  it('echoes the requestId verbatim and carries only the whitelist fields', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    // A workspace tab is open, so `panel` is a real reading rather than null.
    const panel = document.createElement('button');
    panel.setAttribute('data-workspace-tab', 'chat');
    panel.setAttribute('aria-current', 'true');
    document.body.appendChild(panel);

    const rig = buildRig({ pendingApprovals: 2, queuedMessages: 3 });
    render(<Harness {...rig.deps} />);

    await rig.dispatch(requestFrame('req-abc'));

    expect(rig.sent).toHaveLength(1);
    const frame = rig.reply();

    expect(frame.type).toBe('ui.state_response');
    expect(frame.requestId).toBe('req-abc');
    // The exact key set: a message body, a selection or a panel's content has no
    // field here, so an implementation that added one would fail this line.
    expect(Object.keys(frame).sort()).toEqual(RESPONSE_KEYS);

    expect(frame.deviceId).toBe(getDeviceId());
    expect(frame.tabId).toBe(getTabId());
    expect(typeof frame.deviceName).toBe('string');
    expect((frame.deviceName as string).length).toBeGreaterThan(0);
    expect(frame.visibility).toBe('visible');
    expect(frame.hasFocus).toBe(true);
    expect(frame.panel).toBe('chat');
    expect(frame.selectedProject).toBe('project-7');
    expect(frame.selectedSession).toBe('session-9');
    expect(frame.pendingApprovals).toBe(2);
    expect(frame.queuedMessages).toBe(3);
    expect(typeof frame.lastFocusedAt).toBe('number');
    expect(frame.visibleMessages).toEqual({ first: null, last: null });
  });

  it('reports visibility: hidden and hasFocus: false for a background tab', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    stubVisibility('hidden');
    const rig = buildRig();
    render(<Harness {...rig.deps} />);

    await rig.dispatch(requestFrame('req-hidden'));

    const frame = rig.reply();
    expect(frame.requestId).toBe('req-hidden');
    expect(frame.visibility).toBe('hidden');
    expect(frame.hasFocus).toBe(false);
    // Nothing was focused in this tab, so there is no moment to report.
    expect(frame.lastFocusedAt).toBeNull();
  });

  it('reflects this device’s navigation policy and name from localStorage', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    localStorage.setItem('mcpNavigationPolicy', 'reject');
    localStorage.setItem('mcpNavigationDeviceName', '  Studio Mac  ');
    const rig = buildRig();
    render(<Harness {...rig.deps} />);

    await rig.dispatch(requestFrame('req-policy'));

    const frame = rig.reply();
    expect(frame.navigationPolicy).toBe('reject');
    expect(frame.deviceName).toBe('Studio Mac');
  });

  it('drops a request without an id rather than answering one it cannot match', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    const rig = buildRig();
    render(<Harness {...rig.deps} />);

    await rig.dispatch({ type: 'ui.state_request' });
    await rig.dispatch({ type: 'ui.state_request', requestId: '' });
    // A frame of a different kind is not this hook's to answer.
    await rig.dispatch({ type: 'ui.navigate', navigationId: 'nav-1', requestId: 'req-lost' });

    expect(rig.sent).toHaveLength(0);
  });

  it('answers every request it receives, each with its own requestId', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    const rig = buildRig();
    render(<Harness {...rig.deps} />);

    await rig.dispatch(requestFrame('req-one'));
    await rig.dispatch(requestFrame('req-two'));

    expect(rig.sent.map((frame) => frame.requestId)).toEqual(['req-one', 'req-two']);
  });
});
