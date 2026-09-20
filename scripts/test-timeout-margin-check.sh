#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/test-timeout-margin-check.sh — 「冷编译不得挤进用例预算」的确定性判据
# （tasks/gap-resetmodules-cold-compile-timeout.md；AC-103 条件①的根因读数）
#
# 机制（两个因素相乘，缺一不成）：
#   1. `vi.resetModules()` 让模块注册表每个用例失效，而某个 helper 在**用例体内**用
#      `await import(...)` 重新求值整张 hook 依赖图（React + testing-library + 该模块
#      的全部依赖）。Vite 的**编译产物**缓存不随 resetModules 失效，所以整张图的
#      **冷编译**由该文件的**第一个用例**一次性付掉：本机实测 projectsStateSelectionSync
#      首用例 2812–3637ms，其余用例 130–165ms —— 这正是「同文件首用例 3.6s、其余 150ms」
#      的唯一解释。
#   2. `vitest.config.ts` 原先不声明 `testTimeout` ⇒ 吃 vitest 默认 5000ms。
#      2842 / 5000 ⇒ 余量只剩 43%（proposal 记的 3637/5000 只剩 27%）。任何 CPU 争抢
#      都足以把这次冷编译推过线 —— AC-103 的条件①（两份套件 rc 均为 0）15 次实测红 1–2 次，
#      红的就是这条，而不是签名崩溃（红时 STACK_TRACE_ERROR=0、Timeout calling "fetch"=0）。
#
# 判据形态：**余量**，不是红绿。
#   对族内每个文件**单独**跑一次（串行、一次一个），解析最慢用例耗时 T_max，与该文件
#   适用的 testTimeout 预算 B 比较，要求
#       T_max ≤ B / K
#   为什么必须是这样：既有判据（suite-concurrency-check.sh）只有在负载下才红、且只红
#   1/7，改完也无法证明改对了。而余量读数是**确定性**的（不依赖机器是否繁忙），并且
#   改前**必红**（本机实测 2842 / 5000 = 0.568 > 1/4 = 0.25）—— 先观测到红，再动手修。
#
# B 的来源：**从 vitest.config.ts 里显式声明的 testTimeout 读**（本任务 AC3 同时要求该
# 配置显式化），并且把「这个 B 是哪来的」原样打进判词（`B=5000ms(vitest.config.ts 显式
# testTimeout)`）。这样「把 B 抬上去」就不再是一条静默的逃逸路径：抬 B 会出现在判词里。
#
# 为什么 config 里没声明时**不** fail-closed，而是用一个**标注过的**默认值继续判：
# 本判据的职责是在**改之前**就把红观测出来（AC1 要求「当前树上非零退出，且同一行打印
# 最差文件的 T_max / B / 比值 / 1/K」）。而改之前这棵树恰恰就是「config 里没有
# testTimeout」的状态 —— 那时 fail-closed 会让脚本连一行余量读数都给不出，判据就退化成
# 「配置没写」这一件事，而不是它要量的那件事。所以：缺声明 ⇒ 用 vitest 官方默认并**在
# 判词里标注来源**（不是隐式假定）；只有「config 不可读」或「声明了多个不同的值」这种
# 语义不明的状态才 fail-closed。
DEFAULT_TEST_TIMEOUT_MS=5000   # vitest 未声明 testTimeout 时的官方默认（v1 起至今）
#
# 族（family）的判定：`src/**/*.test.ts(x)` 里**同时**含 `resetModules` 与动态
# `import(` 的文件 —— 两个条件都是机制的必要条件（不 reset 注册表就没有冷求值；没有
# 用例内动态 import 就没有人付这笔编译）。由 grep 派生而非硬编码清单，所以新增的同族
# 文件会自动纳入判据。
#
# K 的取值（K_DEFAULT）：由实测的 T_max 分布钉死，见 K_DEFAULT 处注释。
#
# 退出码：0 余量达标；1 余量不足 / 读数不可得（fail-closed）；2 用法错误。
# ─────────────────────────────────────────────────────────────────────────────
set -u

# 上限倍数 K：要求 T_max ≤ B / K。
# 实测分布（2026-09-20，本机，安静，逐文件单独跑，**改前**树，B = 5000ms，13 个族内文件）：
# 两个互不重叠的簇 ——
#   付冷编译的 3 个文件（projectsInitialFetch / projectsStateSelectionSync /
#   projectsStateSessionAlias）T_max = 2717–2955ms，比值 0.543–0.603；
#   其余 10 个文件 T_max ≤ 155ms，比值 ≤ 0.031。
# 修好之后那 3 个文件落到与其余文件同簇（141–276ms，比值 0.028–0.055）。
# 取 K=4 ⇒ 阈值 1250ms：落在两簇之间的空档里（上簇 2781ms 的 45%、下簇 276ms 的 4.5×），
# 对故障态留 2.2× 判别余量，对正常态留 4.5× 余量。与姊妹脚本
# scripts/suite-concurrency-check.sh 的 K_RATIO=4 同值（同一条纪律：分布数据出来之前不设阈值）。
K_DEFAULT="${TFMC_K:-4}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 2

