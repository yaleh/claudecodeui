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
# ── 自身墙钟预算：跑不完时「自报」而不是被击杀成假红（gap-suite-criterion-wallclock-budget）──
# 本判据形状的**地板** = 2 × 最重的服务端文件：它把整张服务端套件跑**两遍**（安静一遍 + 并发
# 一遍），而两遍的地板是同一个文件。2026-09-23 本机实测该文件
# server/modules/debug-agent/tests/debug-agent-external-write.test.ts = **32,730ms**（安静相）/
# 32.6s（并发相）⇒ 两次实跑墙钟 66s / 67s，而 goal 判据 gate 是 runAcceptance({ timeoutMs: 6e4 })。
# 超出后被 SIGKILL，账本记成 verdict=fail、理由「超时」—— 与判据要检测的**互拖红同形**：
# 账本读者分不出「并发把套件拖红了」与「判据没跑完」。而这个上限在本仓**升不动**（插件包四处
# goal-criterion 调用点硬编码 6e4；本仓没有 .quay/gates.yml，也没有 packages/quay），
# 所以判据必须在 60000ms 内跑完，没有第二条路。两条杠杆：
#
# ① 【只跑一相】带【逐文件】再校验的持久安静基线。安静基线的成本就是最重的那个服务端文件，
#    而它每次都是同一笔账。故把安静相做成**按文件记账的持久读数**：按服务端文件存
#    「内容 sha256 → 该文件的安静读数（duration_ms / passed）」，键 = 本脚本内容 sha256
#    （= 判据）+ 安静相读数 argv 前缀（含 --test-concurrency）+ 相关环境。
#    命中时**只有内容哈希与记录不等的那些文件重量**（对那几个文件跑一次短读数），中位分母仍是
#    整个服务端文件集（复用 + 活读数两截相加，逐条合成为与 scripts/test.sh 同形的逐文件行，
#    于是下游的红名单 / 中位 / 覆盖面看不出复用与重跑的区别）。
#    ⛔ 为什么粒度是【内容哈希】而不是整集「路径 + 大小 + mtime」：整集指纹把「一个文件改了一个
#    字」与「全树重建」判成同价，而前者是本仓的常态 —— 每个 worker 都往 server/** 落东西，
#    于是默认路径每次都付 2 × 最重文件的地板（2026-09-24 实测同一形状的墙钟在 25.3s 与
#    ≥59.8s 之间摆，两次被 gate 的 60000ms 击杀）。逐文件内容哈希把成本收回到「真的变了的那
#    几个文件」上，而**任何内容变化都必然让那一个文件重量**（哈希不等 ⇒ 重量），判据哈希仍在
#    键里 ⇒ 判据一改，全部重量。mtime 单独变化（touch）不再复位整相：内容没变就是没变 ——
#    收敛的是读数的粒度，⛔ 不是纪律的放宽。⛔ 也不是「缓存了就一直用」：每一条复用都要逐项
#    通过「键相等 + 该文件内容哈希与记录相等 + 记录里有该文件」，缺一即重量；安静红名单与
#    中位分母要么是活读数，要么其新鲜度由「键 + 该文件的内容哈希 + 时间(created_at) +
#    provenance」四者机械可证。
# ② 【预算闸】预算内跑不完 ⇒ 判据**自己** exit 3（not-evaluated），判词同一行点名预算与实测
#    墙钟。插件的 frozen sweep 已经把子进程 exit 3 映射成 not-evaluated，通道是现成的
#    （goal-driver.js:38558）—— 于是「没跑完」与「互拖红」在账本里不再同形。
#    告警阈值 = 0.75 × 预算，随判词一起打印：余量不足时先告警，而不是等到被击杀。
#    另有一道：每个阶段用 timeout 夹在本阶段的剩余预算内（仅 GNU timeout 可用时），
#    于是「这一相跑飞了」以 rc≠0 + 预算判词收场，而不是把整条判据交给外层 SIGKILL。
#
# 退出码：0 判据成立；1 判据不成立；2 用法错误；
#         3 not-evaluated（超出自身预算 / 被预算截止 —— **未判红也未经绿**）。
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

# ── 自身墙钟预算 ──────────────────────────────────────────────────────────────
# 默认 60000 = goal 判据 gate 的硬上限（runAcceptance({ timeoutMs: 6e4 })），本仓升不动
# （见文件头）。预算内跑不完 ⇒ exit 3（not-evaluated），不是判红。
BUDGET_MS=60000
# 告警阈值 = 0.75 × 预算：留 25% 余量。取 3/4 的依据是 AC-103 自己的验收线 —— 那条 AC 要求
# 判据实跑墙钟 ≤ 45000ms = 0.75 × 60000，本阈值与它同值，于是「告警」与「AC 的验收线」
# 是同一个数，不会出现「没告警却已经越线」。
BUDGET_WARN_NUM=3
BUDGET_WARN_DEN=4

# ── 持久安静基线的目录与文件名 ────────────────────────────────────────────────
# 默认落在 <repo>/.quay/suite-concurrency-check/cache/（与运行目录同级，gitignore 已覆盖 .quay/*）。
# 三件套：①JSON 摘要（键 / provenance / 中位 / 相窗口估计）；②读数日志（安静相的逐文件行）；
# ③【逐文件读数表】—— 复用的唯一颗粒度：`<内容 sha256> <duration_ms> <passed> <path>`。
CACHE_DIR="${SCC_CACHE_DIR:-}"
BASELINE_JSON=""
BASELINE_LOG=""
BASELINE_FILES=""

# ── 安静相的复用状态（判词里那截「成本归因」的读数源）────────────────────────
# QUIET_MODE        live（整相活读数）/ cached（逐文件全命中，未重跑）/ partial（部分重量）
# QUIET_REUSED_N    复用了多少条读数
# QUIET_STALE       哪些文件的内容哈希与记录不等（= 被重跑的文件名单）
# QUIET_LIVE_WINDOW_MS  本相【重跑】那一段的墙钟（cached 时为 0）
# ⛔ 全部先给标量初值：--self-test 的判词走同一个 verdict_lists，而那条路径在
# SERVER_FILES/关联数组建起来之前就打印判词（set -u 下取未定义的数组长度会直接崩）。
QUIET_MODE="live"
QUIET_TOTAL_N=0
QUIET_REUSED_N=0
QUIET_LIVE_WINDOW_MS=0
QUIET_STALE=()
# 判词里的重跑名单只印前几条：整集变化时名单会长到几百字符，而判词行要能被读。
STALE_PREVIEW_MAX="${SCC_STALE_PREVIEW_MAX:-6}"

# 相窗口估计的【来源】：stored（落盘的历史窗口，要乘安全系数）/ fresh（本次运行刚实测，
# 同一台机器、间隔以秒计 —— 对它乘 5/4 是把同一份负载重复计一次，见 ESTIMATE_SAFETY_* 注释）。
EST_SOURCE="stored"
EST_FRESH_WINDOW_MS=0

# ── 主机负载：判词里那截成因读数 ──────────────────────────────────────────────
# 一次被负载拖红的运行与一次真的互拖红，在旧判词里【同形】—— 因为负载只落在
# write_state() 的 provenance 里，判词行没有。同一个量出现在判词行，读者才不必再去翻 JSON。
host_load_now() { cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '?'; }
HOST_LOAD="$(host_load_now)"

