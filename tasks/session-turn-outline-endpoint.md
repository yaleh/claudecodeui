---
id: session-turn-outline-endpoint
title: AC-209 用户轮次大纲接口：返回 total 与每个用户轮次的 id、绝对序号、时间戳、摘要
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - session-history-incremental-cache
goal_ac: AC-209
---
## Proposal

现状：服务端没有任何「用户轮次」索引，也没有每条消息的序号（只有 id，以及仅用户轮次带的 transcriptAnchorId）。导航轨道需要整段会话的轮次列表，包括客户端从未加载过的部分。

要做的事：在历史服务上新增一个只读的「大纲」读面，直接从已缓存的完整历史（`fullHistory.messages`，即 prepareTranscriptMessages 之后、`total` 与 offset 所索引的同一个数组）过滤 `kind === 'text' && role === 'user'`，返回 `{ total, turns: [{ id, index, timestamp, preview }] }`。`index` 是自最早消息起算的绝对序号（0 起，等于该消息在完整数组里的下标），不是尾部偏移，因为追加消息会让尾部偏移全部变化。`id` 取 transcriptAnchorId，缺失时取消息 id；同毫秒的两条用户消息 id 必须不同。`preview` 取正文前约 80 个字符，去掉换行。暴露为 `GET /sessions/:sessionId/outline`，鉴权与既有 messages 路由一致。Cursor / OpenCode 不走缓存，返回由它们的全量读取派生的同形结果或明确的「不支持」，二选一在实现时按现有 provider 分派写清。

不在本任务内：按 id 取窗口（AC-210，另一任务）、缓存增量化（前置任务）。

## Plan

1. 先写判据文件 `server/modules/providers/tests/session-turn-outline.test.ts`，夹具含压缩摘要、被取代的提示分支、子 agent 转录、工具结果折叠、checklist 折叠、一对同毫秒用户消息。先看它红。
2. 在 sessions.service.ts 增加 `fetchOutline`，复用同一份缓存读取；在 provider.routes.ts 增加路由，紧邻既有 messages 路由。
3. 在 src/shared/types.ts 增加前后端共用的大纲类型（带注释），客户端消费由后续任务接入。

## AC

- [ ] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-turn-outline.test.ts` 退出 0。红态基线：测试文件不存在。
- [ ] AC2 取假形态必须红（先提交再变异，逐条记录 diff、逐字失败行与恢复命令）：(a) 从原始 JSONL 行而非归一化数组数轮次 ⇒ 数量断言红；(b) 用尾部偏移当 index ⇒ 下标断言红；(c) 按时间戳去重 ⇒ 同毫秒断言红。
- [ ] AC3 路由经真实 HTTP 调用（node 内起 express 或复用现有路由测试的做法），未带鉴权返回与 messages 路由相同的拒绝。
- [ ] AC4 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

- 大纲由与分页同一份缓存派生，`total` 与分页接口返回的 total 恒等。
- 序号为绝对序号，对追加稳定（同一轮次的 index 在追加后不变）。
- 遵守 `backend-module-standards`；类型放 src/shared/types.ts 并带注释，不创建模块内 types.ts。
- 只动 `## Touches` 列出的文件。

## Touches

- server/modules/providers/services/sessions.service.ts
- server/modules/providers/provider.routes.ts
- src/shared/types.ts
- server/modules/providers/tests/session-turn-outline.test.ts (new)
- tasks/session-turn-outline-endpoint.md
