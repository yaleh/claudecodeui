---
id: gap-ac101-criterion-concurrency-determinism
title: AC-101 判据在舰队并发下不再可靠为绿：并发 e2e 撞死共享写死端口，会话过滤判据 2.4s 假红 / 单次运行 123s 被 goal
  gate 的 60s 上限击杀并遗留占端口孤儿
status: todo
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

AC-101 的判据 `npm run test:e2e -- e2e/session-filter.spec.ts` 在舰队并发下不再可靠为绿。以下读数全部是本轮直接复跑测得（canonical checkout `/data/home/yale/work/claudecodeui`，HEAD `e3777763`）。

### 现象一：静默机器上判据是绿的，余量充足 —— 所以红不是被测功能坏了

`npm run test:e2e -- e2e/session-filter.spec.ts` 连跑三次：EXIT=0 / EXIT=0 / EXIT=0，wall **16.74s / 16.92s / 23.02s**，每次 `5 passed`。逐条用时（run3）：2.5s / 379ms / 6.1s / 897ms / 699ms。

### 现象二：账本里最近一次红是「超时」

`.quay/gate-events.jsonl` 的 AC-101 goal gate：

- `2026-09-21T07:52:04.638Z` goal-sweep **fail** —— reason 为 `acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout`
- `2026-09-21T07:52:15.239Z` goal-cli **fail**（与上一条只隔 10.6s）

同一时刻现场另有一个孤儿 `npm run test:e2e e2e/session-filter.spec.ts`（PPID=1）在跑，存活 **~125s**。

### 现象三：直接复现（两次 e2e 相隔 0.5s 并发启动）

- A = AC-101 的判据 → **2.386s** EXIT=1：`Error: http://127.0.0.1:47173 is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.`
- B = `e2e/model-library.spec.ts` → **123.061s** EXIT=1：先是 `[WebServer] Error: listen EADDRINUSE: address already in use 127.0.0.1:47101`，随后是反复 `Error: connect ECONNREFUSED 127.0.0.1:47101`。

### 机制（四条链，缺一不可）

`playwright.config.ts:13-14` 把两个端口写死 `47101` / `47173`；两处 webServer 都是 `reuseExistingServer: false`（`:155`、`:167`）；而端口是**机器级**资源，不是 checkout 级的。并发时：

1. 抢输的一方约 2s 内以 `already used` 判死 —— 判据变红，与被测功能无关。
2. 抢赢、但**另一个** webServer 撞上 `EADDRINUSE` 的一方，会把 url 健康检查一直重试到 `webServer.timeout: 120_000`（`:156`、`:168`），单次运行 wall 于是到 ≈123s。
3. 123s 远超 goal gate 的 **60s** 硬上限（`packages/quay/src/gate/factories/goal.ts:43` 调 `resolveRunnerOptions` 时**只传了 cwd、没传 timeoutMs**，于是落到 `packages/quay/src/gate/acceptance-runner.ts:156` 的默认 `60000`），该次运行被击杀、记为「超时红」。
4. 被击杀的那次运行**遗留 server / vite 孤儿**继续占着那两个端口，把紧随其后的下一轮也拖成红。

第 2–4 条合起来正是 `07:52:04` 超时 + `07:52:15` 紧接 fail 的成因；本轮也复现出同为 ≈123s 的第 2 条形态（上面 B）。

### 为什么前两次修复没挺住（本任务存在的理由）

`gap-session-filter-real-browser-e2e`（done）立了 spec 与判据，`gap-canonical-checkout-node-modules-missing-compression`（done）补齐了主 checkout 的依赖树。两次修的都是**内容侧**（spec 是否存在、依赖是否装齐、播种时序），一次也没碰判据的**运行级隔离**。所以这条判据从建立起就只在「此刻机器上没有别的 e2e 在跑」时成立；而舰队今天已不满足这个条件：GOAL-004 的六条 e2e 判据（AC-106..111）每条都有 filing agent、worker 与驱动器在各自 checkout 里跑 `npm run test:e2e`。

<!-- dedup-ref -->与在飞任务的边界（记给出处，⛔ 不重复申领）：`gap-e2e-hardcoded-ports-collide`（status=ready，其 `goal_ac` 是 AC-027，Touches 含 `playwright.config.ts`）正在为 AC-027 做「端口按运行分配 + 每次运行独立 outputDir」。端口按运行分配这一条归它，本任务**不重做**，也不把它写成自己的 AC。本任务要的是 AC-101 自己的判据在**它今天变红的那个条件下**确定性为绿，并关掉上面机制第 2–4 条那条 AC-027 任务 Proposal 未覆盖的加重路径（`EADDRINUSE` → 健康检查重试满 120s → 单次运行 >60s → 被 60s 门限击杀并遗留占端口孤儿）。若开工时端口按运行分配已经落地，本任务就退化为「在上述并发条件下取证 + 关闭加重路径」，⛔ 不得为凑 AC 再改一次端口分配。

