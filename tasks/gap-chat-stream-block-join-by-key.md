---
id: gap-chat-stream-block-join-by-key
title: 助手首段文本被渲染两次（流式 live 行 + 服务端行，中间隔着工具行）：客户端按 blockKey 一块一实体归约，live
  块就地被终态帧替换、渲染 key 全程稳定
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-stream-frames-carry-block-key
---
## Proposal

**缺陷。** 一个回合里「说一句 → 跑工具 → 再说」，第一段文字会在转写里渲染两次：一行是服务端的 `text` 行（带 `Claude` 标签与时间戳），一行是客户端自己流式出来的 live 行（无时间戳）。回合结束后仍在，整页重载即消失。浏览器实测（新建会话、「说开始 → Bash sleep 8 → 说完毕」，4 次里 2 次出现；流式中切走 35 秒再切回，重复行落在两个工具行**之间**，还把本该合成一组的 `Bash x2` 拆开）。

**根因（三件事叠加，已用测试固定住）。**

1. 同一段话有两个互不相连的身份：客户端铸的 `live:<sid>:<n>` 与服务端行 `${uuid}_0`，只能靠「文本相等」去猜。
2. 排序混用两个时钟：live 行用客户端 `new Date()` 并在**每次 flush 重盖**（`useSessionStore.ts` 的 `updateStreaming`），其余行用服务端时间戳，所以 live 行必然晚于同回合后续的工具行。
3. 折叠规则只认**相邻**（`dedupeAdjacentAssistantEchoes`）：排成 `[服务端文本, 工具行, live 行]` 后互不相邻，不折叠。

触发还需要：slot 里已经有服务端行（否则 `computeMerged` 直接按到达顺序合并、天然相邻）；以及工具行的服务端时间戳早于客户端结算该 live 行的时刻。

**做法。** 依赖已落地的服务端 `blockKey`（流式帧与该块的终态 `text` 帧带同一个不透明字符串 `blockKey`，见 `gap-claude-stream-frames-carry-block-key`；终态帧同时保留自己的行 id `${uuid}_0`，它与落盘行 id 相等，现有的按 id 去重本来就认它）。客户端把「一块一实体」落到 store：

1. **按块而不是按会话缓冲。** `useChatRealtimeHandlers.ts` 的 `streamBuffersRef` / flush 定时器现在以 `sessionId` 为键、每会话一个 live 行；改为以 `blockKey` 为键（`(sessionId, blockKey)`）。`stream_end` 带 `blockKey` 时只结算该块；**没有 `blockKey` 的帧走原有按会话的路径，行为不变**（codex / cursor / opencode 与旧服务端）。
2. **按 `blockKey` 选择 live 块。** `updateStreaming` / `finalizeStreaming` 在帧带 `blockKey` 时用它找行，而不是「该会话唯一的 live 流式行」。
3. **终态帧就地替换。** 带 `blockKey` 的终态 `text` 帧到达时，**替换**同 `blockKey` 的 live 块：位置不变，行 id 换成终态帧自己的 `${uuid}_0`，保留 `blockKey` 字段。此后历史行带同一个 id 到来，由 `computeMerged` / `pruneRealtimeSupersededByServer` 现有的按 id 去重回收，**不经过任何文本相等**。
4. **时间戳取服务端帧的。** live 块的 `timestamp` 取其**首个** `stream_delta` 帧自带的时间戳，之后的 flush **不再重盖**；终态替换后取终态帧的时间戳。这样 live 块排在同回合后续工具行之前，排序不再依赖客户端时钟。
5. **渲染 key 全程稳定。** `getIntrinsicMessageKey`（`messageKeys.ts`）把 `blockKey` 放到候选的第一位；且当历史行（不带 `blockKey`）按 id 接替 tail 里同 id 的行时，`computeMerged` 把该行的 `blockKey` 带到展示行上，使 key 在「流式 → 终态 → 历史到达」三个状态间**不变**。key 一变就是 unmount + mount，会重现落定帧的滚动跳动（见已修的 `gap-transcript-follow-finalize-remount-loses-bottom` 与 `useSessionStore.ts` 里 `dedupeAdjacentAssistantEchoes` 的注释）。
6. 客户端类型：`src/shared/types.ts` 的 `NormalizedMessage` 与 `ChatMessage` 加可选 `blockKey?: string`，经 `useChatMessages.ts` 的 `sharedMetadata` 带到渲染层。

