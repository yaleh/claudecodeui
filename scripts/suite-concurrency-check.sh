#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/suite-concurrency-check.sh — AC-103 的判据读数
# （goals/AC-103-*.md：「同时运行的两个全量套件互不拖红」）
#
# 判据形态（无参）：在同一台机器上【并发】启动 2 份 client 全量套件，并让 2 份服务端
# 逐文件读数与之【全部同时】起跑；等它们结束后断言
#   ① 2 份套件退出码均为 0；
#   ② 各份输出中 `STACK_TRACE_ERROR` 与 `Timeout calling "fetch"` 的计数均为 0；
#   ③ 并发组的服务端逐文件中位耗时 ≤ K × 安静基线（K 由首次实测钉死，见 K_RATIO）；
#   ④ 确实观测到并发重叠（否则判据不成立，fail-closed）。
# 任一条不成立 ⇒ 退出码 1，且判词【同一行】带出成因与实测读数。
#
# 并发组为什么是「2 client 套件 ‖ 2 服务端读数」而不是「2 份 bash scripts/test.sh」：
# 一份全量套件 = typecheck + lint + 服务端逐文件(node:test) + client(vitest)，本机实测
# **单份就要 55s**；而 quay 的 goal 判据 gate 是 runAcceptance({ timeoutMs: 6e4 }) ——
# 硬上限 60s。两份全量套件并发必然被 gate 杀掉（verdict=fail，判词会变成 "acceptance
# timed out"），AC-103 就永远红在超时上、而不是红在读数上。所以并发组保留**两个真正
# 过订阅的 phase**、砍掉单进程的 typecheck/lint：
#   · 2 份 client 池 —— vitest 池正是 AC-103 取假形态里「去掉池上限」所指的那一项；
#   · 2 份服务端 phase —— 每份全量套件各带一次，且服务端逐文件中位耗时正是 K 约束的量
#     （AC-103 origin 记的 0.7s→41.3s 就是两次 server phase 互踩出来的）。
# 需要逐字完整形态时用 --full-suites（≈2×55s，超出 60s gate 预算，仅供人工/长预算运行）。
#
# 为什么是 standalone 脚本而不是 *.test.ts：scripts/test.sh 只收集
# `server/**/*.test.*` 与 `src/**/*.test.*`，放在 scripts/ 下的检查器不会被套件
# 递归调用 —— 否则它会在套件里再跑套件，自己把自己拖红。
#
# 取假形态（两条都在脚本内，都会以非零退出并打印实测到的那串签名计数）：
#   --concurrency 1   并发数降到 1 ⇒ 未发生并发 ⇒ ④ 不成立（确定性）
#   --drop-pool-cap   client 池改回 availableParallelism()（AC-103 expect 里点名
#                     的那个取假方向）⇒ 期望 ② 的签名计数 > 0
#
# 退出码：0 判据成立；1 判据不成立；2 用法错误。
# ─────────────────────────────────────────────────────────────────────────────
set -u

# 服务端逐文件中位耗时的上限倍数：并发组 / 安静基线。
# 首次实测（2026-09-20，本机，见 tasks/gap-suite-concurrency-checker.md 完成记录）：
# 安静 1388ms → 并发(2 套件 ‖ 2 服务端 phase) 2777ms = 2.00×；而 AC-103 origin 记录的
# 故障态是 0.7s → 41.3s（59×）。取 4：给主机噪声留约 2× 余量，同时对故障态仍有近
# 15× 的判别余量。
K_RATIO="${SCC_K_RATIO:-4}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 2

SUITES=2
READOUTS=""
DROP_POOL_CAP=0
FULL_SUITES=0
TEST_CONCURRENCY=""