K_RATIO="$K_DEFAULT"
LIST_ONLY=0
EXTRA_FILES=()
# 单文件墙钟上限：只用来把「挂死」变成结构性事实（GNU timeout 退出 124）而不是静默超时。
FILE_TIMEOUT_SECS="${TFMC_FILE_TIMEOUT:-180}"

usage() {
  cat <<'USAGE'
usage: bash scripts/test-timeout-margin-check.sh [options]

  无参运行 = 判据形态：串行逐个跑族内文件，断言每个文件的 T_max ≤ B / K。

  --k <ratio>        上限倍数 K（默认 4；**越大越严**：阈值是 B/K）
  --list             只打印派生出的族内文件清单后退出（不跑任何套件）
  --file <path>      追加一个额外被测文件（仍按同一阈值判），可重复
  -h, --help         本帮助

环境变量：TFMC_K（= --k）、TFMC_FILE_TIMEOUT（单文件墙钟上限秒，默认 180）
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --k)            K_RATIO="${2:-}"; shift 2 ;;
    --k=*)          K_RATIO="${1#*=}"; shift ;;
    --list)         LIST_ONLY=1; shift ;;
    --file)         EXTRA_FILES+=("${2:-}"); shift 2 ;;
    --file=*)       EXTRA_FILES+=("${1#*=}"); shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "test-timeout-margin-check: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$K_RATIO" in ''|*[!0-9.]*) echo "test-timeout-margin-check: --k must be a number, got '$K_RATIO'" >&2; exit 2 ;; esac
# 0/负数 K 会让阈值失真（1/K 无意义或反向），显式拒掉。
if ! awk -v k="$K_RATIO" 'BEGIN { exit !(k > 0) }'; then
  echo "test-timeout-margin-check: --k must be > 0, got '$K_RATIO'" >&2; exit 2
fi
case "$FILE_TIMEOUT_SECS" in ''|*[!0-9]*|0) FILE_TIMEOUT_SECS=180 ;; esac

TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1 && timeout --version 2>&1 | grep -qi gnu; then
  TIMEOUT_BIN="$(command -v timeout)"
fi

# ── 预算 B：只认 vitest.config.ts 里**显式声明**的 testTimeout ───────────────
# 行首（允许缩进）就是 `testTimeout:` 才算；注释里的提及（`// testTimeout: …`）匹配不上。
# -> stdout: "<B>\t<来源说明>"；config 不可读 / 声明了多个不同的值 ⇒ 返回非零（语义不明）。
read_budget() {
  local cfg="$ROOT_DIR/vitest.config.ts" vals n
  [ -f "$cfg" ] || return 1
  vals="$(grep -E '^[[:space:]]*testTimeout[[:space:]]*:' "$cfg" 2>/dev/null \
    | sed -E 's/.*testTimeout[[:space:]]*:[[:space:]]*([0-9]+).*/\1/' \
    | grep -E '^[0-9]+$' | sort -u)"
  n="$(printf '%s\n' "$vals" | grep -c . || true)"
  case "$n" in
    # 末尾必须带换行：`read` 在 EOF 且缺定界符时返回非零，会把已经读到的值当成失败丢掉。
    1) printf '%s\t%s\n' "$vals" "vitest.config.ts 显式 testTimeout" ;;
    0) printf '%s\t%s\n' "$DEFAULT_TEST_TIMEOUT_MS" "vitest 默认值（vitest.config.ts 未声明 testTimeout）" ;;
    *) return 1 ;;   # 多个不同的声明值：哪个是预算，脚本无从判断
  esac
}

budget_line="$(read_budget)"
BUDGET="$(printf '%s' "$budget_line" | cut -f1)"
budget_src="$(printf '%s' "$budget_line" | cut -f2)"
if [ "$LIST_ONLY" != "1" ] && [ -z "$BUDGET" ]; then
  printf 'test-timeout-margin-check: FAIL — vitest.config.ts 里的 testTimeout 语义不明（不可读，或声明了多个不同的值）⇒ B 不可得 ⇒ 判据不可判（fail-closed）\n'
  exit 1