**明确不做：**

- ⛔ 不删除、不放宽 `dedupeAdjacentAssistantEchoes` / `pruneRealtimeSupersededByServer` / `isAssistantTextEchoedInSameTurnOnServer`：没有 `blockKey` 的 provider 仍靠它们。本条不尝试修复「无 key 的形态」。
- ⛔ 不改 `computeMerged` 的时间戳排序为结构化排序（那是更大的改动，需单独的提案）。
- ⛔ 不动 `seq` / 订阅 / 快照协议、不动 `lastSeqRef`、不动 500 行的实时上限、不动乐观用户消息（`local_*`）的对账。
- ⛔ 不得为换绿而放宽：不加 `retries`、不删断言、不改 `STALE_THRESHOLD_MS`。
- ⛔ AC 不得使用裸 `bash scripts/test.sh`。

<!-- dedup-ref -->同区域不同机制，仅作溯源：`gap-chat-dedupe-missing-text-to-stream-delta-adjacency`（done）补的是「回声紧挨着 live 行」的**相邻**形态，不覆盖中间隔着工具行；`gap-chat-unviewed-session-raw-delta-fragments`（done）修的是非当前会话的原始增量帧被逐 token 落行，两条都不引入块级身份，写入面与本条在 `useSessionStore.ts` 上有重叠，实现时应在其基础上改。

## AC

- [ ] 新增/改写 `src/modules/chat/tests/echoSeparatedByToolRow.test.tsx`（本任务拥有该文件）：以**带 `blockKey` 的帧**驱动 store，覆盖三种形态且每个都是独立用例、各自可反红：(a) 服务端文本帧 + 工具行 + 已结算 live 块（工具行时间戳早于结算）⇒ 该文本只出现 **1** 行；(b) live 块落在两个工具行之间 ⇒ 1 行；(c) 无实时 `text` 帧、由服务端刷新同时带来回声与工具行 ⇒ 1 行。固定 `Date`（`vi.useFakeTimers({ toFake: ['Date'] })`），store 的服务端历史须**先载入含用户 prompt 行的 slot**（否则按到达顺序合并，缺陷被掩盖）。`npx vitest run src/modules/chat/tests/echoSeparatedByToolRow.test.tsx` 退出码 0。
- [ ] 无 `blockKey` 的旧形态**不被掩盖**：同文件保留这三种形态的无 key 版本，用 `it.fails` 标注「已知缺口：无块级身份的 provider 仍受此限，待提供 key 或另立任务」，使其在缺口被补上时变红提醒；同时保留两条对照用例（相邻顺序已折叠；两个不同回合同文本仍是两行），退出码 0。
- [ ] **key 稳定**：用例断言同一个块在「流式中 → 终态帧替换后 → 服务端历史按 id 接替后」三个状态下，投影出的 `ChatMessage` 经 `getIntrinsicMessageKey` 得到的 key **完全相同**。`npx vitest run src/modules/chat/tests/liveRowIdentity.test.tsx` 退出码 0（该文件钉的是「一个 id 贯穿到刷新」，如需改写须保留其意图并在完成记录里逐条说明）。
- [ ] **时间戳不重盖**：用例断言 live 块的 `timestamp` 等于其首个 delta 帧的时间戳，后续 flush 后不变；终态替换后等于终态帧的时间戳。
- [ ] **一块一行**：同一会话内「文本 A → 工具 → 文本 B」产生两个互不相同的 `blockKey`，store 中是两个独立行；同一回合内**文本相同但 `blockKey` 不同**的两块仍是两行（防过度合并）。
- [ ] **按块缓冲、按会话隔离**：`npx vitest run src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx` 退出码 0（不在看的会话仍只聚成一行、`stream_end` 就地结算、两个会话互不串扰），并新增一条带 `blockKey` 的变体：两个会话各自交错流式，各自的块互不串扰。
- [ ] **无 key 回退路径不变**：`npx vitest run src/modules/chat/tests/adjacentEchoCollapse.test.tsx src/modules/chat/tests/useChatMessages.test.ts src/modules/chat/tests/sessionMessageReconciliation.test.ts src/modules/chat/tests/sessionStoreTruncate.test.tsx` 退出码 0。
- [ ] 抗假变体真跑并如实登记：(i) 终态帧不做就地替换（改为追加）⇒ 形态 (a) 变红；(ii) 保留每次 flush 重盖时间戳 ⇒ 时间戳用例变红；(iii) `getIntrinsicMessageKey` 不把 `blockKey` 放首位 ⇒ key 稳定用例变红。每个变体用 `git checkout -- <file>` 还原后复跑全绿，完成记录贴出各自的红。
- [ ] `npm run typecheck` 退出码 0、`npm run lint` 退出码 0。
- [ ] 浏览器取证（真实 app，**依赖服务端 `blockKey` 已在运行中的服务上生效**）：新建会话，跑「说一句 → `Bash sleep 8` → 再说」至少 6 次；每次同时登记 **三个读数**：(i) 回合结束时转写中该首段文本的行数，(ii) 同一会话整页重载后的行数，(iii) 回合进行中是否出现过工具行早于客户端结算的帧序（读 WS 帧时间戳）。要求 (i) 与 (ii) **逐次相等**。⛔ 本缺陷在修复前 4 次里出现 2 次、且依赖帧序，6 次全无重复**只在读数 (iii) 至少有一次满足触发条件时才成立**；全部不满足时必须写明「未触发」，不得当作已修。另做一次「流式中切走 >30 秒再切回」，登记切回时客户端是否持有 live 块与是否发出 `/messages` 刷新。
- [ ] `e2e/transcript-follow.spec.ts` 里注入**无 `blockKey`** 的 `stream_delta` / `stream_end` 帧的用例（AC-106 至 AC-111 区段）仍通过，用该仓库既有的 e2e 运行方式（`TMPDIR` 指向大卷，见仓库既有 e2e 任务的运行记录），完成记录贴出命令与结果；若受环境限制无法运行，如实写明并说明由哪条单测替代覆盖「回退路径下 key 不变」。
- [ ] `git diff develop --name-only` 的全部改动都落在 Touches 内。