### 约束

⛔ 不得削弱判据换绿：不 stub、不 skip、不删任何断言、不加 `retries`（重试会把真回归掩盖成慢绿）、不把 `reuseExistingServer` 改成 `true`（那会静默复用**别人的** server，而对方的 `QUAY_E2E_DATA_DIR` / `HOME` / `DATABASE_PATH` 全不同 —— 那是假绿，比红更坏）、不删 `keepSessionIds`、不把过滤搬到客户端、不改 `e2e/session-filter.spec.ts` 的任何断言、不改 `goals/AC-101-*.md` 里 `criterion` 命令本身。

## AC

- [ ] AC-101 判据在**并发条件下**退出码 0：先起 `npm run test:e2e -- e2e/model-library.spec.ts`，在 1s 内并发起 `npm run test:e2e -- e2e/session-filter.spec.ts`，后者 EXIT=0 且输出含 `5 passed`（今天同一形态必红：本轮实测 2.386s `47173 is already used`）。两次运行的 EXIT 与被测判据的逐条输出记入证据。
- [ ] AC-101 判据单独连跑 ≥3 次全部 EXIT=0、每次 `5 passed`，各次 wall 时间记入证据（证明并发修好没有把判据本身弄坏）。
- [ ] 单次运行不再存在超过 60s 的路径：构造一次「端口已被占用」形态，实测该次 `npm run test:e2e -- e2e/session-filter.spec.ts` 的 wall **< 60s**，且其输出里第一条可归因错误行点名端口或启动失败（即启动失败是快速且可归因的失败，而不是把健康检查重试到 120s）；把该 wall 与那一行记入证据。
- [ ] 判据命令一字未改：`grep -n "^criterion:" goals/AC-101-*.md` 的输出仍是 `npm run test:e2e -- e2e/session-filter.spec.ts`；且 `git diff develop -- e2e/session-filter.spec.ts` 无输出。
- [ ] 抗假变体真跑并留输出：把「并发下不互撞」的实现回退成共享写死端口（其余不动），同一并发对必须变红（`already used` 或 `EADDRINUSE` 形态），变体须还原。
- [ ] `npm run typecheck` 退出码 0；`npm run lint` 退出码 0。
- [ ] 记录卫生：`goals/AC-101-在真实浏览器里经界面把规则设进去并使列表真的收敛.md` 的 `expect` 末尾那句「⚠️ 当前必红：e2e/session-filter.spec.ts 不存在，且 @playwright/test 已声明但主 checkout 未安装」现在已是**假的**（spec 存在；`node -e "require.resolve('@playwright/test/package.json')"` 在仓根可解析）。用 `quay goal write AC-101 --expect …` 改成与当下一致的陈述，并在完成记录里点名该 note 已误导后续每一次 filing。

## DoD

真实落地判据：不是「配置里多了几行」，也不是「挑一个安静的窗口跑一次绿」。要求在**判据今天变红的那个条件**下 —— 机器上同时有另一个 e2e 在跑 —— 由真实浏览器驱动真实服务跑完 AC-101 全文并退出 0，且单次运行不再存在 >60s 的路径（否则会被 goal gate 的 60s 上限击杀，并遗留占端口孤儿把下一轮也拖红）。取假形态：把运行级隔离回退成共享写死端口后，同一并发对必须变红。判断「修好了没有」的对照读数：本轮静默三连绿 16.74s / 16.92s / 23.02s，并发复现 2.386s（`already used`）与 123.061s（`EADDRINUSE` → `ECONNREFUSED`）。

L_D 该轴仍暗，理由：本任务修的是判据的运行级隔离与失败可归因，不新增会话过滤的领域能力。
L_G 该轴仍暗，理由：同上；判定面由既有 5 条真实断言承担，本任务不新增领域读数。

## Touches

- playwright.config.ts
- e2e/session-filter.spec.ts (覆盖面登记，⛔ 不写入)
- goals/AC-101-在真实浏览器里经界面把规则设进去并使列表真的收敛.md
- tasks/gap-ac101-criterion-concurrency-determinism.md
