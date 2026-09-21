#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/suite-concurrency-check.sh — AC-103 的判据读数
# （goals/AC-103-*.md：「同时运行的两个全量套件互不拖红」）
#
# 判据形态（无参）：在同一台机器上【并发】启动 2 份 client 全量套件，并让 2 份服务端
# 逐文件读数与之【全部同时】起跑；等它们结束后断言
#   ① 2 份套件退出码均为 0（可归因到文件的红按下面的【差分语义】判，见 ③）；
#   ② 各份输出中 `STACK_TRACE_ERROR` 与 `Timeout calling "fetch"` 的计数均为 0；
#   ③ 【差分语义】只有「安静绿 ∧ 并发红」的文件才算被拖红：先做差，再对差集里的文件
#      隔离复跑一次 —— 仍红 ⇒ 判红；复跑绿 ⇒ 记为偶发、打印、不计入；
#   ④ 服务端逐文件中位耗时 ≤ K × 安静基线（K 由首次实测钉死，见 K_RATIO）；
#   ⑤ 确实观测到并发重叠（否则判据不成立，fail-closed）。
# 任一条不成立 ⇒ 退出码 1，且判词【同一行】带出成因与实测读数。
#
# ── 为什么要差分（gap-concurrency-verdict-discriminates-flake-from-drag 的缺口形状）──
# 旧判词用一个退出码同时压住两个不同命题：
#   (A) 它命名的：**并发**把套件互相拖红；
#   (B) 它没命名、也管不了的：这台机器上服务端跑 194 次文件，一次都不许偶发失败。
# (B) 不是并发属性 —— 它在【单进程安静基线】里同样发生。2026-09-20T15:49:15Z 那次
# 判词自己写着 `套件 rc=[0 0] 读数 rc=[0 0] 并发重叠=9852ms`，红的只有单独跑的那份
# 安静基线（file-tree.routes.test.ts，`[TypeError: fetch failed]`，1200ms）；
# 而 `.quay/suite-concurrency-check/` 下 102 次实跑里，并发红 10 次、安静红 1 次，
# **两组的历史最大规模都是 1 个文件**，且每次红的文件都不同 —— 判据红的成因全部来自 (B)。
# 所以判词收回到它命名的不变量上：安静基线自己的红**只报告、不再单独致判据红**。
#
# ── 防洗白：确认步的三条前置上界 ─────────────────────────────────────────────
# 确认步（隔离复跑）本身会把「成批死亡」洗成一个个「偶发」，所以下列任一成立就
# 【跳过确认步直接判红】：
#   · 签名计数 ≠ 0（STACK_TRACE_ERROR / Timeout calling "fetch"）—— AC-103 命名的量；
#   · 劣化比 > K —— AC-103 命名的量；
#   · 差集规模 > DIFF_MAX（见下方实测依据）—— 成批死亡不会只打死一两个文件；
#   · 并发组非零退出却无法归因到文件（例如 typecheck 级失败，没有逐文件行可差分）。
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
# 取假形态（三条都在脚本内，都会以非零退出并打印实测到的那串读数）：
#   --concurrency 1   并发数降到 1 ⇒ 未发生并发 ⇒ ⑤ 不成立（确定性）
#   --k 1             劣化比必然 > K ⇒ 跳过确认步直接判红
#   --drop-pool-cap   AC-103 expect 点名的方向：把【并发组】的池上限去掉 —— client 池改回
#                     availableParallelism()，服务端阶段夹取一并去掉（实测劣化 4.94–5.17×
#                     > K=4）。只去掉 client 池已不足以取假：实测 80 个 client 测试文件、
#                     128 路时 80/80 全绿且比夹取时更快（6.71s vs ~7.5s），签名计数 0、
#                     服务端劣化 1.44× —— client 池上限的去掉在本形状上已不可观测，
#                     故取假形态取的是「这个形状赖以安全的上限」这个整体。
#
# --self-test：把差分判词做成由**合成读数**驱动的确定性自检（不跑并发、不依赖主机负载），
# 带正反控制并按标签打印每条控制的结果。⛔「零个拖红」正是惰性实现也能拿到的分数，
# 所以**必须判红**的那几条（C2/C4/C6/C7/C8）与必须判绿的（C1/C3/C5）放在**同一个 runner**里，
# 且真跑路径与自检走的是同一个 differential_verdict。
#
# 退出码：0 判据成立；1 判据不成立；2 用法错误。
# ─────────────────────────────────────────────────────────────────────────────
set -u

