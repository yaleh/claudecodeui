#!/usr/bin/env bash
# quay fan-in test entrypoint: typecheck + lint + server node:test + client vitest,
# with one `__PERFILE__` line per test file so quay's /tests page gets file-level detail.
# Every stage runs even if an earlier one failed; the exit code is non-zero if any failed.
# Env: QUAY_TEST_DRY=1 consumes args, validates positional files, then exits 0 without running.
#      QUAY_TEST_CONCURRENCY_CEILING=<n> server-phase concurrency ceiling (default 16; see below).
#      QUAY_TEST_FILE_TIMEOUT=<secs> per-process wall-clock bound (default 600).
#      QUAY_SUITE_MAX_RUNTIME_MS=<ms> whole-invocation bound (see the liveness watchdogs below).
#      QUAY_SUITE_SILENCE_MS=<ms> no-progress bound (see the liveness watchdogs below).
#      QUAY_MEMORY_MAX=<size> memory cap for the client vitest process (default 24G; `off` disables).
#      QUAY_SUITE_WATCHDOG_TRACE=1 print the observed progress readings at the end, so the two
#                                  thresholds above can be RE-DERIVED from a measurement rather
#                                  than re-guessed.
#
# Every FAILING file also gets a second, machine-readable record right after its `__PERFILE__`
# line:  `__PERFILE_KIND__ file=<label> kind=infra|assert`
# `infra` = the failure carries no evidence a worker could fix (the process was cut off, or the
# runner reported nothing test-attributable); `assert` = a real failing assertion/test. Before
# this existed, `Error: STACK_TRACE_ERROR` (a load artifact) and `AssertionError: 1 !== 2` (a real
# defect) reached downstream in the same shape — `not ok - <file>: <first line>` — so a fan-in red
# could not be attributed and no worker could be dispatched. The kind is an ADDITIONAL line, not
# an extra key=value on `__PERFILE__`/`not ok`: quay's per-file parser matches `__PERFILE__` with an
# anchored regex, so a trailing field would make it silently drop every row it reads today.
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 2

CONCURRENCY=4
# ── 服务端阶段的并发【上限夹取】(gap-server-phase-concurrency-clamp) ──────────
# 本脚本原先对 `--test-concurrency` **照单全收**（只挡空值/非数字/0），于是调用方给多大就
# 并发多大。fan-in 的 runner 会按 nproc 推一个值 splice 进来（本机 128 核 ⇒ 请求 128），
# 而本仓服务端有 101 个逐文件进程：2026-09-20 16:23Z 那轮 fan-in 的 log 里，把 101 条
# `__PERFILE__` 行的 `[end_ms - duration_ms, end_ms]` 当区间做最大重叠扫描得
# **server_max_concurrent=101**（全部同时在跑），逐文件耗时**中位 46,758ms**；对照本机
# 安静态 N=100 的中位 1,399ms —— **中位涨 33×，几乎每个文件都被垫到 ~47s 的地板**。
# 判红因此落在「每次不同的文件」上（gap-model-env-kind-explanations 连红三次：7.3s /
# 44.4s / 56.3s 三个不同文件，失败文件还走各自的内部截止路径），而「每次不同」正是
# 机制指纹 —— 不是那些测试各自的缺陷。
#
# 上限 = 16，**由实测推出**（读数与复算命令见 scripts/server-phase-concurrency-check.sh
# 的 SLOPE_TABLE 与完成记录的坡度表）：
#   · 吞吐膝点：N=4 墙钟 30.0s → N=16 14.2s（−53%）；N=16 → N=100 只从 14.2s 走到 14.4s
#     （+1.4%，落在噪声内）。16 以上加并发只加压力、不换吞吐。
#   · 同时起步数：夹在 16 ⇒ 服务端阶段同时在跑的进程从 101 降到 16，而**实测零吞吐代价**；
#     那正是上面那条 ~47s 地板赖以形成的量。
#   · 不取更低（例如 4）：N=4 要多付约 16s 墙钟/轮，夹取不该比膝点更狠。
#
# ⛔ 夹取只在【超过上限】时发生：调用方调**低**（例如 4）必须原样生效 —— 既有契约，
# server/shared/tests/quay-test-script.test.ts 与 gap-suite-hang-watchdog 的 AC 都在断言它。
# 上限可用 QUAY_TEST_CONCURRENCY_CEILING 覆盖以便再调；改它就要同时补一档实测读数，
# scripts/server-phase-concurrency-check.sh 会拒绝一个没有实测依据的上限值。
CONCURRENCY_CEILING="${QUAY_TEST_CONCURRENCY_CEILING:-16}"
case "$CONCURRENCY_CEILING" in ''|*[!0-9]*|0) CONCURRENCY_CEILING=16 ;; esac
FILES=()
FOR_TASK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --for-task) FOR_TASK="${2:-}"; shift 2 ;;
    --static-checks-doc) echo "no doc checks in this repo"; exit 0 ;;
    --allow-thin) shift ;;
    --buckets|--root|--state-dir|--runner|--log-file|--run-id) shift 2 ;;
    --test-concurrency=*)
      CONCURRENCY="${1#*=}"
      case "$CONCURRENCY" in ''|*[!0-9]*|0) CONCURRENCY=4 ;; esac
      shift ;;
    -*) shift ;;
    *) FILES+=("$1"); shift ;;
  esac
