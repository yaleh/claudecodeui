# Process isolation and memory caps

*Why a runaway test used to look like "the :3001 server died", and the two guards that stop it.*

## Incident (2026-09-25)

The :3001 server stopped with no crash line: `server.log` simply ended. The cause was the
kernel OOM killer, not the server.

- The server had been started with `setsid nohup npm run server &` from a tmux pane. `setsid`
  changes the session, **not the cgroup**, so the server stayed in the pane's
  `tmux-spawn-<uuid>.scope`.
- A session in another worktree ran `npx vitest run chatComposerResponsive.test.tsx` from the same
  scope. The test grew without bound (scope peak 218.8G of ~252G; no `MemoryMax`).
- The OOM killer reaps a whole scope, so the server went with it.
- Reproduced with a cap: the test hit 12G in ~14s in a worktree carrying an uncommitted one-line
  edit to `ChatComposer.tsx`; the same test on a clean checkout passes in ~300ms. The server never
  loads that file — it only serves the built `dist/` — so the server was a bystander, not a cause.

Earlier OOM scopes the same day (60G, 217.8G, 31.9G) are consistent with the same shape but were
not individually root-caused.

## The guards

| Subject | Guard | Why |
|---|---|---|
| Tests (vitest), layer 1 | per-worker V8 heap ceiling in `vitest.config.ts` | a runaway **dies in seconds**, wherever vitest was started from |
| Tests (vitest), layer 2 | hard `MemoryMax` in their own scope — `scripts/with-memory-cap.sh` | whatever layer 1 cannot see (Buffer/native/external) still dies alone |
| The :3001 server | its own systemd user service — `scripts/serve-scoped.sh` | other processes' OOM cannot reach it |

Layer 1 and layer 2 are **additive, not alternatives**: they bound different channels and cover
different entry points. Neither one replaces the other — see
[the per-worker heap ceiling](#the-per-worker-v8-heap-ceiling-vitestconfigts) below.

The server deliberately gets **isolation, not a cap**. It has no leak history, and a cap would
make it the OOM victim instead of a bystander. If a leak ever shows up, add a generous
`MemoryMax` to that unit separately.

### `scripts/with-memory-cap.sh <cmd…>`

Runs `<cmd>` via `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0` and `exec`s it,
so stdio and PID are unchanged. `QUAY_MEMORY_MAX` (default `24G`) sets the cap; `off` disables it.
Where there is no usable systemd user manager (macOS, CI, containers) it runs the command
uncapped and says so on stderr.

Wired in at:

- `npm run test:client` (`vitest run`);
- the client phase of `scripts/test.sh`, which is what quay's fan-in runs.

Both are **opt-in call sites**, which is exactly how the 2026-09-25 incident got past it: the
pane ran a bare `npx vitest run`, and nothing in that command line reaches this script.

The server phase (`node --test`) is **not** capped: it is many short processes under a
concurrency clamp and has no memory incident on record.

### The per-worker V8 heap ceiling (`vitest.config.ts`)

```ts
pool: 'forks',
poolOptions: { forks: { execArgv: ['--max-old-space-size=4352'] } },
```

Where the wrapper has to be *invoked*, this one is *in the config*, so it applies to every entry
point at once: `npx vitest run`, `npm run test:client`, `scripts/test.sh`, an editor's test
runner — including the bare `npx vitest run` shape of the incident, which the wrapper never sees.
The pool is pinned to `forks` because `poolOptions.forks` is only reachable on that pool; if a
future vitest default changes, the pin makes the ceiling fail loudly instead of quietly becoming
a no-op.

**4352 MB is measured, not guessed.** `npx vitest run --logHeapUsage` over the whole client suite
(103 files, 725 cases) reads a per-file maximum of **1401 MB**
(`src/shared/asr/tests/asrContractInvariants.test.ts`); the next file is 561 MB. 4352 is **3.11×**
that maximum: above the 3× floor the ceiling was specified with, and the tightest value above it.
Re-derive it after a suite change with:

```bash
npx vitest run --logHeapUsage 2>&1 | grep -oE '[0-9]+ MB heap used' | sort -n | tail -5
```

What it does **not** bound: `--max-old-space-size` is a V8 **JS heap** limit. A runaway that
retains objects dies in seconds inside its worker (a worker that exhausts it prints
`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`, and the main
process exits non-zero with `ERR_IPC_CHANNEL_CLOSED`); a runaway that grows `Buffer`/`external`/
native memory instead is **invisible** to it and still needs layer 2. That is why the two are
described as additive, and why `scripts/with-memory-cap.sh` must not be deleted or loosened on the
strength of this ceiling.

It is also **not** a cap on the machine: 4352 MB sits just under Node's own default
`heap_size_limit` on this host (4288 MB), so it changes *how fast and how attributably* a runaway
fails, not how large it gets.

The criterion for "the ceiling is really in force" is `scripts/vitest-heap-limit-check.sh`, run
**without** the wrapper and without `QUAY_MEMORY_MAX` on purpose: it must be the config layer that
stops the fixture.

```bash
bash scripts/vitest-heap-limit-check.sh            # expect exit 0 (受限) — runaway dies, benign control passes
bash scripts/vitest-heap-limit-check.sh --falsify  # expect exit 1 (未受限) — with no ceiling, the same fixture crosses 3× it
node --test scripts/vitest-heap-limit-check.test.mjs  # one case per verdict branch
```

Readings it asserts on one verdict line: the runaway's vitest exit code, heap-exhaustion or
worker-abnormal-exit evidence, the **whole process tree's** RSS peak (sampled from `/proc`, must
be ≤ 1.5× the ceiling — ≈5.1 G against 6528 M in practice), and the wall clock (≤ 30 s; ≈4 s in
practice). Its positive control is a benign fixture holding ~30 % of the ceiling, which must exit
0 — without it the criterion could be satisfied by a ceiling that kills everything.

