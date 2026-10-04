---
id: gap-ac235-control-run-by-id-addressing
title: AC-235 运行按 runId 寻址：chatRunRegistry 增 runsById 索引与 getRunById 摘要（含
  aborted 状态），保留期/时钟可注入，过期返回 expired、未知返回 unknown，「每会话一当前运行」与 chat.subscribe
  重放不变；判据 server/modules/websocket/tests/chat-run-by-id.test.ts
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac234-control-run-source-fidelity
goal_ac: AC-235
---
## Proposal

AC-235（GOAL-019 退出条件 6；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「运行按 id 寻址（阶段 2）」）要求 `chatRunRegistry` 从「按会话寻址」扩展到「按 runId 寻址」：被新运行取代的与已完成的运行在保留期内都能按各自 `runId` 查到，运行摘要带 `runId`/`sessionId`/`source`/`status`/`startedAt`/`completedAt`/`lastSeq`，被中止的运行记为 `aborted` 而不是 `completed`；保留期与时钟可注入（默认仍为 5 分钟），拨过保留期返回 `expired`、从未出现的 id 返回 `unknown`；「每个会话一个当前运行」（`getRun(sessionId)` 返回最新）与 `chat.subscribe` 的重放行为不变。

现状（红态基线）：判据文件 `server/modules/websocket/tests/chat-run-by-id.test.ts` 不存在，判据的存在性闸以退出码 1 输出 `缺判据文件：server/modules/websocket/tests/chat-run-by-id.test.ts`。当前 `server/modules/websocket/services/chat-run-registry.service.ts`：`runs` 是 `Map<appSessionId, ChatRun>`（:74），只按会话寻址；`ChatRunStatus = 'running' | 'completed'`（:13）无 `aborted`；`COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000` 是模块级常量（:57），不可注入；`evictRunLater`（:76）用真实 `setTimeout` 且只删除 `status === 'completed'` 的运行；`decorateAndRecordEvent`（:99）在任意 `complete` 上把状态置 `completed`（:122），被中止的运行因此记成 `completed`；exactly-one-complete 守卫是 `run.status === 'completed'`（:104）；无 `runsById`/`getRunById`/运行摘要。

<!-- dedup-ref -->
前置与边界：`runsById` 索引与最小 `getRunById` 由链上的 `gap-ac231-control-busy-queue-cancel` 先加（它只做「按 id 命中」），控制服务与来源映射由 `gap-ac230`–`gap-ac234` 交付；本条不重做控制服务动作与来源映射，只把注册表扩展成完整的按 id 寻址 + 保留期/时钟注入 + 摘要 + `aborted` + `expired`/`unknown`。依赖尾节点 `gap-ac234-control-run-source-fidelity` 以串行化对 `chat-run-registry.service.ts` 与 `chat-run-registry.test.ts` 的写入。

要交付：

1. **注入式配置**（`chat-run-registry.service.ts`）。新增工厂 `export function createChatRunRegistry(options?: { retentionMs?: number; now?: () => number })`，把现模块级的 `runs`、`runsById`、`evictRunLater`、`decorateAndRecordEvent`、`recordProviderSessionId` 收进工厂闭包，返回与今天同名同义的对象（`startRun`、`openUnattendedRun`、`getRun`、`isProcessing`、`listRunningRuns`、`attachConnection`、`replayEvents`、`completeRun`、`completeRunIfCurrent`、`clearAll`，新增 `getRunById`）。模块仍导出单例 `export const chatRunRegistry = createChatRunRegistry();`，既有 import 点逐字不动。`retentionMs` 缺省读 `process.env.CHAT_RUN_RETENTION_MS`（有限正整数，否则回退 `5 * 60 * 1000`）；`now` 缺省 `() => Date.now()`。**承重要点**：运行的所有时间戳（`startedAt`、`completedAt`）与保留期判定都走注入的 `now()`，否则假时钟下时间算术不成立。导出注释按模块规范写明消费方（生产单例 + 判据文件）。

2. **`runsById` 索引与摘要**。新增 `runsById: Map<runId, ChatRun>`；`startRun`/`openUnattendedRun` 登记运行时把新运行写入 `runsById`，**取代（supersede）时不删除被取代运行的 id**——被取代的旧运行与新运行都按各自 id 可查。`getRunById(runId)` 返回**只读运行摘要**（不是内部 `ChatRun`，不泄漏 writer/events）：`{ runId, sessionId, source, status: 'running' | 'completed' | 'aborted', startedAt, completedAt: number | null, lastSeq }`；从未出现过的 id 返回 `{ status: 'unknown', reason: 'unknown' }`。

