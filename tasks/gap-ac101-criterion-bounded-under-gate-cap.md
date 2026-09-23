---
id: gap-ac101-criterion-bounded-under-gate-cap
title: AC-101 判据在 60s 门限之上无界、越过时不归因：端口预检只是一次快照而 Playwright 自身的 spawn 前探测没有
  deadline（实测构造 150s 不出，预检生效时 0.481s）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
---
## Proposal

AC-101 的判据 `npm run test:e2e -- e2e/session-filter.spec.ts` 在账本里不成立，但不是因为被测功能坏了，也不是因为普通的并发变慢：**这次运行在 60s 上限之上没有任何界，而且越过上限时它什么也不说。**

### 读数一：账本里判据在 4 分钟内两次被 60s 上限击杀

`.quay/gate-events.jsonl` 的 AC-101 goal gate，`criterionHash` 全程 `4f9eff7856601084`（判据文本一字未改 ⇒ 变的是运行时长，不是判据）：

- `05:10:50.811Z` goal-sweep pass / `06:16:16.054Z` pass / `07:17:24.326Z` pass / `08:18:43.849Z` pass
- `09:21:11.297Z` goal-sweep **fail** — `acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout`
- `09:21:36.227Z` goal-cli pass、`09:23:09.663Z` goal-cli pass
- `09:25:07.999Z` goal-cli **fail** — `acceptance timed out after 60000ms (killed)`

60s 是 goal gate 写死、本仓抬不动的上限（`runAcceptance({ timeoutMs: 6e4 })`；本仓无 `packages/quay`、无 `.quay/gates.yml`），且**超时与真失败同形**（都记 `verdict: fail`），所以红本身不可区分。

### 读数二：同一命令我连跑 7 次全绿，23.0–23.7s，含 6 路并发

全部 `npm run test:e2e -- e2e/session-filter.spec.ts`，cwd = 仓根，HEAD `beba8ccd`，并按 driver-anchor 的 environ 把 `ANTHROPIC_*` 摘掉：静默 2 次 **23.626s / 23.219s**；同命令 3 个实例并发 **23.251 / 23.361 / 23.684s**；在 6 个兄弟 spec（model-library、model-library-layout、sidebar-resize、model-env-kind-explanations、mobile-composer-send-key、voice-trim）同时在跑的 6 路负载下 **23.577s**（6 个兄弟各自 EXIT=0）。每一次 EXIT=0、`5 passed`。所以「普通并发变慢」不成立：`09:21:36` 那次复跑就是在 `load1=79.1` 下以 **23.631s** 通过的。

### 读数三：一次运行的 23s 花在哪（`DEBUG=pw:webserver` 实测）

配置求值+npm ≈0.6s → server（`npx tsx server/index.ts`）就绪 **1.86s** → vite 就绪 **0.48s**（两个 webServer 是**串行**启的）→ 浏览器启动 + `beforeAll` 装机 ≈**8.9s** → 5 条用例 **11.3s**（2.3 / 0.37 / 6.6 / 1.4 / 0.66s）。判据自己的判定面只有 11.3s，其中 6.6s 是「watcher 每 6s 轮询一次」这条领域约束，收不得。

### 读数四：我复现出那条无界路径（本任务立案的依据）

`playwright.config.ts` 的端口预检（`findTakenPorts`）在**配置求值那一刻取一次快照**，而 Playwright 自己在 spawn 之前那次可用性探测**没有 deadline**（配置自己的注释写着这句）。两次检查之间就是窗口：端口在快照之后才被占住时，预检放行，而探测会永远等下去。构造（sink = 只 accept TCP、永不应答的监听器，目录 `/data/scratch/yale/ac101probe-8f42af`）：

- 预检生效（今天仓里发出去的样子）：`QUAY_E2E_SERVER_PORT=45501 QUAY_E2E_CLIENT_PORT=45573 npm run test:e2e -- e2e/session-filter.spec.ts` → **EXIT=1 / wall 0.481s**，输出点名 `45501`。
- 把预检旁路以模拟「端口在快照之后才被占住」：同一命令加 `QUAY_E2E_PORTS_VERIFIED=1` → **EXIT=124 / wall 150.007s**（我的 `timeout 150` 打的），150s 里除 npm 横幅外**一行输出都没有**。外部击杀时账本记的就是 `acceptance timed out after 60000ms (killed)`。

一条被外部击杀的运行还会把它启好的 webServer 留下（配置注释自陈）：`gap-ac101-criterion-concurrency-determinism` 的 Proposal 记过一个 PPID=1、存活 ~125s 的孤儿，而孤儿正是下一个探测会连上却等不到应答的那类监听者。

### 为什么这条红会在 4 小时窗口里被反复放大

`check --stale-pass`（goal-store `checkStalePass`）对冻结 AC 取**最近一次 actor=goal-sweep 事件的 verdict**，并在 `DEFAULT_STALE_PASS_MAX_AGE_MS = 4h` 内让它在 `failing` 里买单；**其后 goal-cli 的 pass 不覆盖它**。`sweepFrozen` 对 fail 的重扫门槛是 `minAgeMs / DEFAULT_FAIL_RECHECK_DIVISOR = 10min`。于是 `09:21:11` 那一次 sweep 超时，就把 AC-101 钉成「当前为假」最长 4 小时，driver 每轮（约 1.5 分钟）都要真跑一次 23s 的真实浏览器 e2e 去复验（≈160 次），第二次超时几乎必然发生——`09:25:07` 那次就是它，而它使本轮读成 `confirmed-failing` ⇒ `frozen-violated`，才立了这个案。

### 为什么上一次修复没挺住