# 无历史读数时对「一相」的保守估计（ms）。依据：本机实测安静相窗口 33.9s / 并发相窗口 35.5s，
# 取最重者向上取整到 45s。它只在**第一次**（缓存目录为空、也还没有 estimate 记录）时被用到；
# 一旦跑过一相，estimate 就换成**实测**相窗口，每次运行结束时刷新。
COLD_PHASE_ESTIMATE_MS=45000
# 估计值的安全系数（5/4）：估计来自【上一次实跑】的窗口，而这两次之间这一次的负载可能更重。
# 乘 1.25 之后仍然落在预算内才开工 —— 于是「开工了却跑不完」只在负载比上次恶劣 25% 以上时
# 才可能发生，而那正是 timeout 夹取（见 run_group）兜住的那一格。
# ⛔ 它只作用在【上一次】留下的窗口上。旧实现把「刚测的」与「上次测的」抹成了同形：
# write_state 把本次实测窗口写进 estimate.quiet_window_ms，估算器再从同一个文件读回来 ——
# 于是冷路径的并发相被一个隔了几秒、同一台机器、同一份负载的读数乘 1.25 顶出预算，以 exit 3
# 收场（2026-09-24 实测：quiet 窗口 27845ms ⇒ 估计 34806ms ⇒ 28218+34806=63024 > 60000，
# 而那一相的历史实测只要 22–32s）。同一个运行里刚测出来的窗口不是「上一次实跑」，
# 对它乘 5/4 是把同一份负载重复计一次，故 estimate_phase_ms 分【来源】处理（见该函数）。
ESTIMATE_SAFETY_NUM=5
ESTIMATE_SAFETY_DEN=4

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 判据自身的绝对路径：quiet_baseline_key 要哈希本文件的内容，而脚本随后会 cd 到 ROOT_DIR，
# 那时相对 $0 已不可解析。这里在任何 cd 之前先钉死。
SELF_PATH="$ROOT_DIR/scripts/$(basename "${BASH_SOURCE[0]}")"
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
  --full-suites            并发组用完整 `scripts/test.sh`（≈2×55s；这个形状装不进默认预算，
                           要用它必须显式抬高 --budget-ms，否则以 exit 3 not-evaluated 收场）
  --test-concurrency <n>   服务端逐文件并发度（默认 = availableParallelism()，与 fan-in 同形）
  --k <ratio>              中位耗时上限倍数（默认 4；取 1 = 取假形态，必须红）
  --diff-max <n>           差集规模上界（默认 2；超过即跳过确认步直接判红）
  --budget-ms <n>          本判据自身的墙钟预算（默认 60000 = goal 判据 gate 的硬上限）。
                           超预算 ⇒ exit 3（not-evaluated），判词同一行点名预算与实测墙钟；
                           告警阈值 = 3/4 × 预算，随判词一起打印。默认路径只跑【并发相】，
                           安静基线取自持久读数：键（判据 sha256 + 读数 argv + 环境）与
                           【每个服务端文件的内容 sha256】逐项相等才复用，只有内容变了的那几个
                           文件重量；判词同一行带出复用条数、重跑名单、相窗口与 host load。
  --self-test              用合成读数跑差分判词的正反控制（不跑并发），按标签打印结果
                           该路径不跑套件，故 --budget-ms 不改变 8 条控制的结果
  -h, --help               本帮助

环境变量：
  SCC_LOG_DIR              运行目录（默认 <repo>/.quay/suite-concurrency-check）
  SCC_CACHE_DIR            持久安静基线的目录（默认 <repo>/.quay/suite-concurrency-check/cache）
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
    --budget-ms)          BUDGET_MS="${2:-}"; shift 2 ;;
    --budget-ms=*)        BUDGET_MS="${1#*=}"; shift ;;
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
case "$BUDGET_MS" in ''|*[!0-9]*|0) echo "suite-concurrency-check: --budget-ms must be a positive integer, got '$BUDGET_MS'" >&2; exit 2 ;; esac
# 告警阈值 = 3/4 × 预算（整除，向下取整 —— 阈值只会更低，即更早告警）。
BUDGET_WARN_MS=$(( BUDGET_MS * BUDGET_WARN_NUM / BUDGET_WARN_DEN ))

[ -n "$CACHE_DIR" ] || CACHE_DIR="$ROOT_DIR/.quay/suite-concurrency-check/cache"
BASELINE_JSON="$CACHE_DIR/quiet-baseline.json"
BASELINE_LOG="$CACHE_DIR/quiet-baseline.out"
BASELINE_FILES="$CACHE_DIR/quiet-baseline.files"

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

# stale_preview — 判词里那截【重跑名单】：超过 STALE_PREVIEW_MAX 条时只印前几条 + 总数，
# 整集变化时判词行才仍然读得出来（读数一样不少，只是省掉中段）。
stale_preview() {
  local n=${#QUIET_STALE[@]} i=0 out=""
  [ "$n" -eq 0 ] && { printf '无'; return 0; }
  if [ "$n" -le "$STALE_PREVIEW_MAX" ]; then
    printf '%s' "$(join_commas "$(printf '%s\n' "${QUIET_STALE[@]}")")"
    return 0
  fi
  for ((i = 0; i < STALE_PREVIEW_MAX; i++)); do out="$out${QUIET_STALE[$i]},"; done
  printf '%s…(共%s)' "${out%,}" "$n"
}

# verdict_lists — 判词里那串读数。AC 要求【同一行】带出：并发红名单、安静红名单、
# 差集、确认步后幸存的红文件、签名计数、劣化比、判据自身墙钟（另有上界与它的取值依据）。
# 另加两组【成本归因】：①安静相这次是怎么来的（复用了几条、重跑了哪些文件、重跑窗口多长）；
# ②host load —— 一次被负载拖红的运行与一次真互拖，靠这两个读数才在判词里区分得开。
verdict_lists() {
  printf '并发红名单=[%s] 安静红名单=[%s]（安静 rc=%s）差集=[%s] 确认步=%s 幸存红=[%s] 偶发=[%s] 签名 STACK_TRACE_ERROR=%s Timeout_fetch=%s 服务端逐文件中位耗时 安静=%sms(n=%s) 并发=%sms(n=%s) 劣化比=%s K=%s 上界=%s(依据:%s) 墙钟=%sms/%sms（告警阈值=%sms）安静基线=%s 安静相成本=模式:%s 复用=%s/%s 重跑=[%s] 重跑窗口=%sms host load=%s' \
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
    "${R_RATIO:-n/a}" "${R_K:-4}" "${R_DIFF_MAX:-2}" "${DIFF_MAX_BASIS}" "${R_WALL_MS:-n/a}" \
    "$BUDGET_MS" "$BUDGET_WARN_MS" "$(quiet_baseline_label)" \
    "$QUIET_MODE" "$QUIET_REUSED_N" "$QUIET_TOTAL_N" "$(stale_preview)" "$QUIET_LIVE_WINDOW_MS" \
    "${HOST_LOAD:-$(host_load_now)}"
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
  # ── 预算闸（跑完之后）───────────────────────────────────────────────────────
  # 先于一切判定：超预算 ⇒ not-evaluated（exit 3），不是判红 —— 这正是本任务要修的形状
  #（旧形态里超预算唯一可能的表达就是被外层 SIGKILL，然后记成 verdict=fail）。
  # R_WALL_MS 是【数值】才参与：--self-test 的合成读数是 "self-test"，自检不跑套件、
  # 没有可比的墙钟，且 8 条控制的结果必须在任意 --budget-ms 下逐条不变。
  case "${R_WALL_MS:-}" in
    ''|*[!0-9]*) : ;;
    *)
      if [ "$R_WALL_MS" -gt "$BUDGET_MS" ]; then
        printf 'suite-concurrency-check: NOT-EVALUATED — 超出自身预算，本次未判红也未经绿：判据自身墙钟越过预算（预算=%sms 实测墙钟=%sms 告警阈值=%sms）｜ %s\n' \
          "$BUDGET_MS" "$R_WALL_MS" "$BUDGET_WARN_MS" "$(verdict_lists)"
        return 3
      fi
      ;;
  esac

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

