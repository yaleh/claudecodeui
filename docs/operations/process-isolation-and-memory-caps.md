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

## The two guards

| Subject | Guard | Why |
|---|---|---|
| Tests (vitest) | hard `MemoryMax` in their own scope — `scripts/with-memory-cap.sh` | a runaway test dies alone |
| The :3001 server | its own systemd user service — `scripts/serve-scoped.sh` | other processes' OOM cannot reach it |

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

The server phase (`node --test`) is **not** capped: it is many short processes under a
concurrency clamp and has no memory incident on record.

### `scripts/serve-scoped.sh start|stop|restart|status`

Runs `npm run server` as the transient unit `claudecodeui-server.service` with the repo as working
directory, `HOST` (default `0.0.0.0`) and `SERVER_PORT` (default `3001`), and stdout/stderr appended
to `server.log`. Refuses to `start` when already active.

Run it from a tmux pane, **not** from a session the server hosts: sessions are the server's child
processes, so `stop`/`restart` stops the caller's own cgroup.

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

