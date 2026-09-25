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

**Correction (same day, after the second OOM below):** the reproduction only proves that test can
run away; it does not prove the 218G peaks were it. Earlier OOM scopes the same day (60G, 217.8G,
31.9G) were never individually root-caused, and the 217.8G peak followed a run of the AC-103
concurrency criterion by about ten minutes. Treat the attribution of those peaks as open.

## The guards

| Subject | Guard | Why |
|---|---|---|
| Tests (vitest), layer 1 | per-worker V8 heap ceiling in `vitest.config.ts` | a runaway **dies in seconds**, wherever vitest was started from |
| Tests (vitest), layer 2 | hard `MemoryMax` in their own scope — `scripts/with-memory-cap.sh` | whatever layer 1 cannot see (Buffer/native/external) still dies alone |
| The :3001 server | its own systemd user service, with a restart policy and a V8 heap ceiling — `scripts/serve-scoped.sh` | other processes' OOM cannot reach it, and its own leak ends as a restart rather than as a swap storm |

Layer 1 and layer 2 are **additive, not alternatives**: they bound different channels and cover
different entry points. Neither one replaces the other — see
[the per-worker heap ceiling](#the-per-worker-v8-heap-ceiling-vitestconfigts) below.

The server deliberately gets **isolation and a process-level ceiling, not a cgroup cap**. It has no
leak history — but "no leak history" was, until 2026-09-25, an absence of observation rather than a
positive reading (the only measurement was ~224MB RSS just after boot). A cap that kills the whole
cgroup would make the server the OOM victim instead of a bystander, which is the opposite of what
the second incident needed. So the server is bounded with a **V8 heap ceiling and a restart policy**
instead: a leak ends as a non-zero exit at a predictable point and systemd starts the server again,
rather than the process growing until the *host* thrashes. See below for the numbers.

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

That boundary is **measured**, not asserted. Two probes, same `node`, same
`--max-old-space-size=300`, each contained by a 2 G cgroup as a safety net:

| Probe | Channel | Result |
|---|---|---|
| `for(;;) h.push(new Array(1e6).fill(1.5))` | JS old space | aborted in **266 ms**, rc 134, `Reached heap limit` — layer 1 alone |
| `for(;;) b.push(Buffer.alloc(32<<20))` | `Buffer`/external | sailed **past** the 300 MB old-space limit, killed by the 2 G cgroup after **52.2 s**, rc 137, **no** heap evidence — layer 1 blind |

So the ceiling's guarantee is precisely "a **JS-heap** runaway dies fast and attributably". It
does **not** shorten the life of a non-JS-heap runaway; that one still runs until layer 2 takes it.

A runaway of the first kind, injected into the real component under test (not a synthetic fixture
file) and run through the test named in the 2026-09-25 incident,
`chatComposerResponsive.test.tsx`, dies the same way: whole `npx vitest run` wall clock **3.8 s**,
tree RSS peak **5162 MB** (≤ 1.5 × 4352), `FATAL ERROR: Reached heap limit` plus
`ERR_IPC_CHANNEL_CLOSED`. The synthetic fixture and the real test behave alike on that channel.

**What this does not settle.** The incident's own reproduction input is *unrecoverable*: the
one-line edit is described as "remove the tab's `!hasPendingPermissions` guard", and on the tree
that carries that guard removal the rendered output is **byte-identical** — `chatComposerResponsive`
renders with `activity: null` and `pendingPermissionRequests: []`, so both `!hasPendingPermissions`
and `activity && !hasPendingPermissions` are already `true`/`false` respectively and the guard
short-circuits nothing. Measured: that mutation leaves the test at rc 0, 945 MB tree peak. And a
single JS heap on this host tops out at 4288 MB by default, so a one-process **12 GB** reading
cannot be explained by the old-space channel alone. **Which channel the original runaway used is
therefore undetermined, and this ceiling must not be claimed to have "plugged" that incident** —
layer 2 is still the guard that covers it, exactly as before.

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
to `server.log`. Refuses to `start` when already active, and refuses to run at all — exit 3, with
the reason on stderr — when there is no *usable* systemd user manager, rather than starting an
unscoped server.

**Restart policy.** The unit carries `Restart=on-failure`, `RestartSec=5`, `StartLimitBurst=5`,
`StartLimitIntervalSec=60`. Isolation alone still left a dead server dead: on 2026-09-25
`server.log` simply ended and the only detector was a person happening to look. A crash, a `kill -9`
or an abort now brings the server back within ~5s. A *clean* `stop` is not a failure and is never
restarted — the burst limit is the asymmetry that matters in the other direction: five restarts
inside 60s means something is genuinely wrong, and the unit is left visibly failed instead of
spinning forever.

**Heap ceiling.** The server starts with `NODE_OPTIONS=--max-old-space-size=<MB>`, default **2048**,
`QUAY_SERVER_HEAP_MB` overriding it and `off` (or `0`) omitting it. A caller's own `NODE_OPTIONS` is
appended to, never replaced. When V8 hits the ceiling the process aborts non-zero, which the restart
policy above picks up: a leak becomes a visible restart loop rather than unbounded growth. The host
has 252G and 14.7G of its 16G swap already in use, so an uncapped server on a leak path is a
host-wide problem, not a server problem.

**2048 is a conservative default, not a measurement.** It was chosen before any long soak reading
existed, precisely so that the failure mode is a restart rather than a swap storm. Tighten it once
there is a real soak reading — the point of the ceiling is to be lower than the point where the host
suffers, and nobody knows where that is yet. This is also why there is still no `MemoryMax` here:
the heap ceiling is a *process* limit only the server can trip, and it leaves the cgroup cap — the
thing that would make the server an OOM victim — off the table.

`status` prints the unit's own counters (`NRestarts`, `MemoryCurrent`, `MemoryPeak`, `MainPID`,
`LoadState`, `ActiveState`) after the usual `systemctl status`, because those two readings are what
tell "quietly crash-looping" apart from "up the whole time". `Restart=` doing its job is invisible
otherwise.

