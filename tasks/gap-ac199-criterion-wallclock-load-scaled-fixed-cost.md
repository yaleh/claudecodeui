---
id: gap-ac199-criterion-wallclock-load-scaled-fixed-cost
title: AC-199 判据整轮墙钟在扇入负载下越过 AC 自己的 40s 上限而红（四次红的 artifact 都是 spec:755 的 40s
  断言；task B 的「无测试输出即死」归因被四份 error-context.md 推翻）——把判据的固定开销做成负载不敏感并在负载臂下实测达标
status: todo
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

判据物（逐字取自 `goals/AC-199-真实浏览器-从坞里停止任务与把前台工具转后台-状态以事件为准-连接中断时按钮置灰.md` 的 `criterion:`）：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"`。其 `expect:` 要求：点击任务停止**不乐观**改状态、事件到达才变 `stopped`；点击前台工具的「转后台」后任务面板随后出现该任务；终态任务不再有停止按钮；经 `page.routeWebSocket` 分区后两个按钮都 `disabled` 并带说明；**墙钟须实测不超过 40 秒**；取假形态「点击后立即置 stopped ⇒ 第一条读数必须红」。

### 本轮直接现测：当前检出的判据是绿的

本轮开工 `HEAD=4d1db458b59afb5e5b4c2bc5337994f06f45d739`、`git rev-parse HEAD^{tree}` = `829496b7ddcfe4120576ed064ca8cfccaa0c3119`、branch `author`、`git status --porcelain --untracked-files=no` 空。出货命令逐字不改，直跑两次均 exit 0：

```
run1  EXIT=0 WALL=25s   spec: AC-199 wall clock: 24356ms   1 passed (24.3s)
run2  EXIT=0 WALL=25s   spec: AC-199 wall clock: 24524ms   1 passed (24.3s)
```

读数行逐字（run2）：`ac3.main click-instant: before=running after=running green=true`、`ac7.falseForm click-instant: before=running after=stopped green=false`、`ac4.backgrounded: bgTask=task-bg state=running toolUseId=<X> foreground=<X>`（逐字相等）、`ac6.partition: dockState=unreachable stopDisabled=true bgDisabled=true reasons=[…×3]`。⇒ **产品面成立**；40s 上限在安静宿主上有约 15s 余量。

### 台账尾巴是红的，而且就在这棵树上

`.quay/gate-events.jsonl` 里 AC-199 `gate=goal` 共 **194** 条。尾部逐字（tree 前 12 位）：

```
2026-10-05T19:52:27.610Z pass 8340ba9cc2d5
2026-10-05T23:07:48.474Z fail 3b116bec29ce   ← 本条立案时 driver 读到的那一段
2026-10-05T23:11:05.355Z fail 3b116bec29ce
2026-10-05T23:23:49.509Z fail e4cf8ead767a
2026-10-05T23:30:57.995Z pass c46c04000d5b
2026-10-05T23:40:35.569Z pass 829496b7ddcf   ← 与当前 HEAD 的 tree 相同
2026-10-05T23:44:43.875Z pass 829496b7ddcf
2026-10-05T23:48:57.306Z fail 829496b7ddcf   ← 同一棵树，8 分钟内 pass → pass → fail
```

**同一棵 `829496b7` 先 pass 两次再 fail 一次**（本地时间 +08:00 即 07:40 / 07:44 / 07:48），而本轮直跑绿、task B 直跑也绿。⇒ 这不是「判据假」，是**判据在负载下会红**。四次红全部落在 2026-10-05T23:07–23:48Z（本地 07:07–07:48）这一个 driver 扇入突发窗口内；在此之前 190 条 gate=goal 无一红。

### 真正的死因：四次红跑的都是 spec 自己的 40s 断言

driver 存在台账 `payload.reason` 里的只有 webServer 转发到 stderr 的一段（`[WebServer] [BABEL] Note …`，尾部 `[truncated, 489 chars of stderr omitted]`）。**只看那个字段会得出「启动即哑、无测试输出」的错结论**——正是 task B 得出的结论。读 e2e artifact（`<dataDir>/test-results/<spec>/error-context.md`）才是真读数。四份 artifact 的 `# Error details` 逐字：

