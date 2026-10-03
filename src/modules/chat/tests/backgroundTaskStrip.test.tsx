import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import i18next from 'i18next';
import { createElement } from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Type-only module aliases so the hoisted mock's `importOriginal` can name the
// module and its types without an `import()` annotation the lint forbids and
// without a runtime import that would run before the factory is registered.
import type * as SessionHostsModule from '@/shared/hooks/useSessionHosts';
import type { ChatMessage, SessionHostsSnapshot } from '@/shared/types';

/**
 * Criterion for the background-task strip: the surface that reports the work a
 * session's host is being held for.
 *
 * The defect this pins is that the work used to be visible only if the *model*
 * wrote it down — a background task the model never mentioned left the UI with
 * nothing to show. So the strip's input is the host listing, and the transcript
 * is read for labels only. The readings below fix:
 *
 *   (AC3) two held-work leases draw two rows, each with a label and an elapsed
 *         reading; an empty lease set draws nothing at all; a failed or absent
 *         snapshot draws a state of its own that is programmatically distinct
 *         from "nothing held" — "cannot read" must never collapse into "zero".
 *   (AC7) the task list has one source: the strip imports `useSessionHosts` and
 *         derives its rows from that snapshot, and neither `server/` nor `src/`
 *         production code enumerates the process table.
 *   (AC8) every shipped locale carries the strip's own copy.
 */

const SESSION_ID = 'session-background-task-strip';
const ROOT = process.cwd();
const LOCALES_DIR = resolve(ROOT, 'src', 'modules', 'i18n', 'locales');
const STRIP_SOURCE = resolve(ROOT, 'src', 'modules', 'chat', 'transcript', 'BackgroundTaskStrip.tsx');

/** A fixed instant, so the elapsed readings below are literals rather than a race. */
const NOW = 1_700_000_500_000;
const BG_SINCE = NOW - 125_000; // 2:05
const MONITOR_SINCE = NOW - 300_000; // 5:00

/** The two tool calls the two fixture leases are named after. */
const MESSAGES: ChatMessage[] = [
  {
    type: 'assistant',
    isToolUse: true,
    toolId: 'toolu_bg',
    toolName: 'Bash',
    toolInput: { command: 'npm run train', description: 'Train voice model' },
    content: '',
    timestamp: NOW,
  },
  {
    type: 'assistant',
    isToolUse: true,
    toolId: 'toolu_mon',
    toolName: 'Monitor',
    toolInput: { description: 'Watch training log' },
    content: '',
    timestamp: NOW,
  },
];

// Mutable so each case re-renders the same component against a different
// listing: the positive control that the rows are read off the snapshot rather
// than written as constants.
const harness = vi.hoisted(() => ({
  leases: [] as Array<Record<string, unknown>>,
  snapshotNull: false,
  error: null as string | null,
}));

// The store is a module-scope poller with no test seam, so the snapshot is
// supplied through the hook. The original module's readings (the real
// `findBackgroundTaskLeases`, in particular) are kept, because this file pins
// the surface's DOM shape and not a reimplementation of them.
vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionHostsModule>();
  const snapshot = (): SessionHostsSnapshot =>
    ({
      hosts: [
        {
          hostId: 'host-background-task-strip',
          provider: 'claude',
          mode: 'resident',
          state: 'busy',
          pid: 5252,
          startedAt: 0,
          closeReason: null,
          closeDetail: null,
          bindings: [
            {
              appSessionId: SESSION_ID,
              providerSessionId: null,
              state: 'busy',
              leases: harness.leases,
              lastActivityAt: 0,
              peerName: null,
            },
          ],
        },
      ],
      sessions: [],
    }) as unknown as SessionHostsSnapshot;

  return {
    ...actual,
    useSessionHosts: () => ({
      snapshot: harness.snapshotNull ? null : snapshot(),
      error: harness.error,
      loading: false,
      refresh: async () => {},
      start: async () => {},
      close: async () => {},
    }),
  };
});

const enChat = JSON.parse(readFileSync(join(LOCALES_DIR, 'en', 'chat.json'), 'utf8')) as unknown;

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } } as unknown as Record<string, Record<string, string>>,
  interpolation: { escapeValue: false },
});

const BackgroundTaskStrip = (await import('@/modules/chat/transcript/BackgroundTaskStrip')).default;

function renderStrip(): ReturnType<typeof render> {
  return render(
    createElement(BackgroundTaskStrip, { sessionId: SESSION_ID, messages: MESSAGES, now: () => NOW }),
  );
}

