---
id: gap-claude-stream-frames-carry-block-key
title: Claude 实时流式帧缺块级身份：stream_delta / stream_end 与终态 text 帧之间没有可连接的
  blockKey，客户端只能靠文本相等去猜
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**目标。** 让 Claude 的**实时流式帧**带上一个把「流式碎片」和「它最终落成的那一行」连起来的结构化身份 `blockKey`，使客户端不必再靠「文本相等 + 相邻」去猜哪一行是同一段话。本条只做**服务端产出端**；客户端按 key 归约是另一条任务（`gap-chat-stream-block-join-by-key`，依赖本条）。

**为什么需要。** 回合进行中，同一段助手文字会被渲染两次（流式行 + 服务端行），整页重载即消失。机制：`stream_delta` / `stream_end` 帧只带随机 id，没有 `message.id`、没有块 `index`，与随后的终态 `text` 帧之间**没有任何可连接的标识**，客户端只能靠文本相等去折叠，而折叠只认相邻，排序又混用客户端与服务端两个时钟。

**已实测的事实（2026-10-01，`@anthropic-ai/claude-agent-sdk` 0.3.165，`includePartialMessages: true`，「thinking → 文本 → Bash → 文本」，再读它写出的 JSONL）：**

- `message_start.message.id` ＝ 块级 `assistant` 消息的 `message.id` ＝ JSONL 的 `message.id`，恒等。
- 流里的 `index`（0 thinking、1 text、2 tool_use；下一条消息从 0 重来）＝ 该消息在 JSONL 里的行序。
- 每个块的帧序恒为 `content_block_start{index} → content_block_delta{index}… → assistant(该块的终态，content 只含这一个块) → content_block_stop{index}`。**终态 `assistant` 帧先于 `content_block_stop`**，且它自己不带 `index`。
- 块级 `assistant` 消息的 `uuid` ＝ 对应 JSONL 行的 `uuid`，所以现有终态 `text` 帧的 id `${uuid}_0` 与落盘行 id 本来就相等 —— 缺的只是「流式碎片 → 终态行」这一段。

**做法（只改实时帧，不改历史读取）：**

1. `blockKey = <message.id>:<index>`，对不透明字符串使用，客户端不得解析。
2. 在**实时**路径维护「当前打开的块」：`message_start` 记下 `message.id`；`content_block_start` 记下 `index`；`content_block_stop` 关闭。`stream_delta`、`stream_end` 以及**该块的终态帧**（任何块类型：text / thinking / tool_use）都带上 `blockKey`。终态帧归给「当前打开的块」，并保留自己原有的行 id `${uuid}_${partIndex}`。
3. 状态必须按 **(会话, parent_tool_use_id)** 隔离，且在 `message_stop` / run 结束时清理，不得泄漏、不得跨会话串扰。`forwardNormalizedFrames`（`claude-runtime.provider.js`）是 per-run 与常驻两条路径共用的唯一出口，状态应挂在它能触达的、与 writer 同寿命的地方（例如以 writer 为键），这样**常驻路径无需改 `claude-host-driver.provider.ts`**。
4. **历史读取路径一律不得产出 `blockKey`**（历史行没有流状态；`ClaudeSessionsProvider.normalizeMessage` 同时被历史读取使用，有状态的跟踪器不能放在那里，否则正在流式的会话被并发读历史时会把历史行盖上当前打开块的 key）。
5. `NormalizedMessage` 服务端类型加可选 `blockKey?: string`（`server/shared/types.ts`）。字段是**加法**：不改任何现有字段、不改 `seq`、不改 `stream_end` 的触发时机。

**明确不做：** 不新增 `block.start` / `block.end` 等新帧类型；不流式化 `thinking_delta` / `input_json_delta`（现 normalizer 仍丢弃它们，本条不改）；不改历史读取与行 id 方案；不改 `seq` 作用域；不碰客户端；不碰 codex / cursor / opencode。

<!-- dedup-ref -->同区域不同机制，仅作溯源：`gap-claude-runtime-frame-forwarding-coverage`（done）证明了「normalizer → writer」转发环；`gap-chat-dedupe-missing-text-to-stream-delta-adjacency`（done）补了相邻形态的折叠规则。两条都不涉及在实时帧上**加身份字段**，写入面也不重叠。

**未实测、实现时必须自行验证并如实登记：** 同一条消息里出现**多个文本块**；空文本块 / `redacted_thinking`（现 normalizer 对它们不产出行）是否让 `index` 与帧序错位；子代理（`parent_tool_use_id` 非空）的流事件 —— 一次实测里没有观察到任何带该字段的流事件，故只要求「它们的状态与主线隔离、不污染主线的 key」，不要求为它们产出 key。

