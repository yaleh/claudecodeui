---
id: gap-claude-runtime-frame-forwarding-coverage
title: claude runtime 每帧转发的覆盖：归一化出来的每一帧（含 stream_delta）真的交给 writer —— 提取可导出纯函数 +
  假 writer 用例，补上归一化器与广播器之间那个无人守的连接点
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

AC-108 改由页内夹具驱动后（见 `gap-transcript-follow-criterion-llm-coupling`），「真实的流式帧真的到达 pane」这条链路上**唯一失去自动探测器的一环**是 `server/modules/providers/list/claude/claude-runtime.provider.js:963-977`：

```js
for await (const message of queryInstance) {
  const normalized = context.normalizeMessage(transformedMessage, sid);
  for (const msg of normalized) {
    if (transformedMessage.parentToolUseId && !msg.parentToolUseId) msg.parentToolUseId = transformedMessage.parentToolUseId;
    if (isSubagentPromptEcho(msg)) continue;
    ws.send(msg);
  }
}
```

即「归一化出来的每一帧真的交给 writer」。相邻两半都有覆盖，这一环没有：

- SDK 包裹态 partial frame → `stream_delta` NormalizedMessage：`server/modules/providers/tests/claude-stream-event-unwrap.test.ts`（无 live CLI，直接驱动归一化器）。
- `stream_delta` → 订阅者逐帧、带 `seq`：`server/modules/websocket/tests/chat-run-registry.test.ts:48-73`（假连接 + `run.writer.send`）。

本任务**只补这一环**：⛔ 不重复申领上述两半，⛔ 不重立「逐帧广播」判据（那已有）。现在补的理由：这一环此前唯一的自动探测器就是 AC-108 那条端到端用例；改夹具后它会消失，而这一环是「partial frame 到底有没有被转发出去」的唯一连接点——归一化器对了、广播器也对，中间的转发被删掉不会有任何测试变红。

方案：把循环体里「归一化 + 补 parentToolUseId + 过滤 subagent 回声 + 逐帧交给 writer」提取成一个**可导出的纯函数**（writer 与 normalizeMessage 作为参数传入），循环体改为调用它；再用一个 node:test 用例驱动该函数，断言四件事：

- 每一帧都被交给 writer，且顺序不变；
- `stream_delta` 不被吞（这是 partial 流的承载帧）；
- `isSubagentPromptEcho` 的帧被跳过；
- `parentToolUseId` 被带上。

函数经 `server/modules/providers/index.ts` barrel 导出——本仓约定新测试必须经 barrel 导入（`.oxlintrc.json` 的 boundaries 规则）；该文件已有的导出注释就是 "driven by the … test" 这种格式，照它写。

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提）：本条承接的覆盖由 [[gap-transcript-follow-on-real-stream]]（done，建立 SDK partial frame 到 pane 的整条通路）与 [[gap-transcript-follow-criterion-llm-coupling]]（新立，把 AC-108 的帧来源换成夹具）共同界定；两者都不申领这一环，也不与本条 Touches 重叠。

## AC

- [ ] AC1 循环体不再内联归一化与发送：`claude-runtime.provider.js` 中 `for (const msg of normalized)` 之后只剩一次函数调用（`grep -c "for (const msg of normalized)"` 为 1 且其后无 `ws.send`），`npm run typecheck` 退出码 0。
- [ ] AC2 新测试被 scoped gate 选中且全绿：`bash scripts/test.sh --for-task gap-claude-runtime-frame-forwarding-coverage --allow-thin` 退出码 0，输出中含新测试文件名（证明它被发现，而不是被 thin 跳过）；完成记录贴出直接运行该文件的命令与退出码。
- [ ] AC3 用例覆盖四件事（逐帧且保序、`stream_delta` 不被吞、subagent 回声被跳过、`parentToolUseId` 被带上），每件都是一个独立断言，可分别反红。
- [ ] AC4 抗假变体：把提取出的函数里那行 `ws.send(msg)` 注释掉 ⇒ AC2 的用例必红；还原后 `git diff -- server/modules/providers` 为空。
- [ ] AC5 `npm run lint` 退出码 0（新测试经 barrel 导入，boundaries / unused 规则不红）。

## DoD

`claude-runtime.provider.js` 的 SDK 消息循环通过一个**被真实调用**的导出函数把每一帧交给 writer；该函数被一个假 writer 驱动的用例钉住，且 AC4 证明它承重——去掉其中唯一那行 `ws.send` 用例立刻红，不是同义反复。本任务不把 partial 流端到端搬回浏览器（那是 AC-108 的旧职责，已按覆盖转移表交还给上面两条既有测试），只补上它们之间那个此前无人守的连接点。

## Touches

- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/index.ts
- server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts (new)
- tasks/gap-claude-runtime-frame-forwarding-coverage.md
