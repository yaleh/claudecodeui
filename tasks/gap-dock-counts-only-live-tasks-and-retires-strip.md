---
id: gap-dock-counts-only-live-tasks-and-retires-strip
title: 活动坞只表示当前活动：计数与面板只含非终态任务，终态不再撑住 background 状态；取消与坞重复的 BackgroundTaskStrip 框
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

真实部署取证（2026-10-04，用户重启服务后）：会话里后台任务停了以后，坞的计数不减，点开面板才看到任务其实已经 completed/stopped；同时消息流末尾的 `BackgroundTaskStrip` 框信息很少（只有标签与时长），与坞数的是同一批任务，已无存在必要。

**机制（读代码，不是推断）。** `src/modules/chat/composer/ActivityIndicator.tsx:141` 传 `taskCount: tasks.length`，数的是任务表的全部行，含终态 `completed | failed | stopped | ended`。任务表保留终态行是有意的——转写里的卡片靠 `useTaskByToolUseId` 按 `toolUseId` 查任务来显示状态，所以**不能**在服务端或 store 里删终态行，只能在坞的读侧过滤。同一个缺陷还落在 `src/modules/chat/utils/activityDockView.ts:209`：`taskCount > 0` 决定坞进 `background` 状态，所有任务都已结束时坞仍显示「Background work · N tasks」且永不自行消失。面板 `ActivityDockPanel.tsx` 同样按 `tasks.length` 列出全部行，终态行只是没有停止按钮。

**裁定（用户已定）。** 坞只表示当前活动：计数、`background` 状态判定、面板列表都只含非终态任务（`running` 与 `blocked`）；终态任务不在坞里保留，只留在转写卡片里。计划（cron/wakeup）没有终态，行为不变。`BackgroundTaskStrip` 整体取消：它读 `/api/session-hosts` 租约，坞读 `activity.*` 帧，同一件事两个数据源；它还有两个已知缺陷（标签用 `task_id` 去匹配转写里的 `tool_use_id` 永远匹配不上而退回通用词；服务端缺 `since` 时显示 `NaN:NaN`），随它一起消失。

<!-- dedup-ref --> 相关任务：`gap-background-task-surface-absent-in-session-view`（done，当年立这个条的任务，其浏览器判据 `e2e/background-task-strip.spec.ts` 读条的 DOM，本任务取消条后该判据随之退役）、`gap-activity-dock-background-browser`（AC-194，坞的面板）、`gap-activity-dock-background-human-gate`（AC-201 人工关卡，读数里写「坞里列出描述、状态与最近动作」，本任务不改变它的四步动作）。「任务结束在转写里留一条记录」是另一个机制（服务端 reducer 发转写事件），由兄弟任务 `gap-task-terminal-transition-transcript-row` 承担，本任务不做。

## Plan

1. 在 `activityDockView.ts` 或 `useSessionActivity.ts` 旁抽出一个纯函数「活动任务」：过滤掉终态（复用面板已有的 `TERMINAL_TASK_STATES`，把它提到共享位置，不要抄第二份）。
2. `ActivityIndicator.tsx` 的 `taskCount` 与 `activityDockView.ts` 的 `background` 判定改读活动任务数；全部结束且无计划、无轮次时坞为 `hidden`。
3. `ActivityDockPanel.tsx` 的任务段、`data-task-count` 与 `Tasks N` 标题改为只列活动任务；面板空（无活动任务、无计划、无前台工具）时不渲染。
4. 删除 `BackgroundTaskStrip.tsx`、`ChatMessagesPane.tsx` 里的挂载点、`tests/backgroundTaskStrip.test.tsx`、`e2e/background-task-strip.spec.ts`；`ResidentSessionBadge.tsx` 仍在用的 `resident.backgroundTasks.count` 键保留，条专用的键（`title`、`genericLabel`、`monitorLabel`、`unknown`、`lastNotification`）在 12 个语种里同步删除，先 grep 确认无其它引用。
5. 修 `src/shared/types.ts` 里描述条的过时注释；`e2e/resident-status-bar.spec.ts` 的 i18n 键表同步（见记忆：判据键表会随退役变陈旧）。
6. 新增或改写单测：任务由 running 转 completed/stopped 后，坞计数减一；最后一个任务结束后坞消失；终态行不出现在面板；被取消的条在 DOM 里不存在。

## AC

- [ ] AC1 计数只含活动任务：新增单测给定任务表 `[running, completed, stopped, blocked]`，渲染的 `[data-activity-task-count]` 为 `2`；`npx vitest run src/modules/chat/tests/activityDockTaskSchedule.test.tsx` 退出 0（含新例）。
- [ ] AC2 全部终态时坞自行消失：单测给定任务表只有终态行、无计划、无轮次，`[data-activity-dock]` 不存在（`hidden`）；任务由 running 经一次 `activity.upsert` 帧转 stopped 后，同一渲染里计数从 `1` 变为不存在。
- [ ] AC3 面板只列活动任务：单测给定一行 completed 与一行 running，面板 `[data-task-row]` 只有 1 个，`data-task-count` 为 `1`；已结束任务的停止按钮路径不再被渲染（`[data-task-stop]` 与行数一致）。
- [ ] AC4 条已取消：`test ! -e src/modules/chat/transcript/BackgroundTaskStrip.tsx` 退出 0；`grep -rn "BackgroundTaskStrip\|data-background-task" src e2e` 命中 0。
- [ ] AC5 死键清理且不误删：`grep -rn "resident.backgroundTasks.\(title\|genericLabel\|monitorLabel\|unknown\|lastNotification\)" src e2e` 命中 0，12 个语种的 `chat.json` 同步（`node scripts/` 下既有 i18n 完整性检查或 `npm run lint` 退出 0）；`resident.backgroundTasks.count` 仍存在且 `ResidentSessionBadge` 测试保持绿。
- [ ] AC6 负控制有分辨力：把过滤临时改回 `tasks.length`，AC1 与 AC2 的新单测必须红；打印改前绿、改后红两次读数。
- [ ] AC7 契约面：`npm run lint` 与 `npm run typecheck` 退出 0；`git diff --stat develop...HEAD` 与 Touches 逐条对齐。

## DoD

- 坞在真实渲染里随任务终态把计数减下去，并在最后一个活动任务结束后消失；不是只让一个固定快照数对。
- 面板与计数、`background` 判定读同一个「活动任务」纯函数，没有第二份终态集合。
- 任务表在 store 与服务端里仍保留终态行（转写卡片靠它显示状态）：`useTaskByToolUseId` 对已结束任务仍返回该任务，现有 `liveSubagentGrouping` 与卡片相关测试不回归。
- 条的组件、测试、e2e 判据、死 i18n 键一并删除，没有留下指向它的悬空引用；旧任务 `gap-background-task-surface-absent-in-session-view` 的判据随之退役而不是留红。

## Touches

- src/modules/chat/composer/ActivityIndicator.tsx
- src/modules/chat/utils/activityDockView.ts
- src/modules/chat/transcript/ActivityDockPanel.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/BackgroundTaskStrip.tsx
- src/modules/chat/transcript/ResidentSessionBadge.tsx
- src/modules/chat/hooks/useSessionActivity.ts
- src/shared/types.ts
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/chat/tests/activityDockTaskSchedule.test.tsx
- src/modules/chat/tests/backgroundTaskStrip.test.tsx
- e2e/background-task-strip.spec.ts
- e2e/resident-status-bar.spec.ts
- tasks/gap-dock-counts-only-live-tasks-and-retires-strip.md