# ═════════════════════════════════════════════════════════════════════════════
# 自身墙钟预算（两个出口：开工前的预检 / 跑完后的判词闸）
# ⛔ 出口只有一种形态：同一行点名【预算】与【实测墙钟】，并带上完整读数行。它【不是】判红 ——
#    exit 3 = not-evaluated，插件的 frozen sweep 把子进程 exit 3 映射成 not-evaluated，
#    于是「判据没跑完」与「并发把套件拖红了」在账本里不再同形（这正是本任务要修的那个同形）。
# ═════════════════════════════════════════════════════════════════════════════

# budget_verdict <measured_wall_ms> <cause> — 预算出口的唯一实现。exit 3。
budget_verdict() {
  printf 'suite-concurrency-check: NOT-EVALUATED — 超出自身预算，本次未判红也未经绿：%s（预算=%sms 实测墙钟=%sms 告警阈值=%sms）｜ %s\n' \
    "$2" "$BUDGET_MS" "$1" "$BUDGET_WARN_MS" "$(verdict_lists)"
  exit 3
}

# budget_preflight <phase-label> — 开工前：这一相的保守估计装不进剩余预算就不开工，
# 于是「开工了却跑不完、被外层 SIGKILL 成假红」在源头被掐掉。
budget_preflight() {
  local label="$1" elapsed projected est src est_line
  elapsed=$(( $(now_ms) - SCRIPT_START ))
  [ "$elapsed" -ge "$BUDGET_MS" ] && budget_verdict "$elapsed" \
    "$label 阶段开工前就已越过预算（elapsed=${elapsed}ms ≥ 预算 ${BUDGET_MS}ms）"
  # ⛔ 估计值与它的来源必须一起从【子壳】里带回来：`est="$(estimate_phase_ms)"` 里对全局
  # 变量的赋值只活在子壳里，回到这里就是 unbound（set -u 下直接崩）—— 一行两字段，read 拆开。
  # 第二个实参是可选的手上估计（`<估ms> <来源>`）：逐文件重跑相按【要重跑的那些文件】估
  # （见 estimate_quiet_recheck_ms），不走 estimate_phase_ms 那三格。
  if [ $# -ge 2 ]; then est_line="$2"; else est_line="$(estimate_phase_ms)"; fi
  read -r est src <<<"$est_line"
  projected=$(( elapsed + est ))
  [ "$projected" -gt "$BUDGET_MS" ] && budget_verdict "$elapsed" \
    "$label 阶段的保守估计 ${est}ms（${src}）装不进剩余预算（elapsed=${elapsed}ms + est=${est}ms > 预算 ${BUDGET_MS}ms），不开始该阶段"
  [ "$projected" -gt "$BUDGET_WARN_MS" ] && printf 'suite-concurrency-check: WARN %s 阶段预计收在 %sms > 告警阈值 %sms（预算 %sms）：照常进行，但余量已不足 1/4\n' \
    "$label" "$projected" "$BUDGET_WARN_MS" "$BUDGET_MS"
  return 0
}

# estimate_phase_ms — 对「接下来这一相」的保守估计，一行两字段：`<估计ms> <来源>`。
#   读 estimate 段的顺序是【并发相窗口 → 安静相窗口 → 冷地板】。第一格为空或 0 时必须真的
#   落到第二格：⛔ 0 是「这一相还没被量过」的占位，不是读数 —— 把它当成有效读数会让预检
#   在每一次冷路径上都短接到地板（旧实现里 `[ -n "$v" ]` 对字符串 "0" 为真，第二格永远够
#   不到），而安静窗口是【已经跑过并且落盘】的真读数，它正是「下一相大概多贵」的最近证据。
#   两格都空才用【本次运行刚实测的相窗口】（EST_SOURCE=fresh），再空才用 COLD_PHASE_ESTIMATE_MS。
#   ⛔ 估计值只决定「要不要开工」，不参与判红/判绿 —— 判定语义与它无关。⛔ 来源必须【随值返回】
#   而不是写全局：调用点把它放进命令替换，子壳里的赋值出了子壳就不存在。
#   phase_window_or_empty <dotted.path> — 读一格 estimate 相窗口；缺失/非数/0 ⇒ 空。
phase_window_or_empty() {
  local v
  v="$(json_get "$BASELINE_JSON" "$1")"
  case "$v" in ''|*[!0-9]*) printf ''; return 0 ;; esac
  [ "$v" = "0" ] && { printf ''; return 0; }
  printf '%s' "$v"
}

estimate_phase_ms() {
  local v=""
  # ① 上一轮的【并发相】窗口：就为这一相量的，最新、最对症 —— 但它是上一次运行留下的，
  #    故乘安全系数。
  [ -f "$BASELINE_JSON" ] && v="$(phase_window_or_empty estimate.concurrent_window_ms)"
  if [ -n "$v" ]; then
    printf '%s 历史相窗口 %sms × %s/%s\n' \
      "$(( v * ESTIMATE_SAFETY_NUM / ESTIMATE_SAFETY_DEN ))" "$v" "$ESTIMATE_SAFETY_NUM" "$ESTIMATE_SAFETY_DEN"
    return 0
  fi
  # ② 本次运行刚实测的窗口：同一台机器、同一份负载、间隔以秒计 ⇒ 不打陈旧折扣。
  #    这一格正是冷路径（本轮第一相就是活读数）的并发相开工依据。
  if [ "${EST_SOURCE:-stored}" = "fresh" ] && [ "${EST_FRESH_WINDOW_MS:-0}" -gt 0 ]; then
    printf '%s 本次运行刚实测的相窗口 %sms（同一台机器、间隔以秒计，不乘 %s/%s）\n' \
      "$EST_FRESH_WINDOW_MS" "$EST_FRESH_WINDOW_MS" "$ESTIMATE_SAFETY_NUM" "$ESTIMATE_SAFETY_DEN"
    return 0
  fi
  # ③ 安静相窗口（落盘的历史读数）：安静相与并发相跑的是同一个文件集，它是「下一相大概多贵」
  #    的次新证据。⛔ 只有它不为空且不为 0 时才算数（0 = 还没量过，见上）。
  [ -f "$BASELINE_JSON" ] && v="$(phase_window_or_empty estimate.quiet_window_ms)"
  if [ -n "$v" ]; then
    printf '%s 历史相窗口 %sms × %s/%s\n' \
      "$(( v * ESTIMATE_SAFETY_NUM / ESTIMATE_SAFETY_DEN ))" "$v" "$ESTIMATE_SAFETY_NUM" "$ESTIMATE_SAFETY_DEN"
    return 0
  fi
  # ④ 冷地板。
  printf '%s 无历史读数，保守地板 %sms\n' \
    "$(( COLD_PHASE_ESTIMATE_MS * ESTIMATE_SAFETY_NUM / ESTIMATE_SAFETY_DEN ))" "$COLD_PHASE_ESTIMATE_MS"
}