done

# 夹取（只在上限之上）。判词走 stderr：stdout 是 `__PERFILE__` 与 dry-run 行的既有契约面，
# 不掺别的东西 —— quay 的 per-file 解析器用**锚定**正则，多一行都可能正是它丢行的原因。
if [ "$CONCURRENCY" -gt "$CONCURRENCY_CEILING" ]; then
  printf 'test.sh: --test-concurrency=%s exceeds the server-phase ceiling %s -> clamped to %s (basis: scripts/server-phase-concurrency-check.sh; override with QUAY_TEST_CONCURRENCY_CEILING)\n' \
    "$CONCURRENCY" "$CONCURRENCY_CEILING" "$CONCURRENCY_CEILING" >&2
  CONCURRENCY="$CONCURRENCY_CEILING"
fi

# ── prelude guard: the SCOPE of every worker's self-test (gap-worker-selfcheck-scoped) ───────
# Runs before any stage or file collection, so "nobody runs it" is impossible: a task's self-test
# AC must not make the FULL suite the worker's gate — that is fan-in's merge gate. The guard reads
# this tree's own tasks/, and it distinguishes the two cases instead of demanding --for-task
# everywhere: a task WITH *.test.* in Touches must use `--for-task <its own id>`, while a task
# WITHOUT one must run its own delivered checker (scripts/*.sh) — for that task --for-task would
# resolve to 0 files and exit 0 on the thin path, i.e. a green that cannot go red. `done` /
# `superseded` history is out of scope. Exit 1 (not 2): a red here is a verdict, not a usage error.
if ! bash "$ROOT_DIR/scripts/suite-scope-check.sh"; then
  echo "test.sh: aborting before any stage — the active tasks' self-test scope is not compliant (verdict above)" >&2
  exit 1
fi

# Per-process wall-clock bound. Two reasons it exists: (1) one hung test file must not hang the
# whole suite (the caller's watchdog then kills everything and NOTHING is attributed); (2) it makes
# "this file's process was cut off" a STRUCTURAL fact — GNU timeout(1) exits 124 — rather than
# something a downstream reader has to guess from a log line. The attribution checker lowers it to
# a few seconds to reproduce that shape on purpose; healthy runs never come near it.
FILE_TIMEOUT_SECS="${QUAY_TEST_FILE_TIMEOUT:-600}"
case "$FILE_TIMEOUT_SECS" in ''|*[!0-9]*|0) FILE_TIMEOUT_SECS=600 ;; esac
# Only GNU timeout has --signal/--kill-after; without them the wrapper must not be used at all
# (a busybox timeout would reject the flags and fail every file), so the bound is simply absent.
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1 && timeout --version 2>&1 | grep -qi gnu; then
  TIMEOUT_BIN="$(command -v timeout)"
fi

