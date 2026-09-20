#!/usr/bin/env bash
# quay fan-in test entrypoint: typecheck + lint + server node:test + client vitest,
# with one `__PERFILE__` line per test file so quay's /tests page gets file-level detail.
# Every stage runs even if an earlier one failed; the exit code is non-zero if any failed.
# Env: QUAY_TEST_DRY=1 consumes args, validates positional files, then exits 0 without running.
#      QUAY_TEST_FILE_TIMEOUT=<secs> per-process wall-clock bound (default 600).
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
    ) &
    i=$((i + 1))
    while [ "$(jobs -rp | wc -l)" -ge "$CONCURRENCY" ]; do wait -n; done
  done
  wait
  i=0
  for f in "${SERVER_FILES[@]}"; do
    read -r rc dur end <"$TMP/srv-$i.res"
    if [ "$rc" = "0" ]; then record "$f" "$dur" true "$end"
    else record "$f" "$dur" false "$end" "$(first_error "$TMP/srv-$i.out")" "$(classify_failure_kind server "$rc" "$TMP/srv-$i.out")"; fi
    i=$((i + 1))
  done
fi

# client: single vitest run, JSON report parsed per file
if [ ${#CLIENT_FILES[@]} -gt 0 ]; then
  ARGS=()
  [ "${CLIENT_FILES[0]}" != "__all__" ] && ARGS=("${CLIENT_FILES[@]}")
  VRC=0
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" --signal=TERM --kill-after=10 "$FILE_TIMEOUT_SECS" \
      npx vitest run --reporter=json --outputFile="$TMP/vitest.json" "${ARGS[@]+"${ARGS[@]}"}" >"$TMP/vitest.out" 2>&1 || VRC=$?
  else
    npx vitest run --reporter=json --outputFile="$TMP/vitest.json" "${ARGS[@]+"${ARGS[@]}"}" >"$TMP/vitest.out" 2>&1 || VRC=$?
  fi
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
fi

echo
for l in "${FAILED_LINES[@]+"${FAILED_LINES[@]}"}"; do echo "$l"; done
echo "# tests $TOTAL"
echo "# pass $PASS"
echo "# fail $FAIL"
echo "# cancelled 0"
# UNCLASSIFIED > 0 means a failure reached the report without a usable kind. That is a bug in
# this script's own attribution, so it is a red run, not a silently-attributable one.
[ "$FAIL" -eq 0 ] && [ "$UNCLASSIFIED" -eq 0 ]