/** Reads a dotted path out of a parsed locale file, the way the app's lookup walks it. */
function readKey(source: unknown, keyPath: string): unknown {
  let node: unknown = source;
  for (const segment of keyPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Every production `.ts`/`.tsx` file under a directory, test files and tests/ excluded. */
function listProductionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === '__tests__') continue;
      out.push(...listProductionSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

afterEach(() => {
  cleanup();
  harness.leases = [];
  harness.snapshotNull = false;
  harness.error = null;
});

describe('the background-task strip draws held work from the host listing', () => {
  it('AC3: two held-work leases draw two labelled rows with elapsed readings', () => {
    harness.leases = [
      { kind: 'background-task', id: 'toolu_bg', since: BG_SINCE },
      { kind: 'monitor', id: 'toolu_mon', since: MONITOR_SINCE },
    ];
    const view = renderStrip();

    const strip = view.container.querySelector('[data-background-task-strip]');
    const rows = [...view.container.querySelectorAll('[data-background-task-row]')];
    const labels = rows.map((row) => row.querySelector('[data-background-task-label]')?.textContent ?? null);
    const elapsed = rows.map((row) => row.querySelector('[data-background-task-elapsed]')?.textContent ?? null);
    console.log(`strip.state=${strip?.getAttribute('data-background-task-strip') ?? 'absent'} rows=${rows.length}`);
    console.log(`labels=${JSON.stringify(labels)} elapsed=${JSON.stringify(elapsed)}`);

    assert.ok(strip, 'a listing with held work must draw the strip');
    assert.equal(strip.getAttribute('data-background-task-strip'), 'active');
    assert.equal(rows.length, 2, 'one row per held-work lease');
    assert.deepEqual(labels, ['Train voice model', 'Watch training log'], 'each row is named by its tool call');
    assert.deepEqual(elapsed, ['2:05', '5:00'], 'each row reports how long its lease has been held');
  });

  it('AC3: an empty lease set draws nothing, and a null snapshot draws an unknown state instead', () => {
    harness.leases = [];
    const empty = renderStrip();
    const zeroShape = empty.container.querySelector('[data-background-task-strip]');
    console.log(`zero.strip=${zeroShape !== null} zero.rows=${empty.container.querySelectorAll('[data-background-task-row]').length}`);
    assert.equal(zeroShape, null, 'nothing held is the absence of the strip, not a zero-valued row');

    cleanup();

    harness.snapshotNull = true;
    const unknown = renderStrip();
    const unknownShape = unknown.container.querySelector('[data-background-task-strip="unknown"]');
    console.log(`unknown.strip=${unknownShape !== null} unknown.rows=${unknown.container.querySelectorAll('[data-background-task-row]').length}`);
    assert.ok(unknownShape, 'a snapshot that never answered must draw the unknown state');
    assert.equal(
      unknown.container.querySelectorAll('[data-background-task-row]').length,
      0,
      'the unknown state is not a row: it says nothing is known, not that nothing runs',
    );

    // The two shapes are programmatically distinct — absence versus a positive
    // "could not read" marker — which is the whole point of not letting a failed
    // poll degrade into "zero background tasks".
    assert.notEqual(zeroShape, unknownShape);
  });

  it('AC3: a failed poll draws the same unknown state as a snapshot that never arrived', () => {
    harness.leases = [{ kind: 'background-task', id: 'toolu_bg', since: BG_SINCE }];
    harness.error = 'session-hosts poll failed';
    const view = renderStrip();

    assert.ok(
      view.container.querySelector('[data-background-task-strip="unknown"]'),
      'a stale snapshot must not be reported as current work',
    );
    assert.equal(
      view.container.querySelectorAll('[data-background-task-row]').length,
      0,
      'the failure is reported instead of the work it can no longer confirm',
    );
  });
});

describe('the task list has exactly one source', () => {
  it('AC7: the strip reads the host snapshot and enumerates no process table', () => {
    const source = readFileSync(STRIP_SOURCE, 'utf8');
    assert.ok(
      source.includes("from '@/shared/hooks/useSessionHosts'"),
      'the strip must import the shared host snapshot hook',
    );
    assert.ok(source.includes('useSessionHosts()'), 'and call it for its lease list');
    assert.ok(source.includes('findBackgroundTaskLeases('), 'deriving the leases from the snapshot');
    // A fetch or the API helper would make the strip a second client of the
    // listing; the prose mentioning the endpoint's path is not a call site, so
    // this reads syntax (`fetch(` / the api import) rather than the path string.
    assert.equal(/\bfetch\s*\(/.test(source), false, 'the strip must not fetch anything itself');
    assert.equal(
      /from\s+['"]@\/shared\/api['"]/.test(source),
      false,
      'the strip must not import the API client',
    );
    assert.equal(source.includes('/proc'), false, 'and reads no process table');

    const offenders: string[] = [];
    for (const file of [...listProductionSources(join(ROOT, 'src')), ...listProductionSources(join(ROOT, 'server'))]) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (line.includes('/proc') && /\b(readdir|opendir|globSync)\b/.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }
    console.log(`proc.scan.offenders=${JSON.stringify(offenders)}`);
    assert.deepEqual(offenders, [], 'no production code may enumerate /proc for the task list');
  });
});

describe('every shipped locale carries the strip\'s copy', () => {
  it('AC8: resident.backgroundTasks keys are present and non-empty in all locales', () => {
    const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const required = [
      'resident.backgroundTasks.title',
      'resident.backgroundTasks.genericLabel',
      'resident.backgroundTasks.monitorLabel',
      'resident.backgroundTasks.unknown',
      'resident.backgroundTasks.lastNotification',
      'resident.backgroundTasks.count',
    ];

    const missing: string[] = [];
    for (const locale of locales) {
      const chat = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'chat.json'), 'utf8')) as unknown;
      for (const keyPath of required) {
        const value = readKey(chat, keyPath);
        if (typeof value !== 'string' || value.trim().length === 0) {
          missing.push(`${locale}/chat.json:${keyPath}`);
        }
      }
    }

    console.log(`locales.checked=${locales.length} keys.perLocale=${required.length} missing=${missing.length}`);
    console.log(`locales=${locales.join(',')}`);
    assert.equal(locales.length, 12, 'the twelve shipped locales must all be on disk');
    expect(missing, `every locale must carry the strip's copy; missing: ${missing.join(', ')}`).toEqual([]);
  });
});
