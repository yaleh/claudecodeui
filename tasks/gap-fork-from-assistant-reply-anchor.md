---
id: gap-fork-from-assistant-reply-anchor
title: fork 按钮从用户气泡挪到 assistant 回复：新增 forkAnchorId（回合末尾 assistant 行），Claude 与
  Codex 同语义
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测）：`grep -il "forkFromHere\|forkAnchor\|createForkedSession\|forkSessionById" tasks/*.md` 只命中已完成的 `gap-lifecycle-mode-matrix-and-host-api`（AC-169，谈的是 fork 不继承 lifecycle_mode，与按钮位置无关）；`gap-session-fork-lineage-list` 只管会话列表的血缘徽标，不碰 transcript 内的 fork 入口。⇒ 无任务认领「fork 入口在哪条消息上」，本条不是重复。

**现状**：fork 按钮只渲染在用户气泡的操作栏里（`src/modules/chat/transcript/MessageComponent.tsx:286`，与「编辑重发」并排），条件是 `message.transcriptAnchorId`。该字段只在 `server/modules/providers/list/claude/claude-sessions.provider.ts:994` 对 `role === 'user'` 的消息写入，assistant 消息没有任何锚点。Claude 的 `upToMessageId`（SDK `forkSession`）按 transcript **文件顺序**包含该行，所以从用户行 fork 得到的是「以这条输入结尾、尚未回答」的会话；Codex 的 `upToAnchorId` 是 turnId，fork 会连带保留这条消息和它得到的回答（`codex-fork.provider.ts` 头注释）。同一个按钮在两个 provider 上语义不一致，且都不是用户想要的「对同一个输出换不同输入」。

**本轮实测读数（决定方案形状，勿再推断）**：
1. 在 3 个真实 resident 会话的 transcript 副本上，对全部 170 个用户输入点跑 SDK `forkSession`：产物悬空 tool_use 为 **0**（含 2 个回合中途插入的输入）；产物全部以该用户行结尾。
2. 真 claude 进程上 resume：以**用户行**结尾的 fork，CLI 在其后插入合成 assistant 回复 `No response requested.` 再接新消息（模型仍记得该输入）；以 **assistant 行**结尾的 fork，模型只记得到该回复为止。两者都能正常 resume。
3. 把会话截在 assistant 的 tool_use 行之后（模拟忙源）做整会话 fork 再 resume：**能 resume**，CLI 自行补处理，模型会在回复里说「之前的调用被中断了」。⇒ 忙源不是硬故障，只是带一个被中断的工具调用。
4. 乐观用户气泡（`useChatComposerState.ts:1064`）没有 `transcriptAnchorId`；锚点来自落盘行，要等 `complete` 触发的 `requestLatestMessages`（`useChatRealtimeHandlers.ts:511` 起）。**未验证**：resident 路径是否每个回合都发 `complete`（`claude-host-driver.provider.ts` 里没 grep 到）。

**方案**：
- **新增 `forkAnchorId`，不复用 `transcriptAnchorId`**。后者被编辑、outline、`LazyMessageRow`、`aroundId` 窗口共用，语义是「用户输入行」；给 assistant 行也写它会牵动这些消费方。`forkAnchorId` 只表示「在这里 fork，得到以这条回复结尾的会话」。
- **Claude**：在 `fetchHistory` 的归一化遍历（已拿到全部行）里，每个回合（两条真实用户提示之间）取**最后一条带文本的 assistant 行**的 uuid，写到该行归一化出的消息的 `forkAnchorId`。末尾那个回合仅当会话不在运行时才写。
- **Codex**：把该回合的 `turnId` 写到该回合最后一条 assistant 消息的 `forkAnchorId`（语义本来就含回答）。
- **前端**：fork 按钮从用户气泡移到 assistant 文本消息的操作栏（与复制按钮同处），条件 `onForkFromMessage && message.forkAnchorId`；用户气泡只保留「编辑重发」；会话运行中隐藏；`ChatInterface.handleForkFromMessage` 改读 `forkAnchorId`。
- **服务端兜底**：`forkSessionById` 带 `upToAnchorId` 时不另做类型校验（SDK 对找不到的 uuid 本就报错）；不带锚点的整会话 fork 保持允许（实测可 resume）。

**不在本任务范围**：fork 是否继承 `lifecycle_mode`（AC-169 与 proposal §13.5 明文规定不继承，另议）；「从某条输入之前分支」（可复用 `resolveEditAnchor`，等需要再立）。

## Plan