### `scripts/serve-scoped.sh start|stop|restart|status`

Runs `npm run server` as the transient unit `claudecodeui-server.service` with the repo as working
directory, `HOST` (default `0.0.0.0`) and `SERVER_PORT` (default `3001`), and stdout/stderr appended
to `server.log`. Refuses to `start` when already active.

Run it from a tmux pane, **not** from a session the server hosts: sessions are the server's child
processes, so `stop`/`restart` stops the caller's own cgroup.

## Coverage variables

| Variable | Default | What it changes |
|---|---|---|
| `QUAY_VITEST_HEAP_MB` | `4352` | layer 1 — the per-worker V8 heap ceiling in `vitest.config.ts`; `off` (or `0`) adds no `--max-old-space-size` at all, which is the unguarded control `--falsify` needs |
| `QUAY_MEMORY_MAX` | `24G` | layer 2 — the cgroup `MemoryMax` applied by `scripts/with-memory-cap.sh`; `off` runs uncapped |
| `QUAY_MEMORY_UNIT` | per-run name | the scope name `scripts/test.sh` gives that cap, so an OOM can be found in the user journal |
| `QUAY_HEAP_CHECK_SKIP_CLEANUP` | unset | test-only: leaves the check script's fixtures on disk so its `夹具残留` verdict branch is reachable. Not a production knob |

An unusable `QUAY_VITEST_HEAP_MB` (neither a positive number nor `off`) warns on stderr and falls
back to the ceiling: a mistyped override must not silently become "no ceiling", which is the exact
failure this layer exists to prevent. The wrapper's own failure mode is the same shape — with no
usable systemd user manager it says so on stderr rather than silently pretending to cap.

## Classification: OOM is an `assert`, not `infra`

`scripts/test.sh` marks each failing file `kind=infra|assert`, and an `infra` red is exempt from
blocking a fan-in. A capped OOM must not be exempt: exceeding the budget is a defect in the code
under test.

Two things make that non-obvious:

1. **The exit code is unreliable.** The OOM killer picks a *worker* inside the scope; vitest's main
   process survives and exits `1` with `ERR_IPC_CHANNEL_CLOSED` and no JSON report — the "worker
   died before asserting" shape, which `classify_failure_kind` reads as `infra`.
2. **The journal is the only witness.** So `test.sh` names the scope (`QUAY_MEMORY_UNIT`), and when
   vitest exits non-zero it asks `journalctl --user -u <unit>.scope` for `OOM killer`. On a hit it
   appends `client vitest OOM-killed at the memory cap (…)` to the vitest log, and
   `classify_failure_kind` maps that line to `assert`.

If the journal is unreadable the check is silent and the failure falls back to today's
classification (`infra`). That is a known gap, not a silent success.

## Diagnosing "the server died"

```bash
journalctl --user --since "2 hours ago" | grep -E 'OOM killer|memory peak'
```

`dmesg` needs the `adm` group and is denied here; the user journal is enough. Look for a
`tmux-spawn-*.scope` with a large `memory peak`, then find what ran in that pane at that time.