# --for-task <id>: scoped run = the existing test files listed in tasks/<id>.md Touches (thin is allowed)
if [ -n "$FOR_TASK" ]; then
  TASK_FILE="tasks/$FOR_TASK.md"
  [ -f "$TASK_FILE" ] || { echo "task file not found: $TASK_FILE" >&2; exit 2; }
  while IFS= read -r f; do
    [ -f "$f" ] && FILES+=("$f")
  done < <(awk '/^## Touches/{t=1;next} /^## /{t=0} t && /^- /{sub(/^- +/,"");gsub(/`/,"");print $1}' "$TASK_FILE" | grep -E '\.test\.[jt]sx?$')
  if [ ${#FILES[@]} -eq 0 ]; then
    echo "no scoped test files for $FOR_TASK (thin)"; exit 0
  fi
fi

for f in "${FILES[@]+"${FILES[@]}"}"; do
  if [ ! -f "$f" ]; then
    echo "test file not found: $f" >&2
    exit 2
  fi
done

if [ "${QUAY_TEST_DRY:-}" = "1" ]; then
  echo "dry run: args consumed (concurrency=$CONCURRENCY, files=${#FILES[@]})"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TOTAL=0; PASS=0; FAIL=0; UNCLASSIFIED=0
FAILED_LINES=()

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

# ── __BEGIN_WATCHDOG__ liveness watchdogs ────────────────────────────────────
#
# WHY: nothing above bounds this invocation. `timeout(1)` bounds each *server file*
# and the one vitest run, but a hang that survives those (a stuck stage, a child that
# ignores TERM, a bash-level deadlock, `timeout` absent or non-GNU) leaves the call
# sitting there forever — and this is the one failure class no layer downstream can
# see, because it is not red, it is SILENT. quay's own record of that shape is two
# hangs of 33.7 and 199.5 minutes, both ended by a human running `kill -TERM -- -<pgid>`.
#
# These two guards answer ONE question — is it still moving? — and nothing else. They
# do not decide whether to retry, and they do not change any verdict: they only end
# something that is already hung, which is why they can be unconditionally on.
#
#   max-runtime   the whole invocation has an upper bound
#   silence       no progress for this long => hung
#
# THRESHOLDS ARE MEASURED, NOT GUESSED (quay SPEC-suite-speed AC3: no threshold before
# the data exists). Readings taken on this machine 2026-09-20 with this script's own
# `QUAY_SUITE_WATCHDOG_TRACE=1` (which reprints them, so they can be re-derived instead of
# re-guessed — that is the whole reason the switch exists):
#
#   full suite, alone            wall  53.9s .. 59.0s   max progress gap 6.0s
#   2 full suites concurrently   wall  67.4s (worst)     max progress gap 8.0s
#
# THE ARITHMETIC LIVES IN scripts/suite-hang-watchdog-check.sh, so these two numbers can be
# re-derived rather than re-guessed, and so a stale default cannot sit here quietly:
#
#   bash scripts/suite-hang-watchdog-check.sh --measure     (re-runs the three suites, ~2 min)
#
# Both recipes are "multiply the worst reading, then round UP to a whole minute", and that
# checker fails if what ships below the recipe's floor ever falls under it.
#
# Rounding UP only ever makes a guard more permissive, which is the direction that is safe
# to be sloppy in, because the two failure directions are NOT symmetric: too high leaves a
# hang for a human to notice (what happens today), too low kills a healthy suite that was
# merely slowed down by load and turns a load artifact into a lost run.
#
#   max-runtime  660s = 9 x the worst concurrent wall clock on record (9 x 67.4s = 606s ->
#                660s), and 11.2x the quiet one. The suite is allowed a whole extra per-file
#                bound (QUAY_TEST_FILE_TIMEOUT, 600s) of slack past the worst concurrent
#                reading; past that it is doing ~10 runs' worth of work and is not coming
#                back. This is the backstop, not the usual trigger.
#   silence      240s = 30 x the worst concurrent progress gap (30 x 8.0s = 240s), and 40x
#                the quiet one. Concurrency degraded that gap by only 1.33x here, so the
#                margin absorbs it ~22x over. Note this sits BELOW the 600s per-file bound,
#                so it ends a single stuck file in 240s rather than letting timeout(1) take
#                600s — deliberately, since a file that has produced nothing at all for
#                240s is a hang from the outside. The slowest real file in the quiet run
#                took 12.7s, so nothing healthy is within 19x of this line; raise
#                QUAY_SUITE_SILENCE_MS if a legitimately slow file ever needs longer.
#
# On firing, the guard ends this process tree and this script exits non-zero with a
# `suite-watchdog: ABORT guard=... reason=timeout|hung threshold_ms=... elapsed_ms=...
# silent_ms=...` line in the report. It terminates; it never re-judges.
SUITE_MAX_RUNTIME_MS="${QUAY_SUITE_MAX_RUNTIME_MS:-660000}"
SUITE_SILENCE_MS="${QUAY_SUITE_SILENCE_MS:-240000}"
case "$SUITE_MAX_RUNTIME_MS" in ''|*[!0-9]*|0) SUITE_MAX_RUNTIME_MS=660000 ;; esac
case "$SUITE_SILENCE_MS" in ''|*[!0-9]*|0) SUITE_SILENCE_MS=240000 ;; esac
# __END_WATCHDOG__

# Poll interval. Small relative to either threshold, large enough that the byte census
# below is free; it does not have to divide them evenly (the comparison is >=).
WATCHDOG_POLL_SECS="${QUAY_SUITE_WATCHDOG_POLL_SECS:-2}"
case "$WATCHDOG_POLL_SECS" in ''|*[!0-9]*|0) WATCHDOG_POLL_SECS=2 ;; esac

