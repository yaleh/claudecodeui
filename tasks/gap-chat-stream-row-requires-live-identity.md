---
id: gap-chat-stream-row-requires-live-identity
title: 渲染端的前置条件显式化：stream_delta 行当且仅当带 live id 才落行（今天不可达的保险，把静默污染降级为退化）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**残留。** `src/modules/chat/hooks/useChatMessages.ts:461-471` 的 `case 'stream_delta'` 把**任何** `stream_delta` 行都画成一条助手消息 —— 它不检查这条行是不是本客户端自己铸造的 live 行。上游任务 [[gap-chat-unviewed-session-raw-delta-fragments]] 堵的是**产出端**（非当前查看会话的原始增量不再入库），没有给渲染端留防线；本条补这一环。

**今天不可达（已核实，故本条是保险而不是补 bug）。** `stream_delta` 行的唯一产出者是 `src/modules/chat/hooks/useSessionStore.ts:860`（`updateStreaming` 内部），其 id 在 `:856` 处取 `existing?.id ?? createLiveRowId(sessionId)` ⇒ **必然带 `live:` 前缀**。其余 `appendRealtime` 调用点都不可能产出它：三个走 `chatMessageToNormalized`（只产出 `tool_use` / `thinking` / `task_notification` / `error` / `text`，id 为 `local_…`），第四个是 `protocol_error` → `kind:'error'`；落盘 transcript 里也没有 `stream_delta` 行（上游任务已钉住"落盘不被污染"）。所以加上防线后，行为改变量是零。

**为什么仍然值得加 —— 代价与失败模式不对称。** 代价是一行 `if (!isLiveRowId(msg.id)) break;`，而 `isLiveRowId` 在 `useChatMessages.ts:8` **已经导入**（`:309` 在用），不需要新增 import。失败模式则是**静默且粘滞**的：`pruneRealtimeSupersededByServer`（`useSessionStore.ts:321-372`）与 `dedupeAdjacentAssistantEchoes`（`:265-313`）都靠**全文精确相等**收敛，一个 token 的碎片永远匹配不上完整回复，于是不会被回收，一直挂到整页刷新；而落盘数据是干净的，排查时先要排除"数据坏了"这条错路。加上这一行后，同一类 bug 从**污染**降级为**退化**：增量没有被累积就没有 live 行，该会话不逐字动画，但回合结束时文字仍会从落盘回声里出现。

**判据必须双向，否则是认证表演。** 只断言"喂一条非 live 的 `stream_delta` ⇒ 不产生行"，一个**根本没接线的渲染分支**（比如哪天整个 `case` 被删掉）拿到的也是满分。用例必须在同一个 runner 里同时含正向对照：一条带 `live:` 的行**必须**照样渲染，并且内容变化时仍在原地更新、不新增行。

**连带面（这条不是无风险的一行，必须先处理）。** 既有的 `src/modules/chat/tests/useChatMessages.test.ts` 正好钉着**当前**契约：`:27-30` 与 `:69-72` 两处 `stream_delta` fixture 的 id 都是 `'stream'`（非 live），而 `:40` 断言 `updated[2]?.content === 'Part one and two'` —— 加上防线后该行不再渲染，`updated[2]` 变成 `undefined`，**这条既有用例会红**。生产里 stream 行永远带 `live:`，所以这个 fixture 本身不真实。把它迁成 live 形状（如 `live:session-1:1`）即可，迁移之后它**正好就是**上面要求的正向对照。⚠️ 迁移属于**契约变更**（fixture 原本不符合生产形状），不是放宽断言 —— 必须在完成记录里写明理由，且 `:40` 那条断言一字不改地继续断言"该行被渲染"。

（另一条路是不动渲染端、只在 `appendRealtime` 入口拒绝 `stream_delta`。未采纳：那里的调用点带 `as unknown as NormalizedMessage` 强制转换，类型挡不住；而在生产路径上抛错比渲染端静默降级更糟。）

## AC

- [ ] AC1 渲染端前置条件显式化：`useChatMessages.ts` 的 `case 'stream_delta'` 在 push 之前检查 `isLiveRowId(msg.id)` —— `grep -c "isLiveRowId(msg.id)" src/modules/chat/hooks/useChatMessages.ts` 输出 **2**（既有 `:309` 一处 + 新增一处；实测修复前为 1）；`npm run typecheck` 退出码 0。
- [ ] AC2 scoped gate 选中并全绿：`bash scripts/test.sh --for-task gap-chat-stream-row-requires-live-identity --allow-thin` 退出码 0，输出中含 `src/modules/chat/tests/useChatMessages.test.ts` 的逐文件判决 `passed=true`（证明它被 `## Touches` 选中并真跑，而非被 thin 跳过）；完成记录贴出直接运行该文件的命令、退出码与用例条数。⚠️ scoped gate 的 `# tests N` 计的是**文件数**，用例数以 vitest 自身输出为准，两者不要混。
- [ ] AC3 双向对照各自独立可反红：(a) 一条 id **非 live** 的 `stream_delta` 经 `normalizedToChatMessages` ⇒ **不产出**该行；(b) 一条 id 带 `live:` 的 `stream_delta` ⇒ **照样产出**流式行，且 content 变化时仍在原地更新（不新增行）。两条是各自独立的断言，可分别反红。
- [ ] AC4 抗假变体：把 AC1 那行守卫去掉 ⇒ AC3 的 (a) 红而 (b) 仍绿（证明两条对照可分，不是同一处红掩盖）；还原后 `git diff -- src/modules/chat` 为空。
- [ ] AC5 迁移后的既有用例仍绿：`useChatMessages.test.ts` 的 4 条既有用例（含 `:40` 那条在 fixture 迁成 live 形状后仍断言该行被渲染）全部通过；`npm run lint`（= `oxlint src/ server/`）退出码 0。

## DoD

渲染端的前置条件变成**显式且可测**的：`normalizedToChatMessages` 渲染一条 `stream_delta` 行，**当且仅当**它的 id 是本客户端铸造的 live id。这一条由同一个 runner 里的双向对照同时钉住（live 必渲染、非 live 必不渲染），并由 AC4 证明守卫承重 —— 去掉它 (a) 立刻红，不是同义反复。既有 `useChatMessages.test.ts` 的两处 fixture 迁移到 live 形状，迁移理由（契约变更，不是放宽断言）写进完成记录。

L_D 该轴仍暗，理由：本条只把客户端流式行的渲染前置条件显式化并配一对双向断言，不产出数据/文档语义轴上的量化读数。

## Touches

- src/modules/chat/hooks/useChatMessages.ts
- src/modules/chat/tests/useChatMessages.test.ts
- tasks/gap-chat-stream-row-requires-live-identity.md
