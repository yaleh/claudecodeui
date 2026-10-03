---
id: session-store-window-model
title: AC-212 session store 用绝对序号窗口取代后缀模型：贴尾/脱离、实时消息缓冲、窗口内存上限
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - session-window-around-id-endpoint
goal_ac: AC-212
---
## Proposal

现状：`src/modules/chat/hooks/useSessionStore.ts` 的 SessionSlot 以 `serverMessages` 为「最新端的一段」，`offset` 恒等于已加载条数，`fetchMore` 只能向前接（`mergeOlderServerPage`），实时消息直接并入 `merged`（`computeMerged`）。useChatSessionState 再用 `chatMessages.slice(-visibleMessageCount)` 取尾部切片。这些都假定已加载内容是历史的后缀，所以不可能存在「中间窗口」。

要做的事：给 slot 增加窗口模型——`startIndex`（绝对序号）、`endIndex`、`total`、`attached`（贴尾标志）。贴尾时行为与今天完全一致（这是回归守卫，AC-212 的 (f)）。新增三个动作：`loadWindowAround(id, before, after)` 取围绕某 id 的窗口并把 slot 切换为脱离；`loadBefore()` / `loadAfter()` 向两侧扩展，向后加载到 `endIndex === total` 时自动回到贴尾；`jumpToLatest()`。脱离时 `appendRealtime` 的消息进入 realtime 缓冲且不进入 `getMessages`，另提供「缓冲了多少条更新」的读数；回到贴尾时按原顺序并入且不重复。窗口超过上限（默认 500 条）时丢弃远离视口的一端并同步更新 start/end。total 在加载期间变化时以 id 对齐窗口，而不是用偏移对齐。服务端响应类型取自 AC-210 任务放进 src/shared/types.ts 的窗口类型。

不在本任务内：任何渲染、滚动、导航轨道（后续任务）；本任务只改 store 与它的消费者适配到「贴尾时无行为变化」。

## Plan

1. 先写判据文件 `src/modules/chat/tests/sessionStoreWindow.test.ts`，覆盖 AC-212 的 (a)-(f)。先看它红。
2. 改 useSessionStore.ts：slot 增加窗口字段与新动作；既有动作在贴尾时走原路径。保持 `_historyMutationQueue` 对窗口读写的串行化。
3. 窗口上限常量就地定义在 useSessionStore.ts；不动 sessionMessagePagination.ts（页大小归预取任务）。
4. 跑现有 chat 客户端测试（useSessionStore、useChatSessionState 相关），确认贴尾行为不变。

## AC

- [ ] AC1 判据绿：`npx vitest run src/modules/chat/tests/sessionStoreWindow.test.ts` 退出 0。红态基线：测试文件不存在。
- [ ] AC2 取假形态必须红（先提交再变异，逐条记录 diff、逐字失败行与恢复命令）：(a) 脱离后仍把实时消息并入渲染列表 ⇒ (b) 断言红；(b) 丢弃一端后不更新 startIndex ⇒ (d) 断言红；(c) 回到贴尾时重复展示缓冲消息 ⇒ (c) 断言红。
- [ ] AC3 既有 store 行为不变：`npx vitest run src/modules/chat/tests` 中与 session store、useChatSessionState、lazyMessageRow 相关的既有用例保持绿，写下运行的文件清单。
- [ ] AC4 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

- 窗口以绝对序号表示，对追加稳定；与总数对齐用 id，不用偏移。
- 贴尾状态下对同输入产生与改造前相同的输出，此条有同输入对照用例。
- 遵守 `frontend-module-standards`（`.agents/skills/frontend-module-standards/SKILL.md`）：`@/` 导入、`type` 不用 `interface`、`import type`、导出带消费方注释。
- 只动 `## Touches` 列出的文件。

## Touches

- src/modules/chat/hooks/useSessionStore.ts
- src/shared/types.ts
- src/modules/chat/tests/sessionStoreWindow.test.ts (new)
- tasks/session-store-window-model.md
