---
id: gap-task-terminal-transition-transcript-row
title: 后台任务由非终态转终态时，服务端 reducer 发一条转写事件：任务停了，会话记录里一定留一行（带稳定 id，重放不重复）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

用户要求：坞只表示当前活动（计数随任务结束而减，终态不留在坞里，见兄弟任务 `gap-dock-counts-only-live-tasks-and-retires-strip`），而「某个后台任务停了」这件事要在上方会话记录里留下一行。裁定：**由服务端在 reducer 里发转写事件**，不由客户端在任务表变化时本地插入（本地插入刷新页面就没了，也与历史重放不一致）。

**为什么现状不保证有这一行（读代码与此前真实帧序实测）。** 转写里现有的「Background task finished」行来自 CLI 排队写入 JSONL 的 `<task-notification>` 用户行（`useChatMessages.ts` 的 `parseTaskNotification`），它在后台子代理与 Monitor 事件上稳定出现；但此前对真实 SDK 的实测里，后台 `Bash` 结束时只有 `system/task_updated{status:completed}`，**没有**对应的 `task_notification`；从坞里停止的任务是否在转写里留行，现有代码也没有保证。所以不能依赖那个通知行，必须由任务表自己的终态转换产生一行。

**接缝（读代码）。** `server/modules/providers/services/claude-activity-task-reducer.service.ts` 的 `applyTaskUpdated` / `applyTaskNotification` / `reconcileStopHook`（Stop hook 快照把 running 判为 `ended`）是任务进入终态的全部入口；`server/modules/providers/list/claude/claude-runtime.provider.ts` 在每帧后用 `activitySignature` 前后比对来 tick 活动协议，是已经在场的观察点。归一化帧类型里已有 `task_notification`（`server/shared/types.ts`，客户端 `useChatMessages.ts` 的 `case 'task_notification'` 已能把它画成带 `taskStatus` 的助手通知行），所以客户端渲染面基本现成，缺的是服务端在「非终态 → 终态」那一刻发出该帧。

**必须解决的三个难点，立案时先点明，执行时各自出读数。** ① 同一任务同一次终态转换只发一次：任务 id + 终态作稳定键；快照重放、`task_started` 重放、Stop hook 二次对账（reducer 注释里明确要求幂等）都不得产生第二行。② 已有 CLI 通知行的任务（子代理、Monitor）不能再多出一行重复的：要么按 `task-id` 与已有通知行合并，要么在已有通知行存在时不发，须在执行时实测两种来源并选定一种并写进完成记录。③ 刷新或重连后行还在：事件要落在与其它转写帧同一条可回放的序列里（`chat.subscribe` 的 seq 回放），而不是只推一次的 `activity.*` 帧。

<!-- dedup-ref --> 相关任务：`gap-dock-counts-only-live-tasks-and-retires-strip`（兄弟，坞侧只数活动任务；两者互不依赖，各自可独立落地，合起来才是用户要的完整体验）、`gap-activity-task-reducer`（AC-191，reducer 本体，done）、`gap-chat-stop-task-event-confirmed`（AC-196，停止任务由事件确认，done）、`gap-ac200-monitor-event-projection-collapse`（AC-200，Monitor 事件折叠，done，本任务产生的行不得破坏它的折叠）。

## Plan

1. 先取证再动手：用调试 agent 夹具或真实帧序，分别读出四类终态来源（`task_notification`、`task_updated{completed|killed}`、Stop hook 快照 `ended`、坞停止后的 `stopped`）在转写里现在各留几行；把读数写进完成记录。
2. 在 reducer 里加一个「终态转换」输出：`observe` / `reconcileStopHook` 返回或通过注入的回调报出 `{sessionId, taskId, toolUseId?, from, to, description, summary?, endedAt?}`，只在状态从 `running|blocked` 进入终态的那一次触发（幂等：同一任务已是终态时再来同样的终态不触发）。
3. `claude-runtime.provider.ts` 在已有的 `activitySignature` 比对旁消费该输出，发出一条归一化的 `task_notification` 帧（带稳定 id 与 `status`、`summary`/描述），经与其它转写帧相同的 writer 路径下发并进入 seq 回放；已有 CLI 通知行的任务按 ② 去重。
4. 客户端基本不改：确认 `useChatMessages.ts` 现有 `task_notification` 分支能画出 completed / failed / stopped / ended 四种状态；若需要为 `ended`（原因未知）补一句文案，在 12 个语种的 `chat.json` 同步，但本任务 Touches 不含客户端文件时就只验证、不动。
5. 单测落在既有测试文件里：reducer 的终态转换幂等与四类来源、runtime 的帧转发覆盖；不新增测试文件。

## AC

- [ ] AC1 终态转换恰好一次：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-activity-task-reducer.test.ts` 退出 0；新增例子给定 `task_started` 后依次喂 `task_updated{completed}`、同一 `task_notification{completed}`、再重放整段序列，终态转换回调**只触发 1 次**。
- [ ] AC2 四类终态来源都有一行：新增例子分别驱动 `task_notification(completed|failed|stopped)`、`task_updated{status:'completed'}`（无通知行）、`task_updated{status:'killed'}`、Stop hook 快照使 running 任务变 `ended`，每一类各产生 1 条转换，且 `to` 分别为 `completed | failed | stopped | stopped | ended`。
- [ ] AC3 帧真的下发且可回放：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts` 退出 0；新增例子里任务进入终态后 writer 收到一条 `kind:'task_notification'` 帧，带稳定 id 与 `status`；同一 session 重新订阅按 seq 回放时该帧仍在且只有一条。
- [ ] AC4 不与 CLI 通知行重复：新增例子对一个后台子代理（CLI 会写 `<task-notification>` 用户行）与一个后台 Bash（不会写）各走一遍，转写投影后前者终态只有 1 行、后者终态也只有 1 行；选定的去重方式写进完成记录。
- [ ] AC5 不破坏兄弟：`npx vitest run src/modules/chat/tests/useChatMessages.test.ts` 与 AC-200 的折叠相关测试保持绿；`server/modules/providers/tests/claude-activity-lease-parity.test.ts` 保持绿（租约推导不受影响）。
- [ ] AC6 负控制有分辨力：把「只在非终态→终态时触发」临时改成「每次终态帧都触发」，AC1 的重放例子必须红；打印改前绿、改后红两次读数。
- [ ] AC7 契约面：`npm run lint` 与 `npm run typecheck` 退出 0；`git diff --stat develop...HEAD` 与 Touches 逐条对齐。

## DoD

- 真实的一次后台 Bash 自然结束、一次后台子代理结束、一次从坞里停止 Monitor，在真实或调试 agent 驱动的会话里各让转写多出且只多出一行结束记录，刷新页面后仍在；不是只让单测里的回调被调用。
- 事件由服务端 reducer 的终态转换产生，客户端没有任何本地插入路径；一次重放或 Stop hook 二次对账不会让同一任务多出第二行。
- 与 CLI 自带的 `<task-notification>` 行不重复，去重策略与取证读数（步骤 1 的四类来源现状）写进任务完成记录。
- 不改变任务表保留终态行的事实（转写卡片仍可按 `toolUseId` 找到已结束任务）。

## Touches

- server/modules/providers/services/claude-activity-task-reducer.service.ts
- server/modules/providers/list/claude/claude-runtime.provider.ts
- server/shared/types.ts
- server/modules/providers/tests/claude-activity-task-reducer.test.ts
- server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts
- tasks/gap-task-terminal-transition-transcript-row.md