# estimate_quiet_recheck_ms — 对「本次安静相要重跑的那一段」的保守估计，一行两字段。
#   逐文件记账之后，这一相不再是「整集」而是「内容变了的那些文件」，于是估计也必须逐文件：
#   每个待重跑的文件用它自己上一次的实测耗时，没有记录的新文件按【表里最重的那条】估
#   （新文件不是免费的），表整个为空才退到冷地板。⛔ 这不是把冷地板调小让预检恒放行：
#   每一条被估的文件都带着它自己的实测读数，冷地板 COLD_PHASE_ESTIMATE_MS 一字未动，
#   而【全量重跑】（一条记录都没有）仍然走 estimate_phase_ms 的冷地板那一格。
estimate_quiet_recheck_ms() {
  local f v total=0 unit=0
  local n=${#QUIET_STALE[@]}
  if [ "$n" -eq 0 ]; then printf '0 复用命中，本相无需开工'; return 0; fi
  # ⛔ 键列表只能写 `"${!MAP[@]}"`：写成 `${!MAP[@]+"${!MAP[@]}"}` 会被 bash 5.2 解析成
  # 「间接展开」—— 它拿数组的【值】当变量名去展开，报 `50 60: invalid variable name`，
  # 循环体一次都不进（实测），于是 unit 静默留在 0、估计悄悄退到冷地板。空数组在
  # bash ≥4.4 的 set -u 下本来就展开成空，`+` 守卫在这里既没用又有害。
  for f in "${!BASE_FILE_DUR[@]}"; do
    v="${BASE_FILE_DUR[$f]}"
    case "$v" in ''|*[!0-9]*) continue ;; esac
    [ "$v" -gt "$unit" ] && unit="$v"
  done
  [ "$unit" -gt 0 ] || unit="$COLD_PHASE_ESTIMATE_MS"
  for f in "${QUIET_STALE[@]}"; do
    v="${BASE_FILE_DUR[$f]:-}"
    case "$v" in ''|*[!0-9]*) v="$unit" ;; esac
    total=$(( total + v ))
  done
  printf '%s 逐文件重跑 %s 个（表内实测单价最高 %sms；无记录的新文件按它估）× %s/%s' \
    "$(( total * ESTIMATE_SAFETY_NUM / ESTIMATE_SAFETY_DEN ))" "$n" "$unit" \
    "$ESTIMATE_SAFETY_NUM" "$ESTIMATE_SAFETY_DEN"
}

# ── 小工具 ───────────────────────────────────────────────────────────────────
file_sha256() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# json_str — 只用于我们自己构造的短标量：去掉引号/反斜杠/换行，保证写出的 JSON 合法。
json_str() { printf '%s' "${1:-}" | tr -d '"\\' | tr '\n' ' '; }

# json_get <file> <dotted.path> — 读一个标量；不存在/不可读/不可解析 ⇒ 空 + rc 1。
json_get() {
  node -e '
    const fs = require("node:fs");
    const [file, dotted] = process.argv.slice(1);
    let v;
    try { v = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(1); }
    for (const k of dotted.split(".")) {
      if (v === null || typeof v !== "object") process.exit(1);
      v = v[k];
    }
    if (v === null || v === undefined || typeof v === "object") process.exit(1);
    process.stdout.write(String(v));
  ' "$1" "$2" 2>/dev/null
}

# perfile_labels <logfile...> — 逐文件行里的【标签】（不限 server/ 前缀，供覆盖面比对用）。
perfile_labels() {
  local f files=()
  for f in "$@"; do [ -f "$f" ] && files+=("$f"); done
  [ ${#files[@]} -eq 0 ] && return 0
  awk '/^__PERFILE__/ {
      lab = ""
      for (i = 1; i <= NF; i++) if ($i !~ /^(duration_ms|passed|end_ms)=/) lab = $i
      if (lab != "") print lab
    }' "${files[@]}"
}

# perfile_hashes — 本次服务端文件集的【内容】哈希，`<sha256> <path>` 一行一个。
#   ⛔ 内容是判据，mtime/大小不是：touch 改的是 mtime，文件没变就该继续复用（见文件头 ①）。
#   ⛔ 取名字段用【字节偏移】而不是 awk 的 $2：sha256sum 的输出是 `hash` + 两空格 + 名字，
#   按空白切词会把名字里的空格切碎（本仓路径没有空格，但这不是判据该依赖的性质）。
perfile_hashes() {
  local files=()
  local f
  for f in "${SERVER_FILES[@]+"${SERVER_FILES[@]}"}"; do [ -f "$f" ] && files+=("$f"); done
  [ ${#files[@]} -eq 0 ] && return 0
  sha256sum -- "${files[@]}" 2>/dev/null | awk 'NF > 1 { printf "%s %s\n", $1, substr($0, 67) }'
}

# load_hash_now — 把上面那张表读进 HASH_NOW（path → 内容 sha256）。缓存复用与落盘都用它，
# 于是「记录里的哈希」与「复用判定的哈希」永远同源。
declare -A HASH_NOW=()
load_hash_now() {
  HASH_NOW=()
  local sha path
  while read -r sha path; do
    [ -n "$path" ] && HASH_NOW[$path]="$sha"
  done < <(perfile_hashes)
}

# ═════════════════════════════════════════════════════════════════════════════
# 持久安静基线：带再校验的读数复用
#
# 为什么可以复用：安静基线的成本就是那个 32s 的最重服务端文件，而它每次都是同一笔账 ——
# 判据形状的地板 ≈ 2 × 32s，两遍里有一遍是纯重复。复用那遍，判据才装得进 60000ms。
#
# 为什么复用是【诚实的】：持久段里按服务端文件记「内容 sha256 → 该文件的安静读数
# （duration_ms / passed）」，命中前【逐项再校验四样】：
#   ① 环境键相等（判据内容 / 读数 argv 前缀 / 相关环境；⛔ 文件集不进键，见下）；
#   ② 读数日志的 sha256 与记录一致（日志被人动过 ⇒ 全部重量）；
#   ③ 该文件在逐文件表里有条目（表里没有 ⇒ 这个文件重量）；
#   ④ 该条目的内容 sha256 与本次该文件的内容 sha256 相等（不等 ⇒ 这个文件重量）。
# 于是粒度是【逐文件】的：判据变一个字 ⇒ ① 失败 ⇒ 全部重量（这是明文禁令要保住的那一半）；
# 一个文件变了 ⇒ 只有它落到 ④ 的「不等」上 ⇒ 只有它重量，其余复用。⛔ 为什么是内容哈希
# 而不是「路径 + 大小 + mtime」：mtime 不是内容 —— `touch` 一下就该继续复用，而改内容
# 必须让那一条作废；mtime 只对后者敏感、对前者过敏，两个方向都错。
# 安静红名单与中位分母因此要么是活读数，要么其新鲜度由「逐文件内容哈希 + 键 + 时间 +
# provenance(run_dir/host/读数 argv)」机械可证 —— ⛔ 明文禁止的「文件集或判据变化后不
# 重新校验就复用」在这套校验下不是一条纪律，而是一件做不到的事：没有逐文件读数表，
# cache_load 直接返回 1（全部重量）。
# ═════════════════════════════════════════════════════════════════════════════

# quiet_baseline_key — 基线【环境键】（sha256）：判据内容 + 安静相读数 argv 前缀 + 相关环境。
#   ⛔ 服务端文件集【不进】这个键 —— 它进不去才是本题的目的：文件集那一维改为【逐文件】
#   内容哈希（见 cache_load），于是「一个文件变了」只让那一个文件重量，而不是让整个键失配。
#   判据内容仍在这里 ⇒ 判据一改，键必变 ⇒ 全部重量（这是 AC 明文禁令要保住的那一半）。
quiet_baseline_key() {
  {
    printf 'criterion_sha256=%s\n' "$(file_sha256 "$SELF_PATH")"
    printf 'readout_prefix=%s\n' "${READOUT_PREFIX[*]}"
    printf 'ceiling=%s\n' "${QUAY_TEST_CONCURRENCY_CEILING:-<default>}"
    printf 'file_timeout=%s\n' "${QUAY_TEST_FILE_TIMEOUT:-<default>}"
  } | sha256sum | awk '{print $1}'
}

# quiet_baseline_label — 判词里那截 provenance：安静基线是活读数、逐文件全命中、还是部分重量。
quiet_baseline_label() {
  case "${BASE_MODE:-live}" in
    cached)
      printf '复用(key=%s… 实测于 %s 窗口=%sms 中位=%sms n=%s provenance=%s)' \
        "${BASE_KEY:0:16}" "${BASE_CREATED_AT:-?}" "${BASE_WINDOW_MS:-?}" "${BASE_MEDIAN_MS:-?}" "${BASE_N:-?}" "${BASE_PROVENANCE:-?}"
      ;;
    partial)
      printf '复用+重量(key=%s… 实测于 %s 复用=%s/%s 重量=[%s] 原相窗口=%sms 中位=%sms n=%s provenance=%s)' \
        "${BASE_KEY:0:16}" "${BASE_CREATED_AT:-?}" "${QUIET_REUSED_N:-0}" "${QUIET_TOTAL_N:-0}" \
        "$(stale_preview)" "${BASE_WINDOW_MS:-?}" "${BASE_MEDIAN_MS:-?}" "${BASE_N:-?}" "${BASE_PROVENANCE:-?}"
      ;;
    *) printf '活读数' ;;
  esac
}

