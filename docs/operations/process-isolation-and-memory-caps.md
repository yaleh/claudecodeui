# Process isolation and memory caps

*Why a runaway process used to look like "the :3001 server died", and the guards that stop it.*

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
| Tests (vitest) | hard `MemoryMax` in their own scope — `scripts/with-memory-cap.sh` | a runaway test dies alone |
| Claude sessions | hard `MemoryMax` in one scope each — `claude-session-scope.service.ts` | a runaway session or MCP dies alone, in its own cgroup |
| The :3001 server | its own systemd user service — `scripts/serve-scoped.sh` | other processes' OOM cannot reach it |

The server itself deliberately gets **isolation, not a cap**. It has no leak history, and a cap
would make it the OOM victim instead of a bystander. If a leak ever shows up, add a generous
`MemoryMax` to that unit separately.

The two halves of that sentence are now doing different work, and it is worth being precise about
which one protects the server. A systemd user service is not a cgroup boundary against the
processes its own `ExecStart` goes on to spawn: `claudecodeui-server.service` owns everything the
server forks, so with the server's unit at `memory.max=max` the kernel would reap server *and*
sessions together. Isolation only began to hold when the sessions stopped being in that unit's
cgroup — which is what the session scopes below do. The server still has no cap, on purpose; it
now shares its cgroup with nothing that can run away.

### `scripts/with-memory-cap.sh <cmd…>`

Runs `<cmd>` via `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0` and `exec`s it,
so stdio and PID are unchanged. `QUAY_MEMORY_MAX` (default `24G`) sets the cap; `off` disables it.
Where there is no usable systemd user manager (macOS, CI, containers) it runs the command
uncapped and says so on stderr.

Wired in at:

- `npm run test:client` (`vitest run`);
- the client phase of `scripts/test.sh`, which is what quay's fan-in runs.

The server phase (`node --test`) is **not** capped: it is many short processes under a
concurrency clamp and has no memory incident on record.

### `scripts/serve-scoped.sh start|stop|restart|status`

Runs `npm run server` as the transient unit `claudecodeui-server.service` with the repo as working
directory, `HOST` (default `0.0.0.0`) and `SERVER_PORT` (default `3001`), and stdout/stderr appended
to `server.log`. Refuses to `start` when already active.

Run it from a tmux pane, **not** from a session the server hosts: sessions are the server's child
processes, so `stop`/`restart` stops the caller's own cgroup.

### Session scopes: `claude-session-scope.service.ts`

A Claude session is not one process. It is the `claude` CLI plus the MCP servers it starts (pdf,
playwright, …), and when the CLI is launched through an npm shim, a wrapper process on top. On this
host that is roughly 1 GB of RSS per idle session. All of it used to land in
`claudecodeui-server.service`'s cgroup, where `memory.max` is `max` — so a single runaway session,
or one MCP it launched, was enough for the kernel to reap the whole unit with the server in it. The
2026-09-25 fix separated *tests* from the server; this separates *sessions* from the server.

`server/modules/providers/services/claude-session-scope.service.ts` exports a factory that returns
the SDK's `spawnClaudeCodeProcess` hook. `mapCliOptionsToSDK` installs it, so every Claude session
spawns as:

```
systemd-run --user --scope --quiet --unit=claudecodeui-session-<serverPid>-<rand> \
  -p MemoryMax=<cap> -p MemorySwapMax=0 -- <command> <args…>
```

`--scope` registers a transient scope and then `exec`s the target on the same PID, so stdio, PID and
exit status are unchanged (the same property `with-memory-cap.sh` relies on). `cwd`, `env` and the
abort `signal` are passed straight through.

| Piece | Value |
|---|---|
| cap | `CLAUDE_SESSION_MEMORY_MAX`, default `8G`; `off` (or `0`) disables wrapping |
| unit name | `claudecodeui-session-<serverPid>-<8 hex>` — the owner PID is in the name so a later process can tell whether the server that made the scope still exists |
| degradation | no usable systemd user manager (macOS, CI, containers) → the factory returns `undefined`, the option is **not set**, and the SDK spawns the CLI exactly as before; one log line says so |

The cap is checked once per process by really running `true` inside a capped scope, and the verdict
is cached. `systemd-run` failing (no user manager) and the command failing (a cap too small to even
fork) are indistinguishable by exit status, so nothing weaker than a real capped run can answer it.

**The consequence that has to be handled: a scope is not in the server's cgroup**, which is exactly
what confines the kill — and also means nothing collects it when the server goes away.

- `shutdownRuntimeServices` (`server/index.ts`) stops every scope owned by its own PID, so
  `serve-scoped.sh stop` and `restart` still take their sessions with them.
- `server/index.ts` sweeps *orphaned* scopes at start-up: a scope whose encoded owner PID is gone.
  The shutdown path cannot run when the server is `SIGKILL`ed or reaped, so this is what reaps
  those sessions — on the **next** start, not immediately.
- **A server restart no longer kills the sessions it hosts.** Before the scopes, `stop`/`restart`
  tore down the cgroup and every session in it died with the server. Now a `SIGKILL`ed server's
  sessions keep running until the sweep runs. Treat an unexpected restart as "my sessions may still
  be alive" and check `systemctl --user list-units 'claudecodeui-session-*'`.
- A scope that died on its own (cap kill, abort, crash) stays listed as `failed` until it is
  explicitly reset — `systemctl stop` alone does not clear it. Both stop and sweep therefore
  `reset-failed` as well, or a server that loses sessions to its cap would pile up dead units
  forever.

Attributing a kill to the cap uses the same witness as the test path: the exit code cannot say
(whether the cap did it, look at `journalctl --user -u <unit>.scope | grep 'OOM killer'`), and the
journal write trails the exit, so the lookup retries briefly. On a hit it logs one line naming the
cap; an unreadable journal is silent, which is the known gap described below.

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