## DoD

真实落地判据，不是「store 里改对了」：

(a) 在**真实 app + 真实 Claude 运行**上，首段文本在回合结束时与整页重载后的行数**逐次相等**，且至少有一次读到了触发条件（见 AC 浏览器取证 (iii)）。仅有单测变绿不算 —— 本缺陷的单测需要人为固定时间戳，真实帧序里才有「工具行早于结算」。

(b) key 稳定是**被钉住的不变式**，而不是副产品：流式 → 终态 → 历史到达三态 key 相同由用例断言，并由抗假变体 (iii) 证明可反红。

(c) 无 key 的缺口**被保留为可见的**（`it.fails`），完成记录写明哪些 provider 仍走无 key 路径（codex / cursor / opencode）及其各自的已知差异，**不得**声称「重复问题已全面解决」，只能声称「带 `blockKey` 的 Claude 路径已结构性消除」。

(d) 环境噪声如实登记：本机负载常驻偏高；若取证当刻客户端 `streaming = 0`（WS 未投递增量），必须写明，而不是把「未复现」当作已修复。

L_D 该轴仍暗，理由：本条修的是客户端转写行的合并与 key，不产出数据/文档语义轴上的量化读数。
L_G 该轴仍暗，理由：同上；判定面由本任务自己的 AC 承担，不新增 goal 判据。

## Touches

- src/shared/types.ts
- src/modules/chat/hooks/useChatRealtimeHandlers.ts
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/hooks/useChatMessages.ts
- src/modules/chat/utils/messageKeys.ts
- src/modules/chat/tests/echoSeparatedByToolRow.test.tsx (new)
- src/modules/chat/tests/liveRowIdentity.test.tsx
- src/modules/chat/tests/unviewedSessionStreamAccumulation.test.tsx
- tasks/gap-chat-stream-block-join-by-key.md