# 服务端逐文件中位耗时的上限倍数：并发组 / 安静基线。
# · 钉死依据（首次实测，2026-09-20，本机，见 tasks/gap-suite-concurrency-checker.md 完成记录）：
#   安静 1388ms → 并发(2 套件 ‖ 2 服务端 phase) 2777ms = 2.00×。
# · 本形状下的重测（2026-09-21，本机，同一形状，3 次）：上限齐备时 1.18 / 1.24 / 1.44×；
#   把【并发组】的上限去掉（--drop-pool-cap）后 4.94 / 4.98 / 5.17×（并发侧中位稳定在 ~4.24s，
#   安静侧 823–862ms）。K=4 落在噪声带之上、故障带之下：对噪声约 2.8× 余量，对故障态约 24% 余量。
# ⛔ 别拿 AC-103 origin 里那个 59× 当本形状的故障读数：那是「服务器阶段完全不夹取」的整轮
#   fan-in 形状（101 路同时跑、逐文件中位 46,758ms）测出来的；本判据自己能复现的故障读数
#   就是上面的 ~5×。
K_RATIO="${SCC_K_RATIO:-4}"

# 差集（安静绿 ∧ 并发红）规模上界。
# 实测依据（本仓 `.quay/suite-concurrency-check/` 下 102 次判据实跑，2026-09-20/21）：
#   · 并发红名单规模：92 次 0 个、10 次**恰好 1 个**（file-tree.routes / projects-session-filter
#     / commands / git-init.routes / model-config-write-path / profile-partial-update /
#     sessionFilterEditor / agent.routes / suite-watchdog …，每次红的文件都不同）；
#   · 安静红名单规模：101 次 0 个、1 次**恰好 1 个**（file-tree.routes）。
# 两组的历史最大值都是 1，故上界取 2 = 实测最大值的 2×。它描述的不是噪声上限，而是把
# 【成批死亡】挡在确认步之外：一次真正的并发雪崩同时打死的是几十个文件（见 AC-103 origin
# 记的 59× 劣化那一轮的 server_max_concurrent=101、中位 46,758ms），远在 2 之上 ——
# 所以「差集 > 上界」时跳过确认步直接判红，确认步不可能把成批死亡洗成一个个「偶发」。
DIFF_MAX="${SCC_DIFF_MAX:-2}"
# 上界的取值依据，随读数一起打进判词 —— 「不得凭感觉写」要求依据与值同行可见，
# 而不是只写在脚本的注释里（注释读者是维护者，判词读者是看这次判据为什么红/绿的人）。
DIFF_MAX_BASIS="${SCC_DIFF_MAX_BASIS:-102 次实跑两组红名单最大规模=1，上界=2×}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 2

SUITES=2
READOUTS=""
DROP_POOL_CAP=0
FULL_SUITES=0
TEST_CONCURRENCY=""
SELF_TEST=0

usage() {
  cat <<'USAGE'
usage: bash scripts/suite-concurrency-check.sh [options]

  --concurrency <n>        并发启动的套件份数（默认 2；取 1 = 取假形态，必须红）
  --readouts <n>           并发组里同时跑的「服务端逐文件读数」份数（默认 = --concurrency：
                           两份全量套件就各有一次服务端 phase，这里是同一过订阅形状）
  --drop-pool-cap          client 池改回 availableParallelism()（取假形态）
  --full-suites            并发组用完整 `scripts/test.sh`（≈2×55s，超出 60s gate 预算）
  --test-concurrency <n>   服务端逐文件并发度（默认 = availableParallelism()，与 fan-in 同形）
  --k <ratio>              中位耗时上限倍数（默认 4；取 1 = 取假形态，必须红）
  --diff-max <n>           差集规模上界（默认 2；超过即跳过确认步直接判红）
  --self-test              用合成读数跑差分判词的正反控制（不跑并发），按标签打印结果
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
    --diff-max)           DIFF_MAX="${2:-}"; shift 2 ;;
    --diff-max=*)         DIFF_MAX="${1#*=}"; shift ;;
    --self-test)          SELF_TEST=1; shift ;;
    -h|--help)            usage; exit 0 ;;
    *) echo "suite-concurrency-check: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$SUITES" in ''|*[!0-9]*|0) echo "suite-concurrency-check: --concurrency must be a positive integer, got '$SUITES'" >&2; exit 2 ;; esac