# cache_load — 逐项再校验后【部分或全部】复用：命中（cached / partial）导出 BASE_* 并返回 0；
# 一处都对不上（live）：BASE_MISS_WHY 写明【为什么】并返回 1。
#   cached  = 本次文件集里每个文件的内容哈希都与记录相等 ⇒ 一条都不重量；
#   partial = 有一部分对不上 ⇒ BASE_STALE 列出它们，只有它们重量（其余复用）。
#   ⛔ 复用条件逐条：①环境键相等（判据内容 / 读数 argv 前缀 / 环境）；②读数日志 sha256 与记录
#   一致；③该文件在记录里有条目；④该条目的内容哈希与本次该文件的内容哈希相等。缺一即重量。
cache_load() {
  BASE_MODE="miss"; BASE_MISS_WHY=""
  BASE_KEY="$(quiet_baseline_key)"
  BASE_STALE=(); BASE_REUSED=(); BASE_REUSED_N=0
  [ -f "$BASELINE_JSON" ] || { BASE_MISS_WHY="无基线记录（$BASELINE_JSON 不存在）"; return 1; }
  local stored
  stored="$(json_get "$BASELINE_JSON" key)"
  [ -n "$stored" ] || { BASE_MISS_WHY="基线记录不可解析"; return 1; }
  if [ "$stored" != "$BASE_KEY" ]; then
    BASE_MISS_WHY="环境键已变（记录 ${stored:0:16}… → 本次 ${BASE_KEY:0:16}…；判据内容 / 读数 argv 前缀 / 环境至少一项变了 ⇒ 全部重量）"
    return 1
  fi
  [ -f "$BASELINE_LOG" ] || { BASE_MISS_WHY="读数日志缺失（$BASELINE_LOG）"; return 1; }
  [ -f "$BASELINE_FILES" ] || { BASE_MISS_WHY="逐文件读数表缺失（$BASELINE_FILES）"; return 1; }
  local rec_sha log_sha
  rec_sha="$(json_get "$BASELINE_JSON" readout_sha256)"
  log_sha="$(file_sha256 "$BASELINE_LOG")"
  if [ -z "$rec_sha" ] || [ "$rec_sha" != "$log_sha" ]; then
    BASE_MISS_WHY="读数日志 sha256 与记录不一致（再校验失败：记录 ${rec_sha:0:16}… ≠ 实际 ${log_sha:0:16}…）"
    return 1
  fi
  BASE_LOG_SHA="$log_sha"
  # 逐文件读数表：`<sha256> <duration_ms> <passed> <path>`；path 在最后一列。
  BASE_FILE_SHA=(); BASE_FILE_DUR=(); BASE_FILE_PASS=()
  local sha dur ok path
  while read -r sha dur ok path; do
    [ -n "$path" ] || continue
    BASE_FILE_SHA[$path]="$sha"; BASE_FILE_DUR[$path]="$dur"; BASE_FILE_PASS[$path]="$ok"
  done < "$BASELINE_FILES"
  # 逐文件再校验：内容哈希不等的（以及表里没有的）才重量。⛔ 覆盖面的新鲜度就是这一条 ——
  # 「表里缺这个文件」与「哈希不等」在这里是同一件事：没有记录的读数不许被当成读数复用。
  local f
  for f in "${SERVER_FILES[@]+"${SERVER_FILES[@]}"}"; do
    if [ -n "${BASE_FILE_SHA[$f]:-}" ] && [ "${BASE_FILE_SHA[$f]}" = "${HASH_NOW[$f]:-}" ] && [ -n "${HASH_NOW[$f]:-}" ]; then
      BASE_REUSED+=("$f")
    else
      BASE_STALE+=("$f")
    fi
  done
  BASE_REUSED_N=${#BASE_REUSED[@]}
  BASE_RC="$(json_get "$BASELINE_JSON" quiet.rc)"
  BASE_N="$(json_get "$BASELINE_JSON" quiet.n)"
  BASE_WINDOW_MS="$(json_get "$BASELINE_JSON" quiet.window_ms)"
  BASE_MEDIAN_MS="$(json_get "$BASELINE_JSON" quiet.median_ms)"
  BASE_CREATED_AT="$(json_get "$BASELINE_JSON" created_at)"
  BASE_PROVENANCE="$(json_get "$BASELINE_JSON" provenance.run_dir)"
  case "$BASE_N" in ''|*[!0-9]*) BASE_MISS_WHY="基线记录缺 quiet.n"; return 1 ;; esac
  if [ "${#BASE_STALE[@]}" -eq 0 ]; then BASE_MODE="cached"; else BASE_MODE="partial"; fi
  return 0
}

# quiet_reused_lines — 把复用到的逐文件读数【合成】成 `__PERFILE__` 行。
#   ⛔ 这不是「造一条读数」：每一条的 duration_ms/passed 都来自持久段里那一个文件自己的实测
#   记录，而它之所以能被复用，正是它刚才逐项过了再校验（键 + 日志 sha + 条目存在 + 内容哈希
#   相等）。合成行的形状与 test.sh 自己打印的完全一致，于是下游三处（差分红名单 / 中位分母 /
#   覆盖面）拿到的读数与「真跑了一遍」不可区分 —— 这正是复用的意义，也是它唯一诚实的形态。
#   ⛔ end_ms=0：复用的读数没有本次的结束时刻，写 0 而不是编一个假时间戳。
quiet_reused_lines() {
  local f
  for f in ${BASE_REUSED[@]+"${BASE_REUSED[@]}"}; do
    printf '__PERFILE__ duration_ms=%s %s passed=%s end_ms=0\n' \
      "${BASE_FILE_DUR[$f]:-1}" "$f" "${BASE_FILE_PASS[$f]:-true}"
  done
}