Test seams (defaults are the production behaviour; used by `scripts/serve-scoped-check.sh`, so a
check never touches :3001): `QUAY_SERVER_UNIT`, `QUAY_SERVER_CMD`, `QUAY_SERVER_LOG`,
`QUAY_SERVER_HEAP_MB`.

Run it from a tmux pane, **not** from a session the server hosts: sessions are the server's child
processes, so `stop`/`restart` stops the caller's own cgroup.

**Not done here — `server.log`.** The file is 4,729 multi-line synchronous log lines with no
rotation, and the restart policy now makes restarts *more* likely to be the thing that grows it. Log
rotation and de-noising are out of scope for this change and are not covered by any criterion; they
are their own problem, and the append target should be revisited once it is solved.

### `scripts/serve-scoped-check.sh [all|fake|restart|stop|heap]`

Re-runnable proof of the two promises above, as readings rather than as source text — grepping the
script for `Restart=on-failure` would pass for a unit that never comes back.

| Section | What it reads |
|---|---|
| `fake` | a fake `systemd-run` first on PATH records the argv of each `start`; asserts the restart properties, the burst limit, the 2048 ceiling (and its absence under `off`), the append-not-replace rule for a caller's `NODE_OPTIONS`, the `QUAY_SERVER_CMD` seam, and that a missing user manager is a refusal (exit 3) and not a silent success |
| `restart` | a throwaway unit runs a liveness stub; `kill -9` its main process; the unit must be active again inside 15s with a different `MainPID` and `NRestarts=1` |
| `stop` | a second throwaway unit is stopped through `serve-scoped.sh stop`; `NRestarts` must be 0 beforehand and the unit unloaded afterwards (`LoadState=not-found`) — which is what proves a clean stop is not a failure path |
| `heap` | a third unit runs a stub that retains objects; with the default ceiling it must abort (node's heap-limit line in its log) and come back restarted, with `MemoryPeak` under 2x the ceiling |

`all` (the default) runs `fake` then the three real sections **in parallel**, so the whole thing
finishes in ~15s — inside the 60s criterion gate. Every unit is named with the run's own suffix and
stopped by the EXIT trap, failure paths included. Without a usable systemd user manager the real
sections print `SKIP`; a skip is loud and is not a pass.

`scripts/serve-scoped-check.test.mjs` (`npm run test:scripts`) covers the verdict machinery: for
each branch, the pristine tree must exit 0 and a mutated copy of `serve-scoped.sh` must go red with
the verdict naming the missing item and carrying the actual argv on the same line.

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

## Second incident (2026-09-25 10:38–10:53) and what was retired

The machine thrashed for ~15 minutes (load average 4309) and the operator killed the node processes
by hand. Reconstructed from the user journal, because the processes were gone:

- Every OOM kill (36) landed in `quay-drivers-claudecodeui-*.scope`, the scope the quay drivers and
  all their workers ran in. It was started ad hoc with `systemd-run --user --scope … -p
  OOMPolicy=continue` and **no `MemoryMax`**, and it had no memory accounting, so there is no peak
  reading for it.
- The vitest scopes made by `with-memory-cap.sh` all finished normally before 10:38:31 (CPU 7–95 s).
  The cap was not the problem this time, and it had nothing to catch.
- Four workers were running heavy jobs at 10:35, one of them `scripts/suite-concurrency-check.sh`
  (the AC-103 criterion). That script oversubscribes by design — 2 full client vitest pools plus 2
  server-phase readouts — and called `npx vitest run` directly, bypassing the wrapper. Its own log
  recorded `load=3312` and readouts killed with `rc=137`.
- **Not proven:** which process held the memory. Nothing was left to measure. AC-103 is the strongest
  suspect, not a finding.

Decisions taken (human, 2026-09-25):

1. AC-103 is `superseded`, `GOAL-003`'s exit conditions no longer list it, and
   `scripts/suite-concurrency-check.sh` and its test are deleted (history keeps them).
   claudecodeui has no need to prove oversubscription tolerance; that capability belongs to quay's
   own concurrency tests. The criterion was also evaluated 24–61 times a day by the goal sweep.
2. The task `gap-ac103-worktree-state-drag-and-unbudgeted-confirm` is `superseded`. Its branch
   `task/gap-ac103-worktree-state-drag-and-unbudgeted-confirm` still carries 20 unmerged commits
   (voice false-forms readings narrowed to the run's own files, `__criterion-falsify-*` excluded from
   oxlint and tsc). They are independent of AC-103 and may be worth cherry-picking; nothing was deleted.
3. The quay fleet gets a shared parent slice with a memory ceiling (next section).

## The fleet ceiling: `quay-fleet.slice`

One ceiling over everything the quay loop starts. `systemd-run --scope` does **not** nest under the
caller's cgroup (a capped test scope lands in `app.slice`, not inside the driver's scope), so a limit
on the drivers' own scope would not count the tests they spawn. The shared parent has to be a slice.

