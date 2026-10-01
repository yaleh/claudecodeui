import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { act, cleanup, render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import ResidentStatusBar from '@/modules/chat/transcript/ResidentStatusBar';
import { ResidentMark } from '@/modules/sidebar';
import type { SessionHostsSnapshot } from '@/shared/types';

/**
 * The host-snapshot poll's own failure, and what the UI is allowed to say about it.
 *
 * The store (`useSessionHosts`) keeps the last snapshot when a poll throws — which
 * is right, the listing is not evidence that every process went away — but for as
 * long as it did, both consumers went on reporting the *state word* from that
 * stale snapshot. A server that had died therefore left the status bar and the
 * sidebar mark saying `busy` about a process nobody could see: the "pretending to
 * think" this vocabulary exists to prevent, on the snapshot leg. The fix folds the
 * read's own failure into the ONE shared translation (`readResidentProcessState`),
 * so both consumers read `unknown` while the read is failing and the real word
 * again the moment a read succeeds.
 *
 * This file drives the REAL store, not a mock of it. `vi.mock` of the hook is what
 * the sibling criteria use, and it would make this criterion vacuous: the whole
 * subject is what the hook's `error` does to the reading, and a hand-written fake
 * would be this file grading its own answer. Instead `fetch` is stubbed with a
 * scripted queue — busy succeeds, the next poll rejects, idle succeeds — and the
 * poll's 1-second beat is driven with fake timers. The two consumers are rendered
 * together, and their published attributes (`data-resident-ui-state` on the bar,
 * `data-resident-state` on the mark) are read in each of the three phases.
 *
 * Falsification (run by the implementer, recorded in the completion record): the
 * fix's only moving part is the second argument to `readResidentProcessState`.
 * Reverting both consumers to `readResidentProcessState(host)` restores the
 * pre-fix reading, and the phase-2 assertions below fail: the bar and the mark
 * both stay `busy` instead of reading `unknown`.
 */

const SESSION_ID = 'session-snapshot-failure';
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');
/** The locales AC-189 names, so a missing directory is caught and not merely unenumerated. */
const REQUIRED_LOCALES = ['de', 'en', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'];

/** The shape `authenticatedFetch` and `readApiJson` read off a response. */
type StubResponse = {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => null };
  json: () => Promise<unknown>;
};

/**
 * The shipped English copy, interpolated, so the bar renders the sentence a user
 * reads rather than a key name. Read from the locale file rather than restated
 * here — the copy is not this criterion's subject, and writing it down would let
 * the two drift.
 */
function readKey(source: unknown, keyPath: string): unknown {
  let node: unknown = source;
  for (const segment of keyPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const enChat = JSON.parse(readFileSync(join(LOCALES_DIR, 'en', 'chat.json'), 'utf8')) as unknown;

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = readKey(enChat, key);
  const base = typeof template === 'string' ? template : key;
  return base.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params?.[name] ?? ''));
}) as unknown as TFunction;

