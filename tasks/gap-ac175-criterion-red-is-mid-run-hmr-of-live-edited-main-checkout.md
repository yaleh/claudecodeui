---
id: gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout
title: "AC-175 判据 2026-10-03T09:28:13.036Z 那拍的红由主检出未提交 composer WIP
  在判据运行途中被保存、Vite 把这次保存当 HMR 推给正在跑的页面把树打崩（pageError: useWebSocket must be used
  within a WebSocketProvider ⇒ cancelled 帧未被处理 ⇒ waitForLifecycle 30s
  超时）——verification-only 归因入档：净树直跑 3 passed / exit 0，台账前五拍连续 pass；remedy 归该 WIP
  作者（勿在判据运行期保存主检出）"
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-175
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。AC-175 `status: achieved`，其 GOAL-013 已 achieved 且不再活，未声明 `long-term: true`；台账尾部 `2026-10-03T09:28:13.036Z` 那拍记为 fail，驱动器在立案前重跑判据得 exit 1，故按 CURRENTLY FALSE 立案。

判据物（逐字取自 `goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md` 的 `criterion:`）：`npx playwright test e2e/resident-busy-send.spec.ts`。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `a85348f3`，branch `author`）：`grep -rln '^goal_ac: *AC-175' tasks/` → **5 份**，`status:` 逐字皆 **done**（`gap-ac175-criterion-bounded-boot-guard`、`gap-claude-resident-busy-send-ui`、`gap-ac175-criterion-red-is-uncommitted-composer-wip`、`gap-activity-heartbeat-frame-crashes-realtime-merge`、`gap-ac175-criterion-anchor-retired-by-dock-consolidation`）。在飞扫描（`tasks/*.md` 的 `^status:` ∈ todo/ready/needs-human）→ 全库只有 `tasks/gap-activity-dock-human-gate.md`（`goal_ac: AC-190`），**无一认领 AC-175** ⇒ 无在飞认领者。按「done 不算重复、是更早修法没兜住的证据」：更早五条里最接近的是 `gap-ac175-criterion-red-is-uncommitted-composer-wip`（**启动期**崩：未提交 WIP 里 `ChatComposer.tsx` 用了未导入的 `cn` ⇒ ReferenceError ⇒ 判据首条「打开会话」30s 超时），本条是**另一条触发路径**：同一份未提交 composer WIP 在**判据运行途中被保存**，Vite 把保存当 HMR 推给正在跑的页面 ⇒ 页面 React 树在**用例进行中**崩 ⇒ 被测的 `cancelled` 帧没被处理（失败行、触发源、remedy 全不同）。同形先例见 `tasks/gap-ac173-ledger-red-is-uncommitted-composer-wip.md`（它逐字作了同样的区分：「那条是 `cn` 未导入在启动期崩，本条是运行期 HMR 崩」）。⇒ 本条不是重复。

**本轮直接测量（读数不是推断）**

（1）**净检出直跑 → 绿**（立案前在净检出上重跑出货命令）：`npx playwright test e2e/resident-busy-send.spec.ts` → EXIT **0**，`3 passed (36.5s)`，`elapsed=38440ms`。判据自己打印的读数逐字：`resident.queuedCard=0`、`resident.row.present=true`、`resident.row.annotationKey=resident.pending.annotation`、`withdraw.visibleBefore=true`、`click.dispatched=true`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`turnsAfterWithdraw=0`、`cancelPayloads=1`、`scenario.cancel_async_message=5c612b9c-…`、`controlResponsesForCancel=0`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`afterStarted.label=Started processing`、`perRun.queuedCard=1`。⇒ **被提交的树满足 AC-175。**

（2）**台账尾巴**：`.quay/gate-events.jsonl` 里 AC-175 `gate=goal` 的末六拍逐字为 `08:57:17.468Z pass` → `09:03:36.129Z pass` → `09:09:30.089Z pass` → `09:14:50.056Z pass` → `09:22:03.250Z pass` → `09:28:13.036Z fail`。**五连 pass 之后一拍 fail**。

（3）**那拍 fail 的机制（从其失败跑自己的 trace.zip 读出，不是猜）**：失败跑数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-JHgwgn`；其 `watchdog-state.json` = `{"armed":true,"fired":true,"ceilingMs":40000,"detail":"boot ceiling crossed at 40000ms"}`；`test-results/resident-busy-send-residen-7053b-al-is-the-process-s-own-act/error-context.md` 逐字 `Error: expect(received).toBe(expected) // Object.is equality / Expected: true / Received: false` + `Call Log: - Timeout 30000ms exceeded while waiting on the predicate`。解包 `trace.zip` 后，同一页面（`page@cd6f566ebc47e27c1761b82620f32698`，三段 trace 同属 `resident-busy-send.spec.ts:855` 这一条用例）的 `6-trace.trace` 逐字：

