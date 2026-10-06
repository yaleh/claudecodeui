---
id: gap-session-filter-conversations-live-path
title: 会话过滤覆盖 Conversations 视图的实时更新：session_upserted
  对命中规则的会话不再插入，已有行改名为命中规则后移除，实时列表与重新加载一致
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-279
---
## Proposal

<!-- dedup-ref -->本任务补的是会话名过滤在 Conversations（最近会话）视图实时更新路径上的缺口。同一条线上的相邻工作各管一层：gap-project-session-name-filter-backend 管服务端分页与 recent 接口的过滤（均已 done，本任务不改服务端）；gap-project-session-name-filter-sidebar-ui 管 Projects 列表的条与编辑器；提交 e3a08557 修的是 Projects 列表（useProjectsState.ts）里先无名后命名的新会话。三者都没有碰 Conversations 视图自己的那份状态。

现象（用户 2026-10-05、10-06 两次报告）：规则已保存并生效，Projects 列表与整页刷新后的 Conversations 都是干净的；但停在 Conversations 视图时，过一会儿命中规则的会话（quay drivers 新建）又冒出来。修复 e3a08557 已进构建并重启后仍然如此。

根因（已读代码确认）：`src/modules/sidebar/hooks/useSidebarController.ts` 第 356 行起的 `session_upserted` 订阅。对列表里还没有的会话（约第 380 到 408 行）无条件插入一行；对已有行（约第 423 到 429 行）只更新标题与活动时间，名字后来补成命中规则也不移除。整个文件没有任何 sessionFilter、hiddenCount 或 isSessionHiddenByProjectFilter 的引用，而 recent 接口本身已按项目规则过滤，所以只有实时路径漏。库里的事实是干净的（10-05 12:00Z 之后新建的会话，claudecodeui 命中 320 个、其余 8 个都是真人会话）。

方案：
1. 让 Conversations 的实时更新使用与 Projects 列表同一个判定：`useProjectSessionFilter.ts` 里已有的 `isSessionHiddenByProjectFilter(project, session, keepSessionIds, isShowingHidden)`，规则来自控制器已持有的 `projects` 中对应项目的 `sessionFilter`。新会话命中规则则不插入；已有行改名后命中规则则从列表移除；先无名、后补命中名字的会话净效果是不可见。
2. 一致性是这个任务的判据，不是字面实现：实时更新后的列表成员，必须与随后重新加载 Conversations（`api.recentConversations`）得到的成员一致。recent 接口目前不接收 keepSessionIds，所以对运行中、需关注、当前选中这三类豁免，实现者须让实时路径与 recent 接口的实际语义一致，并把选择及理由写进完成记录；不要让实时视图比重新加载视图更宽松，那正是这次的 bug。
3. ⚠️ 模块边界：project-workspace 已经从 `@/modules/sidebar` 导入（useProjectSessionFilter.ts 的第 5 行），sidebar 反向导入 project-workspace 会成环，被 boundaries lint 拒绝。匹配谓词请经 props 由 useProjectsState 一侧传入，或把纯函数下沉到 shared。新增测试必须经模块 barrel 导入。
4. 正对照不可省：真正的判据是「推送确实送达了该视图，而且命中规则的被挡住」。所以 e2e 里必须有一条同样方式新建、名字不命中规则的会话出现在列表里，否则「没冒出来」可能只是什么都没发生。
5. 已有 e2e 的约定要沿用：session-filter.spec.ts 的注释写明，中途写入的转录会被文件监听器发现，其广播的 upsert 会把会话标为需关注，而需关注是过滤刻意保持可见的例外；开头种下的转录在服务启动前写入，以避开这一点。本任务要测的正是中途新建，所以新 spec 要自己处理这一点（e3a08557 已在 Projects 侧对无名 upsert 跳过需关注标记），并在完成记录里说明 Conversations 一侧的取舍。

## AC

- [ ] `npx vitest run src/modules/sidebar/tests/recentConversationsSessionFilterLive.test.tsx` 退出码 0（新文件）：对未知会话的 `session_upserted`，所属项目规则命中其标题时不插入，不命中时插入（对照）；已有行改名为命中规则的标题后被移除；先无名插入、随后补成命中名字的会话净效果不可见；项目无规则时行为与现状完全一致；每个断言后紧跟一次「重新加载」的等价读数，成员必须与实时结果相同。
- [ ] `npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts` 退出码 0（新文件，真实 Chromium 与 playwright webServer 启动的真实服务）：规则经侧边栏编辑器保存（不得 API 直建）；页面停在 Conversations 并加载完之后，经真实转录写入新建一个命中规则的会话和一个不命中的会话；不命中的出现（正对照），命中的在同一时间窗内不出现；先无名后命名与已有行被改名两种形态各一条；切走再切回与整页刷新之后列表成员与实时结果一致；页面无未翻译 i18n 字面量。
- [ ] 抗假变体至少各真跑一次并把输出记入完成记录：去掉新会话插入分支里的过滤判断，单测与 e2e 都必须变红；去掉改名分支里的移除，单测必须变红。
- [ ] 既有测试不回归：`npx vitest run src/modules/sidebar/tests/sessionFilterBar.test.tsx src/modules/sidebar/tests/sessionFilterEditor.test.tsx src/modules/project-workspace/tests/projectsStateSessionFilterLateName.test.ts src/modules/sidebar/tests/recentConversationRowActions.test.tsx` 退出码 0，且 `npm run test:client` 退出码 0。
- [ ] `npm run typecheck` 与 `npx oxlint` 退出码 0（含 boundaries 规则，sidebar 与 project-workspace 之间无环、无跨模块深导入）。

## DoD

真实落地判据：不是单测绿，也不是新 spec 文件存在。要求 AC-279 的判据命令在 goal-driver 环里由红转绿（`.quay/gate-events.jsonl` 里 AC-279 的 verdict 翻转），并且 e2e 的正对照与抗假变体真的跑过：在完成记录里贴出去掉过滤判断后 spec 变红的输出，以及正常实现下「不命中的出现、命中的不出现」的断言读数。本任务不负责重新构建或重启用户正在使用的 3001 服务（那是人的操作，且不得在托管它的会话里做）；合入后由人重建重启，AC-279 是该行为的机械凭据。

## Touches

- src/modules/sidebar/hooks/useSidebarController.ts
- src/modules/sidebar/Sidebar.tsx
- src/modules/sidebar/index.ts
- src/modules/project-workspace/hooks/useProjectSessionFilter.ts
- src/modules/project-workspace/hooks/useProjectsState.ts
- src/modules/project-workspace/index.ts
- src/shared/types.ts
- src/modules/sidebar/tests/recentConversationsSessionFilterLive.test.tsx (new)
- e2e/session-filter-conversations-live.spec.ts (new)
- playwright.config.ts
- tasks/gap-session-filter-conversations-live-path.md