```
quay-e2e-inGCF7  (23:07:48Z, tree 3b116bec): Error: the criterion must complete within 40s
                                            Expected: <= 40000   Received:    49607
quay-e2e-WY3mdE  (23:11:05Z, tree 3b116bec): … Received:    49866
quay-e2e-KkIGnM  (23:23:49Z, tree e4cf8ead): … Received:    46688
quay-e2e-RHTPBc  (23:48:57Z, tree 829496b7): … Received:    46801
```

四处断言的落点都是 `e2e/activity-dock-background.spec.ts:755` 的 `expect(elapsedMs, 'the criterion must complete within 40s').toBeLessThanOrEqual(40_000)`，其中 `elapsedMs = Date.now() - Number(process.env.QUAY_E2E_RUN_STARTED_AT)`——**从整轮 `npx playwright test` 起算，含 config 求值、seeding、webServer 引导、浏览器启动**（这是 `playwright.config.ts:35-45` 的书面设计，注释明写「a spec that timed its own body would report a number whose shortfall against the ceiling is the part it could not observe」）。四次红也都写了 `test-results/.../trace.zip`，即运行**产出了**测试输出。四个 data dir 的 `watchdog-state.json` 皆 `{"armed":true,"fired":false,"ceilingMs":55000}`——运行是自己 exit 1 的，没被 55s 天花板杀。

⇒ **task B 的归因不成立**：它写「其捕获只有 webServer 的 BABEL Note（无测试输出）」「宿主级运行故障」，但那四次的红是判据**自己的** 40s 上限被越过，捕获里没有断言只是因为 driver 把 `reason` 截在 webServer stderr 上。判法可复用：`gate=goal` 红 + `reason` 只有 webServer 引导输出 ⇒ **必须**读 `<dataDir>/test-results/<spec>/error-context.md`，不得据此断言「无测试输出 / 启动即哑」。

### 为什么前两次修复没兜住

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rln "^goal_ac: *AC-199" tasks/` 命中 2 条，`gap-ac199-dock-stop-background-controls-browser`（`status: done`，交付坞控件 + 调试 agent 控制缝 + e2e 用例）与 `gap-ac199-criterion-ledger-red-is-silent-e2e-death`（`status: done`，verification-only 归因入档）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-199`）⇒ **0 命中**。两条 done **都不是重复**：第一条交付了产品面但从没做过负载鲁棒性，第二条明写「不做任何实现 / 判据 / 宿主配置改动」且归因错（见上），所以负载下的红一次都没被碰过，本轮照旧复发。

### 缺口机制：整轮墙钟的固定开销随宿主负载膨胀，越过 AC 自己的 40s

带时间戳的安静跑（本条实测，`npx playwright test … 2>&1 | while read l; do printf '%6dms %s\n' …; done`）：

```
  533ms  [e2e] data-dir=…                     config 求值 + data-dir 选择完成
  779ms  [e2e] server=… client=…              端口分配完成
 5011ms  Running 1 test using 1 worker        webServer 引导完成（~4.2s）
13584ms  ac2.snapshot…                        浏览器启动 + 打开会话/坞 + beforeAll（~8.6s）
13662ms  ac3.main click-instant…              点击瞬间读数（本条要守住的那个窗口）
24567ms  ac3.settled: …                       等场景时钟的事件到达（~10.9s 纯等待）
25058ms  AC-199 wall clock: 24524ms
25263ms  1 passed (24.3s)
```