SUITE_PID=$$
WATCHDOG_DIR="$TMP/watchdog"
mkdir -p "$WATCHDOG_DIR" 2>/dev/null || true
WATCHDOG_PROGRESS="$WATCHDOG_DIR/progress"   # last milestone, written by progress()
WATCHDOG_VERDICT="$WATCHDOG_DIR/verdict"     # why a guard fired, read by the TERM trap
WATCHDOG_TRACE_FILE="$WATCHDOG_DIR/trace"    # observed readings, rewritten every poll
WATCHDOG_STOP="$WATCHDOG_DIR/stop"           # touched by the normal shutdown path
WATCHDOG_START=$(now_ms)
WATCHDOG_ABORTED=0
WATCHDOG_PID=""
WATCHDOG_HAVE_PGREP=0
command -v pgrep >/dev/null 2>&1 && WATCHDOG_HAVE_PGREP=1

# progress(): the suite's own heartbeat. Called at every boundary where the suite has
# demonstrably moved on — a stage finished, a server file finished, a phase started.
# Written temp+rename so a reader never sees a half-written value.
progress() {
  local t="$WATCHDOG_PROGRESS.$BASHPID"
  now_ms > "$t" 2>/dev/null && mv -f "$t" "$WATCHDOG_PROGRESS" 2>/dev/null
  return 0
}
progress

# kill_tree <pid> <sig>: signal every DESCENDANT of <pid>, deepest first. <pid> itself is
# never signalled, and neither is the caller ($BASHPID) — the watchdog must outlive the
# kill it is performing, or it takes its own verdict down with it.
kill_tree() {
  local pid="$1" sig="${2:-TERM}" c
  [ "$WATCHDOG_HAVE_PGREP" = "1" ] || return 0
  for c in $(pgrep -P "$pid" 2>/dev/null || true); do
    [ "$c" = "$BASHPID" ] && continue
    kill_tree "$c" "$sig"
    kill -s "$sig" "$c" 2>/dev/null || true
  done
  return 0
}

# watchdog_bytes: total bytes the suite's children have produced so far. A test that is
# slow but ALIVE usually keeps printing (node:test emits TAP as subtests finish), so
# output growth is progress just as much as a milestone is — and reading it is what lets
# the silence bound be generous without becoming useless. Only the top level of $TMP is
# counted: the watchdog's own state lives one level down, in $TMP/watchdog.
watchdog_bytes() {
  local n
  n="$(find "$TMP" -maxdepth 1 -type f -printf '%s\n' 2>/dev/null | awk '{s += $1} END { print s + 0 }')"
  printf '%s' "${n:-0}"
}

# suite_alive — false once the suite is gone OR has become a zombie. `kill -0` alone is NOT
# enough and this is not a detail: the suite's parent may be a runner that is itself blocked
# and reaping nothing, so an exited suite sits in the process table as a zombie that still
# answers `kill -0`. Polling on that alone would make every abort pause for the full
# escalation budget to kill something that was already dead. An unreadable /proc (non-Linux)
# falls back to `kill -0`, which is then merely pessimistic, never wrong.
suite_alive() {
  local line st
  kill -0 "$SUITE_PID" 2>/dev/null || return 1
  [ -r "/proc/$SUITE_PID/stat" ] || return 0
  line="$(cat "/proc/$SUITE_PID/stat" 2>/dev/null)" || return 0
  st="${line##*) }"; st="${st%% *}"
  [ "$st" = "Z" ] && return 1
  return 0
}

# watchdog_wait_gone <ticks> — up to <ticks> * 0.25s for the suite to be gone.
watchdog_wait_gone() {
  local i=0
  while [ "$i" -lt "$1" ]; do
    suite_alive || return 0
    i=$((i + 1)); sleep 0.25
  done
  return 0
}

# watchdog_fire <guard> <reason> <limit_ms> <elapsed_ms> <silent_ms>
# Write the verdict where the report and the TERM trap can both see it, end the tree,
# and leave. Deliberately does NOT re-classify anything: whether the run is red is the
# caller's conclusion, and this only reports that it will never finish on its own.
#
# The ORDER is the whole point. SIGKILL cannot be trapped, so killing first and asking
# later is how a hung suite ends up with no report at all — the run stops, and nobody can
# read why. So the suite is asked first (TERM), which lets its own trap finish the report
# and end its own tree; the escalating KILL below is only for a suite that cannot answer,
# e.g. one blocked behind a foreground child that will not die.
watchdog_fire() {
  local guard="$1" reason="$2" limit="$3" elapsed="$4" silent="$5"
  printf 'suite-watchdog: ABORT guard=%s reason=%s threshold_ms=%s elapsed_ms=%s silent_ms=%s\n' \
    "$guard" "$reason" "$limit" "$elapsed" "$silent" > "$WATCHDOG_VERDICT"
  cat "$WATCHDOG_VERDICT"
  kill -s TERM "$SUITE_PID" 2>/dev/null || true
  watchdog_wait_gone 20
  kill_tree "$SUITE_PID" KILL       # unblocks a trap that is queued behind a live child
  watchdog_wait_gone 20
  kill -s KILL "$SUITE_PID" 2>/dev/null || true
  exit 3
}

