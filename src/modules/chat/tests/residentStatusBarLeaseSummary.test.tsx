import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Type-only module aliases, so the mock's `importOriginal` can name the module's type without an
// `import()` annotation (which this repo's lint forbids) and without a runtime import (the factory
// is hoisted above every statement in this file). Erased before that hoisting runs.
import type * as SessionHostsModule from '@/shared/hooks/useSessionHosts';
import type { SessionHostsSnapshot } from '@/shared/types';

/**
 * The collapsed status bar's lease summary, held in jsdom.
 *
 * The bar used to draw one `data-lease-kind` chip per kind a host held, so its width grew with the
 * kinds and crowded the bar while the popover below it stayed half empty. The fix moves the
 * per-kind chips into the popover and leaves the bar a single merged number. The browser criterion
 * (`e2e/resident-status-bar.spec.ts`) is what proves the fix against a real host; this file pins the
 * *shape* it depends on, in milliseconds and with the reason named: the trigger draws no chip, the
 * popover draws one chip per kind, and the bar's number equals the sum of those chips. The reverse
 * leg is a mutation of the component — putting the chip loop back inside the trigger reds the first
 * assertion below — and is run by the implementer, not encoded here.
 */

const SESSION_ID = 'session-lease-summary';
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** Three leases of three distinct kinds: the fixture both the bar and the popover must account for. */
const LEASES: Array<Record<string, unknown>> = [
  { kind: 'turn', runId: 'run-1' },
  { kind: 'monitor', id: 'monitor-1' },
  { kind: 'cron', id: 'cron-1', recurring: false, expiresAt: 0 },
];

// Shared with the hoisted mock below. Mutable so one test case can re-render the same component
// against a different lease set — the positive control that proves the merged number is read off
// the leases rather than written as a constant.
const harness = vi.hoisted(() => ({
  leases: [] as Array<Record<string, unknown>>,
}));

// The store is a module-scope poller with no test seam, so the snapshot is supplied through the
// hook; the original module's readings (`findSessionHostState`, `readResidentProcessState`, …) are
// kept, because this file exercises the bar's own DOM shape and not a reimplementation of them.
vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionHostsModule>();
  const snapshot = (): SessionHostsSnapshot => ({
    hosts: [
      {
        hostId: 'host-lease-summary',
        provider: 'claude',
        mode: 'resident',
        state: 'busy',
        pid: 4242,
        startedAt: 0,
        closeReason: null,
        closeDetail: null,
        bindings: [
          {
            appSessionId: SESSION_ID,
            providerSessionId: 'provider-lease-summary',
            state: 'busy',
            leases: harness.leases,
            lastActivityAt: 0,
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
        running: true,
        reason: null,
      },
    ],
  } as unknown as SessionHostsSnapshot);

  return {
    ...actual,
    useSessionHosts: () => ({
      snapshot: snapshot(),
      error: null,
      loading: false,
      refresh: async () => {},
      start: async () => {},
      close: async () => {},
    }),
  };
});

/** Reads a dotted path out of a parsed locale file, the way the app's own lookup walks it. */
function readKey(source: unknown, keyPath: string): unknown {
  let node: unknown = source;
  for (const segment of keyPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const enChat = JSON.parse(readFileSync(join(LOCALES_DIR, 'en', 'chat.json'), 'utf8')) as unknown;

/**
 * The shipped English copy, interpolated — the sentence a user reads, not a key name.
 *
 * Passing this as `t` is what lets the criterion compare the bar's merged number against the
 * sentence rendered from the locale file (`{{count}} active` → `3 active`), rather than asserting
 * against a value this file also wrote.
 */
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = readKey(enChat, key);
  const base = typeof template === 'string' ? template : key;
  return base.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params?.[name] ?? ''));
}) as unknown as TFunction;

const ResidentStatusBar = (await import('@/modules/chat/transcript/ResidentStatusBar')).default;

function renderBar(): ReturnType<typeof render> {
  return render(createElement(ResidentStatusBar, { sessionId: SESSION_ID, t }));
}

function triggerEl(): HTMLElement {
  const trigger = document.querySelector('[data-resident-status-bar-trigger]');
  assert.ok(trigger, 'the bar must render a trigger for a resident session');
  return trigger as HTMLElement;
}

/** Opens the popover and returns its panel. Flushed inside `act` because it mounts on the effect. */
function openPanel(): HTMLElement {
  act(() => {
    fireEvent.click(triggerEl());
  });
  const panel = document.querySelector('[role="dialog"]');
  assert.ok(panel, 'the trigger must open the popover');
  return panel as HTMLElement;
}