fi

# hookTimeout 只**报告**，不参与判定：它是 beforeAll 预热那笔冷编译所在的预算（见
# vitest.config.ts 的注释）。把它打出来是为了让「预热那笔账」可见 —— 本判据量的是**用例**
# 余量（确定性），而 file_ms 与 hookTimeout 的关系是负载敏感的，不能拿来做阈值。
read_hook_timeout() {
  local cfg="$ROOT_DIR/vitest.config.ts" v
  [ -f "$cfg" ] || return 0
  v="$(grep -E '^[[:space:]]*hookTimeout[[:space:]]*:' "$cfg" 2>/dev/null \
    | sed -E 's/.*hookTimeout[[:space:]]*:[[:space:]]*([0-9]+).*/\1/' \
    | grep -E '^[0-9]+$' | sort -u | head -1)"
  printf '%s' "${v:-未声明}"
}
HOOK_TIMEOUT="$(read_hook_timeout)"

# ── 族：resetModules 与用例内动态 import 同时出现 ────────────────────────────
FAMILY=()
while IFS= read -r f; do
  [ -f "$f" ] || continue
  grep -qE 'vi\.[[:space:]]*resetModules|resetModules\(' "$f" || continue
  grep -qE '(await[[:space:]]+)?import[[:space:]]*\(' "$f" || continue
  FAMILY+=("$f")
done < <(find src \( -name '*.test.ts' -o -name '*.test.tsx' \) ! -path '*/node_modules/*' 2>/dev/null | sort)
for f in "${EXTRA_FILES[@]+"${EXTRA_FILES[@]}"}"; do
  [ -n "$f" ] && FAMILY+=("$f")
done

