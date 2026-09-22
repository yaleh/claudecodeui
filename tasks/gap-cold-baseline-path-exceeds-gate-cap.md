---
id: gap-cold-baseline-path-exceeds-gate-cap
title: AC-103 判据的冷路径装不进 gate 的 60000ms 上限：无基线可复用时必 exit 3，而 gate 把 exit 3 记成
  verdict=fail ⇒ 判据/测试文件每变一次就翻红一次
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-103
---
## Proposal

**现象（本轮一手读数）**：AC-103 的判据 `bash scripts/suite-concurrency-check.sh` 的**判定语义是绿的**，但它在「复用不到持久基线」的那一次**一定** `exit 3`，而 gate 把 `exit 3` 记成 `verdict=fail` —— 于是 AC-103 在账本里翻红。

两条对照读数（本轮实跑，同一台机器，同一份代码）：

| 路径 | 结果 | 判词要点 |
|---|---|---|
| 暖（命中持久基线） | **rc=0**，墙钟 34385ms | `安静基线=复用(key=0a73f071… 窗口=33393ms 中位=1042ms n=113)`；`套件 rc=[0 0] 读数 rc=[0 0] 并发窗口=33863ms`；`并发红名单=[] 安静红名单=[] 差集=[] 签名 STACK_TRACE_ERROR=0 Timeout_fetch=0 劣化比=1.16 K=4 墙钟=34385ms/60000ms` |
| 冷（无可用基线） | **exit 3** | `[concurrent] 阶段的保守估计 56250ms（无历史读数，保守地板 45000ms）装不进剩余预算（elapsed=33670ms + est=56250ms > 预算 60000ms），不开始该阶段` |

**账本里这两次的形状**（`.quay/gate-events.jsonl`）：

- `2026-09-22T17:54:33.912Z actor=goal-cli verdict=fail reason="acceptance failed (exit 3) — …NOT-EVALUATED…"`（冷那次，就是本轮立案前 gate 的那一次读数）
- 更早若干轮：`actor=goal-sweep / goal-cli verdict=fail reason="acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout"`

**为什么「exit 3 不是红」这条契约在本仓不成立 —— 这是本条缺口的核心，也是上一条修复没能兜住的地方。**

`goal-driver.js:39269-39270`（`quay goal gate` 走的路径）逐字写着 `verdict = result.ok ? "pass" : "fail"`，**没有任何 exit 3 的分支**；上游 `runAcceptance`（`goal-driver.js:37419`）把非 0 一律渲染成 `acceptance failed (exit ${r.status})`。`exit 3 ⇒ not-evaluated` 的映射**只存在于 sweep 路径**（`goal-driver.js:38558`）。上一条任务（`gap-suite-criterion-wallclock-budget`，done，`goal_ac: AC-103`）的完成记录写着「插件的 frozen sweep 已经把子进程 exit 3 映射成 not-evaluated，所以这条通道是现成的」—— 这句话只对 sweep 成立，**gate 路径看不到它**。于是「判据没跑完」在这条路径上仍然与「两个套件互拖红」**同形**，正是上一条任务声称已经消除的那件事。

⚠️ 插件在仓库外（`~/.claude/plugins/cache/…`），本仓改不了那条映射。**本仓唯一能落地的出路是：默认路径不许出现 exit 3。**

**为什么默认路径一定会出现 exit 3（这是几何，不是调参）**：判据冷时要跑两相，每相都被同一个最重的服务端文件钉住 ≈33s ⇒ 冷路径地板 ≈ `2 × 33.4s ≈ 67s > 60000ms`。任何「保守估计」都改不掉这个事实 —— 即使估得完全准（`33400 + 33800 = 67200`），也装不进 60000ms。**冷路径必须变便宜，而不是估计变乐观。**

**两处实测证据（都指向同一个根）**

1. **最重文件的 32s 里有 ~16s 是已知的死等。** `server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 在最近 6 次运行的**两相**里都是 32.2–33.7s（安静/并发比 1.01–1.02 ⇒ 内在成本，不是争用）。它自己打印的读数（本轮单跑实得 `rc=0 wall=32005ms`，其中一条用例自报 `28394ms`）说：
   ```
   [load] `add` observed on attempt 2 of 2; per attempt: #1=false #2=true
   ```
   **两条臂都是 `#1=false`**：第 1 次 arm 落在 chokidar 首次遍历的窗口里，被 `ignoreInitial` 吞掉，代码**明知如此**地重 arm —— 而它每次都为这次注定失败的尝试等满 `LOAD_ATTEMPT_MS = POLL_INTERVAL_MS(6000) + 2000 = 8000ms`。两臂 ≈ **16s/遍**。这是「按读数可回收的余量」，不是「必须付的成本」。