/** The `data-lease-kind` chips under `root`, with their counts summed. */
function readPills(root: ParentNode): { nodes: number; kinds: Set<string>; countSum: number } {
  const nodes = root.querySelectorAll('[data-lease-kind]');
  const kinds = new Set<string>();
  let countSum = 0;
  nodes.forEach((node) => {
    kinds.add(node.getAttribute('data-lease-kind') ?? '');
    countSum += Number(node.getAttribute('data-lease-count') ?? '0');
  });
  return { nodes: nodes.length, kinds, countSum };
}

/** The bar's merged-count node, if it drew one. */
function readSummary(): { text: string; count: number | null } {
  const node = triggerEl().querySelector('[data-resident-lease-summary]');
  if (!node) return { text: '', count: null };
  const raw = node.getAttribute('data-resident-lease-total');
  return { text: (node.textContent ?? '').trim(), count: raw === null ? null : Number(raw) };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('[role="dialog"]').forEach((node) => node.remove());
  harness.leases = [];
});

describe('the collapsed status bar summarises the leases the popover breaks down', () => {
  it('draws no per-kind chip on the bar and a popover whose chips sum to the bar number', () => {
    harness.leases = LEASES;
    const { rerender } = renderBar();

    // The bar: one merged number, and no chip per kind. This first assertion is where the reverse
    // leg lands — putting the chip loop back inside the trigger makes it fail with a count > 0.
    const onBar = readPills(triggerEl());
    const summary = readSummary();
    console.log(`trigger.leaseKindNodes=${onBar.nodes}`);
    console.log(`trigger.summaryText=${JSON.stringify(summary.text)}`);
    console.log(`trigger.summaryCount=${String(summary.count)}`);
    assert.equal(
      onBar.nodes,
      0,
      'the collapsed bar must not draw a chip per lease kind; the breakdown belongs in the popover',
    );
    assert.equal(summary.count, 3, 'a host holding three leases must show a merged count of three');
    assert.equal(summary.text, '3 active', 'the merged count is the shipped sentence for this locale');

    // The popover: the same leases, kind by kind, under the attributes AC-172's reader uses.
    const panel = openPanel();
    const inPanel = readPills(panel);
    console.log(`popover.leaseKindNodes=${inPanel.nodes}`);
    console.log(`popover.kindCount=${inPanel.kinds.size}`);
    console.log(`popover.countSum=${inPanel.countSum}`);
    assert.equal(inPanel.nodes, 3, 'one chip per lease present in the popover');
    assert.equal(inPanel.kinds.size, 3, 'the three fixtures are three distinct kinds');
    assert.equal(
      inPanel.countSum,
      summary.count,
      'the merged number must equal the sum of the popover chips it stands for',
    );
    for (const kind of ['turn', 'monitor', 'cron']) {
      assert.equal(
        panel.querySelector(`[data-lease-kind="${kind}"]`) !== null,
        true,
        `the popover must carry the data-lease-kind chip for ${kind}`,
      );
    }

    // Positive control: the same component with no leases draws no merged count at all, so the
    // number asserted above is read off the leases rather than baked into the markup.
    harness.leases = [];
    rerender(createElement(ResidentStatusBar, { sessionId: SESSION_ID, t }));
    const empty = readSummary();
    console.log(`trigger.summaryText.zeroLeases=${JSON.stringify(empty.text)}`);
    assert.equal(empty.text, '', 'a host holding no leases must render no merged count');
    assert.equal(empty.count, null, 'a host holding no leases must render no merged-count node');
  });
});

describe('every shipped locale carries the merged-count sentence', () => {
  it('has a non-empty resident.statusBar.activeCount in each locale', () => {
    const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const missing: string[] = [];
    for (const locale of locales) {
      const chat = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'chat.json'), 'utf8')) as unknown;
      const value = readKey(chat, 'resident.statusBar.activeCount');
      if (typeof value !== 'string' || value.trim().length === 0) {
        missing.push(`${locale}/chat.json:resident.statusBar.activeCount`);
      }
    }

    console.log(`locales.checked=${locales.length} activeCount.missing=${missing.length}`);
    assert.equal(locales.length > 0, true, 'the locale directory must enumerate at least one locale');
    expect(
      missing,
      `every locale must carry resident.statusBar.activeCount; missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