# quiet_recheck_run — 安静相的【部分重量】支：只跑 QUIET_STALE 里那些内容哈希与记录不等的文件，
#   其余由 quiet_reused_lines 复用，两者拼成本次运行的 quiet-readout-0.out（= 全集的读数视图）。
#   夹取与活读数支同式（同一个剩余预算、同一个 TIMEOUT_BIN），于是「开工了却跑不完」在这里
#   与在那里是可归因的同一件事，而不是一条只在这种模式下才有的新路径。
quiet_recheck_run() {
  local bound_ms s e rc
  bound_ms=$(( BUDGET_MS - ( $(now_ms) - SCRIPT_START ) ))
  [ "$bound_ms" -lt 1000 ] && bound_ms=1000
  local bound=()
  [ -n "$TIMEOUT_BIN" ] && bound=("$TIMEOUT_BIN" --signal=TERM --kill-after=5 \
    "$(awk -v m="$bound_ms" 'BEGIN { printf "%.3f", m / 1000 }')s")
  s=$(now_ms)
  "${bound[@]+"${bound[@]}"}" "${READOUT_PREFIX[@]}" "${QUIET_STALE[@]}" \
    >"$RUN_DIR/quiet-readout-fresh.out" 2>&1
  rc=$?
  e=$(now_ms)
  QUIET_LIVE_WINDOW_MS=$(( e - s ))
  if [ -n "${TIMEOUT_BIN:-}" ] && [ "$QUIET_LIVE_WINDOW_MS" -ge "$bound_ms" ]; then
    GROUP_DEADLINE_HIT=1
  fi
  {
    quiet_reused_lines
    cat "$RUN_DIR/quiet-readout-fresh.out"
  } > "$RUN_DIR/quiet-readout-0.out"
  printf '%s 0 %s\n' "$rc" "$QUIET_LIVE_WINDOW_MS" > "$RUN_DIR/quiet-readout-0.meta"
  QUIET_START=0; QUIET_END="$QUIET_LIVE_WINDOW_MS"
}

# baseline_files_write <log> — 把安静读数的【逐文件】记录落盘：`<内容sha256> <duration_ms> <passed> <path>`。
#   ⛔ 哈希取【写盘这一刻】的文件内容（HASH_NOW）—— 与 cache_load 的复用条件同源，于是记录里的
#   哈希恒等于「那条读数赖以成立的那份内容」，而不是「写盘时恰好是什么」。
#   ⛔ 一行都取不到时【也要落盘一个空表】：空表 ⇒ 下一次 cache_load 在 ③ 上全部失败 ⇒ 全部
#   重量。留着一张旧表才是危险的（它会把旧读数套在新文件上）。
baseline_files_write() {
  local log="$1" tmp="$BASELINE_FILES.tmp.$$" dur ok path sha
  mkdir -p "$CACHE_DIR" 2>/dev/null || return 0
  awk '/^__PERFILE__/ {
      dur = ""; lab = ""; ok = "";
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^duration_ms=/) dur = substr($i, 13)
        else if ($i ~ /^passed=/) ok = substr($i, 8)
        else if ($i !~ /^end_ms=/) lab = $i
      }
      if (dur != "" && lab != "" && ok != "") printf "%s %s %s\n", dur, ok, lab
    }' "$log" 2>/dev/null | while read -r dur ok path; do
      sha="${HASH_NOW[$path]:-}"
      [ -n "$sha" ] || continue
      printf '%s %s %s %s\n' "$sha" "$dur" "$ok" "$path"
    done > "$tmp" 2>/dev/null
  mv "$tmp" "$BASELINE_FILES" 2>/dev/null || rm -f "$tmp"
  return 0
}

# write_state — 把逐文件基线 + 相窗口估计写成 quiet-baseline.json（先写 tmp 再 mv，原子）。
# baseline 段：本次不是「逐文件全命中」就换成新的（日志 + 逐文件表一起落盘）；全命中时原样不动。
# estimate 段：每次运行结束都刷新，它是【下一次】预检的依据，与 baseline 键无关
#（键变了要重量时，估计值仍然来自上一次真实跑过的相窗口）。
write_state() {
  mkdir -p "$CACHE_DIR" 2>/dev/null || return 0
  if [ "${BASE_MODE:-live}" != "cached" ] && [ -f "$RUN_DIR/quiet-readout-0.out" ]; then
    if cp "$RUN_DIR/quiet-readout-0.out" "$BASELINE_LOG.tmp.$$" 2>/dev/null; then
      mv "$BASELINE_LOG.tmp.$$" "$BASELINE_LOG"
      BASE_LOG_SHA="$(file_sha256 "$BASELINE_LOG")"
      baseline_files_write "$BASELINE_LOG"
    fi
  fi
  local tmp="$BASELINE_JSON.tmp.$$"
  # 逐文件表里的条数（不是数组长度）—— 空表也要如实写 0：判词与记录都不许把「没记到」
  # 说成「记到了」。
  BASE_FILES_N="$(grep -c . "$BASELINE_FILES" 2>/dev/null || true)"
  case "${BASE_FILES_N:-}" in ''|*[!0-9]*) BASE_FILES_N=0 ;; esac
  {
    printf '{\n'
    printf '  "schema": 1,\n'
    printf '  "key": "%s",\n' "$(json_str "${BASE_KEY:-}")"
    printf '  "criterion_sha256": "%s",\n' "$(json_str "$(file_sha256 "$SELF_PATH")")"
    printf '  "readout_prefix": "%s",\n' "$(json_str "${READOUT_PREFIX[*]:-}")"
    printf '  "readout_argv": "%s",\n' "$(json_str "${READOUT_CMD[*]:-}")"
    printf '  "readout_sha256": "%s",\n' "$(json_str "${BASE_LOG_SHA:-}")"
    printf '  "created_at": "%s",\n' "$(json_str "${BASE_CREATED_AT:-}")"
    printf '  "provenance": {"run_dir": "%s", "criterion": "%s", "host": "%s", "mode": "%s", "measured_at": "%s"},\n' \
      "$(json_str "${BASE_PROVENANCE:-}")" "scripts/suite-concurrency-check.sh" \
      "$(json_str "cores=$(nproc 2>/dev/null || echo '?') load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '?')")" \
      "$(json_str "${BASE_MODE:-live}")" "$(json_str "${BASE_CREATED_AT:-}")"
    printf '  "quiet": {"window_ms": %s, "median_ms": %s, "n": %s, "rc": %s, "server_files": %s, "reused": %s, "files_recorded": %s},\n' \
      "${BASE_WINDOW_MS:-0}" "${BASE_MEDIAN_MS:-0}" "${BASE_N:-0}" "${BASE_RC:-0}" \
      "${#SERVER_FILES[@]}" "${BASE_REUSED_N:-0}" "${BASE_FILES_N:-0}"
    printf '  "estimate": {"quiet_window_ms": %s, "concurrent_window_ms": %s, "measured_at": "%s", "source": "%s"}\n' \
      "${EST_QUIET_MS:-0}" "${EST_CONC_MS:-0}" "$(json_str "$(now_iso)")" "$(json_str "${BASE_MODE:-live}")"
    printf '}\n'
  } > "$tmp" 2>/dev/null && mv "$tmp" "$BASELINE_JSON"
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
#
# READOUT_PREFIX = 安静相读数 argv 的【前缀】（命令 + 并发度，不含文件集）。它是基线环境键的
# 一半（见 quiet_baseline_key），而键【故意】不含文件集：逐个文件的新鲜度由逐文件内容哈希
# 负责（见 cache_load）。逐文件重跑相（quiet_recheck_run）直接用它拼出「只跑这几个文件」——
# 于是「一个文件变了」付的是那一个文件的账，而不是整整一相。
READOUT_PREFIX=(bash scripts/test.sh --test-concurrency="$TEST_CONCURRENCY")
if [ "$FULL_SUITES" = "1" ]; then
  SUITE_CMD=("${READOUT_PREFIX[@]}")
  READOUT_CMD=()
  READOUTS=0
