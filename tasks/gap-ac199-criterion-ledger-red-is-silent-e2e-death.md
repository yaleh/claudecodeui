---
id: gap-ac199-criterion-ledger-red-is-silent-e2e-death
title: AC-199 台账尾红是「e2e 运行无测试输出即死」：同树直跑 2×绿（24.3s/24.4s）、watchdog fired:false、同窗
  AC-120/AC-254 同形红 —— verification-only 归因入档，不重实现既有修复
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-199
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是复述台账尾巴）。AC-199 记录 `status: achieved`，其 GOAL-015 已 `achieved`、不再活，且未声明 `long-term: true`，故台账 `gate=goal` 尾部按 CURRENTLY FALSE 交办。

判据物（逐字取自 `goals/AC-199-真实浏览器-从坞里停止任务与把前台工具转后台-状态以事件为准-连接中断时按钮置灰.md` 的 `criterion:`）：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"`。其 `expect:` 要求：点击任务停止**不乐观**改状态、事件到达才变 `stopped`；点击前台工具的「转后台」后任务面板随后出现该任务；终态任务不再有停止按钮；经 `page.routeWebSocket` 分区（夹具同 AC-184）后两个按钮都 `disabled` 并带说明；墙钟实测 ≤ 40s；取假形态「点击后立即置 stopped ⇒ 第一条读数必须红」。