3. **保留期过期**。`getRunById` 对终态（`completed`/`aborted`）运行做惰性过期判定：`now() - completedAt > retentionMs` ⇒ 返回 `{ status: 'unknown', reason: 'expired' }`；保留期内返回摘要。过期判定在查询时用注入时钟计算（不依赖真实 `setTimeout` 触发），使假时钟下可推进读数。`expired` 与 `unknown` 由 `reason` 区分（与 SPEC `{ status: 'unknown', reason: 'expired' | 'restarted' }` 一致；`'restarted'`/bootId 属后续 MCP-gateway 阶段，不在本 AC）。`evictRunLater` 扩展为对 `'completed' | 'aborted'` 都回收事件缓冲，`runs`（当前会话映射）与 `runsById`（按 id 索引）的内存都有界（复用 `MAX_BUFFERED_EVENTS_PER_RUN` 上限）。

4. **`aborted` 状态**。`ChatRunStatus` 增加 `'aborted'`（`'running' | 'completed' | 'aborted'`）。`decorateAndRecordEvent`：遇到 `message.kind === 'complete'` 且 `message.aborted === true`（`createCompleteMessage` 已带该布尔，`server/shared/utils.ts:379`）⇒ `run.status = 'aborted'` 且 `run.completedAt = now()`，**不**记 `completed`。exactly-one-complete 守卫由 `run.status === 'completed'` 放宽为「运行已处终态（`status !== 'running'`）即丢弃重复 `complete`」——否则中止后运行迟到的 `complete` 会被记成第二个终态。`isProcessing`、`completeRun`/`completeRunIfCurrent` 的 `status !== 'running'` 语义保持不变。

5. **`getRun(sessionId)` 与 `replayEvents` 不变**。「每个会话一个当前运行」不变：supersede 后 `getRun(sessionId)` 返回新运行；`attachConnection`/`replayEvents` 逐字不改，`chat.subscribe` 的重放帧序列不变。

6. **判据 `server/modules/websocket/tests/chat-run-by-id.test.ts`**（红先行；沿用同目录既有注入式形态——临时 `DATABASE_PATH` + `initializeDatabase` + sessionsDb 造会话——用 `createChatRunRegistry({ retentionMs, now })` 造一个**独立**注册表实例，注入假时钟，**不构造 socket、不碰全局单例**）。读数：
   (a) 同一会话先 `startRun`（`supersedeRunning` 缺省，保持 running），再以 `supersedeRunning: true` 开第二次；`getRunById(runId1)` 与 `getRunById(runId2)` 都命中且 `runId` 各自正确，两个状态独立正确（旧 `running` 或 `completed`、新 `running`），写下两条摘要。
   (b) 对第二次运行调 `completeRun(sessionId, { exitCode: 1, aborted: true })` 后，`getRunById(runId2)` 的 `status === 'aborted'`（不是 `completed`），且摘要含且仅含 `runId`/`sessionId`/`source`/`status`/`startedAt`/`completedAt`/`lastSeq` 七个字段且值正确（`completedAt` 为数字），写下整条摘要。
   (c) 注入 `retentionMs`（如 1000）与假时钟：一条已 `completed` 的运行在 `completedAt + retentionMs` 之内可查（返回摘要）；把假时钟拨到超过保留期后返回 `{ status: 'unknown', reason: 'expired' }`；一个从未用过的随机 id 返回 `{ status: 'unknown', reason: 'unknown' }`，写下三个返回值。
   (d) supersede 之后 `getRun(sessionId)?.runId === runId2`（返回新运行），写下读数。
   (e) 对一条运行发已知事件序列后，`replayEvents(sessionId, 0, runId)` 与 `replayEvents(sessionId, k, runId)` 返回的帧（`seq`/`runId`/`sessionId`/`kind`/`content`）与改动前一致（逐帧 `deepEqual` 固定期望数组，写下实际帧数组）。

7. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 让 `runsById` 只记当前运行（supersede 时把旧 id 从 `runsById` 删掉或按会话键覆盖）⇒ (a) 必须红（`getRunById(runId1)` 落成 `unknown`）；
   (ii) 让过期判定永不生效（去掉 `now() - completedAt > retentionMs` 分支，或令终态运行永不过期）⇒ (c) 的 `expired` 必须红（拨过保留期仍返回 `completed` 摘要）；
   (iii) 在 `decorateAndRecordEvent` 里把 `aborted` 的 `complete` 记成 `completed` ⇒ (b) 必须红（`status === 'completed'`）；
   (iv) 让 `getRun(sessionId)` 在 supersede 后返回旧运行 ⇒ (d) 必须红。
   每条记录恢复命令与恢复后重跑绿。

