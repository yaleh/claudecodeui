import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { createElement, type ReactNode } from 'react';
import type * as ReactDomModule from 'react-dom';
import { afterEach, describe, it, vi } from 'vitest';

// Type-only module aliases for the two mocks below, so their `importOriginal` calls can name the
// module's type without an `import()` annotation (which this repo's lint forbids) and without a
// runtime import (the factories are hoisted above every statement in this file, so a value import
// would be evaluated too late for them to see it). Both are erased before that hoisting runs.
import type * as SessionHostsModule from '@/shared/hooks/useSessionHosts';
import type { SessionHostsSnapshot } from '@/shared/types';

/**
 * The structural half of AC-177, held in jsdom.
 *
 * The browser criterion (`e2e/resident-ui-layout.spec.ts`) is the load-bearing reading — it decides
 * reachability with `document.elementFromPoint`, which is the only thing that can tell a clipped
 * button from a merely overlapped one. jsdom lays nothing out, so this file cannot repeat that
 * reading and does not try to. What it can hold is the *shape* the fix depends on: the panel must
 * not be a descendant of the transcript's scroll container, because that container is
 * `overflow-y-auto overflow-x-hidden` and a descendant is therefore inside the clip. A regression
 * that rendered the panel inline again — the natural-looking way to write it, and the way it was
 * written before — would still be caught here in milliseconds rather than in a 16-second browser
 * run, and would be caught with the reason named rather than as a mismatched coordinate.
 */

const SESSION_ID = 'session-narrow';

const t = ((key: string) => key) as unknown as TFunction;

/**
 * Shared with the mocks below, which are hoisted above every other statement in this file.
 *
 * `inline` is the reverse leg's lever: with it set, `createPortal` degrades to rendering the node
 * where it was written instead of into `document.body`, which is exactly the pre-fix shape.
 */
const harness = vi.hoisted(() => ({
  inline: false,
  snapshot: {
    hosts: [
      {
        hostId: 'host-narrow',
        provider: 'claude',
        mode: 'resident',
        state: 'idle',
        pid: 4242,
        startedAt: Date.now() - 60_000,
        closeReason: null,
        closeDetail: '',
        bindings: [
          {
            appSessionId: 'session-narrow',
            providerSessionId: 'provider-session-narrow',
            state: 'idle',
            leases: [],
            lastActivityAt: Date.now(),
            peerName: 'resident@host',
          },
        ],
      },
    ],
    sessions: [
      {
        appSessionId: 'session-narrow',
        provider: 'claude',
        lifecycleMode: 'resident',
        running: false,
        reason: null,
      },
    ],
  } as unknown as SessionHostsSnapshot,
}));

// The store is a module-scope poller with no test seam, so the snapshot is supplied through the
// hook and the original module's readings (`findSessionHostState`, `readResidentProcessState`, …)
// are kept: this file is exercising the bar's own DOM shape, not a reimplementation of them.
vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionHostsModule>();
  return {
    ...actual,
    useSessionHosts: () => ({
      snapshot: harness.snapshot,
      error: null,
      loading: false,
      refresh: async () => {},
      start: async () => {},
      close: async () => {},
    }),
  };
});

// The reverse leg. Overriding only `createPortal` leaves the rest of `react-dom` — and therefore
// React itself, which the test renderer needs — untouched.
vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactDomModule>();
  return {
    ...actual,
    createPortal: (node: ReactNode, container: Element | DocumentFragment) =>
      (harness.inline ? node : actual.createPortal(node, container)),
  };
});

const ResidentStatusBar = (await import('@/modules/chat/transcript/ResidentStatusBar')).default;

/** A stand-in for the transcript's scroll container, drawn with the classes that clip. */
function renderInPane(): HTMLDivElement {
  const pane = document.createElement('div');
  pane.className = 'chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden';
  document.body.appendChild(pane);

  render(createElement(ResidentStatusBar, { sessionId: SESSION_ID, t }), { container: pane });
  return pane;
}

/** Opens the panel and returns it. Flushed inside `act` because the panel mounts on the effect. */
function openPanel(pane: HTMLDivElement): HTMLElement {
  const trigger = pane.querySelector('[data-resident-status-bar-trigger]');
  assert.ok(trigger, 'the resident bar must render a trigger for a resident session');
  act(() => {
    fireEvent.click(trigger);
  });

  const panel = document.querySelector('[role="dialog"]');
  assert.ok(panel, 'the trigger must open the panel');
  return panel as HTMLElement;
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('.chat-messages-pane, [role="dialog"]').forEach((node) => node.remove());
});

describe('the resident popover and the transcript clip', () => {
  it('renders the open panel outside the transcript scroll container', () => {
    const pane = renderInPane();
    const panel = openPanel(pane);

    // Both predicates are stated as booleans rather than as "this node equals that node" on purpose.
    // When such an assertion FAILS, the reporter has to render the nodes it was handed, and jsdom's
    // elements are deep circular graphs: formatting one does not return, so the whole worker hangs and
    // the run dies with no output at all instead of reporting a red. Handing it `false` keeps a
    // regression legible — this file's own reverse leg below is the proof, since writing it the
    // natural way is exactly what produced that hang.
    assert.equal(
      panel.closest('.chat-messages-pane') === null,
      true,
      'the panel is a descendant of the overflow-y-auto pane, so the pane can clip it',
    );
    assert.equal(
      panel.parentElement === document.body,
      true,
      'the panel must be portaled to document.body',
    );
  });

  // The reverse leg: with the portal disabled, the very predicate asserted above must flip. If both
  // tests ever agree, the assertion above is measuring nothing — a green that survives the bug it
  // exists to catch is worse than no test.
  it('reverse leg: falls back inside the pane when the portal is disabled', () => {
    harness.inline = true;
    try {
      const pane = renderInPane();
      const panel = openPanel(pane);

      assert.equal(
        panel.closest('.chat-messages-pane') !== null,
        true,
        'without the portal the panel is back inside the scroll container — the pre-fix shape',
      );
      // The panel is written where it was declared, so it is the bar that parents it — not the body
      // the portal would have moved it to. This is the second half of the first test's predicate,
      // flipped; stated as a boolean for the same reason as above.
      assert.equal(
        panel.parentElement === document.body,
        false,
        'the inline fallback must be parented by the bar, not document.body',
      );
    } finally {
      harness.inline = false;
    }
  });
});