usage() {
  cat <<'USAGE'
usage: bash scripts/suite-concurrency-check.sh [options]

  --concurrency <n>        并发启动的套件份数（默认 2；取 1 = 取假形态，必须红）
  --readouts <n>           并发组里同时跑的「服务端逐文件读数」份数（默认 = --concurrency：
                           两份全量套件就各有一次服务端 phase，这里是同一过订阅形状）
  --drop-pool-cap          client 池改回 availableParallelism()（取假形态）
  --full-suites            并发组用完整 `scripts/test.sh`（≈2×55s，超出 60s gate 预算）
  --test-concurrency <n>   服务端逐文件并发度（默认 = availableParallelism()，与 fan-in 同形）
  --k <ratio>              中位耗时上限倍数（默认 4）
  -h, --help               本帮助
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --concurrency)        SUITES="${2:-}"; shift 2 ;;
    --concurrency=*)      SUITES="${1#*=}"; shift ;;
    --readouts)           READOUTS="${2:-}"; shift 2 ;;
    --readouts=*)         READOUTS="${1#*=}"; shift ;;
    --drop-pool-cap)      DROP_POOL_CAP=1; shift ;;
    --full-suites)        FULL_SUITES=1; shift ;;
    --test-concurrency)   TEST_CONCURRENCY="${2:-}"; shift 2 ;;
    --test-concurrency=*) TEST_CONCURRENCY="${1#*=}"; shift ;;
    --k)                  K_RATIO="${2:-}"; shift 2 ;;
    --k=*)                K_RATIO="${1#*=}"; shift ;;
    -h|--help)            usage; exit 0 ;;
    *) echo "suite-concurrency-check: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$SUITES" in ''|*[!0-9]*|0) echo "suite-concurrency-check: --concurrency must be a positive integer, got '$SUITES'" >&2; exit 2 ;; esac
[ -n "$READOUTS" ] || READOUTS="$SUITES"
case "$READOUTS" in ''|*[!0-9]*) echo "suite-concurrency-check: --readouts must be a non-negative integer, got '$READOUTS'" >&2; exit 2 ;; esac
case "$K_RATIO" in ''|*[!0-9.]*) echo "suite-concurrency-check: --k must be a number, got '$K_RATIO'" >&2; exit 2 ;; esac

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

if [ -z "$TEST_CONCURRENCY" ]; then
  TEST_CONCURRENCY="$(node -e 'const os=require("node:os");process.stdout.write(String(os.availableParallelism?os.availableParallelism():os.cpus().length))' 2>/dev/null || true)"
  case "$TEST_CONCURRENCY" in ''|*[!0-9]*|0) TEST_CONCURRENCY=4 ;; esac
fi

LOG_DIR="${SCC_LOG_DIR:-$ROOT_DIR/.quay/suite-concurrency-check}"
RUN_DIR="$LOG_DIR/$(date +%Y%m%dT%H%M%S)-$$"
mkdir -p "$RUN_DIR" || { echo "suite-concurrency-check: FAIL — cannot create log dir $RUN_DIR" >&2; exit 1; }

# 服务端逐文件读数：与 scripts/test.sh 的全量收集式一致（server/**/*.test.ts|js）
SERVER_FILES=()
while IFS= read -r f; do SERVER_FILES+=("$f"); done < \
  <(find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort)

# ── 并发组与被观测的套件 ─────────────────────────────────────────────────────
# SUITE_CMD    并发启动 N 份的那条命令（client 全量套件；--full-suites 时是完整套件）
# READOUT_CMD  提供「服务端逐文件中位耗时」的那条命令（不跑 typecheck/lint/client，
#              只跑服务端逐文件；--full-suites 时由套件自身提供，故为 none）
CLIENT_CMD=(npx vitest run)
if [ "$DROP_POOL_CAP" = "1" ]; then
  # AC-103 取假形态点名的方向：把 client 池改回 availableParallelism()。
  # 用 CLI 覆盖而不是改 vitest.config.ts —— 不改工作树、无需还原。
  CLIENT_CMD+=(--maxWorkers="$TEST_CONCURRENCY")
fi

# 并发组 = N 份套件 + R 份服务端逐文件读数，全部同时起跑。
# R 默认 = N：两份全量套件各有一次服务端 phase，这是与 fan-in 相同的过订阅形状
# （AC-103 记录的服务端劣化 0.7s→41.3s 正是两次 server phase 互相踩出来的）。
# --full-suites 时套件自身就是读数来源，R=0。
if [ "$FULL_SUITES" = "1" ]; then
  SUITE_CMD=(bash scripts/test.sh --test-concurrency="$TEST_CONCURRENCY")
  READOUT_CMD=()
  READOUTS=0
