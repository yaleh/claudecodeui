---
id: gap-chat-subscribe-cursor-needs-run-identity
title: WS 重连的补发游标跨 run 错位：服务端 seq 每个 run 从 1 重来而客户端 lastSeq 只增不减，同一会话第 2 个回合起重订阅补不回帧
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**缺陷。** 客户端用来「断线重连后补发错过的帧」的游标和服务端 `seq` 的作用域不一致，导致**同一会话第二个及以后的回合**里，中途断线重连得不到补发。

**机制（已用服务端注册表层面的探针验证；浏览器里的真实断线重连未复现）。**

- 服务端每个 **run** 一份 `seq`：`startRun` 把 `lastSeq` 置 0（`chat-run-registry.service.ts` 的 `startRun` / `decorateAndRecordEvent`），回放缓冲 `events` 也是每个 run 一份。`dispatchRun` 每发一条消息都会 `startRun`，所以**不只是常驻会话**，任何会话的第 2 个回合起 `seq` 都从 1 重来。
- 客户端游标 `lastSeqRef` 是 `Map<sessionId, number>`，**只增不减、没有任何复位点**（`useChatRealtimeHandlers.ts` 里只有 `if (msg.seq > known) set`），重连时原样发给服务端（`ChatInterface.tsx`、`useChatSessionState.ts` 的 `chat.subscribe`）。
- 实测读数：run 1 发 5 帧（客户端游标 = 5），run 2 发 3 帧；`replayEvents(会话, 5)` 返回 **空**，而 `replayEvents(会话, 0)` 返回 run 2 的 3 帧（`seq` 1、2、3）。即客户端若在 run 2 里错过了这 3 帧，重订阅时一帧都补不回来。
- 影响面有限：工具行等落盘行能靠 REST 刷新补上；带 `blockKey` 的终态 `text` 帧会带全文并替换 live 块。所以症状是流式文本中间出现一段缺口、直到该块终态到达，而不是永久丢内容。**这是读代码加注册表探针得出的结论，没有在真实浏览器里复现过**。

**做法（加法，不改 `seq` 的作用域）。**

1. 每个 run 在 `startRun` 时生成一个 `runId`（不透明字符串，`randomUUID()`），存在 `ChatRun` 上。
2. `decorateAndRecordEvent` 给**每个**实时帧同时盖 `seq` 与 `runId`；`chat_subscribed` 应答带上当前 run 的 `runId`（无 run 时省略）。
3. `chat.subscribe` 的每个目标可选带 `runId`。服务端回放规则：**带了 `runId` 且与当前 run 的 `runId` 不同 ⇒ 从 0 回放**（客户端的游标属于另一个 run，对当前 run 没有意义）；`runId` 相同 ⇒ `seq > lastSeq`（现有行为）；**没带 `runId`（旧客户端）⇒ 现有行为，完全不变**。
4. 客户端游标改为 `{ runId, seq }`：收到帧时若其 `runId` 与已存的不同，**用该帧的 `seq` 覆盖**（而不是取 max）；订阅时把 `runId` 一并发出；收到 `chat_subscribed` 时若应答的 `runId` 与已存的不同，游标复位为 `{ runId: 应答的, seq: 0 }`。没有 `runId` 的帧（旧服务端）走原有「只增不减」逻辑。
5. 类型：服务端 `NormalizedMessage` / `chat_subscribed` 应答与客户端 `src/shared/types.ts` 各加可选 `runId?: string`。`server/modules/websocket/README.md` 里「Per-run event log」一节同步写明 `runId`。

**明确不做：**

- ⛔ 不把 `seq` 改成按会话计数、不引入会话级 Item Log、快照、`liveCursor`、`subscribe(afterSeq)` 的新语义（这些属于被暂缓的更大协议设计，见 `docs/proposals/chat-transcript-streaming-architecture.md` 的 §4–§6；没有实证需要它们，先不做）。
- ⛔ 不改回放对**已完成 run** 的限制（`complete` 之后仍不通过 WS 回放）。
- ⛔ 不处理 `supersedeRunning` 让旧 run 缓冲不可达的问题；不处理缓冲 5000 条上限溢出时给客户端缺口信号的问题。
- ⛔ 不动 `blockKey`、不动 store 的归约；不动 500 行的实时上限与乐观用户消息。

<!-- dedup-ref -->同区域不同机制，仅作溯源：`gap-session-hosts-per-run-frame-parity`、`gap-claude-resident-unattended-turn` 等只是引用 `chat.subscribe` / `seq`，修的是各自的帧产出与宿主生命周期；没有任何一条处理游标跨 run 的作用域错位，写入面与本条也不重叠。

## AC