<!-- dedup-ref -->`gap-ac101-criterion-concurrency-determinism`（status=done，`goal_ac: AC-101`）关掉的是**启动期**的 >60s 路径：写死端口 → 内核按运行分配端口、`EADDRINUSE` → 健康检查重试满 120s → 被 60s 击杀并遗留占端口孤儿。它自己的 Evidence 末尾把**测试期/运行级**的 >60s 路径明确登记为残留并留给后续任务取舍（「本任务关闭的是启动期的 >60s 路径……测试期仍可超过 60s……收窄它们等于削弱判据，本任务明文禁止，故不在此处改动，仅登记供后续任务取舍」），而它加的那道预检只是**一次快照**，留下的正是上面读数四那条路径。所以它没挺住不是因为它做错了，而是因为它明文停在了启动期。

### 本任务要做的

1. **先复现**：拿到一次 wall ≥ 上限（或卡死不出）的判据运行，并记录它把时间花在哪个阶段（配置求值/播种、webServer 启动、浏览器启动、`beforeAll` 装机、5 条用例）。用读数四那条构造去逼出卡死即可，但必须记录读数。
2. **把运行自身的天花板压到 60s 之下**：让任何一次运行都在被外部击杀之前**自己结束并点名**（阶段 + 已用毫秒），而不是留下一句没有归因的超时。⛔ 不是收窄判定阈值：5 条用例的断言、`ALL_SESSIONS`、规则字面量、6s 轮询等待一个字都不许动。
3. **关掉读数四那条无界路径**：把「端口在预检快照之后才被占住」这个窗口要么关死、要么加界，使同一构造在 60s 内以一条可归因的红结束。
4. **孤立进程归零**：包括故意跑红的那次在内，结束后不残留本次运行启动的 `server/index.ts` / `vite --host 127.0.0.1 --strictPort`。

### 约束（⛔）

⛔ 不得削弱判据换绿：不 stub、不 skip、不删任何断言、不加 `retries`、不把 `reuseExistingServer` 改成 `true`（那会静默复用**别人的** server，而对方的 `QUAY_E2E_DATA_DIR` / `HOME` / `DATABASE_PATH` 全不同——是假绿，比红更坏）、不删 `keepSessionIds`、不把过滤搬到客户端、不改 `e2e/session-filter.spec.ts` 的 5 条断言、不改 `goals/AC-101-*.md` 里 `criterion` 命令本身。

## AC

- [ ] 复现读数入证据：构造出一次判据运行 wall ≥ 60000ms（或卡死不出），并把该次运行在各阶段的用时（配置求值/播种 / webServer 启动 / 浏览器启动 / `beforeAll` / 5 条用例）与逼出它的构造一并记入证据。
- [ ] 卡死可归因且在上限内结束：同一构造下，`npm run test:e2e -- e2e/session-filter.spec.ts` 在 **< 60000ms** 内自行结束、EXIT≠0，且输出里有一行点名卡住的阶段与已用毫秒（即红是这次运行自己解释的，不是被外部击杀的）；把该 wall 与该行原文记入证据。
- [ ] 并发下判据仍为绿：在 ≥4 个兄弟 spec（如 model-library / model-library-layout / sidebar-resize / voice-trim）同时在跑的条件下，连跑 ≥5 次判据，每次 EXIT=0、输出含 `5 passed`，各次 wall 记入证据且每次 < 45000ms。
- [ ] 无孤立进程：上述每一次运行（含故意跑红的那次）结束后，按 cwd 过滤的 `pgrep -af "server/index.ts"` 与 `pgrep -af "vite --host 127.0.0.1 --strictPort"` 都不含本次运行的进程；把命令与输出记入证据。
- [ ] 判定面未被削弱：`grep -c "reuseExistingServer: false" playwright.config.ts` 为 2；`grep -c "retries" playwright.config.ts` 为 0；`grep -cE "^  test\(" e2e/session-filter.spec.ts` 为 5；`git diff develop -- e2e/session-filter.spec.ts` 里 `await expect(` 的行数不减少；`grep -n "^criterion:" goals/AC-101-*.md` 仍是 `npm run test:e2e -- e2e/session-filter.spec.ts`。
- [ ] 抗假变体真跑并留输出：把新加的界回退（恢复成上限之上的旧天花板），同一构造必须再次变成「外部击杀 / 无归因超时」；变体须还原，`git status` 干净。
- [ ] `npm run typecheck` 退出码 0；`npm run lint` 退出码 0。

## DoD

真实落地判据：不是「配置里多了一行」，也不是「挑一个安静的窗口跑一次绿」。要求在**判据今天变红的那个条件**下——机器上同时有别的 e2e 在跑、且存在一个只 accept 不应答的监听者——由真实浏览器驱动真实服务跑完 AC-101 全文并退出 0，且任何一次运行都在 60s 上限之前自己结束并说明原因，不遗留占端口的孤儿。取假形态：把新加的界回退掉，同一构造必须退回「被外部击杀、账本里只留一句 `acceptance timed out after 60000ms (killed)`」。对照读数：本轮静默 23.626s / 23.219s，3 路并发 23.251 / 23.361 / 23.684s，6 路并发 23.577s；无界构造 150.007s 不出（预检生效时 0.481s）。

L_D 该轴仍暗，理由：本任务修的是判据运行的界与可归因性，不新增会话过滤的领域能力。
L_G 该轴仍暗，理由：同上；判定面由既有 5 条真实浏览器断言承担，本任务不新增领域读数。

## Touches

- playwright.config.ts
- e2e/session-filter.spec.ts
- tasks/gap-ac101-criterion-bounded-under-gate-cap.md