watchdog_loop() {
  local now m size last_progress prev_bytes elapsed silent max_silent=0 events=0
  last_progress="$WATCHDOG_START"; prev_bytes=0
  while [ ! -e "$WATCHDOG_STOP" ]; do
    now=$(now_ms)
    m="$(cat "$WATCHDOG_PROGRESS" 2>/dev/null || true)"
    case "$m" in ''|*[!0-9]*) m=0 ;; esac
    if [ "$m" -gt "$last_progress" ]; then last_progress="$m"; events=$((events + 1)); fi
    size="$(watchdog_bytes)"
    if [ "$size" -gt "$prev_bytes" ]; then
      prev_bytes="$size"; last_progress="$now"; events=$((events + 1))
    fi
    [ "$last_progress" -gt "$now" ] && last_progress="$now"
    elapsed=$(( now - WATCHDOG_START ))
    silent=$(( now - last_progress ))
    [ "$silent" -gt "$max_silent" ] && max_silent=$silent
    printf 'max_silence_ms=%s progress_events=%s elapsed_ms=%s\n' \
      "$max_silent" "$events" "$elapsed" > "$WATCHDOG_TRACE_FILE.$$" 2>/dev/null \
      && mv -f "$WATCHDOG_TRACE_FILE.$$" "$WATCHDOG_TRACE_FILE" 2>/dev/null
    if [ "$elapsed" -ge "$SUITE_MAX_RUNTIME_MS" ]; then
      watchdog_fire max-runtime timeout "$SUITE_MAX_RUNTIME_MS" "$elapsed" "$silent"
    fi
    if [ "$silent" -ge "$SUITE_SILENCE_MS" ]; then
      watchdog_fire silence hung "$SUITE_SILENCE_MS" "$elapsed" "$silent"
    fi
    sleep "$WATCHDOG_POLL_SECS"
  done
  return 0
}

# The watchdog is DISOWNED on purpose. It is a job like any other while it runs, and
# `jobs -rp | wc -l` is what throttles the server phase to $CONCURRENCY and what the bare
# `wait` waits on — left attached, the watchdog would silently cost one concurrency slot
# and make the suite wait for a process that only exits when the suite does.
( watchdog_loop ) &
# `${!:-}` rather than `$!`: under `set -u` a bare `$!` is a fatal error whenever no
# background job has been started, which turns "the guard is not armed" into "the suite
# will not start" — the opposite of what a disabled guard should do.
WATCHDOG_PID="${!:-}"
[ -n "$WATCHDOG_PID" ] && { disown "$WATCHDOG_PID" 2>/dev/null || true; }

watchdog_stop() {
  : > "$WATCHDOG_STOP" 2>/dev/null || true
  [ -n "${WATCHDOG_PID:-}" ] && kill -s TERM "$WATCHDOG_PID" 2>/dev/null
  return 0
}

# A guard that fired has already asked this shell to stop; all that is left is to end the
# tree, make the run non-zero, and say so where the failure list would have been. The
# report carries the raw verdict line verbatim, so guard / threshold / silence are all
# readable from it. Also reachable mid-report (see the server record loop): a guard can
# take the .res files out from under it, and "file X failed" is the wrong story for that.
suite_abort() {
  [ "${WATCHDOG_ABORTED:-0}" = "1" ] && return 0
  WATCHDOG_ABORTED=1
  kill_tree "$$" TERM
  local verdict
  verdict="$(cat "$WATCHDOG_VERDICT" 2>/dev/null || true)"
  if [ -n "$verdict" ]; then
    printf 'not ok - %s\n' "$verdict"
  else
    printf 'not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above\n'
  fi
  # The four counters stay consistent (tests = pass + fail + cancelled) even though the run
  # was cut short: every unit that never reported is a cancellation, except that one of them
  # is the hang itself, which the verdict line above already counts as the failure. Before
  # PLANNED is set (an abort during typecheck/lint) the fallback still balances, since TOTAL
  # is then the number already recorded.
  local planned="${PLANNED:-$((TOTAL + 1))}" cancelled
  cancelled=$((planned - TOTAL - 1))
  [ "$cancelled" -lt 0 ] && cancelled=0
  printf '# tests %s\n# pass %s\n# fail %s\n# cancelled %s\n' \
    "$planned" "$PASS" "$((TOTAL - PASS + 1))" "$cancelled"
  exit 3
}