| Piece | Where | What |
|---|---|---|
| `quay-fleet.slice` | `~/.config/systemd/user/quay-fleet.slice` (outside the repo) | `MemoryHigh=48G` throttles first, `MemoryMax=64G` kills, `MemorySwapMax=0` |
| `scripts/start-drivers-scoped.sh` | this repo | starts `start-drivers.js` under `--slice=quay-fleet.slice`, exports `QUAY_MEMORY_SLICE`; refuses to start if the slice has no `MemoryMax` or drivers already run for this root |
| `scripts/with-memory-cap.sh` | this repo | honours `QUAY_MEMORY_SLICE`: each per-test scope keeps its own 24G cap **and** counts toward the fleet ceiling |

The numbers are provisional. Read `memory.peak` of the slice after a day of real use and re-set them;
the largest single pane peak seen before this was 26G. The host is shared (kai, tom, vince, zhengji
run their own drivers), so lean low. Note the dash in the slice name makes systemd create an implicit,
unlimited parent `quay.slice`; harmless, but it is why the cgroup path reads
`quay.slice/quay-fleet.slice`.

The unit file lives in the user's home, not the repo, so a fresh machine needs it created by hand
(the two `Memory*` lines above are the whole content). `start-drivers-scoped.sh` fails loudly rather
than starting uncapped when it is missing.

Verified (2026-09-25): the wrapper's scope lands under the slice; a scope whose own cap was 10G was
killed at a 300M ceiling set on a throwaway slice, so the parent ceiling binds children; the start
script refuses on a slice with no limit and on a missing plugin. **Not yet verified:** a real driver
run — that `start-drivers.js` and the workers it spawns inherit `QUAY_MEMORY_SLICE` (workers are
`claude` sessions, and env inheritance through them was not checked). Confirm after the first start
that `test.sh` scopes appear under `quay-fleet.slice`.

