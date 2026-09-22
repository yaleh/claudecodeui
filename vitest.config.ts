import { availableParallelism } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vitest sizes its client worker pool from `os.availableParallelism()` when the
// config pins nothing — 128 workers on this box. A single suite survives that,
// but quay never runs a single suite: every task worker runs scripts/test.sh as
// one of its own judging criteria, and fan-in runs it again, so several ~128-way
// pools overlap. They oversubscribe Vite's module server and workers die
// mid-run, surfacing as `STACK_TRACE_ERROR` and `Timeout calling "fetch"` — at
// the reporter layer those are indistinguishable from real test failures, and a
// different subset of files goes red each run.
//
// So bound the pool, adaptively rather than at a fixed width: half the cores
// (a small machine is never asked for more workers than it has) and never more
// than 8. Measured on this box: 4.97s uncapped, 7.53s at 8 workers, 13.43s at 4
// — 8 costs almost nothing and leaves headroom for the concurrent suites.
const CLIENT_MAX_WORKERS = 8;
const maxWorkers = Math.min(
  CLIENT_MAX_WORKERS,
  Math.max(1, Math.floor(availableParallelism() / 2)),
);

// The client test suite runs under jsdom because the hook and component tests
// added alongside the state refactor rely on real effects, DOM events and
// localStorage — none of which run under react-dom/server.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The repository-root shared tree (ADR-004 decision 2). Registered here because this
      // file's `resolve.alias` is its own — vitest prefers vitest.config.ts over
      // vite.config.js, so it inherits nothing from that one, and a frontend module importing
      // `@shared/...` fails to transform with "Failed to resolve import". Four registrations
      // are needed in total and none of them covers another: tsconfig.json (typecheck),
      // vite.config.js (the bundle), this file (the unit-test transform) and .oxlintrc.json
      // (the lint resolver + boundaries).
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    environment: 'jsdom',
    // Pinned so the suite does not silently change shape with a developer's
    // local .env — this workspace has VITE_IS_PLATFORM=true, CI has no .env at
    // all, and the flag decides whether the app authenticates with a bearer
    // token. The tests that care stub it per case and assert both modes.
    env: {
      VITE_IS_PLATFORM: 'false',
    },
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
    // Both budgets are declared here rather than left to vitest's defaults (5000 /
    // 10000). `vi.resetModules()` plus an in-case dynamic `import()` makes one case
    // pay a whole module graph's cold compile (measured 2.7–3.0s for the
    // useProjectsState graph) — in a case budget, 60% of it gone before the test
    // does anything, which is how AC-103's condition ① went red 1–2 times in 15
    // runs while its signature counters stayed at 0. The family now warms that
    // graph in `beforeAll` (charged to hookTimeout) and
    // scripts/test-timeout-margin-check.sh reads testTimeout back to assert every
    // file keeps T_max <= testTimeout / K.
    //
    // testTimeout stays at the default: the fix does not need a bigger case budget,
    // and widening it would blunt the hang detection a case budget exists for.
    // hookTimeout is the budget that now carries the compile, so it is sized from
    // the measurement instead: 2.8s quiet, and ~5.3s under the exact contention
    // shape AC-103 exercises (2 client pools ‖ 2 server phases: file wall time
    // 6037ms minus ~700ms of cases). 20000 leaves ~3.8× over that contended
    // reading, against the 1.9× the 10000 default would have left — and 1.9× is
    // precisely the margin that already failed in the case budget.
    testTimeout: 5000,
    hookTimeout: 20000,
    maxWorkers,
  },
});