## AC

- [ ] 新增服务端测试用真实捕获的帧序做夹具（thinking → text → tool_use，及第二条消息的 text；夹具内容见上文「已实测」），断言：该序列经实时出口后，`stream_delta`、对应的 `stream_end`、以及该块的终态 `text` 帧**带同一个** `blockKey = <message.id>:<index>`，且终态 `text` 帧的行 id 仍是 `${uuid}_0`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-stream-block-key.test.ts` 退出码 0。
- [ ] thinking 与 tool_use 块的终态帧同样带其块的 `blockKey`，且第二条消息的 `index` 从 0 重新开始、与第一条消息的 key 不相等（`message.id` 不同）。同一测试文件内有独立用例，退出码 0。
- [ ] **历史路径不带 key**：同一个 `ClaudeSessionsProvider` 实例上，先喂一半实时流事件（让「当前打开的块」非空），再对同一 `sessionId` 调 `normalizeMessage` 处理一条历史 `assistant` 行 ⇒ 结果行**没有** `blockKey`。独立用例，退出码 0。
- [ ] **隔离**：两个会话的流事件交错到达 ⇒ 各自的 key 只用各自的 `message.id`，互不串扰；一条带 `parentToolUseId` 的子代理流事件交错进主线 ⇒ 主线后续帧的 key 不变。独立用例，退出码 0。
- [ ] **状态不泄漏**：`message_stop` 之后到达的、没有打开块的终态帧**不带** `blockKey`（不沿用上一个块的 key）；一个会话跑完 100 条消息后，跟踪器内部不残留该会话的条目（用例里直接断言）。独立用例，退出码 0。
- [ ] 抗假变体真跑并如实登记：把「给终态帧盖 key」那一处短路 ⇒ 终态帧用例变红而 `stream_delta` 用例仍绿；把「按会话隔离」改成全局单例 ⇒ 隔离用例变红。每个变体用 `git checkout -- <file>` 还原后复跑全绿，完成记录里贴出两次红的断言信息。
- [ ] 既有用例全绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-stream-event-unwrap.test.ts server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts` 退出码 0（它们钉了 `stream_delta` / `stream_end` 的形状与「其它事件不渲染为行」；加字段后若有 `deepEqual` 类断言需同步，且不得为换绿放宽断言）。
- [ ] `npm run typecheck` 退出码 0、`npm run lint` 退出码 0。
- [ ] 常驻路径无需改动的结论被证明：`git diff develop --name-only -- server/modules/providers/list/claude/claude-host-driver.provider.ts` 无输出，且存在一条经 `forwardNormalizedFrames` 的用例，用常驻路径同款调用形态（writer 为假对象）得到带 key 的帧。
- [ ] `git diff develop --name-only` 的全部改动都落在 Touches 内。

## DoD

真实落地判据，不是「字段加上了」：

(a) 在**真实 SDK 运行**上读到过 key：用一次性脚本（`cwd` 放 `/tmp` 下的独立目录，跑完删脚本与它在 `~/.claude/projects` 下留的会话文件）直接调 `@anthropic-ai/claude-agent-sdk` 的 `query`（`includePartialMessages: true`，提示「说甲段 → Bash echo → 说乙段」），把全部 `stream_event` / `assistant` 消息喂给 `forwardNormalizedFrames`，完成记录里贴出：每个 `stream_delta` 与其终态 `text` 帧的 `blockKey` 相等、且等于 JSONL 里对应行的 `<message.id>:<行序>`。夹具测试是必要而不充分，这一条才是「对象真的经过机制」。

(b) 这一条证明的是**身份存在且可连接**，不是「重复已消失」—— 客户端按 key 归约在依赖它的那条任务里才落地，本条完成记录不得声称缺陷已修。

(c) 未实测项（多文本块、空文本块 / `redacted_thinking`、子代理流事件）逐项写明「是否实测、读到什么」，没测的写「未测」，不得省略。

L_D 该轴仍暗，理由：本条为服务端帧字段的加法，不产出数据/文档语义轴上的量化读数。
L_G 该轴仍暗，理由：同上；判定面由本任务自己的 AC 承担，不新增 goal 判据。

## Touches

- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/shared/types.ts
- server/modules/providers/tests/claude-stream-block-key.test.ts (new)
- server/modules/providers/tests/claude-stream-event-unwrap.test.ts
- server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts
- tasks/gap-claude-stream-frames-carry-block-key.md