else
  SUITE_CMD=("${CLIENT_CMD[@]}")
  READOUT_CMD=(bash scripts/test.sh --test-concurrency="$TEST_CONCURRENCY")
  if [ ${#SERVER_FILES[@]} -gt 0 ]; then READOUT_CMD+=("${SERVER_FILES[@]}"); fi
fi

# run_group <group> <suite-runs> <readout-runs>
# 把每份运行的 rc / 起止时间 / 日志分别落在 $RUN_DIR 下，供后面逐条判读。
run_group() {
  local group="$1" n="$2" r="$3" i
  GROUP_START=$(now_ms)
  for ((i = 0; i < n; i++)); do
    (
      s=$(now_ms); "${SUITE_CMD[@]}" >"$RUN_DIR/$group-suite-$i.out" 2>&1; rc=$?
      e=$(now_ms); echo "$rc $s $e" >"$RUN_DIR/$group-suite-$i.meta"
    ) &
  done
  if [ "$r" -gt 0 ] && [ ${#READOUT_CMD[@]} -gt 0 ]; then
    for ((i = 0; i < r; i++)); do
      (
        s=$(now_ms); "${READOUT_CMD[@]}" >"$RUN_DIR/$group-readout-$i.out" 2>&1; rc=$?
        e=$(now_ms); echo "$rc $s $e" >"$RUN_DIR/$group-readout-$i.meta"
      ) &
    done
  fi
  wait
  GROUP_END=$(now_ms)
}

# 固定字符串计数；`grep -c` 无命中时返回 1，故显式归一为 0。
count_sig() { # count_sig <file> <fixed-string>
  local n
  n="$(grep -c -F -- "$2" "$1" 2>/dev/null)" || true
  case "${n:-}" in ''|*[!0-9]*) n=0 ;; esac
  echo "$n"
}

# 从 `__PERFILE__ duration_ms=<n> <label> passed=<b> end_ms=<n>` 行里取服务端逐文件耗时。
# ⛔ 逐个喂给 awk 之前先滤掉不存在的日志：gawk 遇到读不到的文件会 fatal 退出（rc=2），
# 那会把「安静组没跑套件」这类正常情况误判成「一条读数都没有」，进而 fail-closed 误红。
server_durations() { # server_durations <logfile...>
  local files=() f
  for f in "$@"; do [ -f "$f" ] && files+=("$f"); done
  [ ${#files[@]} -eq 0 ] && return 0
  awk '
    /^__PERFILE__/ {
      dur = ""; lab = "";
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^duration_ms=/) dur = substr($i, 13)
        else if ($i !~ /^(passed|end_ms)=/) lab = $i
      }
      if (dur != "" && lab ~ /^server\//) print dur
    }' "${files[@]}" | sort -n
}

# 偶数个取中间两数均值（向下取整），奇数个取中位数
median_of() { # reads sorted numbers on stdin
  awk '{ v[NR] = $1 } END {
    if (NR == 0) { print ""; exit }
    print (NR % 2) ? v[(NR + 1) / 2] : int((v[int(NR / 2)] + v[int(NR / 2) + 1]) / 2)
  }'
}

echo "suite-concurrency-check: root=$ROOT_DIR"
if [ ${#READOUT_CMD[@]} -gt 0 ]; then
  echo "suite-concurrency-check: suites=$SUITES readouts=$READOUTS suite_cmd=${SUITE_CMD[*]} ｜ readout_cmd=bash scripts/test.sh --test-concurrency=$TEST_CONCURRENCY <${#SERVER_FILES[@]} server files> ｜ k=$K_RATIO"
else
  echo "suite-concurrency-check: suites=$SUITES suite_cmd=${SUITE_CMD[*]}（--full-suites：中位耗时由套件自身提供）｜ k=$K_RATIO"
fi
echo "suite-concurrency-check: host cores=$(nproc 2>/dev/null || echo '?') load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '?') logs=$RUN_DIR"

# ── 第 1 组：安静基线（只有一份读数命令在跑；--full-suites 时是一份完整套件）───
echo "suite-concurrency-check: [quiet] $([ ${#READOUT_CMD[@]} -gt 0 ] && echo 'server-phase only' || echo 'one full suite')"
run_group quiet "$([ ${#READOUT_CMD[@]} -gt 0 ] && echo 0 || echo 1)" "$([ ${#READOUT_CMD[@]} -gt 0 ] && echo 1 || echo 0)"
QUIET_START=$GROUP_START; QUIET_END=$GROUP_END

# ── 第 2 组：并发组（N 份套件 + R 份服务端读数同时起跑）─────────────────────
echo "suite-concurrency-check: [concurrent] $SUITES × ${SUITE_CMD[*]}$([ ${#READOUT_CMD[@]} -gt 0 ] && echo "  ‖ $READOUTS × server-phase(readout)")"
run_group concurrent "$SUITES" "$READOUTS"
CONC_START=$GROUP_START; CONC_END=$GROUP_END

# ── 收集读数 ────────────────────────────────────────────────────────────────
quiet_logs=("$RUN_DIR/quiet-suite-0.out")
for ((i = 0; i < READOUTS; i++)); do quiet_logs+=("$RUN_DIR/quiet-readout-$i.out"); done
quiet_dur="$(server_durations "${quiet_logs[@]}")"
median_quiet="$(printf '%s\n' "$quiet_dur" | median_of)"
n_quiet="$(printf '%s\n' "$quiet_dur" | grep -c . || true)"

# 并发组的中位耗时：--full-suites 时由套件自身提供，否则由并发的读数命令提供
conc_logs=()
for ((i = 0; i < SUITES; i++)); do conc_logs+=("$RUN_DIR/concurrent-suite-$i.out"); done
for ((i = 0; i < READOUTS; i++)); do conc_logs+=("$RUN_DIR/concurrent-readout-$i.out"); done
conc_dur="$(server_durations "${conc_logs[@]}")"
median_conc="$(printf '%s\n' "$conc_dur" | median_of)"
n_conc="$(printf '%s\n' "$conc_dur" | grep -c . || true)"

# 签名计数：套件自身的输出（AC-103 的「两份输出」）+ 并发读数命令的输出
sig_ste=0; sig_fetch=0
for ((i = 0; i < SUITES; i++)); do
  sig_ste=$(( sig_ste + $(count_sig "$RUN_DIR/concurrent-suite-$i.out" 'STACK_TRACE_ERROR') ))
  sig_fetch=$(( sig_fetch + $(count_sig "$RUN_DIR/concurrent-suite-$i.out" 'Timeout calling "fetch"') ))
done
for ((i = 0; i < READOUTS; i++)); do
  sig_ste=$(( sig_ste + $(count_sig "$RUN_DIR/concurrent-readout-$i.out" 'STACK_TRACE_ERROR') ))
  sig_fetch=$(( sig_fetch + $(count_sig "$RUN_DIR/concurrent-readout-$i.out" 'Timeout calling "fetch"') ))
done

# 套件退出码 + 读数命令退出码 + 并发重叠窗口
runs_rc=""; readout_rc=""; overlap_ms=""
first_end=""; last_start=""
for ((i = 0; i < SUITES; i++)); do
  meta="$RUN_DIR/concurrent-suite-$i.meta"
  if [ ! -s "$meta" ]; then runs_rc="$runs_rc missing"; continue; fi
  read -r rc s e <"$meta"
  runs_rc="$runs_rc $rc"
  if [ -z "$first_end" ] || [ "$e" -lt "$first_end" ]; then first_end="$e"; fi
  if [ -z "$last_start" ] || [ "$s" -gt "$last_start" ]; then last_start="$s"; fi
done
# 读数命令就是「全量套件的服务端 phase」：它的退出码也是套件退出码的一部分，
# 所以一并判（否则「服务端那半截红了」会被中位耗时读数掩盖过去）。
for ((i = 0; i < READOUTS; i++)); do
  meta="$RUN_DIR/concurrent-readout-$i.meta"
  if [ -s "$meta" ]; then read -r rc _s _e <"$meta"; readout_rc="$readout_rc $rc"; fi
done
if [ -n "$first_end" ] && [ -n "$last_start" ]; then overlap_ms=$(( first_end - last_start )); fi

ratio="n/a"
if [ -n "$median_quiet" ] && [ -n "$median_conc" ] && [ "$median_quiet" -gt 0 ]; then
  ratio="$(awk -v a="$median_conc" -v b="$median_quiet" 'BEGIN { printf "%.2f", a / b }')"
fi

# 判词：所有分支都同行带出成因 + 实测读数
verdict_readout="签名 STACK_TRACE_ERROR=$sig_ste Timeout_fetch=$sig_fetch ｜ 服务端逐文件中位耗时 安静=${median_quiet:-n/a}ms(n=$n_quiet) 并发=${median_conc:-n/a}ms(n=$n_conc) 比值=$ratio K=$K_RATIO"
echo "suite-concurrency-check: 读数 套件 rc=[${runs_rc# }] 读数 rc=[${readout_rc# }] 并发重叠=${overlap_ms:-n/a}ms 并发窗口=$(( CONC_END - CONC_START ))ms 安静窗口=$(( QUIET_END - QUIET_START ))ms ｜ $verdict_readout"

# ① 取假/前置守卫：必须真的发生并发（--concurrency 1 走这里，确定性）
if [ "$SUITES" -lt 2 ]; then
  printf 'suite-concurrency-check: FAIL — 并发数 %s < 2：未观测到并发重叠，"两个套件互不拖红" 不可判（fail-closed）｜ %s\n' "$SUITES" "$verdict_readout"
  exit 1
fi
if [ -z "$overlap_ms" ] || [ "$overlap_ms" -le 0 ]; then
  printf 'suite-concurrency-check: FAIL — 未观测到并发重叠（套件没有同时在跑，first_end=%s last_start=%s）｜ %s\n' "${first_end:-n/a}" "${last_start:-n/a}" "$verdict_readout"
  exit 1
fi

# ② 读数缺失即 fail-closed（不能让「量不到」被当成「没问题」）
if [ "$n_quiet" = "0" ] || [ "$n_conc" = "0" ]; then
  printf 'suite-concurrency-check: FAIL — 未解析到服务端逐文件行（安静 %s 条 / 并发 %s 条），中位耗时不可比，判据不可判（fail-closed）｜ %s\n' "$n_quiet" "$n_conc" "$verdict_readout"
  exit 1
fi

# ③ 退出码（套件 + 服务端读数；安静基线非零退出单独说，免得把「本来就红」记成并发拖红）
bad_rc=""
i=0
for rc in $runs_rc; do
  [ "$rc" = "0" ] || bad_rc="$bad_rc suite#$i=$rc"
  i=$(( i + 1 ))
done
if [ -n "$bad_rc" ]; then
  printf 'suite-concurrency-check: FAIL — 并发套件非零退出：%s（故障文件见 %s 的 not ok 行）｜ %s\n' "${bad_rc# }" "$RUN_DIR" "$verdict_readout"
  exit 1
fi
quiet_rc=""
if [ -s "$RUN_DIR/quiet-readout-0.meta" ]; then read -r quiet_rc _s _e <"$RUN_DIR/quiet-readout-0.meta"; fi
[ -z "$quiet_rc" ] && [ -s "$RUN_DIR/quiet-suite-0.meta" ] && read -r quiet_rc _s _e <"$RUN_DIR/quiet-suite-0.meta"
if [ -n "$quiet_rc" ] && [ "$quiet_rc" != "0" ]; then
  printf 'suite-concurrency-check: FAIL — 安静基线自己就非零退出（rc=%s，与并发无关）：先修基线再谈并发读数｜ %s（日志 %s）\n' "$quiet_rc" "$verdict_readout" "$RUN_DIR"
  exit 1
fi
bad_readout=""
i=0
for rc in $readout_rc; do
  [ "$rc" = "0" ] || bad_readout="$bad_readout readout#$i=$rc"
  i=$(( i + 1 ))
done
if [ -n "$bad_readout" ]; then
  printf 'suite-concurrency-check: FAIL — 并发下服务端读数非零退出：%s（服务端 phase 也是全量套件退出码的一部分；故障文件见 %s 的 not ok 行）｜ %s\n' "${bad_readout# }" "$RUN_DIR" "$verdict_readout"
  exit 1
fi

# ④ 签名计数
if [ "$sig_ste" -ne 0 ] || [ "$sig_fetch" -ne 0 ]; then
  printf 'suite-concurrency-check: FAIL — 并发下出现 worker 死亡签名（STACK_TRACE_ERROR=%s Timeout calling "fetch"=%s），套件在互相拖红｜ %s（日志 %s）\n' "$sig_ste" "$sig_fetch" "$verdict_readout" "$RUN_DIR"
  exit 1
fi

# ⑤ 中位耗时劣化
if [ "$ratio" = "n/a" ]; then
  printf 'suite-concurrency-check: FAIL — 无法计算中位耗时比值（安静=%s 并发=%s）｜ %s\n' "${median_quiet:-n/a}" "${median_conc:-n/a}" "$verdict_readout"
  exit 1
fi
if awk -v r="$ratio" -v k="$K_RATIO" 'BEGIN { exit !(r > k) }'; then
  printf 'suite-concurrency-check: FAIL — 并发劣化超限：服务端逐文件中位耗时 %sms → %sms（%s× > K=%s），并发套件把服务端拖慢｜ %s（日志 %s）\n' "$median_quiet" "$median_conc" "$ratio" "$K_RATIO" "$verdict_readout" "$RUN_DIR"
  exit 1
fi

printf 'suite-concurrency-check: PASS — %s 份套件并发 rc=[%s]、服务端读数 rc=[%s]，未观测到 worker 死亡签名，服务端逐文件中位耗时劣化 %s× ≤ K=%s｜ %s\n' \
  "$SUITES" "${runs_rc# }" "${readout_rc# }" "$ratio" "$K_RATIO" "$verdict_readout"
exit 0