[ -n "$READOUTS" ] || READOUTS="$SUITES"
case "$READOUTS" in ''|*[!0-9]*) echo "suite-concurrency-check: --readouts must be a non-negative integer, got '$READOUTS'" >&2; exit 2 ;; esac
case "$K_RATIO" in ''|*[!0-9.]*) echo "suite-concurrency-check: --k must be a number, got '$K_RATIO'" >&2; exit 2 ;; esac
case "$DIFF_MAX" in ''|*[!0-9]*|0) echo "suite-concurrency-check: --diff-max must be a positive integer, got '$DIFF_MAX'" >&2; exit 2 ;; esac

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }
SCRIPT_START="$(now_ms)"

# ═════════════════════════════════════════════════════════════════════════════
# 判据核心：差分判定。真跑与 --self-test 走的是同一条 differential_verdict，
# 所以自检测的是判据本身，不是它的复制品。
# ═════════════════════════════════════════════════════════════════════════════

# red_labels <logfile...> — 抽出这些日志里【失败的文件标签】，去重排序。
# 只认三条结构化输出契约面（⛔ 不按错误文本匹配 —— 同一句话出现在多个文件里会被并成一个）：
#   ① `__PERFILE__ duration_ms=N <label> passed=false end_ms=N`（scripts/test.sh 的逐文件行）
#   ② `not ok - <label>: ...`（scripts/test.sh 的失败行）
#   ③ vitest 默认 reporter 的文件行 ` FAIL  <path>`
# ANSI 先剥掉：本环境 FORCE_COLOR 被设过，被重定向的日志仍可能带色码，色码会粘在标签上。
red_labels() {
  local f
  for f in "$@"; do
    [ -f "$f" ] || continue
    awk '
      /^__PERFILE__/ {
        prev = ""
        for (i = 1; i <= NF; i++) {
          if ($i == "passed=false") print prev
          if ($i !~ /^(duration_ms|passed|end_ms)=/) prev = $i
        }
      }' "$f"
    grep -o '^not ok - [^:]*' "$f" 2>/dev/null | sed 's/^not ok - //'
    grep -oE '^ *FAIL +[^ ]+' "$f" 2>/dev/null | sed 's/^ *FAIL *//'
  done | sed 's/\x1b\[[0-9;]*m//g' | grep . | sort -u
}

# join_commas <newline-list> — 印在同一行用；空列表印空串。
join_commas() {
  printf '%s\n' "${1:-}" | grep . | tr '\n' ',' | sed 's/,$//'
}

# diff_list_of — 差集 = 并发红 \ 安静红（安静绿 ∧ 并发红）。
diff_list_of() {
  local q c
  q="$(printf '%s\n' "${R_QUIET_RED:-}" | grep . | sort -u || true)"
  c="$(printf '%s\n' "${R_CONC_RED:-}" | grep . | sort -u || true)"
  comm -13 <(printf '%s\n' "$q") <(printf '%s\n' "$c") | grep . || true
}