/** A listing holding one resident session, served by one live host in the given state. */
function listingWithHost(state: 'busy' | 'idle', leases: Array<Record<string, unknown>>): SessionHostsSnapshot {
  return {
    hosts: [
      {
        hostId: 'host-snapshot',
        provider: 'claude',
        mode: 'resident',
        state,
        pid: 4242,
        startedAt: 0,
        closeReason: null,
        closeDetail: null,
        bindings: [
          {
            appSessionId: SESSION_ID,
            providerSessionId: 'provider-snapshot',
            state,
            leases,
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
  } as unknown as SessionHostsSnapshot;
}

/** The `GET /api/session-hosts` success envelope carrying one listing. */
function ok(body: unknown): StubResponse {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

/** One scripted answer the next `fetch` resolves (or rejects) with. */
type Answer = () => Promise<StubResponse>;

// Shared with the hoisted `fetch` stub, which the module under test reaches through
// `authenticatedFetch`'s reference to the global.
const harness = vi.hoisted(() => ({ script: [] as Array<() => Promise<unknown>> }));

beforeEach(() => {
  vi.useFakeTimers();
  harness.script.length = 0;
  vi.stubGlobal('fetch', async (): Promise<unknown> => {
    const next = harness.script.shift();
    assert.ok(next, 'the poll made a request the script did not account for');
    return next();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The bar's published UI state, or null when the bar did not render. */
function barState(): string | null {
  const bar = document.querySelector('[data-resident-status-bar]');
  return bar?.getAttribute('data-resident-ui-state') ?? null;
}

/** The sidebar mark's published state, or null when the mark did not render. */
function markState(): string | null {
  const mark = document.querySelector('[data-resident-state]');
  return mark?.getAttribute('data-resident-state') ?? null;
}

/**
 * Advances the poll by `ms` and drains every microtask the read chain produces
 * (`fetch` → `authenticatedFetch` → `readApiJson` → `emit` → React re-render),
 * inside `act` so the external-store update is flushed before the next reading.
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  });
}

describe('a host-snapshot poll that fails degrades both readers to unknown', () => {
  it('reads busy, then unknown on a failed poll, then idle again when a poll succeeds', async () => {
    const busy = listingWithHost('busy', [{ kind: 'turn', runId: 'run-1' }]);
    const idle = listingWithHost('idle', []);

    // The script, in the order the poll consumes it: success busy, failure (reject),
    // success idle — exactly the three beats AC-189 names.
    const answers: Answer[] = [
      () => Promise.resolve(ok({ success: true, data: busy })),
      () => Promise.reject(new Error('session-hosts endpoint unreachable')),
      () => Promise.resolve(ok({ success: true, data: idle })),
    ];
    harness.script.push(...answers);

    render(
      createElement(
        'div',
        null,
        createElement(ResidentStatusBar, { sessionId: SESSION_ID, t }),
        createElement(ResidentMark, { sessionId: SESSION_ID, t }),
      ),
    );

    // The subscriber starts the poller immediately, so the first read is in flight
    // without any timer. `advance(0)` flushes it and fires no interval tick.
    await advance(0);

    const phase1 = { bar: barState(), mark: markState() };
    console.log(`host-snapshot-failure phase1.busy bar=${phase1.bar} mark=${phase1.mark}`);
    assert.equal(phase1.bar, 'busy', 'a successful poll reporting a busy host reads busy on the bar');
    assert.equal(phase1.mark, 'busy', 'and the same reading reaches the sidebar mark');
    assert.equal(
      document.querySelector('[data-resident-mark]')?.getAttribute('data-resident-mark'),
      'solid+spinner',
      'the busy mark is drawn as the solid dot plus spinner',
    );

    // One beat later the poll rejects. The store keeps the snapshot, but the read's
    // own failure must fold the state word to `unknown` in the SAME render.
    await advance(1000);

    const phase2 = { bar: barState(), mark: markState() };
    console.log(`host-snapshot-failure phase2.failed bar=${phase2.bar} mark=${phase2.mark}`);
    assert.equal(phase2.bar, 'unknown', 'a failed poll must not keep the bar on the stale busy word');
    assert.equal(phase2.mark, 'unknown', 'nor the mark: one failed read, one word, in both readers');
    assert.notEqual(phase2.bar, 'busy', 'the bar is not allowed to claim busy with no live reading behind it');
    assert.notEqual(phase2.mark, 'busy', 'nor the mark');
    assert.equal(
      document.querySelector('[data-resident-spinner]'),
      null,
      'the unknown mark must not draw the busy spinner',
    );
    assert.equal(
      document.querySelector('[data-resident-mark]')?.getAttribute('data-resident-mark'),
      'unknown',
      'its shape is neither the busy spinner nor the idle solid dot',
    );

    // One beat later a poll succeeds again, and the real word returns at once.
    await advance(1000);

    const phase3 = { bar: barState(), mark: markState() };
    console.log(`host-snapshot-failure phase3.recovered bar=${phase3.bar} mark=${phase3.mark}`);
    assert.equal(phase3.bar, 'idle', 'a successful poll restores the true state on the bar');
    assert.equal(phase3.mark, 'idle', 'and on the mark — it does not stay stuck at unknown');

    // Equivalence across every phase: the two attributes are equal each time, which is
    // what proves both readers consult one reading rather than deciding for themselves.
    for (const [phase, reading] of Object.entries({ phase1, phase2, phase3 })) {
      assert.equal(
        reading.bar,
        reading.mark,
        `the bar and the mark must publish the same state in ${phase}`,
      );
    }

    assert.equal(
      harness.script.length,
      0,
      'exactly three polls were driven — one per phase — and no request went unexplained',
    );
  });
});

describe('every shipped locale carries the unknown sentence', () => {
  it('has a non-empty resident.statusBar.unknown in each of the twelve locales', () => {
    const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const missing: string[] = [];
    for (const locale of locales) {
      const chat = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'chat.json'), 'utf8')) as unknown;
      const value = readKey(chat, 'resident.statusBar.unknown');
      if (typeof value !== 'string' || value.trim().length === 0) {
        missing.push(`${locale}/chat.json:resident.statusBar.unknown`);
      }
    }
    for (const required of REQUIRED_LOCALES) {
      if (!locales.includes(required)) {
        missing.push(`${required}/chat.json:<locale directory absent>`);
      }
    }

    console.log(`host-snapshot-failure locales.checked=${locales.length} unknown.missing=${missing.length}`);
    assert.equal(locales.length >= REQUIRED_LOCALES.length, true, 'every required locale must be enumerated');
    assert.deepEqual(missing, [], `every locale must carry resident.statusBar.unknown; missing: ${missing.join(', ')}`);
  });
});