三段固定开销：(1) `npx`+config 求值+webServer 引导 ≈ 5.0s；(2) 浏览器启动+页面+beforeAll ≈ 8.6s；(3) **场景时钟 12s 的等待 ≈ 10.9s**——`CONTROL_SCENARIO` 把停止事件放在 `STOP_EVENT_AT = 12_000`、转后台帧放在 `BG_STARTED_AT = 12_300` / `BG_UPDATED_AT = 12_600`（`e2e/activity-dock-background.spec.ts:452-454`），spec 的注释逐字写「Both control *events* are far down the clock (12s), so the whole click-and-read window happens before either」。安静合计 24.3s，负载下这四段一起膨胀到 46.7–49.9s（`Received` 四值）。⛔ 单纯把 12s 调小**不是**解：点击-读数窗口自己就要 ~8.5s，缩短偏移会让窗口在负载下与事件到达赛跑，把 AC3 的「点击瞬间不改状态」读数翻红——那是把一种红换成另一种红。

**本条要求把固定开销做成负载不敏感，并给出负载臂实测。** 允许的杠杆（worker 自选，但每条都必须实测其墙钟贡献）：把「事件到达」从固定时钟偏移改成**由 spec 自己的进度释放**的确定性握手（消掉那 ~10.9s 固定等待，同时消掉赛跑）；削减 (1)(2) 两段固定开销（config 求值 / seeding / webServer 引导 / 浏览器启动 / beforeAll 里可去掉的等待与重载回退）。⛔ **不得**改判据命令、**不得**改 `goals/AC-199-…md` 的 `criterion:` / `expect:`、**不得**放宽或删除 40s 上限、**不得**弱化 `ac3.main` / `ac4.backgrounded` / `ac6.partition` / `ac7.falseForm` 任何一条读数。

## Plan

