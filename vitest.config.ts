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
    maxWorkers,
  },
});
