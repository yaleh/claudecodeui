---
id: gap-ac175-criterion-red-is-uncommitted-composer-wip
title: AC-175 判据在净检出上直跑为绿（3 passed），台账红由主检出的未提交 composer 布局 WIP
  造成：ChatComposer.tsx 用了 cn(...) 未导入 ⇒ ReferenceError 崩掉聊天面板，判据首条「打开会话」30s
  超时——verification-only 归因入档，钉住「未提交 WIP 崩 ≠ AC-175 回归」（remedy：随该 WIP 提交 import {
  cn } from '@/shared/utils'）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-175
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-10-02，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `ccffe44c`，branch `author`）：`grep -rln '^goal_ac: *AC-175' tasks/` → 4 份，**全部 `status: done`**（`gap-claude-resident-busy-send-ui`、`gap-activity-heartbeat-frame-crashes-realtime-merge`、`gap-ac175-criterion-anchor-retired-by-dock-consolidation`，以及 `gap-resident-composer-hides-enable-affordance` 正文提及）。在飞（todo/ready/needs-human）认领者实测为 **0**：`tasks/` 里 todo/ready/needs-human 的只有 `gap-ac173-badge-source-mismatch-after-dock-consolidation`（goal_ac: AC-173）与 `gap-activity-dock-human-gate`（goal_ac: AC-190）。按「done 不算重复、是更早修复没兜住的证据」本应立新条——但**本条的两处直跑推翻了默认读法**：更早三条修复在净检出上**都还在**，判据净检出直跑为绿，红不在被提交的代码里。

**判据物（逐字取自 `goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md` 的 `criterion:`）**：`npx playwright test e2e/resident-busy-send.spec.ts`。

**本轮两处直跑（同一 checkout，读数不是推断，也不是台账尾巴）**：

（1）**主检出当前工作树（带未提交改动）直跑 → 红**，退出 1，`1 failed / 2 did not run`：

```
Error: expect(locator).toBeVisible() failed
Locator: locator('.chat-messages-pane')
Expected: visible  Timeout: 30000ms  Error: element(s) not found
  at openSession (e2e/resident-busy-send.spec.ts:352:36)
  at e2e/resident-busy-send.spec.ts:623:5
[e2e] page console error: ErrorBoundary caught an error: ReferenceError: cn is not defined
    at ChatComposer (http://127.0.0.1:.../src/modules/chat/composer/ChatComposer.tsx:288:18)
```

红落在判据的**第一条读数**（`openSession` 等 `.chat-messages-pane`），**根本没走到 AC 的任何一条断言**——聊天面板整棵被 React ErrorBoundary 换掉，pane 永不出现。

（2）**同一 checkout 把 4 个未提交改动 stash 掉、净树（HEAD `ccffe44c` = `develop` 内容）再直跑 → 绿**，退出 0，`3 passed (36.3s)`：

```
resident.queuedCard=0
resident.row.present=true
resident.row.annotationKey=resident.pending.annotation
resident.row.annotation=Will be handled after this answer finishes
withdraw.visibleBefore=true  click.dispatched=true  ui.withdrawnBeforeEvent=false
ui.withdrawnAfterEvent=true  row.presentAfter=false  turnsAfterWithdraw=0
cancelPayloads=1  controlResponsesForCancel=0  cancelVerdictSource=command_lifecycle
afterStarted.withdrawButton=0  afterStarted.annotationKey=resident.pending.started
perRun.queuedCard=1
withdrawn.run.ok=true status=200  started.run.ok=true status=200
  3 passed (36.3s)
```

AC 点名的每一条读数都在场（resident 不走 `QueuedMessageCard`、标注、撤回三态、per-run 正控制）。⇒ **被提交的树满足 AC-175**。

**机制（本轮定位，含崩溃栈）**：主检出工作树里的 4 个未提交改动是一份**尚未提交的 composer 布局 WIP**（短视口 tier + 工具内联 tier：`useDeviceSettings` 加 `isShortViewport`、`useComposerCompactTier` 加 `areToolsInline`、`ChatComposer` 按其改版），配套未跟踪的 `docs/proposals/mobile-workspace-and-composer-layout.md`。其中 `src/modules/chat/composer/ChatComposer.tsx` 未提交版本在 **549** 与 **899** 两处用了 `cn(...)`，却**没有** `import { cn } from '@/shared/utils'`：

```
$ grep -n 'cn(' src/modules/chat/composer/ChatComposer.tsx        # 工作树
549:      className={cn(
899:          className={cn(
$ grep -n "import.*cn" src/modules/chat/composer/ChatComposer.tsx # 无输出（没有导入）
$ git show HEAD:src/modules/chat/composer/ChatComposer.tsx | grep -c '\bcn\b'
0
```

`cn` 定义在 `src/shared/utils.ts:22`，全仓其它调用点一律 `import { cn } from '@/shared/utils'`；没有任何全局声明 ⇒ 既 `tsc` 报 TS2304，运行时又是 `ReferenceError`。浏览器里 ChatComposer 一挂载就抛，ErrorBoundary 接住，聊天面板整棵不渲染 ⇒ 判据首条读音红。**该 WIP 无归属任务**：`grep -rl 'isShortViewport\|areToolsInline\|短视口' tasks/ goals/` → 0；`git log -S isShortViewport -- src/`、`git log -S areToolsInline -- src/` → 0（从未提交）。