# verdict_lists — 判词里那串读数。AC 要求【同一行】带出：并发红名单、安静红名单、
# 差集、确认步后幸存的红文件、签名计数、劣化比、判据自身墙钟（另有上界与它的取值依据）。
verdict_lists() {
  printf '并发红名单=[%s] 安静红名单=[%s]（安静 rc=%s）差集=[%s] 确认步=%s 幸存红=[%s] 偶发=[%s] 签名 STACK_TRACE_ERROR=%s Timeout_fetch=%s 服务端逐文件中位耗时 安静=%sms(n=%s) 并发=%sms(n=%s) 劣化比=%s K=%s 上界=%s(依据:%s) 墙钟=%sms/60000ms' \
    "$(join_commas "${R_CONC_RED:-}")" \
    "$(join_commas "${R_QUIET_RED:-}")" \
    "${R_QUIET_RC:-n/a}" \
    "$(join_commas "$(diff_list_of)")" \
    "${V_CONFIRM_NOTE:-未执行}" \
    "$(join_commas "${V_SURVIVORS:-}")" \
    "$(join_commas "${V_FLAKES:-}")" \
    "${R_SIG_STE:-0}" "${R_SIG_FETCH:-0}" \
    "${R_MEDIAN_QUIET:-n/a}" "${R_N_QUIET:-0}" \
    "${R_MEDIAN_CONC:-n/a}" "${R_N_CONC:-0}" \
    "${R_RATIO:-n/a}" "${R_K:-4}" "${R_DIFF_MAX:-2}" "${DIFF_MAX_BASIS}" "${R_WALL_MS:-n/a}"
}

