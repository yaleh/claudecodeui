---
id: gap-dock-stop-control-inert-when-provider-lacks-stoptask
title: 坞里的 Stop task 在真实 Claude 常驻会话上是惰性的：provider 声明 stopTask:false 而控件的
  disabled 从不读能力矩阵，AC-196/AC-199 却绿在替身路径上
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: finding
---
## Finding

<!-- dedup-ref --> **机制去重读数（本轮立案时实测，2026-10-04）**：`grep -rln "provider-capabilities\|stopTask: false" tasks/` 命中的都是别处的任务，**无一条**认领「真实 provider 不能停止任务、而坞的控件对此说谎」这一机制。`gap-chat-stop-task-event-confirmed`（AC-196）与 `gap-ac199-dock-stop-background-controls-browser`（AC-199）是那两条**替身路径** AC 的实现者，不是本机制的认领者。⇒ 不是重复。

**现象（真实 Claude 常驻会话，隔离实例实测，不是推断）。** 在一个真实 resident 会话（`lifecycleMode: resident, running: true`）里，坞的 TASKS 表列出了三条：一条 `subagent`（completed）、一条 `shell`（completed）、一条 `shell` **running**，后者的描述是 `never-appears.txt appearing in proj (expected never)`，行上带 **Stop task** 按钮。点它之后 **12 秒**再读：该行**仍是 `running`**；同一时刻 Monitor 的进程**还活着**（`until [ -f /data/home/yale/ac190-probe/proj/never-appears.txt ]; do sleep 2; done`）；`GET /api/sessions/<id>/activity` 的 `tasks[]` 里那条也一直 `state: running`。**点击没有任何回执，也没有任何状态变化。**

**机制（三处代码，逐条直读）**：
1. **能力闸关着**：`server/modules/providers/services/provider-capabilities.service.ts:147` —— `stopTask: false, // not covered by E1–E8`。同文件 :27-30 的注释逐字：「Default `false` and set `true` only where a driver was measured to hold the verb … A `false` here is what the stop-task control plane answers `unsupported` for, **before it reaches any driver**.」
2. **客户端不看能力矩阵**：`src/modules/chat/hooks/useActivityControls.ts:119` —— `const disabled = liveness === 'unreachable' || !isConnected || !sendMessage;`。`stopTask`(:126) 直接 `sendMessage({ type: 'chat.stop-task', sessionId, taskId, requestId })`。⇒ 只要 socket 活着，按钮就**可点、有 hover**，与 provider 是否支持无关。
3. **能力矩阵本来就拿得到**：客户端已经在 `useChatProviderState.ts:254` 拉 `api.providers.capabilities()`（`src/shared/api.ts:462` → `GET /api/providers/capabilities`，服务端 `provider.routes.ts:817`），dock 的控制面**只是不读它**。

**判据洞（与 `gap-cross-session-message-dropped-by-ismeta-gate` 同形 —— 判据绿在一条生产到不了的路径上）。** 两条相关 AC 都是 `achieved`，而它们的判据**都在替身上跑**：
- **AC-196**：判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-stop-task.test.ts`，其 `expect` 逐字写着「WS 处理函数加驱动（resident 与 per-run 各一条，**Query 用脚本化替身**）」。
- **AC-199**：判据 `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"`，其 `expect` 逐字写着「**调试 agent 场景**提供一个后台任务与一个前台运行中的工具」。
- 而替身的 host driver 是**接受**的：`server/modules/debug-agent/debug-agent.host-driver.ts:638` `async function stopTask(_appSessionId, _taskId)`，紧邻注释「The substitute's background verb: it accepts.」

⇒ 两条 AC 证明的是「控制面在替身接受时会正确地走完时序」，**没有任何判据碰过真实 provider 的能力闸**。

**波及 AC-201（人工关卡）。** GOAL-015 的 §12.2 第 3 步逐字是「从坞里停止 Monitor」，§12.3 的读数是「由 SDK 的通知变为 `stopped`」—— 正是这条路径。所以该人工关卡按现在的写法**过不了**。AC-201 的机械面已落在 develop（merge `4deb6f5a`：§12 + 通用 checker + 护栏），任务自身 7/7 AC 全绿，停在 `needs-human`；本条的产出（AC1/AC2/AC3 的读数）是决定「改产品还是改关卡文本」的前置。

**非目标**：不改 AC-196 / AC-199 的判据（它们各自测的是控制面与事件确认，都成立）；不动 AC-201 的记录小节文本；不在本条里替人裁定「产品该不该支持停止」——本条只把这条路径变成可判的读数。

## AC

- [ ] AC1 **真实路径的停止真的生效（红态基线必测）**：新增判据证明在真实 Claude 常驻会话上，从坞里停止一个运行中的后台任务/Monitor 之后，它**真的停止** —— 读数可以是进程消失、或 SDK 的 `task_notification` 宣告停止、或 activity 快照里该条 `state` 离开 `running`（给出你选的读法与逐字输出）。**红态基线**：今天这条路径是惰性的（本轮实测：点击后 12s 仍是 `running`，进程仍活），这组读数必须逐字写进完成记录。
- [ ] AC2 **分辨力：判据能区分「被接受」与「不支持」两条路径**：当 provider 声明 `stopTask:false`（或替身拒绝）时，点击**不得**被当成成功 —— 要么给出 `unsupported` 的明确回执并让读者看见，要么控件本身**不可点**（DOM `disabled` 为真且带原因）。「可点但静默无效」是本条要消灭的形态。把能力闸去掉（无条件放行）⇒ 该用例必须红。
- [ ] AC3 **判据洞被堵上**：AC-196 / AC-199 的判据保持绿，同时新增至少一条**真实 provider 能力面**的读数，使「停止可用」这一承诺不再只由替身路径承载。给出「未修复 ⇒ 红 / 已修复 ⇒ 绿」两次读数。
- [ ] AC4 **契约面**：`npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（含任务文件自身）。

## DoD

- 真实 Claude 常驻会话上，从坞里停止一个真的在跑的后台任务/Monitor，**它真的停下来**；停止的**确认来自 SDK 的通知**，不是点击本身（AC-199 已确立的时序不得回退）。
- 判据有分辨力：AC2 的负控制必红；AC3 的两次读数逐字记录。
- 若人的裁定是「产品不支持」：控件在 `stopTask:false` 的 provider 上**不可点并给出原因**，而不是可点却静默无效；AC-201 §12.2 第 3 步随之由人改写（本任务不自作主张改它）。
- 只动 `## Touches` 列出的文件。

## Touches

- server/modules/providers/services/provider-capabilities.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- src/modules/chat/hooks/useActivityControls.ts
- src/modules/chat/transcript/ActivityDockPanel.tsx
- server/modules/websocket/tests/claude-stop-task-capability.test.ts (new)
- e2e/activity-dock-background.spec.ts
- tasks/gap-dock-stop-control-inert-when-provider-lacks-stoptask.md