边界：不实现 MCP 网关/OAuth/新端点/MCP 工具；不做控制服务的动作与访问入口（归 AC-230–AC-232）与单实例装配/处理器改造（归 AC-233）；不做来源映射（归 AC-234）；不做宿主启停服务（归 AC-236）；不改 WebSocket 协议与 `chat.subscribe` 帧序列；不实现 `'restarted'`/bootId（后续阶段）；不改 `startRun` 对既有调用方的语义与签名必填性；不给 `websocket/index.ts` 加无跨文件消费者的 barrel 导出（`getRunById` 与其摘要类型的对外 barrel 导出随 mcp-gateway 阶段 3 的消费者一起加）。

判定纪律：按 id 查到的是「注册表被实测读回的事实」；被取代的运行必须真的留在索引里（(a)(i) 证明）；`aborted` 来自 `complete.aborted` 这一既有事实而非新造标志；过期用注入时钟判定而非真实等待；`getRun`/`replayEvents` 为不回归面（(d)(e) 与既有判据双证）；遵守 `$backend-module-standards`（TypeScript、导出带消费方注释、不导出无消费者符号、模块私有实现不导出）。

## AC

- [ ] AC1 判据绿：`for f in server/modules/websocket/tests/chat-run-by-id.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-by-id.test.ts` 退出 0。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出 `缺判据文件：server/modules/websocket/tests/chat-run-by-id.test.ts`）。
- [ ] AC2 (a) 被取代与当前运行都按 id 可查：同一会话先后两次 `startRun`（第二次 `supersedeRunning: true`），`getRunById(runId1)` 与 `getRunById(runId2)` 均命中、`runId` 各自正确、状态独立正确（旧 running/completed、新 running），写下两条摘要。
- [ ] AC3 (b) 摘要字段与 aborted：被中止运行 `getRunById(runId).status === 'aborted'`（不是 completed），摘要含 `runId`/`sessionId`/`source`/`status`/`startedAt`/`completedAt`/`lastSeq` 七字段且值正确，写下整条摘要。
- [ ] AC4 (c) 保留期与 expired/unknown：注入保留期与假时钟，保留期内 `completed` 可查；拨过保留期返回 `{status:'unknown', reason:'expired'}`；从未出现的随机 id 返回 `{status:'unknown', reason:'unknown'}`，写下三个返回值。
- [ ] AC5 (d) 每会话一当前运行不变：supersede 后 `getRun(sessionId)?.runId === runId2`，写下读数。
- [ ] AC6 (e) 重放不变：同一运行的 `replayEvents(sessionId, 0, runId)` 与 `replayEvents(sessionId, k, runId)` 逐帧 `deepEqual` 固定期望数组；并跑既有 `server/modules/websocket/tests/chat-run-registry.test.ts` 逐字通过（写明命令与结果）。
- [ ] AC7 注入式配置与时钟承重：保留期来自 `createChatRunRegistry({ retentionMs })` 或环境变量 `CHAT_RUN_RETENTION_MS`（默认 5 分钟），时钟来自注入的 `now()`；判据用假时钟推进读数而不真实等待（写下注入参数与推进前后时钟读数）。
- [ ] AC8 取假形态四条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 索引只记当前运行 ⇒ AC2 红；(ii) 过期永不生效 ⇒ AC4 的 expired 红；(iii) 中止记成 completed ⇒ AC3 红；(iv) `getRun` 返回旧运行 ⇒ AC5 红。每条记录恢复命令与恢复后重跑绿。
- [ ] AC9 不回归与仓库门：既有 WebSocket 判据逐字通过——至少 `server/modules/websocket/tests/chat-run-registry.test.ts`、`server/modules/websocket/tests/chat-control-busy.test.ts`（若其对 `getRunById` 的断言读取非摘要字段则同步更新为摘要形态）（写明命令与结果）；`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级，写明计数）；跨模块只经 barrel、无深导入。
- [ ] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 被取代的运行真的留在 `runsById` 里、按各自 id 读回各自状态，这是「按 id 寻址」的实据；不是「代码看起来会存」。
- 被中止的运行按 id 读回 `aborted`（来源是 `complete.aborted` 这一既有事实），且中止后迟到的 `complete` 不产生第二个终态。
- 保留期与时钟真的可注入：假时钟推进即得 `expired`，从未出现的 id 得 `unknown`，二者可区分；默认不注入时仍是 5 分钟。
- `getRun(sessionId)` 与 `replayEvents` 的不回归由新判据读数与既有 `chat-run-registry.test.ts` 双证。
- 四条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 遵守 `$backend-module-standards`（TypeScript、导出带消费方注释、不导出无消费者符号、模块私有实现不导出）；不越界实现其它 AC 的范围（见边界）；不改协议与既有判据。

## Touches

- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/websocket/tests/chat-run-by-id.test.ts (new)
- server/modules/websocket/tests/chat-control-busy.test.ts
- tasks/gap-ac235-control-run-by-id-addressing.md