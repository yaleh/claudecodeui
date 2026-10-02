import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { createElement } from 'react';
import { afterEach, describe, it, vi } from 'vitest';

// Type-only module aliases, so the mock's `importOriginal` can name the module's type without an
// `import()` annotation (which this repo's lint forbids) and without a runtime import (the factory
// is hoisted above every statement in this file). Erased before that hoisting runs.
import type * as SessionHostsModule from '@/shared/hooks/useSessionHosts';
import type { SessionHostsSnapshot } from '@/shared/types';

/**
 * The resident controls are reachable from the dock, held in jsdom.
 *
 * This file used to guard a portal: the status bar's popover had to be rendered into
 * `document.body`, because the bar lived inside the transcript's `overflow-y-auto` pane and a
 * popover opening downward from there was *clipped* — `document.elementFromPoint` at the Close
 * button's own centre returned whatever was painted under the pane, and the control could not be
 * clicked at all. The bar is gone; the controls are the activity dock's expanded panel now, and
 * the dock's mount sites are outside that scroll container on the layout that draws a floating
 * surface (the composer) and in the flow on the one that does not (the transcript, below `md`).
 * A panel that is in the flow cannot be clipped by the flow: it is part of it.
 *
 * So the portal is no longer the mechanism, and the reading that replaces it is the one that
 * matters to a user: **the disclosure opens a panel that carries the controls, and closing it
 * takes them away again**. jsdom lays nothing out, so reachability-by-pointer stays the browser
 * criterion's job (`e2e/activity-dock-truthful.spec.ts -g "AC-188"` opens this panel on a real
 * page); what this file holds is that the panel is *there*, that the dock is what renders it, and
 * that nothing else on the page renders a second copy.
 */

const SESSION_ID = 'session-narrow';

const t = ((key: string) => key) as unknown as TFunction;

/** Shared with the mock below, which is hoisted above every other statement in this file. */
const harness = vi.hoisted(() => ({
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
// hook and the original module's readings (`findSessionHostState`, `findBinding`, …) are kept:
// this file is exercising the dock's own DOM shape, not a reimplementation of them.
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

const ActivityIndicator = (await import('@/modules/chat/composer/ActivityIndicator')).default;

/**
 * The dock as a resident session draws it between turns.
 *
 * `persistWhenIdle` is the whole of what makes this the resident case: with it the dock keeps its
 * collapsed entry point when there is no turn to report, which is the only state in which a user
 * would need the resident controls at all.
 */
function renderDock(): ReturnType<typeof render> {
  return render(
    createElement(ActivityIndicator, {
      activity: null,
      sessionId: SESSION_ID,
      persistWhenIdle: true,
    }),
  );
}

const DOCK = '[data-activity-dock]';
const TOGGLE = '[data-activity-dock-toggle]';
const PANEL = '[data-activity-dock-panel]';

afterEach(() => {
  cleanup();
});

describe('the resident controls live in the dock, and the disclosure is how they are reached', () => {
  it('opens the panel from the dock and takes it away again on the second press', () => {
    const view = renderDock();
    const dock = view.container.querySelector(DOCK);
    assert.ok(dock, `a resident session must keep a dock between turns (${DOCK})`);
    assert.equal(
      view.container.querySelector(PANEL),
      null,
      'the panel starts closed: the collapsed dock is one row, not a wall of facts',
    );

    const toggle = view.container.querySelector(TOGGLE);
    assert.ok(toggle, 'the collapsed dock must offer the disclosure that opens the panel');
    act(() => {
      fireEvent.click(toggle);
    });

    const panel = view.container.querySelector(PANEL);
    assert.ok(panel, 'the disclosure must open the panel');
    assert.ok(
      dock.contains(panel),
      'the panel must be the dock\'s own, so a reader that found the dock finds the facts',
    );
    for (const marker of ['[data-resident-address]', '[data-resident-pid-text]', '[data-resident-copy]', '[data-resident-close]']) {
      assert.ok(
        panel.querySelector(marker),
        `the open panel must carry ${marker}; it reads ${panel.textContent ?? ''}`,
      );
    }

    // The second press closes it, and the controls go with it — a disclosure that only ever
    // opened would leave the transcript permanently covered on the layout where it floats.
    act(() => {
      fireEvent.click(toggle);
    });
    assert.equal(view.container.querySelector(PANEL), null, 'a second press must close the panel again');
  });

  it('renders exactly one dock, and the panel only ever inside it', () => {
    const view = renderDock();
    assert.equal(
      view.container.querySelectorAll(DOCK).length,
      1,
      'a resident session draws exactly one dock; a second mount site would be a second answer',
    );

    const toggle = view.container.querySelector(TOGGLE);
    assert.ok(toggle, 'premise: the disclosure must exist, or the reading below is about a closed panel');
    act(() => {
      fireEvent.click(toggle);
    });

    const panels = document.querySelectorAll(PANEL);
    assert.equal(panels.length, 1, `exactly one panel must exist once opened; found ${panels.length}`);
    assert.ok(
      view.container.querySelector(DOCK)?.contains(panels[0]),
      'and it must be the dock\'s descendant, not a second surface beside it',
    );
  });

  it('draws no dock at all for a session that is not resident', () => {
    // The positive control on `persistWhenIdle`: with the flag off there is no turn and nothing to
    // hold open, so the dock is absent — which is what makes the presence above a reading of the
    // flag rather than of the component always rendering something.
    const view = render(
      createElement(ActivityIndicator, { activity: null, sessionId: SESSION_ID }),
    );
    assert.equal(
      view.container.querySelector(DOCK),
      null,
      'an idle non-resident session has nothing to say and no facts to keep: no dock',
    );
  });
});