# Every exit path ends the tree, not just the abort path: a fatal error in this script
# (set -u, a bad read) would otherwise orphan whatever tests are still running, which is
# the same "nobody ends it" shape the watchdogs exist to remove.
suite_cleanup() {
  watchdog_stop
  kill_tree "$$" TERM
  rm -rf "$TMP"
}
trap 'suite_abort' TERM INT
trap 'suite_cleanup' EXIT

# record <label> <duration_ms> <passed> <end_ms> [first_error] [kind]
#
# A failing file must carry a classification: without one a downstream reader cannot tell a
# worker-fixable defect from an infrastructure artifact, and quay's policy (ci-red-attribute)
# makes an infra label an irreversible exemption. So an unknown/absent kind is emitted as
# kind=unclassified AND makes the run exit non-zero — the field is never silently optional.
record() {
  local label="$1" dur="$2" ok="$3" end="$4" err="${5:-}" kind="${6:-}"
  [ "$dur" -lt 1 ] && dur=1
  echo "__PERFILE__ duration_ms=$dur $label passed=$ok end_ms=$end"
  TOTAL=$((TOTAL + 1))
  if [ "$ok" = "true" ]; then PASS=$((PASS + 1)); else
    FAIL=$((FAIL + 1)); FAILED_LINES+=("not ok - $label: ${err:-failed}")
    case "$kind" in
      infra|assert) ;;
      *) kind="unclassified"; UNCLASSIFIED=$((UNCLASSIFIED + 1)) ;;
    esac
    echo "__PERFILE_KIND__ file=$label kind=$kind"   # __KIND_RECORD__
  fi
}

first_error() {
  local line
  line="$(grep -m1 -E 'Error|error|not ok|✗|FAIL|failed' "$1" 2>/dev/null | head -c 300)"
  echo "${line:-see log}"
}

# __BEGIN_CLASSIFY__
# classify_failure_kind <lane> <rc> <log> [<failed_assertions>] -> prints infra | assert
#
# STRUCTURAL FACTS ONLY — no log keyword matching (nothing greps for "ETIMEDOUT",
# "STACK_TRACE_ERROR", "Error:" or any other message text). What it reads:
#   * the process exit-code envelope: 129..192 = died from signal 128+N, 124 = GNU timeout(1)
#     fired — in both cases the process was cut off, so its report cannot be trusted;
#   * the runner's OWN failed-assertion tally: node's test reporter summary counter (`# fail N`
#     under TAP, `ℹ fail N` under the spec reporter) and vitest's JSON assertionResults[].status.
#
# The asymmetry is deliberate, and it is the same one quay's ci-red-attribute records: a real
# assertion failure is NEVER relabelled infra (each infra label exempts a red, and that direction
# is not reversible), so `assert` wins the moment the runner tallied a failing assertion. `infra`
# is reachable only when the runner tallied NOTHING attributable to a test.
#
# lane=stage (typecheck/lint) has no framework tally to read, so only the envelope applies: a
# stage that exited normally with a nonzero status found a real defect in the tree.
classify_failure_kind() {
  local lane="$1" rc="$2" log="$3" failed="${4:-}"
  case "$lane" in
    server)
      if sed -E 's/\x1b\[[0-9;]*m//g' "$log" 2>/dev/null | grep -qE '^(#|ℹ) ?fail [1-9][0-9]*'; then
        echo assert; return 0
      fi
      ;;
    client)
      # Normalise the tally BEFORE the arithmetic test. The subject must be the raw value: a
      # `:-0` default here would make an empty tally subject the string "0", which matches neither
      # branch, so the assignment would silently not happen and `[ "" -gt 0 ]` would both error on
      # stderr and skip the assertion tally it exists to read.
      case "$failed" in ''|*[!0-9]*) failed=0 ;; esac
      if [ "$failed" -gt 0 ]; then echo assert; return 0; fi
      # Killed by the memory cap scripts/with-memory-cap.sh imposes: the test blew its budget, which
      # is attributable to the code under test, so it is NOT the "cut off" infra shape below.
      if grep -q 'client vitest OOM-killed at the memory cap' "$log" 2>/dev/null; then echo assert; return 0; fi
      ;;
    stage) : ;;                      # no framework tally to read: the envelope below decides
    *) echo assert; return 0 ;;      # unknown lane: never grant an exemption
  esac
  # Nothing test-attributable was reported. A cut-off process explains that structurally...
  if { [ "$rc" -ge 129 ] && [ "$rc" -le 192 ]; } || [ "$rc" -eq 124 ]; then
    echo infra; return 0
  fi
  # ...otherwise the lane decides. vitest reported the file failed with ZERO assertion results
  # (its worker died before asserting anything: the STACK_TRACE_ERROR shape) => infra. For the
  # server lane the same absence means node/tsx could not even run the file — a broken test file,
  # which is a real defect to fix => assert. A typecheck/lint stage reached this point having
  # exited normally, so it found a real defect too.
  case "$lane" in
    client) echo infra ;;
    *) echo assert ;;
  esac
}
# __END_CLASSIFY__

