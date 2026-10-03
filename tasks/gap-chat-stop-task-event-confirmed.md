---
id: gap-chat-stop-task-event-confirmed
title: AC-196 停止任务：WS 处理函数 chat.stop-task 校验会话/归属/任务表，限时，以
  task_notification(stopped) 为确认（resident 与 per-run 双驱动）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-activity-task-reducer
goal_ac: AC-196
---
## Proposal

**这条是什么。** AC-196 的判据逐字：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-stop-task.test.ts`（该文件当前 **ABSENT**，判据红）。它要为活动坞的控制面立第一个动词 `chat.stop-task`：WS 处理函数在**调用驱动之前**自己校验（会话存在 + 归属 + taskId 在任务表且未终结），对停止请求设**上限**，并把「任务真的停了」的确认交给随后到达的 `task_notification(stopped)`（由归约器写任务表），回执只说「请求已受理」，绝不乐观改状态。驱动侧要同时覆盖 **resident**（`ClaudeResidentQuery.stopTask`）与 **per-run**（`claude-runtime.provider.ts` 的 `activeSessions` 实例）两条路径，两者在判据里都用**脚本化 Query 替身**驱动。

**今天的缺口（读代码）。**
- `grep -rn "stopTask" server/ src/` 只有 `claude-host-driver.provider.ts:306` 的一句注释（把 `stopTask` 列在 SDK Query 的实测方法清单里），**没有任何实现或调用**；`ClaudeResidentQuery`（`claude-host-driver.provider.ts:279`）只声明 `interrupt` / 可选 `close?` / `setModel?` / `setPermissionMode?`。
- `chat-websocket.service.ts` 的 dispatch（`:820` 附近的 `case` 表）里没有 `chat.stop-task`；`ProviderRuntimeGateway` 没有 stopTask 动词；`provider-runtime.service.ts` 的 `cancelQueuedInput`（`:448`）只解析 resident 驱动，只有 `abort` 才有 resident/per-run 分叉。
- 能力矩阵 `provider-capabilities.service.ts:116` 的 `residentFeatures` 没有 `stopTask` 项。
- 任务表来源：`createClaudeTaskReducer()` / `getTasks(sessionId)`（AC-191，`tasks/gap-activity-task-reducer.md`，接口见其「接口（本条钉死）」段）。本条 taskId 校验与终态确认读它。

**为什么必须服务端自己校验。** 实测（提案 §9.3）：`q.stopTask(taskId)` 对**运行中**任务约 100ms 后出现 `task_updated{killed}` + `task_notification{stopped}`；对**已结束或不存在的 id 静默 resolve**，不报错、不发任何事件。所以 SDK 不能回答「任务不存在」——`unknown-task` 必须由服务端读任务表得出，且不能靠「驱动调用成功」推断任务停了。

**接口（本条钉死，供判据断言）。**
- 新 WS 动词：`chat.stop-task`，入参 `{ sessionId, taskId, requestId }`。
- 回执：新 kind `control_result`，`{ kind: 'control_result', sessionId, requestId, result }`，`result ∈ 'requested' | 'forbidden' | 'unknown-task' | 'timeout' | 'unsupported' | 'error'`。`requested` **只表示请求已受理**，不携带也不改写任务状态。
- 归属校验走**单一入口**（提案 §4「统一的 assertSessionAccess」）：本任务定义该入口，`chat.stop-task` 调它；`chat.background-task`（AC-197）与 `chat.cancel-queued` 规整（AC-198）复用它。归属不符 ⇒ `forbidden` 且**不调用驱动**。
- 校验通过后：调 `runtime.stopTask(provider, sessionId, taskId)`（resident/per-run 分叉），随后**在有界时间内**等待任务表里该任务变为终态（`stopped`，由 `task_notification(stopped)` 驱动）；上限内到达 ⇒ `requested`；上限内没有 ⇒ `timeout` 且任务**保持原状态**；`stopTask` 抛错或永不返回：用 `Promise.race`/超时保证处理函数**不挂住**（抛错 ⇒ `error`，不返回 ⇒ 到点 `timeout`）。
- 能力矩阵新增 `residentFeatures.stopTask`（默认 `false`，与 `cancelQueuedInput` 同款「未实测不开」纪律）；为 false ⇒ `unsupported`，**不调用驱动**。

**假形态（写进判据，证明主断言有分辨力）。**
- 在回执里**乐观**把任务标为 `stopped`（不等待事件）⇒「终态由事件驱动 / timeout 时保持原状态」的读数必须红。
- **省略归属校验** ⇒ `forbidden` 用例必须红（驱动被调用了，或回执不是 `forbidden`）。

<!-- dedup-ref --> **机制去重读数（本轮立案实测，2026-10-04，读任务库与代码）。** `grep -rn "goal_ac: *AC-196" tasks/ goals/` → **0 命中**（`tasks/gap-activity-task-reducer.md`、`gap-activity-lease-parity.md`、`gap-activity-dock-background-browser.md`、`gap-activity-protocol-snapshot-rev.md` 只在「非目标」里逐字把控制面让给 AC-196/197/198，无一认领）。机制词扫描 `grep -rln "chat.stop-task\|stopTask" tasks/` → **0 命中**；`test -f server/modules/websocket/tests/chat-stop-task.test.ts` → **ABSENT**。姊妹 AC-197（`chat-background-task.test.ts`，转后台，寻址 Turn Tracker 的前台 tool_use）与 AC-198（`chat-control-ownership.test.ts`，归属校验抽取 + cancel-queued 规整）是**不同判据文件、不同机制**，目前也无在飞认领者；本条只建停止路径与停止判据文件，转后台与 cancel-queued 规整由各自任务追加。⇒ 不是重复。

**非目标。** 不实现 `chat.background-task`（AC-197）；不做 cancel-queued 的 requestId/归属规整（AC-198）；不做前端坞控件与 e2e（AC-194/AC-199）；不改活动协议快照/增量（AC-193）；不改租约路径（AC-195）；不实现任务归约器本身（AC-191，本条消费其 `getTasks`）；不碰其它 provider。

## Plan

1. **任务表读取缝（消费 AC-191）。** 从 `server/modules/providers/index.ts` 桶导入归约器工厂（或其在活动聚合器里的单例）；在 WS 处理函数的依赖里加入窄读缝 `getTask(sessionId, taskId): { state, ... } | null`（默认接真实归约器；判据可注入脚本化替身）。**只读、不改**租约路径。
2. **能力矩阵**：`server/modules/providers/services/provider-capabilities.service.ts` 的 `ResidentFeatures` 加 `stopTask: false`，并写「未由 E 系列实测覆盖 ⇒ 保守 false」的注释（沿用 `cancelQueuedInput` 的语气）。
3. **驱动声明**：`claude-host-driver.provider.ts` 的 `ClaudeResidentQuery` 加可选 `stopTask?(taskId: string): Promise<void>`（可选：脚本化替身可以不给；更新 `:306` 那段「measured 方法清单」注释）。resident 驱动加 `stopTask(sessionId, taskId)`，经 `liveStateFor` 拿到 query 后调用；**不得**结束进程或释放输入。
4. **per-run 路径**：`claude-runtime.provider.ts` 在 `abortClaudeSDKSession`（`:1718`）旁导出 `stopClaudeSDKTask(sessionId, taskId)`：`getSession(sessionId)?.instance.stopTask?.(taskId)`；**不得**调 `releaseInput` / `removeSession`（它们结束 run，而停任务不能结束 run）。加进 `claudeRuntime` 对象与 `export {}` 列表。
5. **provider-runtime 动词**：`provider-runtime.service.ts` 的 `ProviderRuntimeGateway` 加 `controlStopTask?(provider, sessionId, taskId): Promise<'requested'|'unsupported'|'timeout'|'error'>`；实现按 `abort` 的 resident/per-run 分叉：resident 且 `residentFeatures.stopTask === true` ⇒ 走 resident 驱动；否则 per-run ⇒ 走 `stopClaudeSDKTask`；能力为 false ⇒ `unsupported`；两次 `Promise.race` 限时（驱动调用 + 事件等待），抛错 ⇒ `error`。
6. **归属入口**：新增单一 `assertSessionAccess(userId, session)`（放本模块内或 `server/modules/sessions/` 的公开面，按现有归属数据模型二选一），`chat.stop-task` 调它；`forbidden` 时**先于任何驱动调用**返回。
7. **WS 处理函数**：`chat-websocket.service.ts` 加 `case 'chat.stop-task'` 与 `handleChatStopTask`：校验三字段（缺 sessionId/taskId/requestId 各自 `sendProtocolError` 拒绝）→ 会话存在 → 归属 → taskId 在任务表且未终结 → 能力 → 调 `runtime.controlStopTask` → 有界等待任务表终态 → 回 `control_result`。处理函数**不得**自己写任务状态。
8. **判据文件**：新增 `server/modules/websocket/tests/chat-stop-task.test.ts`，按 `claude-resident-idle.test.ts` / `claude-resident-busy-input.test.ts` 的写法构造 WebSocket 桩 + resident 脚本化 `ClaudeResidentQuery`，并驱动一条 per-run 路径（脚本化 `activeSessions` 实例）。逐条断言 Proposal 的读数，含两条假形态臂（复用主用例读数函数、断言红）。
9. **后端规范**：跨模块只经 `index.ts` 桶；单处用的类型/工具放组件文件、两处以上才进 `server/shared/`；新增导出写消费者注释（`.agents/skills/backend-module-standards/SKILL.md`）。
10. **本地直跑**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-stop-task.test.ts` 退出 0；`npm run typecheck`、`npm run lint` 绿；既有 `chat-edit-send` / `chat-permission-mode` / 既有 resident 用例不被改红。