# confirm_outcome <label> — 打印 red | green。这是【确认步】的唯一入口。
# 隔离复跑：单进程、不带 --test-concurrency 的过订阅，也不与任何东西并发。
# live 模式按标签形态选命令；自检模式（CONFIRM_MODE=synthetic）读合成表，不碰文件系统。
confirm_outcome() {
  local label="$1" log rc=0
  if [ "${CONFIRM_MODE:-live}" = "synthetic" ]; then
    if [ "${CONFIRM_SYNTH[$label]:-green}" = "red" ]; then printf 'red'; else printf 'green'; fi
    return 0
  fi
  log="$RUN_DIR/confirm-$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_').out"
  case "$label" in
    server/*) bash scripts/test.sh --test-concurrency=1 "$label" >"$log" 2>&1; rc=$? ;;
    src/*)    npx vitest run "$label" >"$log" 2>&1; rc=$? ;;
    # 归不到文件形态的标签（例如 suite-watchdog 的整轮判词）无法隔离复跑 ⇒ fail-closed 记仍红。
    *)        printf 'red'; return 0 ;;
  esac
  if [ "$rc" -eq 0 ]; then printf 'green'; else printf 'red'; fi
}

# differential_verdict — 判据的【唯一】判定路径。读 R_* 读数，打印一行判词，返回 0/1。
# 顺序刻意如此：三条上界先于确认步，任一成立就跳过确认步直接判红（防洗白）。
differential_verdict() {
  local diff_list n_diff
  diff_list="$(diff_list_of)"
  n_diff="$(printf '%s\n' "$diff_list" | grep -c . || true)"

  local short_reason=""
  if [ "${R_SIG_STE:-0}" -ne 0 ] || [ "${R_SIG_FETCH:-0}" -ne 0 ]; then
    short_reason="并发下出现 worker 死亡签名（STACK_TRACE_ERROR=${R_SIG_STE:-0} Timeout calling \"fetch\"=${R_SIG_FETCH:-0}）"
  elif [ "${R_RATIO:-n/a}" = "n/a" ]; then
    short_reason="中位耗时比值不可算（ratio=n/a），无法排除拖慢"
  elif awk -v r="${R_RATIO}" -v k="${R_K:-4}" 'BEGIN { exit !(r > k) }'; then
    short_reason="并发劣化超限（${R_RATIO}× > K=${R_K}）"
  elif [ -n "${R_UNATTR:-}" ]; then
    short_reason="并发组非零退出但无法归因到文件：${R_UNATTR# }"
  elif [ "$n_diff" -gt "${R_DIFF_MAX:-2}" ]; then
    short_reason="差集规模 $n_diff > 上界 ${R_DIFF_MAX}（成批死亡，不交确认步）"
  fi

  V_CONFIRM_NOTE=""; V_SURVIVORS=""; V_FLAKES=""
  if [ -n "$short_reason" ]; then
    V_CONFIRM_NOTE="跳过（防洗白：$short_reason）"
    V_SURVIVORS="$diff_list"
  else
    local lab outcome
    while IFS= read -r lab; do
      [ -n "$lab" ] || continue
      outcome="$(confirm_outcome "$lab")"
      if [ "$outcome" = "red" ]; then V_SURVIVORS="$V_SURVIVORS$lab"$'\n'
      else V_FLAKES="$V_FLAKES$lab"$'\n'; fi
    done <<< "$diff_list"
    V_CONFIRM_NOTE="隔离复跑 $n_diff 个差集文件（单进程）"
  fi

  local n_surv n_flake headline
  n_surv="$(printf '%s\n' "$V_SURVIVORS" | grep -c . || true)"
  n_flake="$(printf '%s\n' "$V_FLAKES" | grep -c . || true)"

  if [ -n "$short_reason" ]; then
    headline="FAIL — $short_reason"
  elif [ "$n_surv" -gt 0 ]; then
    headline="FAIL — 差集里有 $n_surv 个文件在隔离复跑中【仍红】，并发把它们拖红"
  else
    headline="PASS — 差集 $n_diff 个文件无一在隔离复跑中复现（偶发 $n_flake 个，已打印、不计入）"
  fi

  printf 'suite-concurrency-check: %s ｜ %s\n' "$headline" "$(verdict_lists)"
  if [ -n "$short_reason" ] || [ "$n_surv" -gt 0 ]; then return 1; fi
  return 0
}

# fail_closed <reason> — 判据不可判（量不到并发 / 量不到逐文件行）时用。fail-closed：不成立。
fail_closed() {
  printf 'suite-concurrency-check: FAIL — %s（fail-closed，判据不可判）｜ %s\n' "$1" "$(verdict_lists)"
  exit 1
}

# ── --self-test 的合成读数控制 ────────────────────────────────────────────────
# readings <quiet_reds> <conc_reds> <ste> <fetch> <ratio> <k> <diff_max> <unattr> <quiet_rc>
readings() {
  R_QUIET_RED="$1"; R_CONC_RED="$2"; R_SIG_STE="$3"; R_SIG_FETCH="$4"
  R_RATIO="$5"; R_K="$6"; R_DIFF_MAX="$7"; R_UNATTR="$8"; R_QUIET_RC="${9:-0}"
  R_WALL_MS="self-test"
}

# 确认步的合成结果表（--self-test 用）。必须是关联数组：标签是文件路径，不是下标。
declare -A CONFIRM_SYNTH=()

ST_TOTAL=0
ST_PASS=0
ST_FAILED=()

# self_control <label> <expect green|red> [needle1] [needle2]
# 跑【真】的 differential_verdict，按标签打印结果；失败时指明是哪一条控制、为什么。
self_control() {
  local label="$1" expect="$2" needle1="${3:-}" needle2="${4:-}"
  local out rc got ok=1 why=""
  out="$(differential_verdict)"; rc=$?
  if [ "$rc" -eq 0 ]; then got="绿"; else got="红"; fi
  if [ "$expect" = "green" ]; then
    [ "$rc" -eq 0 ] || { ok=0; why="预期 绿，实得 红"; }
  else
    [ "$rc" -ne 0 ] || { ok=0; why="预期 红，实得 绿"; }
  fi
  if [ "$ok" = 1 ] && [ -n "$needle1" ]; then
    case "$out" in *"$needle1"*) ;; *) ok=0; why="判词里没有控制点名的片段：'$needle1'";; esac
  fi
  if [ "$ok" = 1 ] && [ -n "$needle2" ]; then
    case "$out" in *"$needle2"*) ;; *) ok=0; why="判词里没有控制点名的片段：'$needle2'";; esac
  fi
  ST_TOTAL=$(( ST_TOTAL + 1 ))
  if [ "$ok" = 1 ]; then
    ST_PASS=$(( ST_PASS + 1 ))
    printf 'suite-concurrency-check: self-test [%s] PASS — 预期 %s，实得 %s\n' "$label" "$expect" "$got"
  else
    ST_FAILED+=("$label")
    printf 'suite-concurrency-check: self-test [%s] FAIL — %s ｜ 判词：%s\n' "$label" "$why" "$out"
  fi
}

run_self_test() {
  CONFIRM_MODE="synthetic"
  echo "suite-concurrency-check: self-test — 合成读数驱动差分判词（不跑并发、不依赖主机负载）"

  # ① 安静红 = 并发红 ⇒ 差集为空 ⇒ 绿（同一个文件两边都红，不是并发造成的）
  readings 'server/a.test.ts' 'server/a.test.ts' 0 0 1.20 4 2 '' 0
  self_control "C1 安静红=并发红 ⇒ 绿" green

  # ② 安静绿 ∧ 并发红 ∧ 复跑红 ⇒ 红（这正是被拖红的形状）
  CONFIRM_SYNTH=(); CONFIRM_SYNTH[server/x.test.ts]=red
  readings '' 'server/x.test.ts' 0 0 1.50 4 2 '' 0
  self_control "C2 安静绿∧并发红∧复跑红 ⇒ 红" red '幸存红=[server/x.test.ts]'

  # ③ 安静绿 ∧ 并发红 ∧ 复跑绿 ∧ 差集 ≤ 上界 ⇒ 绿且打印偶发
  CONFIRM_SYNTH=(); CONFIRM_SYNTH[server/y.test.ts]=green
  readings '' 'server/y.test.ts' 0 0 1.50 4 2 '' 0
  self_control "C3 安静绿∧并发红∧复跑绿∧差集≤上界 ⇒ 绿且打印偶发" green '偶发=[server/y.test.ts]'

  # ④ 取假形态：并发红成批（> 上界）⇒ 红，且不因复跑绿而洗白（确认步根本没跑）
  CONFIRM_SYNTH=()
  local i
  for i in 1 2 3 4 5 6; do CONFIRM_SYNTH["server/batch$i.test.ts"]=green; done
  readings '' $'server/batch1.test.ts\nserver/batch2.test.ts\nserver/batch3.test.ts\nserver/batch4.test.ts\nserver/batch5.test.ts\nserver/batch6.test.ts' 0 0 1.50 4 2 '' 0
  self_control "C4 取假：并发红成批(>上界) ⇒ 红且复跑绿洗不白" red '差集规模 6 > 上界 2' '上界=2(依据:'

  # ⑤ 2026-09-20T15:49:15Z 那次读数形状：安静 1 红、并发全绿 ⇒ 绿，且判词带出那个安静红文件
  #    （安静基线自己的红只报告，不再单独致判据红 —— 这就是本任务修掉的那个误判）
  readings 'server/modules/file-tree/tests/file-tree.routes.test.ts' '' 0 0 2.08 4 2 '' 1
  self_control "C5 安静 1 红∧并发全绿 ⇒ 绿且带出安静红文件" green \
    '安静红名单=[server/modules/file-tree/tests/file-tree.routes.test.ts]' '幸存红=[]'

  # ⑥ 签名计数 ≠ 0 ⇒ 跳过确认步直接判红（差集为空也必须红）
  CONFIRM_SYNTH=()
  readings '' '' 3 0 1.10 4 2 '' 0
  self_control "C6 签名≠0 ⇒ 跳过确认步直接红" red '确认步=跳过'

  # ⑦ 劣化比 > K ⇒ 跳过确认步直接判红
  readings '' '' 0 0 59.00 4 2 '' 0
  self_control "C7 劣化比>K ⇒ 跳过确认步直接红" red '确认步=跳过'

  # ⑧ 并发组非零退出却无法归因到文件 ⇒ 跳过确认步直接红
  readings '' '' 0 0 1.10 4 2 ' concurrent-suite-0.out(rc=1)' 0
  self_control "C8 并发非零退出无法归因 ⇒ 跳过确认步直接红" red '确认步=跳过'

  local verdict
  if [ ${#ST_FAILED[@]} -eq 0 ]; then verdict="PASS"; else verdict="FAIL"; fi
  printf 'suite-concurrency-check: self-test: %s — controls=%s/%s\n' "$verdict" "$ST_PASS" "$ST_TOTAL"
  if [ ${#ST_FAILED[@]} -gt 0 ]; then
    printf 'suite-concurrency-check: self-test: FAIL — 失败的控制：%s\n' "${ST_FAILED[*]}"
    return 1
  fi
  return 0
}

if [ "$SELF_TEST" = "1" ]; then
  run_self_test
  exit $?
fi

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
# 并发组读数命令的额外环境（默认空）。只有 --drop-pool-cap 才非空。
CONC_READOUT_ENV=()
if [ "$DROP_POOL_CAP" = "1" ]; then
  # AC-103 取假形态点名的方向：把 client 池改回 availableParallelism()。
  # 用 CLI 覆盖而不是改 vitest.config.ts —— 不改工作树、无需还原。
  CLIENT_CMD+=(--maxWorkers="$TEST_CONCURRENCY")
  # 判据的【并发形状】靠两个上限才安全：client 池（vitest maxWorkers=8）与
  # 服务端阶段夹取（QUAY_TEST_CONCURRENCY_CEILING=16，见 scripts/test.sh）。
  # 取假形态问的是「把这个形状的上限去掉之后，判据还认不认得那个故障态」，所以
  # 两个上限都要去掉 —— 只去掉一个、另一个仍夹着，测到的就不是「去掉上限」。
  # ⛔ 只去掉【并发组】那一侧：安静基线一旦也放开，它就不再是基线。
  # 实测（2026-09-21 本机）：两侧都放开时劣化比只有 2.90×（上限把安静基线一起抬了，
  # 恰好把故障态抹平），而安静基线保持夹取时故障态才重新可见 —— 这与 AC-103 origin
  # 的读数形状一致（安静态 N=100 中位 1,399ms vs 并发 101 路时中位 46,758ms = 33×）。
  CONC_READOUT_ENV=(QUAY_TEST_CONCURRENCY_CEILING="$TEST_CONCURRENCY")
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
# 读数命令额外带 $READOUT_ENV（只在并发组非空，见 --drop-pool-cap）。
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
        s=$(now_ms); env ${READOUT_ENV[@]+"${READOUT_ENV[@]}"} "${READOUT_CMD[@]}" >"$RUN_DIR/$group-readout-$i.out" 2>&1; rc=$?
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
  echo "suite-concurrency-check: suites=$SUITES readouts=$READOUTS suite_cmd=${SUITE_CMD[*]} ｜ readout_cmd=bash scripts/test.sh --test-concurrency=$TEST_CONCURRENCY <${#SERVER_FILES[@]} server files> ｜ k=$K_RATIO diff_max=$DIFF_MAX"
else
  echo "suite-concurrency-check: suites=$SUITES suite_cmd=${SUITE_CMD[*]}（--full-suites：中位耗时由套件自身提供）｜ k=$K_RATIO diff_max=$DIFF_MAX"
fi
echo "suite-concurrency-check: host cores=$(nproc 2>/dev/null || echo '?') load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '?') logs=$RUN_DIR"

# ── 第 1 组：安静基线（只有一份读数命令在跑；--full-suites 时是一份完整套件）───
# READOUT_ENV 在这里恒为空：安静基线必须是最干净的参照，取假形态也只放开并发组。
echo "suite-concurrency-check: [quiet] $([ ${#READOUT_CMD[@]} -gt 0 ] && echo 'server-phase only' || echo 'one full suite')"
READOUT_ENV=()
run_group quiet "$([ ${#READOUT_CMD[@]} -gt 0 ] && echo 0 || echo 1)" "$([ ${#READOUT_CMD[@]} -gt 0 ] && echo 1 || echo 0)"
QUIET_START=$GROUP_START; QUIET_END=$GROUP_END

# ── 第 2 组：并发组（N 份套件 + R 份服务端读数同时起跑）─────────────────────
echo "suite-concurrency-check: [concurrent] $SUITES × ${SUITE_CMD[*]}$([ ${#READOUT_CMD[@]} -gt 0 ] && echo "  ‖ $READOUTS × server-phase(readout)")${CONC_READOUT_ENV[*]+ ｜ readout_env=${CONC_READOUT_ENV[*]}}"
READOUT_ENV=("${CONC_READOUT_ENV[@]}")
run_group concurrent "$SUITES" "$READOUTS"
READOUT_ENV=()
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
# 读数命令就是「全量套件的服务端 phase」：它的退出码也是套件退出码的一部分。
for ((i = 0; i < READOUTS; i++)); do
  meta="$RUN_DIR/concurrent-readout-$i.meta"
  if [ -s "$meta" ]; then read -r rc _s _e <"$meta"; readout_rc="$readout_rc $rc"; fi
done
if [ -n "$first_end" ] && [ -n "$last_start" ]; then overlap_ms=$(( first_end - last_start )); fi

ratio="n/a"
if [ -n "$median_quiet" ] && [ -n "$median_conc" ] && [ "$median_quiet" -gt 0 ]; then
  ratio="$(awk -v a="$median_conc" -v b="$median_quiet" 'BEGIN { printf "%.2f", a / b }')"
fi

# ── 差分读数：红名单 / 签名 / 比值 / 未归因的并发非零退出 / 墙钟 ─────────────
R_CONC_RED="$(red_labels "${conc_logs[@]}")"
R_QUIET_RED="$(red_labels "${quiet_logs[@]}")"

quiet_rc=""
if [ -s "$RUN_DIR/quiet-readout-0.meta" ]; then read -r quiet_rc _s _e <"$RUN_DIR/quiet-readout-0.meta"; fi
[ -z "$quiet_rc" ] && [ -s "$RUN_DIR/quiet-suite-0.meta" ] && read -r quiet_rc _s _e <"$RUN_DIR/quiet-suite-0.meta"

# 并发组的每一份：rc ≠ 0 却在日志里找不到任何失败文件标签 ⇒ 无法差分 ⇒ 防洗白（直接判红）。
# 安静组不参与这条：安静基线自己的红只报告（差分语义）。
conc_rc_pairs=()
for ((i = 0; i < SUITES; i++)); do
  meta="$RUN_DIR/concurrent-suite-$i.meta"
  [ -s "$meta" ] && { read -r rc _s _e <"$meta"; conc_rc_pairs+=("$RUN_DIR/concurrent-suite-$i.out:$rc"); }
done
for ((i = 0; i < READOUTS; i++)); do
  meta="$RUN_DIR/concurrent-readout-$i.meta"
  [ -s "$meta" ] && { read -r rc _s _e <"$meta"; conc_rc_pairs+=("$RUN_DIR/concurrent-readout-$i.out:$rc"); }
done
unattr=""
for pair in "${conc_rc_pairs[@]+"${conc_rc_pairs[@]}"}"; do
  plog="${pair%:*}"; prc="${pair##*:}"
  [ "$prc" = "0" ] && continue
  [ -n "$(red_labels "$plog")" ] && continue
  unattr="$unattr $(basename "$plog")(rc=$prc)"
done

R_SIG_STE="$sig_ste"; R_SIG_FETCH="$sig_fetch"
R_MEDIAN_QUIET="${median_quiet:-n/a}"; R_N_QUIET="$n_quiet"
R_MEDIAN_CONC="${median_conc:-n/a}"; R_N_CONC="$n_conc"
R_RATIO="$ratio"; R_K="$K_RATIO"; R_DIFF_MAX="$DIFF_MAX"; R_UNATTR="$unattr"
R_QUIET_RC="${quiet_rc:-n/a}"
R_WALL_MS=$(( $(now_ms) - SCRIPT_START ))
V_CONFIRM_NOTE=""; V_SURVIVORS=""; V_FLAKES=""

echo "suite-concurrency-check: 读数 套件 rc=[${runs_rc# }] 读数 rc=[${readout_rc# }] 并发重叠=${overlap_ms:-n/a}ms 并发窗口=$(( CONC_END - CONC_START ))ms 安静窗口=$(( QUIET_END - QUIET_START ))ms"

# ── 前置：fail-closed（不能让「量不到」被当成「没问题」）───────────────────────
if [ "$SUITES" -lt 2 ]; then
  fail_closed "并发数 $SUITES < 2：未观测到并发重叠，\"两个套件互不拖红\" 不可判"
fi
if [ -z "$overlap_ms" ] || [ "$overlap_ms" -le 0 ]; then
  fail_closed "未观测到并发重叠（套件没有同时在跑，first_end=${first_end:-n/a} last_start=${last_start:-n/a}）"
fi
if [ "$n_quiet" = "0" ] || [ "$n_conc" = "0" ]; then
  fail_closed "未解析到服务端逐文件行（安静 $n_quiet 条 / 并发 $n_conc 条），中位耗时不可比"
fi

# ── 判定：差分判词（与 --self-test 走同一个 differential_verdict）─────────────
differential_verdict
exit $?