# run_stage <label> <cmd...>: run a whole-command stage as one pseudo file
run_stage() {
  local label="$1"; shift
  local out="$TMP/stage-$label.out" s e rc
  s=$(now_ms); "$@" >"$out" 2>&1; rc=$?; e=$(now_ms)
  if [ $rc -eq 0 ]; then record "$label" $((e - s)) true "$e"
  else record "$label" $((e - s)) false "$e" "$(first_error "$out")" "$(classify_failure_kind stage "$rc" "$out")"; fi
  progress
}

SERVER_FILES=(); CLIENT_FILES=()
if [ ${#FILES[@]} -gt 0 ]; then
  for f in "${FILES[@]}"; do
    f="${f#./}"
    case "$f" in server/*) SERVER_FILES+=("$f") ;; *) CLIENT_FILES+=("$f") ;; esac
  done
else
  while IFS= read -r f; do SERVER_FILES+=("$f"); done < <(find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort)
  CLIENT_FILES=("__all__")
  run_stage typecheck npm run typecheck
  run_stage lint npm run lint
fi

# How many units this invocation means to report, pinned while the plan is still known. The
# abort path needs it: a guard that ends the run has to be able to say how much never ran,
# and past this point the counters only describe what DID run. Typecheck and lint each count
# as one unit in the collecting path (they are recorded as stages); in the scoped path they
# do not run at all, so they are not planned.
PLANNED=$((${#SERVER_FILES[@]} + ${#CLIENT_FILES[@]}))
[ ${#FILES[@]} -eq 0 ] && PLANNED=$((PLANNED + 2))

# server: one node:test process per file, up to $CONCURRENCY at a time
if [ ${#SERVER_FILES[@]} -gt 0 ]; then
  i=0
  for f in "${SERVER_FILES[@]}"; do
    (
      s=$(now_ms)
      if [ -n "$TIMEOUT_BIN" ]; then
        "$TIMEOUT_BIN" --signal=TERM --kill-after=10 "$FILE_TIMEOUT_SECS" \
          npx tsx --tsconfig server/tsconfig.json --test "$f" >"$TMP/srv-$i.out" 2>&1
      else
        npx tsx --tsconfig server/tsconfig.json --test "$f" >"$TMP/srv-$i.out" 2>&1
      fi
      rc=$?; e=$(now_ms)
      echo "$rc $((e - s)) $e" >"$TMP/srv-$i.res"
      # One file finished => the suite moved on. This is the server phase's only
      # per-file liveness signal that does not depend on the child printing anything.
      progress
    ) &
    i=$((i + 1))
    while [ "$(jobs -rp | wc -l)" -ge "$CONCURRENCY" ]; do wait -n; done
  done
  wait
  i=0
  for f in "${SERVER_FILES[@]}"; do
    if [ -s "$TMP/srv-$i.res" ]; then
      read -r rc dur end <"$TMP/srv-$i.res"
      if [ "$rc" = "0" ]; then record "$f" "$dur" true "$end"
      else record "$f" "$dur" false "$end" "$(first_error "$TMP/srv-$i.out")" "$(classify_failure_kind server "$rc" "$TMP/srv-$i.out")"; fi
    elif [ -e "$WATCHDOG_VERDICT" ]; then
      # A guard ended the tree, so this file has no result and none is coming. Report the
      # guard, not the file: a missing result file is not a defect any worker can fix.
      suite_abort
    else
      record "$f" 1 false "$(now_ms)" "no result file was written for this file — its process died without reporting" assert
    fi
    i=$((i + 1))
  done
fi

# client: single vitest run, JSON report parsed per file
if [ ${#CLIENT_FILES[@]} -gt 0 ]; then
  # This phase is ONE process whose whole span is a single silence: `--reporter=json`
  # writes the per-file report at the end, so neither stdout nor the report grows while
  # it runs. The heartbeat goes in here, at the phase's own start, so the silence the
  # watchdog measures during the client phase is the client phase and not the tail of
  # whatever ran before it.
  progress
  # The vitest process runs in its own memory-capped cgroup scope: a runaway test (2026-09-25:
  # 218G peak) otherwise makes the kernel OOM-kill the whole tmux-pane scope, :3001 included.
  # A capped kill surfaces as exit 137 with no report, which classify_failure_kind reads as infra.
  MEMCAP="$ROOT_DIR/scripts/with-memory-cap.sh"
  export QUAY_MEMORY_UNIT="quay-vitest-$$-$(now_ms)"
  ARGS=()
  [ "${CLIENT_FILES[0]}" != "__all__" ] && ARGS=("${CLIENT_FILES[@]}")
  VRC=0
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" --signal=TERM --kill-after=10 "$FILE_TIMEOUT_SECS" \
      "$MEMCAP" npx vitest run --reporter=json --outputFile="$TMP/vitest.json" "${ARGS[@]+"${ARGS[@]}"}" >"$TMP/vitest.out" 2>&1 || VRC=$?
  else
    "$MEMCAP" npx vitest run --reporter=json --outputFile="$TMP/vitest.json" "${ARGS[@]+"${ARGS[@]}"}" >"$TMP/vitest.out" 2>&1 || VRC=$?
  fi
  # The kernel kills a WORKER, not vitest itself, so the exit code is unreliable (observed: 1, with
  # ERR_IPC_CHANNEL_CLOSED and no report) and would read as the "cut off"/zero-assertion infra shape.
  # Exceeding the cap is the test's own defect, not the host's: the journal is the only witness, so
  # leave a marker classify_failure_kind reads.
  if [ "$VRC" -ne 0 ] && journalctl --user --no-pager -q -u "$QUAY_MEMORY_UNIT.scope" 2>/dev/null | grep -q 'OOM killer'; then
    echo "client vitest OOM-killed at the memory cap (QUAY_MEMORY_MAX=${QUAY_MEMORY_MAX:-24G})" >>"$TMP/vitest.out"
  fi
  # A guard that fired while vitest was running reaches here only if this shell's TERM trap
  # has not been honoured yet; reporting the client phase from a dead run would be a lie.
  [ -e "$WATCHDOG_VERDICT" ] && suite_abort
  if [ -s "$TMP/vitest.json" ]; then
    # Column 5 is the runner's own failed-assertion tally for that file: it is what separates a
    # real assertion failure (assert) from a file the worker died on before asserting (infra).
    while IFS=$'\t' read -r label dur ok end nfailed err; do
      if [ "$ok" = "true" ]; then record "$label" "$dur" true "$end"
      else record "$label" "$dur" false "$end" "$err" "$(classify_failure_kind client "$VRC" "$TMP/vitest.out" "$nfailed")"; fi
    done < <(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const root = process.argv[2] + "/";
      for (const t of r.testResults) {
        const bad = t.status !== "passed";
        const msg = bad
          ? (((t.assertionResults || []).find((a) => a.status === "failed") || {}).failureMessages || [t.message || "failed"])[0] || "failed"
          : "";
        const nfailed = (t.assertionResults || []).filter((a) => a.status === "failed").length;
        const dur = Math.max(1, Math.round(t.endTime - t.startTime));
        console.log([t.name.replace(root, ""), dur, !bad, Math.round(t.endTime), nfailed, String(msg).split("\n")[0].slice(0, 300)].join("\t"));
      }' "$TMP/vitest.json" "$ROOT_DIR")
  else
    # No report at all: the run itself died (worker killed, reporter channel closed, hard
    # timeout). Nothing test-attributable was recorded, so lane=client classifies it infra.
    record client-vitest 1 false "$(now_ms)" "$(first_error "$TMP/vitest.out")" "$(classify_failure_kind client "$VRC" "$TMP/vitest.out")"
  fi
  progress
fi

# The suite finished on its own, so no guard could have fired. Stop the watchdog before
# the report is printed so it can never append a verdict to a run that already ended.
watchdog_stop

echo
for l in "${FAILED_LINES[@]+"${FAILED_LINES[@]}"}"; do echo "$l"; done
# Opt-in: the raw readings the two thresholds are derived from, so a later change to them
# can be a re-measurement instead of a guess. Read from the trace the watchdog rewrote on
# every poll — it is a snapshot, not a final tally, so it is only printed for a run that
# ran to completion.
if [ "${QUAY_SUITE_WATCHDOG_TRACE:-}" = "1" ] && [ -s "$WATCHDOG_TRACE_FILE" ]; then
  printf 'suite-watchdog: trace %s max_runtime_threshold_ms=%s silence_threshold_ms=%s\n' \
    "$(cat "$WATCHDOG_TRACE_FILE")" "$SUITE_MAX_RUNTIME_MS" "$SUITE_SILENCE_MS"
fi
echo "# tests $TOTAL"
echo "# pass $PASS"
echo "# fail $FAIL"
echo "# cancelled 0"
# UNCLASSIFIED > 0 means a failure reached the report without a usable kind. That is a bug in
# this script's own attribution, so it is a red run, not a silently-attributable one.
[ "$FAIL" -eq 0 ] && [ "$UNCLASSIFIED" -eq 0 ]