else
  SUITE_CMD=("${CLIENT_CMD[@]}")
  READOUT_CMD=("${READOUT_PREFIX[@]}")
  if [ ${#SERVER_FILES[@]} -gt 0 ]; then READOUT_CMD+=("${SERVER_FILES[@]}"); fi
fi

# ── 每个阶段的墙钟夹取 ───────────────────────────────────────────────────────
# 只在 GNU timeout 可用时启用（与 scripts/test.sh 的判据同形：非 GNU 的 timeout 会拒收
# --signal/--kill-after，把每个文件都弄失败，所以那种情况下宁可不夹）。
# 夹的是【本阶段的剩余预算】：于是「这一相跑飞了」以 rc≠0 收场，被下面的跑完之后预算闸
# 记成 not-evaluated，而不是把整条判据交给外层 SIGKILL（那会记成 verdict=fail「超时」，
# 与被检测的互拖红同形 —— 正是本任务要修的形状）。
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1 && timeout --version 2>&1 | grep -qi gnu; then
  TIMEOUT_BIN="$(command -v timeout)"
fi
GROUP_DEADLINE_HIT=0
GROUP_BOUND_MS=0

# run_group <group> <suite-runs> <readout-runs>
# 把每份运行的 rc / 起止时间 / 日志分别落在 $RUN_DIR 下，供后面逐条判读。
# 读数命令额外带 $READOUT_ENV（只在并发组非空，见 --drop-pool-cap）。
run_group() {
  local group="$1" n="$2" r="$3" i bound_ms bound=()
  GROUP_START=$(now_ms)
  GROUP_BOUND_MS=$(( BUDGET_MS - ( GROUP_START - SCRIPT_START ) ))
  bound_ms="$GROUP_BOUND_MS"
  [ "$bound_ms" -lt 1000 ] && bound_ms=1000
  if [ -n "$TIMEOUT_BIN" ]; then
    bound=("$TIMEOUT_BIN" --signal=TERM --kill-after=5 "$(awk -v m="$bound_ms" 'BEGIN { printf "%.3f", m / 1000 }')s")
  fi
  for ((i = 0; i < n; i++)); do
    (
      s=$(now_ms); "${bound[@]+"${bound[@]}"}" "${SUITE_CMD[@]}" >"$RUN_DIR/$group-suite-$i.out" 2>&1; rc=$?
      e=$(now_ms); echo "$rc $s $e" >"$RUN_DIR/$group-suite-$i.meta"
    ) &
  done
  if [ "$r" -gt 0 ] && [ ${#READOUT_CMD[@]} -gt 0 ]; then
    for ((i = 0; i < r; i++)); do
      (
        s=$(now_ms); env ${READOUT_ENV[@]+"${READOUT_ENV[@]}"} "${bound[@]+"${bound[@]}"}" "${READOUT_CMD[@]}" >"$RUN_DIR/$group-readout-$i.out" 2>&1; rc=$?
        e=$(now_ms); echo "$rc $s $e" >"$RUN_DIR/$group-readout-$i.meta"
      ) &
    done
  fi
  wait
  GROUP_END=$(now_ms)
  # 截止判定的读数就是时间本身：夹取开了、而这个组的墙钟走到了它的界 ⇒ 有东西被夹断了。
  if [ -n "$TIMEOUT_BIN" ] && [ $(( GROUP_END - GROUP_START )) -ge "$bound_ms" ]; then
    GROUP_DEADLINE_HIT=1
  fi
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

# ── 安静基线：持久读数复用（只在这个形状里成立）──────────────────────────────
# --full-suites 的「安静相」是一整份套件、且它自己就是读数来源，形状不同 ⇒ 不参与复用，
# 也不参与预估（那一格由 --budget-ms 显式抬高来表达，见 --help）。
USE_CACHE=0
if [ "$FULL_SUITES" != "1" ] && [ ${#READOUT_CMD[@]} -gt 0 ]; then USE_CACHE=1; fi

BASE_MODE="live"; BASE_MISS_WHY=""; BASE_KEY=""; BASE_LOG_SHA=""
BASE_RC=0; BASE_N=0; BASE_WINDOW_MS=0; BASE_MEDIAN_MS=0; BASE_CREATED_AT=""; BASE_PROVENANCE=""
BASE_STALE=(); BASE_REUSED=(); BASE_REUSED_N=0
declare -A BASE_FILE_SHA=() BASE_FILE_DUR=() BASE_FILE_PASS=()
EST_QUIET_MS="$(json_get "$BASELINE_JSON" estimate.quiet_window_ms || true)"
EST_CONC_MS="$(json_get "$BASELINE_JSON" estimate.concurrent_window_ms || true)"
case "${EST_QUIET_MS:-}" in ''|*[!0-9]*) EST_QUIET_MS=0 ;; esac
case "${EST_CONC_MS:-}" in ''|*[!0-9]*) EST_CONC_MS=0 ;; esac
# 历史相窗口只对【同一个形状】有意义：--full-suites 那一格不能拿默认形状的窗口当预估，
# 也不能把自己的窗口写进去（否则会把下一次默认形状的预检推到永远超预算）。
[ "$USE_CACHE" = "1" ] || { EST_QUIET_MS=0; EST_CONC_MS=0; }
QUIET_TOTAL_N=${#SERVER_FILES[@]}
[ "$USE_CACHE" = "1" ] && load_hash_now

# ── 第 1 组：安静基线 ────────────────────────────────────────────────────────
# 三种来源，判词同一行都能读出来（模式 + 复用条数 + 重跑名单 + 相窗口）：
#   cached  逐文件全命中，一条都不重跑（本仓的常态路径 —— 判据/文件都没真变时）
#   partial 只有【内容哈希与记录不等】的文件重量，其余复用（「一个文件变了」这条常态路径）
#   live    整相活读数：--full-suites，或一条记录都用不上（冷路径 / 键或日志再校验失败）
# READOUT_ENV 在这里恒为空：安静基线必须是最干净的参照，取假形态也只放开并发组。
if [ "$USE_CACHE" = "1" ] && cache_load; then
  if [ "$BASE_MODE" = "cached" ]; then
    QUIET_MODE="cached"; QUIET_REUSED_N=$BASE_REUSED_N; QUIET_LIVE_WINDOW_MS=0
    echo "suite-concurrency-check: [quiet] 逐文件全命中，未重跑：复用 ${BASE_REUSED_N}/${QUIET_TOTAL_N} 条读数（key=${BASE_KEY:0:16}… 实测于 ${BASE_CREATED_AT} 原相窗口=${BASE_WINDOW_MS}ms 中位=${BASE_MEDIAN_MS}ms n=${BASE_N} provenance=${BASE_PROVENANCE}）"
    cp "$BASELINE_LOG" "$RUN_DIR/quiet-readout-0.out"
    printf '%s 0 %s\n' "$BASE_RC" "$BASE_WINDOW_MS" > "$RUN_DIR/quiet-readout-0.meta"
    QUIET_START=0; QUIET_END="$BASE_WINDOW_MS"
    QUIET_WINDOW_LABEL="$BASE_WINDOW_MS"
  else
    QUIET_MODE="partial"; QUIET_REUSED_N=$BASE_REUSED_N
    QUIET_STALE=("${BASE_STALE[@]}")
    echo "suite-concurrency-check: [quiet] 逐文件复用 ${BASE_REUSED_N}/${QUIET_TOTAL_N}，重跑 $(printf '%s\n' "${QUIET_STALE[@]}" | grep -c . || true) 个（内容哈希与记录不等）：$(stale_preview)"
    budget_preflight "[quiet]" "$(estimate_quiet_recheck_ms)"
    quiet_recheck_run
    QUIET_WINDOW_LABEL="$QUIET_LIVE_WINDOW_MS"
    BASE_CREATED_AT="$(now_iso)"; BASE_PROVENANCE="$RUN_DIR"
    # ⛔ median/n 必须在【这里】算出来再落盘（理由同下面 live 那一支）：这一相跑完就落盘，
    # 于是即使下一相装不进预算而 exit 3，这一次的读数也没白跑。
    quiet_logs=("$RUN_DIR/quiet-readout-0.out")
    quiet_dur="$(server_durations "${quiet_logs[@]}")"
    median_quiet="$(printf '%s\n' "$quiet_dur" | median_of)"
    n_quiet="$(printf '%s\n' "$quiet_dur" | grep -c . || true)"
    BASE_N="$n_quiet"; BASE_MEDIAN_MS="${median_quiet:-0}"
    write_state
  fi
else
  QUIET_MODE="live"
  if [ "$USE_CACHE" = "1" ]; then
    echo "suite-concurrency-check: [quiet] 未命中基线，重量：${BASE_MISS_WHY}"
  fi
  echo "suite-concurrency-check: [quiet] $([ ${#READOUT_CMD[@]} -gt 0 ] && echo 'server-phase only' || echo 'one full suite')"
  [ "$USE_CACHE" = "1" ] && budget_preflight "[quiet]"
  READOUT_ENV=()
  run_group quiet "$([ ${#READOUT_CMD[@]} -gt 0 ] && echo 0 || echo 1)" "$([ ${#READOUT_CMD[@]} -gt 0 ] && echo 1 || echo 0)"
  QUIET_START=$GROUP_START; QUIET_END=$GROUP_END
  QUIET_WINDOW_LABEL=$(( QUIET_END - QUIET_START ))
  QUIET_STALE=("${SERVER_FILES[@]}"); QUIET_REUSED_N=0; QUIET_LIVE_WINDOW_MS=$QUIET_WINDOW_LABEL
  if [ "$USE_CACHE" = "1" ]; then
    BASE_MODE="live"; BASE_CREATED_AT="$(now_iso)"; BASE_PROVENANCE="$RUN_DIR"
    BASE_WINDOW_MS=$(( QUIET_END - QUIET_START ))
    EST_QUIET_MS="$BASE_WINDOW_MS"
    # 这一相是【本次运行刚实测】的：并发相的估计取自它时不该再乘陈旧折扣。
    EST_SOURCE="fresh"; EST_FRESH_WINDOW_MS="$BASE_WINDOW_MS"
    # ⛔ median/n 必须在【这里】算出来再落盘，不能等下面「收集读数」段：那一段在并发相之后，
    # 而冷启动那一次会在【并发相预检】处 exit 3，永远走不到结尾的 write_state。只写
    # window_ms 的话记录里会永久留下 median=0 / n=0，此后每次复用命中都把它原样抄进判词
    #（基线其实量到了 118 个文件），判词就会自己说出一条假读数。与下面同式，重算幂等。
    quiet_logs=("$RUN_DIR/quiet-suite-0.out")
    for ((i = 0; i < READOUTS; i++)); do quiet_logs+=("$RUN_DIR/quiet-readout-$i.out"); done
    quiet_dur="$(server_durations "${quiet_logs[@]}")"
    median_quiet="$(printf '%s\n' "$quiet_dur" | median_of)"
    n_quiet="$(printf '%s\n' "$quiet_dur" | grep -c . || true)"
    BASE_N="$n_quiet"; BASE_MEDIAN_MS="${median_quiet:-0}"
    # 安静相一跑完就落盘：即使下一相装不进预算而 exit 3，这一次的读数也没白跑。
    write_state
  fi
fi

# ── 第 2 组：并发组（N 份套件 + R 份服务端读数同时起跑）─────────────────────
# 开工前先问「这一相装得进剩余预算吗」：装不进就 not-evaluated，而不是开工后被 SIGKILL。
[ "$USE_CACHE" = "1" ] && budget_preflight "[concurrent]"
echo "suite-concurrency-check: [concurrent] $SUITES × ${SUITE_CMD[*]}$([ ${#READOUT_CMD[@]} -gt 0 ] && echo "  ‖ $READOUTS × server-phase(readout)")${CONC_READOUT_ENV[*]+ ｜ readout_env=${CONC_READOUT_ENV[*]}}"
READOUT_ENV=("${CONC_READOUT_ENV[@]}")
run_group concurrent "$SUITES" "$READOUTS"
READOUT_ENV=()
CONC_START=$GROUP_START; CONC_END=$GROUP_END
[ "$USE_CACHE" = "1" ] && EST_CONC_MS=$(( CONC_END - CONC_START ))

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

# 安静相是【活读数】时，把它的 rc / 中位 / 条数补进基线记录（复用命中时这三样来自记录本身）。
if [ "$BASE_MODE" = "live" ]; then
  BASE_RC="${quiet_rc:-0}"; BASE_N="$n_quiet"; BASE_MEDIAN_MS="${median_quiet:-0}"
fi

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

echo "suite-concurrency-check: 读数 套件 rc=[${runs_rc# }] 读数 rc=[${readout_rc# }] 并发重叠=${overlap_ms:-n/a}ms 并发窗口=$(( CONC_END - CONC_START ))ms 安静窗口=${QUIET_WINDOW_LABEL:-$(( QUIET_END - QUIET_START ))}ms 安静相=$([ "$BASE_MODE" = "cached" ] && echo '复用持久基线' || echo '活读数')"

# ── 跑完之后：预算闸先于一切判定 ─────────────────────────────────────────────
# 夹取切断了一个阶段、或墙钟已经越过预算 ⇒ not-evaluated（exit 3），⛔ 不是判红。
# 这一闸必须在 fail-closed 之前：被判据自己的截止切断的那一相本来就会「量不到」，
# 若先走 fail-closed，一次预算超支会被记成判据不成立 —— 正是要消除的那个同形。
if [ "${GROUP_DEADLINE_HIT:-0}" = "1" ]; then
  budget_verdict "$(( $(now_ms) - SCRIPT_START ))" \
    "有一个阶段被本阶段的剩余预算夹断（timeout ${GROUP_BOUND_MS}ms：判据自身没跑完，读数不完整）"
fi
if [ "$R_WALL_MS" -gt "$BUDGET_MS" ]; then
  budget_verdict "$R_WALL_MS" "判据自身墙钟越过预算"
fi

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
# 判词先出（stdout 顺序 = 读者看到的顺序），再落盘相窗口估计（它是【下一次】预检的依据），
# 最后用判词的退出码退出 —— write_state 静默，不掺进判词行。
differential_verdict
VERDICT_RC=$?
[ "$USE_CACHE" = "1" ] && write_state
exit "$VERDICT_RC"