if [ ${#FAMILY[@]} -eq 0 ]; then
  printf 'test-timeout-margin-check: FAIL — 派生出的族为空（判据没看任何东西；fail-closed）\n'
  exit 1
fi

if [ "$LIST_ONLY" = "1" ]; then
  for f in "${FAMILY[@]}"; do echo "$f"; done
  exit 0
fi

LOG_DIR="${TFMC_LOG_DIR:-$ROOT_DIR/.quay/test-timeout-margin-check}"
RUN_DIR="$LOG_DIR/$(date +%Y%m%dT%H%M%S)-$$"
mkdir -p "$RUN_DIR" || { echo "test-timeout-margin-check: FAIL — cannot create log dir $RUN_DIR" >&2; exit 1; }

threshold="$(awk -v k="$K_RATIO" 'BEGIN { printf "%.3f", 1 / k }')"

echo "test-timeout-margin-check: root=$ROOT_DIR"
echo "test-timeout-margin-check: family=${#FAMILY[@]} files ｜ B=${BUDGET}ms（来源：${budget_src}）｜ K=$K_RATIO ⇒ 阈值 1/K=$threshold ｜ 串行逐个跑 ｜ logs=$RUN_DIR"
echo "test-timeout-margin-check: hookTimeout=${HOOK_TIMEOUT}ms（仅报告：预热那笔冷编译的预算，见下 file_ms；本判据只判用例余量）"
echo "test-timeout-margin-check: host cores=$(nproc 2>/dev/null || echo '?') load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '?')"

# worst_* 记「比值最大的那个文件」——红蓝两条分支都用它出判词。
worst_file=""; worst_tmax=""; worst_ratio=""; worst_note=""
n_ok=0; n_bad=0; bad_rows=""

slug() { printf '%s' "$1" | tr '/' '_'; }

for f in "${FAMILY[@]}"; do
  json="$RUN_DIR/$(slug "$f").json"
  log="$RUN_DIR/$(slug "$f").out"
  rc=0
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" --signal=TERM --kill-after=10 "$FILE_TIMEOUT_SECS" \
      npx vitest run "$f" --reporter=json --outputFile="$json" >"$log" 2>&1 || rc=$?
  else
    npx vitest run "$f" --reporter=json --outputFile="$json" >"$log" 2>&1 || rc=$?
  fi

  # T_max = 该文件最慢**用例**的耗时；同时取到用例数与失败数。
  # 读不到 JSON（跑挂 / 被 timeout 杀掉 / reporter 通道断了）⇒ 读数不可得 ⇒ fail-closed。
  # ⛔ 必须 IFS=$'\t'：node 那侧是制表符分隔，而用例名里带空格 —— 用默认 IFS 会把标题
  # 切成好几段、把后面的字段整体错位（错位出来的 nfailed 是文字，判据会静默失灵）。
  row=""
  row="$(node -e '
    const fs = require("fs");
    try {
      const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      let max = 0, title = "(none)", failed = 0, n = 0, fileMs = 0;
      for (const t of r.testResults || []) {
        fileMs = Math.max(fileMs, Math.round(t.endTime - t.startTime));
        for (const a of t.assertionResults || []) {
          n += 1;
          if (a.status === "failed") failed += 1;
          if (a.duration > max) { max = a.duration; title = a.title; }
        }
      }
      process.stdout.write([Math.round(max), String(title).replace(/\s+/g, " ").slice(0, 58), failed, n, fileMs].join("\t"));
    } catch (e) { process.exit(1); }
  ' "$json" 2>/dev/null)" || row=""
  tmax="" title="" nfailed="" ntests="" fl_ms=""
  [ -n "$row" ] && IFS=$'\t' read -r tmax title nfailed ntests fl_ms <<<"$row"

  if [ -z "${tmax:-}" ]; then
    n_bad=$(( n_bad + 1 ))
    bad_rows="$bad_rows
test-timeout-margin-check: file=$f status=UNREADABLE rc=$rc T_max=n/a（JSON 报告缺失 ⇒ 无从判余量；日志 $log）"
    # 「量不到」比「量到超标」更坏：判词必须指向它而不是某个有数字的文件。
    worst_file="$f"; worst_tmax="n/a"; worst_ratio="n/a"; worst_note="UNREADABLE(rc=$rc)"
    continue
  fi

  ratio="$(awk -v t="$tmax" -v b="$BUDGET" 'BEGIN { printf "%.3f", t / b }')"
  over=0
  awk -v t="$tmax" -v b="$BUDGET" -v k="$K_RATIO" 'BEGIN { exit !(t > b / k) }' && over=1

  status="ok"
  [ "$over" = "1" ] && status="OVER-BUDGET"
  [ "$rc" != "0" ] && status="$status,rc=$rc"
  [ "$nfailed" != "0" ] && status="$status,failed=$nfailed"

  echo "test-timeout-margin-check: file=$f T_max=${tmax}ms(${title}) B=${BUDGET}ms 比值=$ratio 1/K=$threshold tests=$ntests file_ms=$fl_ms status=$status"
  echo "$f	$tmax	$ratio	$title	$ntests	$status" >>"$RUN_DIR/rows.tsv"

  # worst 判定：数字大的赢，但 UNREADABLE（比值 n/a）永远不被数字覆盖。
  if [ -z "$worst_file" ]; then
    worst_file="$f"; worst_tmax="$tmax"; worst_ratio="$ratio"; worst_note="$title"
  elif [ "$worst_ratio" = "n/a" ]; then
    : # 已经指向一个「量不到」的文件，不覆盖
  elif awk -v a="$ratio" -v b="$worst_ratio" 'BEGIN { exit !(a > b) }'; then
    worst_file="$f"; worst_tmax="$tmax"; worst_ratio="$ratio"; worst_note="$title"
  fi

  if [ "$over" = "1" ] || [ "$rc" != "0" ] || [ "$nfailed" != "0" ]; then
    n_bad=$(( n_bad + 1 ))
    bad_rows="$bad_rows
test-timeout-margin-check: file=$f status=$status T_max=${tmax}ms(${title}) B=${BUDGET}ms 比值=$ratio 阈值 1/K=$threshold → 冷编译还留在用例预算里（日志 $log）"
  else
    n_ok=$(( n_ok + 1 ))
  fi
done

# 判词：所有分支都**同一行**带出「族内最差文件 / T_max / B / 比值 / 阈值 1/K」。
verdict_readout="worst=${worst_file:-n/a} T_max=${worst_tmax:-n/a}ms B=${BUDGET:-n/a}ms(来源：${budget_src:-n/a}) 比值=${worst_ratio:-n/a} 阈值 1/K=$threshold (K=$K_RATIO)"
[ -n "$worst_note" ] && verdict_readout="$verdict_readout 最慢用例='$worst_note'"

printf '%s' "$bad_rows"
if [ "$n_bad" -gt 0 ]; then
  printf 'test-timeout-margin-check: FAIL — 族内 %s/%s 个文件余量不足或读数不可得（要求每个文件 T_max ≤ B/K）｜ %s\n' \
    "$n_bad" "${#FAMILY[@]}" "$verdict_readout"
  exit 1
fi

printf 'test-timeout-margin-check: PASS — 族内 %s 个文件全部 T_max ≤ B/K（最差比值 %s），冷编译不在任何用例的 testTimeout 预算内 ｜ %s\n' \
  "$n_ok" "$worst_ratio" "$verdict_readout"
exit 0