2. **持久基线的 estimate 段永远是 0，`quiet_window_ms` 回退是死代码。** `.quay/suite-concurrency-check/cache/quiet-baseline.json` 实读：`estimate.concurrent_window_ms = 0` 而 `quiet_window_ms = 33393`。成因两处：`write_state`（`scripts/suite-concurrency-check.sh:582`）写的是 `${EST_CONC_MS:-0}`，而 `EST_CONC_MS` 只在该相**跑完之后**才被赋值，冷路径在并发相预检处就 exit 3 ⇒ 落盘的永久是 0；`estimate_phase_ms`（`scripts/suite-concurrency-check.sh:416-419`）的回退 `[ -n "$v" ] || v="$(json_get … estimate.quiet_window_ms)"` **够不到** —— 字符串 `"0"` 非空，`[ -n ]` 直接为真，回退被短路，随后 `[ "$v" = "0" ] && v=""` 把它清空 ⇒ 永远落到 `COLD_PHASE_ESTIMATE_MS=45000`。于是**每一次运行**（不只是第一次）都按 `45000×5/4 = 56250` 预检：本轮暖跑的判词里就带着 `WARN [concurrent] 阶段预计收在 56693ms > 告警阈值 45000ms`。

**上一条修复为何没兜住**（留在任务体里供审计）：

<!-- dedup-ref -->
`gap-suite-criterion-wallclock-budget`（done，`goal_ac: AC-103`）交付了预算闸 + 带再校验的持久基线，并把它的 AC5「判据自身墙钟 < 60000ms 且超时不是判据的一种红」**当作瞬时读数**验收：暖跑 35.9/36.0s 为真 ⇒ 勾 `[x]`。它没有把「冷路径必然 exit 3」当成机制来钉 —— 而冷路径恰恰在**每一次判据内容变化、或任一服务端测试文件变化之后**必然出现（基线键含判据 sha256 与服务端文件集指纹，`scripts/suite-concurrency-check.sh:491-500`）。也就是说：**这条判据在自己被修好的那一轮、以及每一个改了测试文件的轮次，都会翻红一次** —— 修得越勤，红得越勤。`gap-concurrency-verdict-discriminates-flake-from-drag`（done）同样把 not-evaluated 当成「已验证的形状」记下了。

**要落地的事（路线由实现者定，读数指向这两个杠杆）**

1. **让冷路径装进上限（决定性）。** `rm -rf .quay/suite-concurrency-check/cache` 之后，判据必须 `rc=0` 且判词墙钟 ≤ 45000ms。证据指向的路线是把相成本压到 ≈≤22s（每相 ≤ 45000/2），而这**要求** `debug-agent-external-write.test.ts` 从 ~32s 降到 ≲20s —— 上面第 1 条给出的 ~16s 死等就是那笔钱。⛔ 收掉死等**不得**削弱「载入事件必须被观测到」这条断言：`[load] … add observed` 行、`attempts` 的逐次打印、以及「drain 静默必须超过一个轮询周期（`silence > POLL_INTERVAL_MS`）」这三样都必须保持原样可读；若提前重 arm 使 `MAX_LOAD_ATTEMPTS` 不够，只能调那个上限，**不能**把「必须观测到 add」改成「等一会儿就算」。
2. **让 estimate 段成为真读数**（上面第 2 条）：跑完一次默认路径后 `estimate.concurrent_window_ms` 必须 `> 0`；`estimate_phase_ms` 的 quiet 回退必须真的能用。⛔ 不许用「把 `COLD_PHASE_ESTIMATE_MS` 调小」来让预检恒放行 —— 那是把预算闸洗白：它会让一次 ~67s 的冷跑开工，然后被外层 SIGKILL 成 `timed out`，正是另一种假红。地板只能被调到「实测窗口支持的值」。

**⛔ 明文禁止（承 AC-103 的 expect 与 GOAL-003 的非目标）**：删除或跳过任何测试；缩 `scripts/test.sh` 的收集面；放宽 K=4；把最重的服务端文件从**任一相**里排除；把判据哈希从基线键里拿掉（「判据变化后复用」）；靠削弱 `--self-test` 的 8 条合成控制来让自检变绿；把预算闸整个删掉（`--budget-ms` 的契约必须留着 —— 它现在是唯一把「开工了却跑不完」在源头掐掉的机件）。

**形状纪律。** 本题改动落在 `scripts/**` 与 `server/**`。按 `AGENTS.md`，触及 `server/**` 时先加载 `$backend-module-standards` 并只对后端代码施用。改完跑 `npm run lint`（`oxlint src/ server/ scripts/`；裸 `npx oxlint` 退出 1 是本仓既有现象）与 `npm run typecheck`；改动/新增的 `.mjs` 还要 `tsc -p scripts/tsconfig.json`（scoped gate 的 `\.test\.[jt]sx?$` 正则看不见 `.mjs`，thin 的 scoped gate 会把 typecheck 一起跳过）。

## AC

