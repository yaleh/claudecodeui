#!/usr/bin/env bash
# quay fan-in test entrypoint: typecheck + lint + server node:test + client vitest,
# with one `__PERFILE__` line per test file so quay's /tests page gets file-level detail.
# Every stage runs even if an earlier one failed; the exit code is non-zero if any failed.
# Env: QUAY_TEST_DRY=1 consumes args, validates positional files, then exits 0 without running.
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
TOTAL=0; PASS=0; FAIL=0
FAILED_LINES=()

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

# record <label> <duration_ms> <passed> <end_ms> [first_error]
record() {
  local label="$1" dur="$2" ok="$3" end="$4" err="${5:-}"
  [ "$dur" -lt 1 ] && dur=1
  echo "__PERFILE__ duration_ms=$dur $label passed=$ok end_ms=$end"
  TOTAL=$((TOTAL + 1))
  if [ "$ok" = "true" ]; then PASS=$((PASS + 1)); else
    FAIL=$((FAIL + 1)); FAILED_LINES+=("not ok - $label: ${err:-failed}")
  fi
}

first_error() {
  local line
  line="$(grep -m1 -E 'Error|error|not ok|✗|FAIL|failed' "$1" 2>/dev/null | head -c 300)"
  echo "${line:-see log}"
}

# run_stage <label> <cmd...>: run a whole-command stage as one pseudo file
run_stage() {
  local label="$1"; shift
  local out="$TMP/stage-$label.out" s e rc
  s=$(now_ms); "$@" >"$out" 2>&1; rc=$?; e=$(now_ms)
  if [ $rc -eq 0 ]; then record "$label" $((e - s)) true "$e"
  else record "$label" $((e - s)) false "$e" "$(first_error "$out")"; fi
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
      npx tsx --tsconfig server/tsconfig.json --test "$f" >"$TMP/srv-$i.out" 2>&1
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
    else record "$f" "$dur" false "$end" "$(first_error "$TMP/srv-$i.out")"; fi
    i=$((i + 1))
  done
fi

# client: single vitest run, JSON report parsed per file
if [ ${#CLIENT_FILES[@]} -gt 0 ]; then
  ARGS=()
  [ "${CLIENT_FILES[0]}" != "__all__" ] && ARGS=("${CLIENT_FILES[@]}")
  npx vitest run --reporter=json --outputFile="$TMP/vitest.json" "${ARGS[@]+"${ARGS[@]}"}" >"$TMP/vitest.out" 2>&1
  if [ -s "$TMP/vitest.json" ]; then
    while IFS=$'\t' read -r label dur ok end err; do
      record "$label" "$dur" "$ok" "$end" "$err"
    done < <(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const root = process.argv[2] + "/";
      for (const t of r.testResults) {
        const bad = t.status !== "passed";
        const msg = bad
          ? (((t.assertionResults || []).find((a) => a.status === "failed") || {}).failureMessages || [t.message || "failed"])[0] || "failed"
          : "";
        const dur = Math.max(1, Math.round(t.endTime - t.startTime));
        console.log([t.name.replace(root, ""), dur, !bad, Math.round(t.endTime), String(msg).split("\n")[0].slice(0, 300)].join("\t"));
      }' "$TMP/vitest.json" "$ROOT_DIR")
  else
    record client-vitest 1 false "$(now_ms)" "$(first_error "$TMP/vitest.out")"
  fi
fi

echo
for l in "${FAILED_LINES[@]+"${FAILED_LINES[@]}"}"; do echo "$l"; done
echo "# tests $TOTAL"
echo "# pass $PASS"
echo "# fail $FAIL"
echo "# cancelled 0"
[ "$FAIL" -eq 0 ]