- [ ] 服务端注册表用例复现并钉住该缺陷：同一会话先 run 1 发 5 帧、再 run 2 发 3 帧，用 run 1 的 `runId` 与游标 5 调回放 ⇒ 返回 run 2 的 **3 帧**（`seq` 1、2、3）；用 run 2 的 `runId` 与 `lastSeq=1` ⇒ 返回 `seq` 2、3；**不带 `runId`** ⇒ 与现状一致（`seq > lastSeq`）。放在 `server/modules/websocket/tests/chat-run-registry.test.ts`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts` 退出码 0。
- [ ] 同一个 run 的所有实时帧 `runId` 相同，不同 run 的 `runId` 不同；`complete` 帧也带。独立用例，退出码 0。
- [ ] 订阅路径用例（沿用 `chat-edit-send` / `chat-permission-mode` 测试里驱动 `chat.subscribe` 的方式）：`chat_subscribed` 应答带当前 run 的 `runId`；订阅带过期 `runId` ⇒ 应答之后补发的帧从该 run 的第一帧起；带当前 `runId` ⇒ 只补发 `seq > lastSeq`；完全不带 ⇒ 与现状一致。独立用例，退出码 0。
- [ ] 客户端用例（`src/modules/chat/tests/replayCursorAcrossRuns.test.tsx`，本任务新建）：游标在 run 变化时被覆盖（run 2 的第一帧 `seq=1` 把游标从 `{run1, 5}` 改成 `{run2, 1}`，修复前这一帧被「只增不减」吞掉）；`chat.subscribe` 消息里带 `runId`；收到 `runId` 不同的 `chat_subscribed` 时游标复位；没有 `runId` 的帧与应答走旧逻辑、行为不变。`npx vitest run src/modules/chat/tests/replayCursorAcrossRuns.test.tsx` 退出码 0。
- [ ] 抗假变体真跑并如实登记：(i) 把服务端回放里「`runId` 不同则从 0」去掉 ⇒ 注册表用例变红；(ii) 客户端把「`runId` 变化时覆盖」改回 `max` ⇒ 客户端用例变红。每个变体用 `git checkout -- <file>` 还原后复跑全绿，完成记录贴出各自的红。
- [ ] 既有用例全绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-edit-send.test.ts server/modules/websocket/tests/chat-permission-mode.test.ts server/modules/session-hosts/tests/session-host-per-run-parity.test.ts` 退出码 0，以及 `npx vitest run src/modules/chat/tests/permissionPromptReplay.test.tsx` 退出码 0。若帧夹具里有对整帧 `deepEqual` 的断言，因多了 `runId` 而需要同步时，**只允许把 `runId` 加进期望**，不得放宽到忽略整个字段。
- [ ] `npm run typecheck` 退出码 0、`npm run lint` 退出码 0。
- [ ] `server/modules/websocket/README.md` 的「Per-run event log」一节写明 `runId` 与回放规则；`grep -c runId server/modules/websocket/README.md` 大于 0。
- [ ] `git diff develop --name-only` 的全部改动都落在 Touches 内。

## DoD

真实落地判据，不是「字段加上了」：

(a) 在**真实运行的服务**上读到「修复前补不回、修复后补得回」：同一会话在页面不刷新的情况下连发两条消息（run 1、run 2），在 run 2 进行中让该页的 WebSocket 断开再重连（例如在浏览器里 `page.context().setOffline(true/false)`，或关掉该 socket 让应用自己重连），读取重连后收到的**补发帧数**。修复前后各读一次：修复前补发 0 帧、修复后补发 run 2 已产生的帧。取证时必须同时登记：断线时 run 2 已经产出了多少帧、重连时 `chat_subscribed` 应答的 `lastSeq`/`runId`、客户端发出的订阅里带的 `lastSeq`/`runId`。三个读数缺任何一个，取证不成立。

(b) 若真实浏览器里无法稳定制造「run 2 进行中断线」，必须写明，并说明用什么（例如服务端层面的真实 socket 测试）替代，**不得**把注册表单测当作端到端证明。

(c) 完成记录里不得声称「流式文本不会丢」，只能声称「同一会话第 2 个及以后的 run 中，重连后补发恢复」。

L_D 该轴仍暗，理由：本条修的是 WS 重连的补发游标，不产出数据/文档语义轴上的量化读数。
L_G 该轴仍暗，理由：同上；判定面由本任务自己的 AC 承担，不新增 goal 判据。

## Touches

- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/README.md
- server/shared/types.ts
- src/shared/types.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/hooks/useChatRealtimeHandlers.ts
- src/modules/chat/hooks/useChatSessionState.ts
- server/modules/websocket/tests/chat-run-registry.test.ts
- src/modules/chat/tests/replayCursorAcrossRuns.test.tsx (new)
- tasks/gap-chat-subscribe-cursor-needs-run-identity.md