- [ ] AC1 — **冷路径绿且装进上限（决定性）**。连做 3 次：每次先 `rm -rf .quay/suite-concurrency-check/cache`，再 `bash scripts/suite-concurrency-check.sh`，三次都 **rc=0**，且每次判词行里 `墙钟=<X>ms/60000ms` 的 X ≤ **45000**；不得出现 `NOT-EVALUATED`、不得被 SIGKILL（rc=137 / 判词缺失都算不达标）。失败时打印实际 rc 与完整判词行。（这正是 gate 路径看的那一条：`exit 3 ⇒ verdict=fail`。）
- [ ] AC2 — **冷路径的判定语义未被削弱（抗假）**。AC1 那 3 次里：安静相 `__PERFILE__` 行数 ≥ 113、并发相 ≥ 226（当前 2 读数 × 113 文件集规模），`server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 在两相里都出现且 `passed=true`；`git diff develop --name-status` 里没有删除任何 `*.test.*`、没有新增 `skip`/`todo`；K 仍为 4。另单跑一次 `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts`：rc=0，其自身输出里仍能看到 `[load]` 的 `add` 观测行与 `silence … (> one polling period 6000ms)` 的 drain 读数，且该文件单跑墙钟从当前的 ~32s 降到 **≤ 20000ms**。失败时打印实际行数、缺失文件名与实际墙钟。
- [ ] AC3 — **estimate 段是真读数，不是恒 0**。跑完至少一次默认路径后，`.quay/suite-concurrency-check/cache/quiet-baseline.json` 的 `estimate.concurrent_window_ms` **> 0**；`scripts/suite-concurrency-check.test.mjs` 新增一例钉住 `estimate_phase_ms` 的 quiet 回退（`concurrent_window_ms=0` 且 `quiet_window_ms=N` ⇒ 估计来源是 quiet 窗口而不是冷地板），并让该例在去掉回退修复时变红；`node --test scripts/suite-concurrency-check.test.mjs` rc=0，`npm run test:scripts` rc=0。
- [ ] AC4 — **预算闸与 8 条控制原样保留**。`bash scripts/suite-concurrency-check.sh --budget-ms 1000` rc=3 且判词点名预算与实测墙钟；默认判词里的预算字面量是 `/60000ms`、`--budget-ms 45000` 时是 `/45000ms`；`--help` 列出该开关；`--self-test` 在默认与任意 `--budget-ms` 下 rc=0，8 条控制按标签打印且 **C1/C3/C5 绿、C2/C4/C6/C7/C8 红**，逐条不变。失败时打印实际 rc / 实际字面量 / 哪一条控制变了。
- [ ] AC5 — **AC 记录被改成可兑现的契约**。`goals/AC-103-同时运行的两个全量套件互不拖红.md` 的 `expect` 里，「装不进上限 ⇒ exit 3」不再被当作 gate 路径上的一种合法收场（改为：默认路径 —— 含冷路径 —— 必须在 60000ms 硬上限内判绿，`--budget-ms` 只留给显式抬高预算的调用方），并保留基线的三样再校验与「⛔ 不得在文件集或判据变化后不重新校验就复用」的原文约束。失败时打印改后的那一段。

## DoD

**真实落地判据：不是「判词里出现了 cold 这个词」。** 在同一台机器上留下读数：

1. **3 次冷跑** —— 每次前置 `rm -rf .quay/suite-concurrency-check/cache`，各自 rc=0 且判词 `墙钟=` ≤ 45000ms（运行目录落在 `.quay/suite-concurrency-check/<ts>/`）；
2. **1 次最重文件单跑** —— rc=0，其自身 `[load]`/`silence` 读数仍在，墙钟 ≤ 20s；
3. **1 次 `--self-test`** —— 8 条控制的标签与结果；
4. **1 次 `--budget-ms 1000`** —— rc=3、判词点名预算；
5. **`node --test scripts/suite-concurrency-check.test.mjs` / `npm run test:scripts` / `npm run lint` / `npm run typecheck` / `tsc -p scripts/tsconfig.json`** 各 rc=0。

⛔ 仅改判词、仅改估计常数、或仅把判据文本换一种说法而冷路径仍然 exit 3，都不算完成。⛔ 不得靠删除/跳过任何测试、缩 `scripts/test.sh` 的收集面、放宽 K、把最重的服务端文件从任一相里排除、或削弱 `--self-test` 控制来达绿。

**必须写进 `goals/AC-103-*.md` 的 `expect` 的诚实契约。** 现在的 `expect` 把「装不进上限 ⇒ exit 3（不是红）」当作契约的一部分，而实测证明 **gate 路径把 exit 3 记成 `verdict=fail`**（`goal-driver.js:39270` 没有 exit-3 分支）—— 这句话在本仓是一句做不到的承诺。改成：**默认路径（含冷路径）必须在 60000ms 硬上限内判绿；`--budget-ms` 只用于显式抬高预算的调用方。** 并把「上一条修复为何没兜住」那一段留在任务体里供审计。

## Touches

- scripts/suite-concurrency-check.sh
- scripts/suite-concurrency-check.test.mjs
- server/modules/debug-agent/tests/debug-agent-external-write.test.ts
- goals/AC-103-同时运行的两个全量套件互不拖红.md
- tasks/gap-cold-baseline-path-exceeds-gate-cap.md
