---
id: gap-selected-session-title-live-update
title: 当前查看会话的顶部标题不随 session_upserted 更新：selectedSession
  是独立副本，只有别名分支会同步，ai-title 到达后侧栏已变而 header 需刷新
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

缺陷：新建会话并发出第一条消息后，服务端把 Claude 生成的 `ai-title` 采纳为会话名，并广播 `session_upserted`；左侧会话列表随之改名，但当前会话顶部的标题（`WorkspaceTitle` 的 `h2`，读 `getSessionTitle(selectedSession)`）不变，整页刷新后才更新。人已在真实使用中观察到这一现象。

机制（已定位到行，`src/modules/project-workspace/hooks/useProjectsState.ts`）：

1. `selectedSession` 是与 `projects` 列表分离的一份独立 state 副本（`useState<ProjectSession | null>`）。
2. `session_upserted` 处理器里，`setProjects(...)` 用 `upsertSessionIntoProject` 更新列表，所以侧栏立即变；但对 `selectedSession` 的同步只写在末尾的别名分支：仅当事件带 `providerSessionId` 且它不等于 `sessionId`、并且当前选中的 id 正好是那个 provider id 时才 `setSelectedSession`。App 新建的会话选中的 id 就是事件的 `sessionId` 本身，不进入这个分支，所以副本从不更新。
3. 副本唯一的另一条同步路径是 `refreshProjectsSilently` 里按 id 从 `projects` 重新取一份，它只在刷新流程里跑，不由 `session_upserted` 触发。

已确认所有读 `selectedSession.summary` 的地方（顶部标题、浏览器页签标题 `getPageTitle`、导出文件名与标题、输入框的 `sessionSummary`）都会一并陈旧，修副本即一次修好，不需要逐处补丁。

方案：在 `session_upserted` 处理器里，当事件的别名 id 集合（`getSessionAliasIds`）包含当前选中会话的 id 时，把事件里的 `summary` 合并进 `selectedSession`。约束：(a) 沿用列表已有的规则——事件的 `summary` 为空白时不得覆盖已有标题（新会话会先广播一个空 `custom_name`）；(b) 只有 `summary` 真的变化时才 `setSelectedSession`，其余情况返回原对象引用，避免后台会话的 upsert 或无变化的 upsert 让主内容树重渲染（该处理器注释已明确要求这一点）；(c) 现有别名分支的行为不变。

## AC

- [ ] `npx vitest run src/modules/project-workspace/tests/projectsStateSelectedSessionTitle.test.ts` 退出码 0（沿用 `projectsStateSessionAlias.test.ts` 的 socket 替身与 `useProjectsState` 渲染方式）：选中一个 App 会话（选中 id 等于事件 `sessionId`），发出 `session_upserted` 带新 `summary`，`selectedSession.summary` 变为新标题，且未发生任何 refetch。
- [ ] 同一测试文件断言不变量，每条独立可反红：(a) 事件 `summary` 为空白时 `selectedSession.summary` 保持原标题；(b) 事件 `summary` 与现值相同时 `selectedSession` 保持同一对象引用（`Object.is`）；(c) 事件属于另一个会话 id 时 `selectedSession` 保持同一对象引用，而 `projects` 列表里那个会话确实被更新（证明事件已送达，不是空转）；(d) 别名场景（选中 id 等于事件的 `providerSessionId`）仍能更新且 id 改写为 `sessionId`，行为与改动前一致。
- [ ] 抗假变体：把新增的合并逻辑注释掉，同一测试文件必须变红（红在 (a) 之前那条「标题变为新值」的断言上），还原后 `git diff` 只剩预期改动，测试转绿。
- [ ] `npx vitest run src/modules/project-workspace/tests/projectsStateSessionAlias.test.ts src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts` 退出码 0（既有别名与选择同步用例不回归）。
- [ ] `npm run typecheck` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：不是仅有单测。要求在真实浏览器里操作一次并留读数：用临时 `DATABASE_PATH` 与临时 `HOME` 起独立服务实例（固定 `HOST=127.0.0.1`，结束时按进程组杀），在页面里打开一个 `derived` 命名的会话，不刷新页面，向其 transcript 追加真实格式的 `ai-title` 行，等待 watcher 同步；读数三处：顶部 `h2` 文本、侧栏该会话行文本、浏览器页签标题，三者都应变为该 `ai-title`，并记录 `window` 上的存活标记在读数前后仍在（证明没有整页刷新）。再手工改名一次，确认三处同步变为手工名。读数写进任务 Evidence。实施时按 `.agents/skills/frontend-module-standards/SKILL.md` 落位，新增测试只经模块 barrel 导入。

L_D 该轴仍暗，理由：纯客户端状态同步，没有可独立度量的数据或文档语义读数；验收以上面的单测与真实浏览器读数为准。

## Touches

- src/modules/project-workspace/hooks/useProjectsState.ts
- src/modules/project-workspace/tests/projectsStateSelectedSessionTitle.test.ts (new)
- tasks/gap-selected-session-title-live-update.md