## AC

- [ ] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-stop-task.test.ts` 退出 0，stdout `fail 0`。
- [ ] AC2 必填字段：缺 `sessionId`、缺 `taskId`、缺 `requestId` 各返回协议错误，且**都不调用驱动**。
- [ ] AC3 会话不存在 ⇒ 拒绝；归属不符 ⇒ `control_result.result === 'forbidden'` 且**驱动零调用**。
- [ ] AC4 任务校验：`taskId` 不在任务表 ⇒ `unknown-task`；已在终态（`stopped`/`completed`/`failed`/`ended`）⇒ `unknown-task`；两者都**不调用 stopTask**。
- [ ] AC5 受理回执：校验通过 ⇒ 调用了驱动 `stopTask(sessionId, taskId)`，回执 `result === 'requested'` 且带 `requestId`；**回执本身不把任务改成 stopped**（发出回执后、事件到达前，任务表仍是原状态）。
- [ ] AC6 事件确认：随后喂入 `task_notification{status:'stopped'}`（由归约器写任务表）⇒ 任务表里该任务变 `stopped`；证明终态由事件驱动，不是处理函数写的。
- [ ] AC7 限时：喂入「永不 stopped」的帧序 ⇒ 回执 `timeout`，任务表状态与调用前一致。
- [ ] AC8 不挂住：`stopTask` 抛错 ⇒ 回执 `error`；`stopTask` 永不 resolve ⇒ 到期回执 `timeout`，处理函数在预算内返回（用例带超时上限断言）。
- [ ] AC9 能力矩阵：`residentFeatures.stopTask === false` ⇒ 回执 `unsupported` 且**不调用驱动**；为 true 时（用例注入）才走驱动。
- [ ] AC10 双驱动：resident 与 per-run 各一条用例，断言各自驱动替身被调用（resident 的 `query.stopTask`、per-run 的 `instance.stopTask`）。
- [ ] AC11 假形态红：乐观改状态的变体 ⇒ AC6/AC7 的读数红；省略归属校验的变体 ⇒ AC3 的 `forbidden` 用例红。

## DoD

- [ ] `chat.stop-task` 在**真实应用装配**（非仅测试桩）里可达：`server/modules/websocket/index.ts` 的处理函数注册与 `provider-runtime.service.ts` 的网关动词接上真实 resident 驱动与真实 per-run 运行时；用本机 resident 会话真实触发一次 `chat.stop-task`，观察到回执 `control_result{result:'requested', requestId}`，随后真实 `task_notification(stopped)` 到达、任务表变为 `stopped`（记录原始帧/回执，不使用乐观路径）。
- [ ] 任务表由 AC-191 的 `createClaudeTaskReducer()` 产出并被本条真实消费（不是测试内自建的第二张表）；`grep` 证明没有第二份任务登记实现。
- [ ] `npm run typecheck`、`npm run lint`、`npm run build` 全绿；既有 websocket 判据（`chat-edit-send` / `chat-permission-mode` / `chat-run-registry`）保持绿。
- [ ] 完成记录写清：四字段/会话/归属/任务/能力/限时各读数对应的原始回执与帧（含 `requestId`），以及 resident 与 per-run 两条路径各自被真实调用的证据。

## Touches

- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/tests/chat-stop-task.test.ts (new)
- server/modules/providers/services/provider-runtime.service.ts
- server/modules/providers/services/provider-capabilities.service.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/list/claude/claude-runtime.provider.ts
- server/modules/providers/index.ts
- tasks/gap-chat-stop-task-event-confirmed.md