1. 建本条隔离 worktree（起点 = 开工时 `develop`），打印路径、`git rev-parse HEAD`、`git rev-parse HEAD^{tree}`，确认 `git status --porcelain` 空。
2. 机械复录红态证据：对 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-{inGCF7,WY3mdE,KkIGnM,RHTPBc}` 逐个 `cat` 其 `test-results/*/error-context.md` 的 `# Error details` 段与 `watchdog-state.json`，逐字入档；写明 `e2e/activity-dock-background.spec.ts:755` 是断言落点，并写明 task B 的「无测试输出」结论被这四份 artifact 推翻。
3. 在净 worktree 上做安静臂基线：出货命令逐字跑 ≥3 次，记录 exit code、spec 自印 `AC-199 wall clock`、整轮墙钟。
4. 按带时间戳跑法（`npx playwright test … 2>&1 | while IFS= read -r l; do printf '%6dms %s\n' "$(($(date +%s%3N)-START))" "$l"; done`）量出三段固定开销的现状，作为改动前的对照读数。
5. 实施改动：优先做第 Proposal 段的确定性释放握手（spec 读完点击瞬间后自己触发事件），并顺手削减 (1)(2) 两段可去掉的固定开销。改 `server/**` 时按 AGENTS.md 载入并遵守 `$backend-module-standards`；改 `src/**` 时载入 `$frontend-module-standards`。⛔ 该 spec 与 AC-194 共享，改动用 add/add 纪律（从 develop 取文件、只改本条拥有区段，见 `shared-e2e-spec-add-add-merge-take-develop-then-append-renamed`）。
6. 安静臂复测 ≥3 次，全部 exit 0 且 `AC-199 wall clock ≤ 40000`；再跑 AC-194 判据确认同文件兄弟不回归。
7. 负载臂：用能复现膨胀的并发负载（≥2–3 个兄弟浏览器 spec 或等价注入负载）重跑判据 ≥2 次，全部 exit 0 且 ≤40000；入档负载生成命令、并发度、宿主 `load1`、每次墙钟。负载臂墙钟必须与安静臂有可见差距，否则负载没造出来、本条不算验证。
8. 若负载臂仍有 >40000ms：停手，置 `needs-human`，附逐字读数；⛔ 不改上限、不把安静通过写成修复。交付只落在实现文件 + `tasks/<本条 id>.md`。

## AC

- [ ] AC1 红态真因机械入档：四个 data dir 的 `error-context.md` 的 `# Error details` 逐字打印为 `Error: the criterion must complete within 40s` + `Expected: <= 40000` + `Received: 49607 / 49866 / 46688 / 46801`，四个 `watchdog-state.json` 逐字为 `fired:false`；写明断言落点 `e2e/activity-dock-background.spec.ts:755`，并写明 task B 的「无测试输出 / 启动即哑」归因被这四份 artifact 推翻。
- [ ] AC2 安静臂基线：净 worktree 上出货命令逐字跑 ≥3 次，全部 exit 0 且 spec 自印 `AC-199 wall clock` ≤ 40000；入档 worktree 路径、`HEAD`、`HEAD^{tree}`、每次墙钟。
- [ ] AC3 负载臂达标：在能复现膨胀的并发负载下跑 ≥2 次，全部 exit 0 且 `AC-199 wall clock` ≤ 40000；入档负载生成命令、并发度、宿主 `load1`、每次墙钟，且负载臂墙钟与安静臂有可见差距（证明负载真的造出来了）。
- [ ] AC4 读数与上限都未弱化：`grep -n "toBeLessThanOrEqual(40_000)" e2e/activity-dock-background.spec.ts` 仍命中 AC-199 那处；spec 输出里 `ac3.main click-instant: before=running after=running green=true`、`ac7.falseForm click-instant: before=running after=stopped green=false`、`ac4.backgrounded … toolUseId==foreground`、`ac6.partition … stopDisabled=true bgDisabled=true` 逐字仍在；`goals/AC-199-…md` 与判据命令逐字未改（`git diff <base>..HEAD -- goals/` 为空）。
- [ ] AC5 兄弟判据不回归：`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` exit 0 且其墙钟 ≤ 40000（该 spec 与 AC-194 共享）。
- [ ] AC6 失败路径如实：若负载臂仍 >40000ms，停手并置 `needs-human`，附逐字读数与已排除项；⛔ 不得放宽 40s 上限、不得删除断言、不得把安静臂通过写成「flake 已修」。

## DoD

- 判据本体（真实浏览器 spec，出货命令逐字不改）在**负载臂**下真的达标过 ≥2 次、exit 0、`AC-199 wall clock ≤ 40000`，读数逐字入档 —— 不是只跑安静臂、不是复述 `expect:`、不是读台账尾巴。
- 红态归因段里每一条读数（四份 `error-context.md`、四个 `watchdog-state.json`、台账尾部 `pass/pass/fail` 序列）都能由任何人在同一 checkout 上用 `cat` / `jq` 复现，不依赖本条转述。
- 改动后 `ac3.main` / `ac4.backgrounded` / `ac6.partition` / `ac7.falseForm` 四条读数与 40s 上限逐字不变 —— 固定开销是被**做小/做实**的，不是被绕过的。
- 交付物只动 Touches 列出的文件 + `tasks/<本条 id>.md`；`goals/`、判据命令、40s 上限一个字节未动。

## Touches

- `e2e/activity-dock-background.spec.ts`（判据本体：40s 断言落点与 `CONTROL_SCENARIO` 的 12s 时钟偏移；与 AC-194 共享该文件）
- `server/modules/debug-agent/debug-agent.scenario.ts`（场景步/时钟偏移的类型与解析）
- `server/modules/debug-agent/debug-agent.engine.ts`（`POST /clock` 驱动场景步进与 `wait` 的实现）
- `server/modules/debug-agent/debug-agent.routes.ts`（控制面路由；若要新增「释放事件」的显式控制动词则加在这里）
- `server/modules/debug-agent/tests/debug-agent-control-plane.test.ts`（控制面行为的单测覆盖）
- `server/modules/debug-agent/tests/debug-agent-typed-turn.test.ts`（时钟/步进语义的单测覆盖）
- `playwright.config.ts`（`QUAY_E2E_RUN_STARTED_AT` 起算点、`DEBUG_AGENT_SPEC_FILES` 选段与 config 侧固定开销读数）
- `tasks/gap-ac199-criterion-wallclock-load-scaled-fixed-cost.md`（自触）
