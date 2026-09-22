---
id: gap-session-title-display-surfaces
title: 标题显示面收口：PluginTabContent 字段对齐 getSessionTitle，命令面板/Conversations/归档列表在改名后不刷新
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

已确认的现状（前端）：经 `session_upserted` 实时更新的面是顶部 `h2`、侧栏行、浏览器页签、Shell 名字、导出文件名、通知文案（由 `src/modules/project-workspace/hooks/useProjectsState.ts` 里 selectedSession 的合并块与列表的 `upsertSessionIntoProject` 提供）。以下四处不在其中：

1. `src/modules/plugins/PluginTabContent.tsx` 传给插件标签页的 `session.title` 读的是 `selectedSession.title || selectedSession.name || selectedSession.id`，而全局唯一权威 `getSessionTitle`（`src/shared/utils.ts`）读的是 `summary || name`。字段不一致，插件页可能显示 id 或旧名，而 header 是对的。
2. `src/modules/command-palette/hooks/useSessionsSource.ts` 只按 `projectId` 取一次 `api.projectSessions`，不订阅任何事件。
3. `src/modules/sidebar/SidebarRecentConversations.tsx` 读 `conversation.sessionTitle`，只在**本机**发起改名时才就地补丁（`src/modules/sidebar/hooks/useSidebarController.ts` 的改名回调里）。
4. 归档会话：`src/modules/sidebar/hooks/useSidebarController.ts` 持有独立的 `archivedSessions` store；它更糟——服务端 `server/modules/websocket/services/session-upsert-broadcast.service.ts` 对 `row.isArchived` 的行直接 `return null`，所以归档行**根本不会**产生事件。

方案：这四处是同一个机制——「持有会话名的本地 store 要跟着已发生的改名走」。以 `getSessionTitle` 为唯一权威，把改名结果补齐到所有 store：

1. `PluginTabContent` 改为调用 `getSessionTitle(selectedSession)`（经模块 barrel 导入，不深导入）。
2. 命令面板与 Conversations 订阅同一个 `session_upserted`（或等价的共享 store），收到属于自己列表的会话时就地改其标题，不整表 refetch。
3. 归档列表：本机发起的改名返回后就地补 `archivedSessions` 里那一行。

**明确不在本任务范围**（记录下来，不静默改）：服务端对归档行不广播这一条**不改**。改它等于让归档会话重新参与广播，是产品语义变更（归档会话的 transcript 仍可能被改动而产生 upsert），需要单独裁定。因此本任务只保证「本机改名后归档列表跟着变」；**另一个客户端**对归档会话的改名仍然不会实时到达——这条限制写进 Evidence，不要伪装成已解决。

实施时按 `.agents/skills/frontend-module-standards/SKILL.md` 落位，新增前端测试只经模块 barrel 导入。

## AC

- [ ] `npx vitest run src/modules/plugins/tests/pluginTabSessionTitle.test.tsx` 退出码 0（经模块 barrel 渲染 `PluginTabContent`）：三种夹具——只有 `summary`、只有 `name`、两者皆无——插件拿到的 `session.title` 都等于 `getSessionTitle(selectedSession)`；两者皆无时断言与 `getSessionTitle` 自身的约定一致（不得凭空规定一个值）。
- [ ] 抗假变体：把实现改回 `title || name || id` 后同一命令必须变红，且红的必须是「只有 `summary`」那条夹具；还原后转绿。
- [ ] `npx vitest run src/modules/sidebar/tests/sessionTitleSurfaces.test.tsx` 退出码 0：归档列表与 Conversations store 在本机改名后（`api.renameSession` 成功返回）不经过任何整表 refetch 就显示新名。**正控**：改名前后两次读取该行的名字必须**不同**（证明补丁真的写进去了，而不是断言了一个恒等）。**负控**：一个不属于自己列表的会话的 upsert 不得引起这两处任何变化。
- [ ] `npx vitest run src/modules/command-palette/tests/sessionTitleLiveUpdate.test.ts` 退出码 0：发出属于面板列表的 `session_upserted` 后，面板行的 label 变为新名，且未重新调用 `api.projectSessions`（以调用计数断言）；属于其他项目的 upsert 不改变面板。
- [ ] 抗假变体：把命令面板的事件订阅整段去掉后同一命令必须变红；还原后转绿。
- [ ] `npm run typecheck` 与 `npm run lint` 退出码均为 0（含 boundaries 规则）。

## DoD

真实落地判据：不是仅有单测。要求用临时 `DATABASE_PATH` 与临时 `HOME` 起真实服务实例（`HOST=127.0.0.1`，结束时按进程组杀），在真实浏览器里打开一个会话，经 UI 改名，然后**不刷新页面**依次读数四处：(1) 打开插件标签页读它拿到的 session title；(2) 打开命令面板搜索该会话读其行文本；(3) 把该会话归档后打开归档列表读其行文本；(4) 顶部 `h2` 作为对照。四处都必须显示新名，且窗口存活标记在读数前后都在（证明没有整页刷新）。读数写进 Evidence。另需如实记录：用**第二个**浏览器上下文（模拟另一客户端）对归档会话改名时，第一个上下文里的归档行**不会**实时更新——这是本任务明确不解决的限制。

L_D 该轴仍暗，理由：纯客户端 store 同步与展示，没有可独立度量的数据或文档语义读数；验收以上面的单测与真实浏览器读数为准。

## Touches

- src/modules/plugins/PluginTabContent.tsx
- src/modules/sidebar/hooks/useSidebarController.ts
- src/modules/sidebar/SidebarRecentConversations.tsx
- src/modules/command-palette/hooks/useSessionsSource.ts
- src/modules/project-workspace/hooks/useProjectsState.ts
- src/modules/plugins/tests/pluginTabSessionTitle.test.tsx (new)
- src/modules/sidebar/tests/sessionTitleSurfaces.test.tsx (new)
- src/modules/command-palette/tests/sessionTitleLiveUpdate.test.ts (new)
- tasks/gap-session-title-display-surfaces.md