1. **前置读数（先于实现，未取到肯定读数不动产品代码）**：确认 resident 路径（`claude-host-driver.provider.ts`）每个回合结束都会让前端收到 `complete` 并触发尾部刷新。读数方式：起真 resident 会话（或判据里的 host driver 替身 + 真 WS），发两轮，记录每轮结束时前端是否收到 `complete`、`requestLatestMessages` 是否被调用。若**不是每回合都有**，把「回合结束时触发一次尾部刷新」并入本任务的实现面并在完成记录写明读数。
2. **判据骨架先红**：在 `claude-sessions.test.ts` / `codex-sessions.test.ts` / 新前端测试里先写出各断言，在当前树上跑出红态文案。
3. **类型**：`server/shared/types.ts` 与 `src/shared/types.ts` 加 `forkAnchorId?: string`（注释写明与 `transcriptAnchorId` 的分工）。
4. **Claude 归一化**：在 `fetchHistory` 遍历里按回合计算并写入；多回合、含 tool_use/tool_result 夹层、末尾回合运行中、回合中途插入的用户输入四种夹具各一条。
5. **Codex 归一化**：turnId → 该回合最后一条 assistant 消息的 `forkAnchorId`。
6. **前端**：`useChatMessages.ts` 把字段带过去；`MessageComponent.tsx` 迁移按钮；`ChatInterface.tsx` 改读 `forkAnchorId` 且运行中隐藏。
7. **收尾**：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出 0；按 AGENTS.md 单文件直接跑各判据，不做无界 fan-out；写完成记录（含第 1 步读数）。

## AC

- [ ] 前置读数已取得并写进完成记录：resident 路径每个回合结束时前端是否收到 `complete`（打印 `residentTurnComplete=<every-turn|not-every-turn>`）；若为 `not-every-turn`，则本任务同时落「回合结束触发尾部刷新」，且下面各项在该实现下成立。
- [ ] Claude 归一化：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts` 退出码 0，且该文件里新增用例断言——多回合夹具里每个回合恰有**一条**带 `forkAnchorId` 的 assistant 消息，其值等于该回合最后一条带文本的 assistant 行的 uuid；夹在 tool_use 与 tool_result 之间的 assistant 行**没有** `forkAnchorId`；用户消息**没有** `forkAnchorId` 且其 `transcriptAnchorId` 与改前逐字相同（不回归编辑/outline 的锚点）。
- [ ] 运行中回合：同文件用例断言，末尾回合在会话运行中读出时**没有** `forkAnchorId`，会话空闲后读出**有**（正控制，防「永远不写」）。
- [ ] Codex 归一化：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/codex-sessions.test.ts` 退出码 0，且新增用例断言该回合最后一条 assistant 消息的 `forkAnchorId` 等于该回合 turnId，用户消息不带 `forkAnchorId`。
- [ ] fork 产物语义（真 SDK）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-fork.test.ts` 退出码 0，且新增用例在一份含 tool_use 的 transcript 夹具上，用 `forkAnchorId` 作为 `upToAnchorId` fork，产物末行是该 assistant 文本行，且产物里没有悬空 tool_use（打印 `danglingToolUse=0 lastRow=assistant`）。
- [ ] 前端：`npx vitest run src/modules/chat/tests/forkFromAssistantReply.test.tsx` 退出码 0（新文件），断言——fork 按钮只出现在带 `forkAnchorId` 的 assistant 文本消息上；用户气泡上**没有** fork 按钮但仍有「编辑重发」；点击后 `api.forkSession` 以 `{ upToAnchorId: <forkAnchorId> }` 调用；会话处于运行中时按钮不渲染。
- [ ] 假形态承重：(a) 把 Claude 的写入改回「给 user 行写 forkAnchorId」⇒ 上面 Claude 用例必须红；(b) 在前端把按钮条件改回读 `transcriptAnchorId` ⇒ 前端用例必须红；(c) 把「运行中隐藏」去掉 ⇒ 前端用例必须红。各自还原后转绿，完成记录写出三条的实测红文案。
- [ ] `npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出码均为 0（新测试的跨模块 import 全部经 barrel）。

## DoD

真实落地：在真实服务实例（临时 `HOME` + 临时 `DATABASE_PATH`）里，经真实浏览器打开一个至少含两个回合的 Claude 会话（其中一个回合带工具调用）：(1) 每个回合的最终回复下出现 fork 按钮，用户气泡上没有；(2) 点击第一个回合回复上的按钮，新会话打开，其 transcript（直接读文件）末行是该回复，且不含第二个回合的任何内容；(3) 在该 fork 里再发一条消息，模型的回答只引用得到第一个回合为止的内容（读回复文本，不是读测试通过与否）；(4) 会话正在运行时，最后一个回合的回复上没有 fork 按钮，回合结束后出现。三处读数连同前置读数一并写进完成记录。若有 resident 会话可用，对一个 resident 会话重复 (1)(2)，记录按钮出现时机相对回合结束的先后。

## Touches

- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/modules/providers/list/codex/codex-sessions.provider.ts
- server/shared/types.ts
- src/shared/types.ts
- src/modules/chat/hooks/useChatMessages.ts
- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/ChatInterface.tsx
- server/modules/providers/tests/claude-sessions.test.ts
- server/modules/providers/tests/codex-sessions.test.ts
- server/modules/providers/tests/session-fork.test.ts
- src/modules/chat/tests/forkFromAssistantReply.test.tsx (new)
- tasks/gap-fork-from-assistant-reply-anchor.md