```
13701.953  console debug  [vite] hot updated: /src/index.css
13702.200  console debug  [vite] hot updated: /src/modules/chat/ChatInterface.tsx
13728.459  pageError      useWebSocket must be used within a WebSocketProvider   (at ProjectWorkspaceRouteContent)
13731.548  pageError      （同）
13742.514  pageError      （同）
13733.849  console error  The above error occurred in the <ProjectWorkspaceRouteContent> component: ...
```

`6-trace.trace` 首行 `wallTime=1791019662914`（= `2026-10-03T09:27:42.914Z`）、`monotonicTime=10248.76` ⇒ HMR 落在 **`09:27:46.367Z`**、pageError 落在 **`09:27:46.394Z`**。同轮 `test.trace`（`wallTime=1791019656469` = `09:27:36.469Z`）显示：用例体自 `t=10234ms` 起，`withdraw` 点击在 `t=10576ms`，`cancelPayloads>=1` 的轮询在 `t≈10627ms` 已过，而被测的 `waitForLifecycle(..., 'cancelled', 30_000)`（spec `:933`，poll 体 `:631`）自 `t=10641.825ms`（= `09:27:43.307Z`）起、到 `t=39692.066ms`（= `09:28:12.357Z`）超时。⇒ 因果链：**点击已发出且已被进程收到（`cancelPayloads>=1`）→ 3.1s 后页面树被 HMR 崩掉 → `cancelled` 帧再没被处理 → 30s 轮询超时 → `09:28:13.036Z` 记 fail**。

**触发源是谁**：`find src e2e playwright.config.ts -newermt '2026-10-03 17:20' ! -newermt '2026-10-03 17:35' -type f`（本地 = UTC+8）只命中 `src/modules/chat/hooks/useChatComposerState.ts` 与 `src/modules/chat/tests/composerDraftScoping.test.tsx` —— 即主检出那份**未提交的 composer WIP**（`ChatInterface.tsx` / `index.css` 出现在 HMR 行里是 Vite 沿 import 链传播的 importer，不是被保存的文件：两者 mtime 分别是 `11:18:47` / `10:46:30`，早于本跑数小时）。该 WIP 随后在 `09:28:22Z` / `09:28:26Z` 再被保存，并在 `09:29:00Z`（本地 `17:29:00`）提交为 develop 的 `cc658aec`（`fix(chat): retire the project draft a first resident send was typed in`）。⇒ **台账那拍红 = 主检出工作树在判据运行途中被保存、Vite 把这次保存当 HMR 推给正在跑的页面、承载页面的 React 树崩掉、被测的 `cancelled` 帧随之无人处理**，不是 AC-175 的承诺退化。

**这条是什么、不是什么**：verification-only 归因入档。它**不**改实现、判据、宿主配置一个字节，也**不**动主检出的活 WIP（`stash` / `git checkout --` / 编辑一律不做——那份 WIP 归其作者）。它交付的是可复核的读数与判法：**「未提交 WIP 在判据运行途中的 HMR 推送把页面打崩 ≠ AC-175 回归」**，以及 remedy —— 该 WIP 的作者不要在判据运行期保存主检出（或把它改到可编译并提交）。

## Plan

1. 建本条的隔离 worktree（起点 = 开工时的 `develop`；`git status --porcelain` 空），在**其中**跑出货命令两次：一次普通跑（读退出码 / `3 passed` / `elapsed`），一次带 `--trace on`（留一份**净树**的 trace 作对照）。
2. 从净树那次 trace 里读出同一条用例的页面事件，证明净树跑里**没有** `pageError`、**没有** `[vite] hot updated`（与本条的失败跑逐字对照）——这是本条归因的承重分辨力。
3. 从失败跑留下的 `trace.zip` 里把 Proposal(3) 的每条读数**重新解包、逐字抄**（trace 路径与解包命令写进完成记录）；若该目录已被 6h TTL 回收，改用本条隔离 worktree 里的同机制复现：在跑动途中保存一个 `src/modules/chat/**` 文件制造 HMR，读到同一 pageError 后立即回退并证明零残留。
4. 机械核对「触发源是谁」与「无归属」：`find` 窗口读数、两条 composer 文件的 mtime、`cc658aec` 的提交时刻、在飞任务扫描（无 AC-175 认领者）。
5. 如实登记台账尾巴与本条读数；交付只落在 `tasks/<id>.md`。

## AC