**台账归因读数**：`.quay/gate-events.jsonl` 里 AC-175 `gate=goal` 尾巴是 **`pass` 后接 `fail`**：

```
2026-10-02T12:57:14.694Z  goal-cli   pass  acceptance passed (exit 0)
2026-10-02T13:04:26.537Z  goal-cli   fail  acceptance failed (exit 1) — [WebServer] [BABEL] ...（687 chars of stderr omitted）
```

`fail` 时刻（本地 21:04）与未提交 WIP 落进主检出的时刻（`src/shared/tests/useDeviceSettings.test.ts` mtime = 21:02）同窗；12:57 的 `pass` 在 WIP 落地之前。⇒ 台账这次的红是**主检出的未提交物崩**，不是 AC-175 的承诺退化。

**本条的交付面（verification-only，不改实现/判据/宿主配置一个字节）**：把上面两处直跑读数与归因做成**可复核的入档读数**，并钉住判法「未提交 WIP 崩 ≠ AC-175 回归」。**不在未提交物上改代码**：`cn` 缺导入属于那份 composer 布局 WIP 自身，正确落点是随该 WIP 一起提交 `import { cn } from '@/shared/utils'`（由该 WIP 的作者/归属任务处理），本条只登记，不夹带修它，也不改动那份未提交工作树。

## AC

- [ ] AC1 判据在**净树**直跑：把主检出的 4 个未提交改动 stash 后（或用隔离 worktree，起点 = `develop`）跑 `npx playwright test e2e/resident-busy-send.spec.ts`，退出 0，把判据自己打印的读数行**逐字**抄进完成记录（`resident.queuedCard=0`、`resident.row.present=true`、`resident.row.annotationKey=resident.pending.annotation`、`withdraw.visibleBefore=true`、`click.dispatched=true`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`row.presentAfter=false`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`controlResponsesForCancel=0`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.annotationKey=resident.pending.started`、`perRun.queuedCard=1`、`withdrawn.run.ok=true`、`started.run.ok=true`、`3 passed`），并给出跑动时刻（`date -u`）与 `git rev-parse HEAD`。
- [ ] AC2 归因可复现（任何人可复跑）：在工作树跑 `npx playwright test e2e/resident-busy-send.spec.ts` 复现退出 1 且红在 `e2e/resident-busy-send.spec.ts:352`（`.chat-messages-pane` not found），并从页面 console 抄到 `ReferenceError: cn is not defined` at `ChatComposer.tsx`；同时用 `grep -n 'cn(' src/modules/chat/composer/ChatComposer.tsx` 给出两处调用行、`grep -n "import.*cn" src/modules/chat/composer/ChatComposer.tsx` 给出**无导入**、`git show HEAD:src/modules/chat/composer/ChatComposer.tsx | grep -c '\bcn\b'` 给出 **0**。
- [ ] AC3 台账归因读数（机械）：用 `python3`/`jq` 读 `.quay/gate-events.jsonl`，打印 AC-175 `gate=goal` 尾巴的 `verdict` 序列（应含那对 `pass`→`fail`）、两条的 `timestamp` 与 `payload.reason` 逐字，并指明 `fail` 时刻与该未提交 WIP 的 mtime 同窗。
- [ ] AC4 无归属任务读数：`grep -rl 'isShortViewport\|areToolsInline\|短视口' tasks/ goals/`（应为空或只命中本条）与 `git log --oneline -S isShortViewport -- src/`（应为空），证明该 WIP 无 task/commit 认领。
- [ ] AC5 如实登记：若本轮之后 driver 的独立复核里 AC-175 `gate=goal` 尾巴仍为 `fail`，完成记录里**逐字写明**「台账尾巴仍是 fail」并附 AC1 的直跑读数，不得写成已通过，也不得用组件层 jsdom 的绿替代浏览器层的绿。
- [ ] AC6 字节纪律：`git diff --name-only develop..HEAD` 只含 `tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip.md`；未提交的 4 个 composer 文件与本条启动时逐字相同（本条**未**改 `src/**`、`e2e/resident-busy-send.spec.ts`、`playwright.config.ts`、宿主配置一个字节）。

## DoD

- 判据本体（出货命令 `npx playwright test e2e/resident-busy-send.spec.ts`）在**净树**上被真的跑过一次，读数行逐字入档——不是复述 expect 的文字，也不是读台账尾巴。
- 归因段落里的每一条读数（两处 `cn(` 行号、无导入、HEAD `cn` 计数 0、脏树 `ReferenceError` 崩溃栈、`fail` 与 WIP mtime 同窗）都能由任何人在同一 checkout 上复现。
- 完成记录里明确写出「被提交的树满足 AC-175；台账红是主检出的未提交 composer WIP 崩」，并指出 remedy：随该 WIP 提交 `import { cn } from '@/shared/utils'`。
- 交付物只动 `tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip.md`：判据文件、实现、未提交工作树、宿主配置一个字节未动。

## Touches

- tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip.md
- e2e/resident-busy-send.spec.ts （本条只跑不改：AC1/AC2 的判据本体）
- src/modules/chat/composer/ChatComposer.tsx （本条只读不改：未提交 WIP 的 `cn` 未导入证据）