**本轮直接现测：判据在净检出上退出 0（产品面成立）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`，`git rev-parse HEAD` = `b9e7c0b3cd04ca69d9de27edac16c7af2a29e8c3`，`git rev-parse HEAD^{tree}` = `3b116bec29ce55904412d81f7564859d78cde5a4`，`git status --short` 无 tracked 修改）直跑两次，均 exit 0：

```
run1: AC-199 wall clock: 24299ms;  1 passed (24.3s)
run2: AC-199 wall clock: 24424ms;  1 passed (24.0s)
```

逐字读数（两跑一致，spec 自己打印）：`ac2.snapshot.status=200 snapshot.tasks=["task-stop-target:running","task-terminal:completed","task-never:running"] dom.tasks=["task-never","task-stop-target"]`；`ac2.stopTarget.state=running`；`ac5.terminalRows=0 liveRows=2 liveStops=2`；`ac3.main click-instant: before=running after=running green=true`；`ac3.settled`（随后事件到达才 `stopped`）；`ac4.idsBeforeBackground=["task-stop-target","task-never"]`；`ac4.backgrounded: bgTask=task-bg state=running toolUseId=<X> foreground=<X>`（逐字相等）；`ac7.falseForm click-instant: before=running after=stopped green=false`；`ac6.partition: dockState=unreachable stopDisabled=true bgDisabled=true reasons=[… ×3]`。⇒ `expect:` 点名的每一条读数都在场，40s 上限实测 24.3s/24.4s。

**为什么台账尾巴读 fail。** `.quay/gate-events.jsonl` 里 AC-199 `gate=goal` 读数共 **189** 条；尾巴逐字：

```
2026-10-05T16:46:09.279Z goal-sweep pass  tree= c9988b7227f962b1d70938059a9a44edcc78326d
2026-10-05T19:52:27.610Z goal-sweep pass  tree= 8340ba9cc2d512b26fbbb39f257ff1029dbd4b6c
2026-10-05T23:07:48.474Z goal-sweep fail  tree= 3b116bec29ce55904412d81f7564859d78cde5a4
2026-10-05T23:11:05.355Z goal-cli   fail  tree= 3b116bec29ce55904412d81f7564859d78cde5a4
```

两条 `fail` 的 `payload.treeSha` 都是 `3b116bec…`，**正是本条直跑为绿的那棵树**（`git rev-parse HEAD^{tree}`）⇒ 不是「另一棵树上的旧红」。且这两条是 `3b116bec` 上**唯一**的 gate 读数（该 tree 没有一次 pass）。

两条 `fail` 的 `payload.reason` 逐字（前段；两条都以 `[truncated, 489 chars of stderr omitted]` 结尾）：

```
acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-inGCF7/vite-cache/deps/react-scan.js?v=… as it exceeds the max of 500KB. [WebServer] (node:218171) [DEP0190] DeprecationWarning: … [WebServer] (Use `node -- … [truncated, 489 chars of stderr omitted]
```

捕获到的 stderr 只有 **webServer 自己转发的 stdout（vite 依赖预打包的一条 Note）**，**没有测试输出、没有 Playwright 的失败报告**。

**指纹：同一「启动即哑」形态在同夜命中了互不共享源文件的其它浏览器判据。** `gate=goal` 在 `2026-10-05T21:00Z–23:30Z` 窗口内（剔除人为红：AC-256 缺文件 / AC-257 缺人工验收行）：

```
2026-10-05T21:24:17.689Z goal-sweep AC-120 fail  一条 BABEL Note，无截断标记（整段 stderr 仅此一行）
2026-10-05T21:54:13.466Z goal-cli   AC-254 fail  同上
2026-10-05T22:14:32.727Z goal-cli   AC-254 fail  同上
2026-10-05T23:07:48.474Z goal-sweep AC-199 fail  同上 + DEP0190
2026-10-05T23:11:05.355Z goal-cli   AC-199 fail  同上 + DEP0190
```

**5 条红 / 3 条互不共享判据文件的 AC**（AC-120 / AC-254 / AC-199，三条连 spec 文件都不同）—— `3 条独立回归`不成立；这是**宿主级运行故障**的指纹（同族判法见 `gap-ac153-ledger-red-is-host-quota` 的 AC3）。

**watchdog 对 AC-199 的两条红 `fired:false`（不是被自己的天花板杀的）。** `playwright.config.ts` 把本次运行的 watchdog 状态写进 `<dataDir>/watchdog-state.json`（`WATCHDOG_STATE_FILE = path.join(dataDir, 'watchdog-state.json')`）。逐字读出（这五个 data dir 仍在 `/data/home/yale/.cache/quay-e2e-tmp/`）：

```
quay-e2e-inGCF7  (AC-199 23:07:48Z 那次): {"armed":true,"fired":false,"ceilingMs":55000,"detail":"boot 40000ms, re-armed to 55000ms once past boot"}
quay-e2e-WY3mdE  (AC-199 23:11:05Z 那次): 同上，fired:false
quay-e2e-YSfbh2  (AC-120 21:24Z 那次):    同上，fired:false
quay-e2e-J8CjkH  (AC-254 21:54Z 那次):    {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55006ms"}
quay-e2e-mvE2AS  (AC-254 22:14Z 那次):    {"armed":true,"fired":true,"ceilingMs":55000,"detail":"ceiling crossed at 55004ms"}
```

⇒ AC-199 与 AC-120 那几次是**运行自己 exit 1**（boot 40s（`BOOT_CEILING_MS`）/ run 55s（`RUN_CEILING_MS`）两个天花板都没到），AC-254 那两次是被 **55s 运行天花板**杀的。两种死法，同一种「无测试输出」的捕获。

**机制（本轮能钉到的程度）。** AC-199 是一次全栈浏览器 e2e（配置求值 + data-dir 选择 + server boot + vite boot + 浏览器启动 + beforeAll + 一个 12.9s 的用例），整条 `npx playwright test` 调用必须在 **40s** 内跑完；安静时 24.3–24.4s，余量约 16s。窗口内宿主 `load1` 9.36–20.3（AC-199 自己 2026-10-04T23:51 的独立复核还记到 `hostFreeBytes=6.47e9`），boot/用例预算被吃光后运行在**产出任何测试输出之前** exit 1。**这不是产品回归**：同一棵树直跑两跑皆绿。

**残留未钉死假设（如实登记，本条必须让 worker 收敛它，或两条都登记）。** 本轮**未**钉死那两次 AC-199 运行的确切死亡点（driver 把 stderr 截在 489 字符，stdout 不在 `reason` 里）。两个候选并存：(i) 用例内的负载敏感计时（spec 的 20s 任务行、15s disabled 读数、30s pane 等等待）在负载下超时；(ii) `3b116bec` 是**第一次携带新落地 voice 模块**的 gate 运行（`server/modules/websocket/services/chat-websocket.service.ts` 新增 `import { voiceLexicon } from '@/modules/voice/index.js'` 与 `dispatchRun` 里的 `voiceLexicon.observeSentText(...)`），并发/磁盘状态下 boot 或首帧慢。⛔ 不得用 (i) 一句「负载」把 (ii) 抹掉。

<!-- dedup-ref --> **机制去重读数（本轮立案实测）。** `grep -rln "^goal_ac: *AC-199" tasks/` 只命中 1 条：`tasks/gap-ac199-dock-stop-background-controls-browser.md`，`status: done`。在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-199`）→ **0 命中** ⇒ 无在飞认领者。那条 done 任务交付的**产品面**（坞控件 + 调试 agent 控制缝 + e2e）在本轮直跑里**成立**（见上面 AC1 读数），所以本条**不是**「再修一次既有实现」，而是台账红尾的归因入档（同族先例 `gap-ac135-criterion-ledger-red-is-merge-race`、`gap-ac153-ledger-red-is-host-quota`、`gap-ac178-criterion-ledger-red-is-merge-race`，皆为 verification-only）。本条**不做**任何实现 / 判据 / 宿主配置改动。

**非目标 / 标准适用性。** 不改 `e2e/activity-dock-background.spec.ts`、`playwright.config.ts`、`src/**`、`server/**`、`goals/**`、`.quay/config.yml`；不重实现 AC-199 的产品面；不在本条内修宿主负载或回收问题。本条不触碰任何 `server/**` 或 `src/**` 的生产代码 ⇒ AGENTS.md 的 `$backend-module-standards` / `$frontend-module-standards` 均不适用。

## Plan

1. 建本条隔离 worktree（起点 = 开工时 `develop`），打印路径、`git rev-parse HEAD`、`git rev-parse HEAD^{tree}`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据 ≥2 次（出货命令逐字不改）：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"`；逐字抄退出码、墙钟、以及 spec 自己打印的读数行（`ac2.*` / `ac3.*` / `ac4.*` / `ac5.*` / `ac6.*` / `ac7.*` / `AC-199 wall clock`）。
3. 机械复算台账：用 `python3` / `jq` 读 `.quay/gate-events.jsonl`，打印 AC-199 `gate=goal` 总条数、尾部 `verdict` 序列与 `treeSha`，并断言两条 fail 的 `treeSha == git rev-parse HEAD^{tree}`。
4. 机械复算指纹：打印同窗（21:00Z–23:30Z）内 AC-120 / AC-254 / AC-199 的 fail `reason`（逐字），并逐字读出五个 `watchdog-state.json`。
5. 尝试钉死死亡点：在净 worktree 上以**并发负载**（至少再起 2–3 个兄弟 e2e，或人工 `stress`）重复跑判据，记录是否复现红、复现时的失败阶段与捕获输出；查 `dmesg` / cgroup OOM 记录；若不可复现，如实登记两条候选假设与已排除项。
6. 交付只落在 `tasks/<本条 id>.md`。

## AC

- [ ] AC1 判据在净 worktree 直跑 ≥2 次皆 exit **0**，逐字入档墙钟与 spec 读数行（至少 `ac3.main … green=true`、`ac4.backgrounded … toolUseId==foreground`、`ac6.partition … stopDisabled=true bgDisabled=true`、`AC-199 wall clock ≤ 40000`）；给出 worktree 路径、`git rev-parse HEAD` 与 `git rev-parse HEAD^{tree}`。红态基线（本轮立案读数）：两条 fail 的 `treeSha=3b116bec…` 与本条 worktree tree 相等而判据红。
- [ ] AC2 台账归因机械入档：用 `python3` 读 `.quay/gate-events.jsonl`，打印 AC-199 `gate=goal` 总条数（本轮 189）、尾部序列（`… pass/c9988b72 → pass/8340ba9c → fail/3b116bec → fail/3b116bec`）、两条 fail 的逐字 `payload.reason`；并断言 `payload.treeSha == git rev-parse HEAD^{tree}`。
- [ ] AC3 指纹与 watchdog 机械入档：打印同窗 AC-120（21:24:17.689Z）、AC-254（21:54:13.466Z、22:14:32.727Z）、AC-199（23:07:48.474Z、23:11:05.355Z）五条 fail 的逐字 `reason`，指出其捕获只有 webServer 的 BABEL Note（无测试输出）；逐字打印五个 `watchdog-state.json`，并写明 AC-199 那两次 `fired:false`、AC-254 那两次 `fired:true`（55s 运行天花板）。
- [ ] AC4 死亡点钉定**或**两条假设都如实登记：在净 worktree 上做过一次「并发 / 加载下重跑」的复现尝试（记录命令、并发度、是否复现、复现时的阶段与捕获），并检查该窗口的 `dmesg` / OOM 记录；完成记录必须明确写出结论是 (i) 负载敏感计时、(ii) 新 voice 模块的并发敏感 boot、还是「两条都未能排除」，⛔ 不得只写「负载」了事。若判据在净 worktree 上**也红**，停手上报并置 `needs-human`（本条归因不成立）。
- [ ] AC5 空 delta：本条对 base 的净改动（排除 `tasks/<本条 id>.md` 自身）为空 —— `git diff --stat <base>..HEAD -- e2e/ playwright.config.ts src/ server/ goals/ .quay/` 打印为空，且 `git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash`、未 `git checkout --`、未编辑任何 `e2e/**`、`playwright.config.ts`、`src/**`、`server/**`、`goals/**`）。
- [ ] AC6 判法可复用且如实：完成记录给出可机械复用的判法 —— `gate=goal` 红而捕获只有 webServer 引导输出、无测试输出、且同窗存在**互不共享文件的 AC** 同形红 ⇒ 宿主级运行死，不是「判据假」；并写明 AC-199 的产品保证由本条的**浏览器层**直跑读数钉住（⛔ 不得用 jsdom / 单元层读数替代），以及写完成记录时台账尾巴是否已被 driver 重判为 pass（若无，逐字写明「尾巴仍是 fail」）。

## DoD

- 判据本体（真实浏览器 spec，出货命令逐字不改）在净检出上**真的跑过 ≥2 次**、exit 0，读数行逐字入档 —— 不是复述 `expect:`、不是读台账尾巴。
- 归因段落里每一条读数（台账总条数 / 尾部 / treeSha、同窗五条 fail 的 `reason`、五个 `watchdog-state.json`）都能由任何人在同一 checkout 上用 `python3` / `jq` / `cat` 复现，不依赖本条转述。
- 死亡点结论明确（或两条假设都登记且说明未排除的理由）；若净树直跑为红，本条按 AC4 停手上报，⛔ 不把环境红写成产品绿、不据此改断言。
- 交付物只动 `tasks/<本条 id>.md`：判据文件、实现、`playwright.config.ts`、宿主配置一个字节未动。

## Touches

- `tasks/gap-ac199-criterion-ledger-red-is-silent-e2e-death.md`（自触）
- `e2e/activity-dock-background.spec.ts`（本条只跑不改：判据本体）
- `playwright.config.ts`（本条只读不改：`BOOT_CEILING_MS` / `RUN_CEILING_MS` / `WATCHDOG_STATE_FILE` 读数来源）
- `goals/AC-199-真实浏览器-从坞里停止任务与把前台工具转后台-状态以事件为准-连接中断时按钮置灰.md`（本条只读不改：`criterion:` / `expect:` 逐字来源）