- [ ] AC1 判据在**净检出**（本条自己的隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑：`npx playwright test e2e/resident-busy-send.spec.ts` 退出 **0**、`3 passed`、`elapsed < 55_000ms`，并把判据自己打印的读数行逐字抄进完成记录（至少含 `resident.queuedCard=0`、`ui.withdrawnBeforeEvent=false`、`ui.withdrawnAfterEvent=true`、`cancelPayloads=1`、`cancelAckFrames=1`、`cancelVerdictSource=command_lifecycle`、`afterStarted.withdrawButton=0`、`perRun.queuedCard=1`）。红态基线（本轮立案读数）：主检出直跑那跑 EXIT=1、`Timeout 30000ms exceeded while waiting on the predicate`。
- [ ] AC2 分辨力（承重）：净树那次带 `--trace on` 的跑里，同一条用例的页面事件中 `pageError` 计数为 **0**、`[vite] hot updated` 计数为 **0**；把两条计数命令与逐字输出入档，并与失败跑的 `pageError=3` / `hot updated=27`（15×`index.css` + 12×`ChatInterface.tsx`）逐字对照。⚠️ 若净树跑因宿主原因出现无关 pageError，点名归因并给出可区分读数，不得含糊。
- [ ] AC3 归因读数逐字入档：从 `~/.cache/quay-e2e-tmp/quay-e2e-JHgwgn/test-results/resident-busy-send-residen-7053b-al-is-the-process-s-own-act/trace.zip` 解包，打出 `6-trace.trace` 的 `hot updated` 行与 `pageError` 行的**相对时刻 + 由 `wallTime`/`monotonicTime` 换算出的绝对时刻**（本轮读数：HMR `09:27:46.367Z`、pageError `09:27:46.394Z`），以及 `test.trace` 里被测轮询的起止（`09:27:43.307Z` → `09:28:12.357Z`）；trace 路径与解包命令写进完成记录。若该目录已被回收，按 Plan(3) 用同机制复现替代，并证明复现后零残留（`git status --porcelain` 回到空）。
- [ ] AC4 触发源与归属（机械）：`find src e2e playwright.config.ts -newermt '2026-10-03 17:20' ! -newermt '2026-10-03 17:35' -type f` 只命中两份 composer 文件；`stat -c '%y %n'` 给出两份文件 mtime（本轮 `17:28:26` / `17:28:22`）；`git log -1 --format='%h %ad %s' --date=iso cc658aec` 给出提交时刻（`17:29:00`）；在飞任务扫描显示无任务认领 AC-175。四条命令与逐字输出入档。
- [ ] AC5 承重面未被本条触碰：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`；主检出 `git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `src/**`、`e2e/**`、`server/**`、`playwright.config.ts`）。
- [ ] AC6 如实登记：完成记录逐字写明「被提交的树满足 AC-175」与「台账 `09:28:13.036Z` 那拍红由主检出未提交 composer WIP 在运行途中的 HMR 推送造成」，并附 AC1 的净树读数；⛔ 不得用组件层/jsdom 的绿替代浏览器层的绿。

## DoD

- 出货命令（`npx playwright test e2e/resident-busy-send.spec.ts`，逐字不改；⛔ 不加 `-g`、不 skip、不加 `retries`、不改断言）在净检出上真的跑过，读数行逐字入档——不是复述 `expect` 的文字，不是读台账尾巴。
- 归因的每一条读数（HMR 行 + pageError 行的时刻、被测轮询的起止、触发文件与提交时刻）都能由任何人在同一 checkout 上从那份 `trace.zip`（或本条隔离 worktree 里的同机制复现）复现；trace 路径与解包命令写进完成记录。
- 完成记录明确写出判法：**「未提交 WIP 在判据运行途中的 HMR 推送把页面打崩 ≠ AC-175 回归」**，并给出 remedy：该 WIP 的作者不要在判据运行期保存主检出（或把它改到可编译并提交）。
- 交付物只动 `tasks/<本条 id>.md`：判据文件、实现、未提交工作树、宿主配置一个字节未动。
- 若净树直跑为**红**（即红不依赖运行期编辑），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」——⛔ 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- tasks/gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout.md（自触）
- e2e/resident-busy-send.spec.ts（本条只跑不改：AC1/AC2 的判据本体，出货命令逐字不改）
- src/modules/chat/hooks/useChatComposerState.ts（本条只读不改：触发保存的文件 / mtime 与提交时刻证据）
- src/modules/chat/tests/composerDraftScoping.test.tsx（本条只读不改：同一窗口的第二份被保存文件）
- goals/AC-175-真实浏览器里常驻会话忙时发送直接送达-不走前端本地排队-标注与-cli-实际归属一致.md（本条只读不改：criterion/expect 的逐字来源）