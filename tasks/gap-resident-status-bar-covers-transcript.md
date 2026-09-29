---
id: gap-resident-status-bar-covers-transcript
title: AC-179 视口 780x493 下常驻状态条不压住对话文字：e2e 读两边界框不相交且消息块在视口内 + 非常驻正控制 +
  假形态（状态条改绝对定位盖消息）必须红 + 结构不变量
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-179
---
## Proposal

<!-- dedup-ref --> 机制去重读数（2026-09-29 本轮实测）：`grep -rln '^goal_ac: *AC-179' tasks/` → **0**；`grep -rln 'AC-179' tasks/` 只命中 `tasks/gap-resident-composer-hides-enable-affordance.md`（goal_ac: AC-178）与 `tasks/gap-resident-popover-close-reachable-narrow-viewport.md`（goal_ac: AC-177）——两处逐字都写着「不实现 AC-179（状态条不压消息）」，是**让位**而非认领。同机制扫描：`grep -rln 'status bar does not cover the transcript' tasks/` → **0**；`grep -rln '^goal_ac: *AC-172' tasks/` 命中 `gap-claude-resident-status-bar.md`（status: done），其 DoD 逐字只读四态 / 计数 / popover / 无人轮标签，**不读任何边界框几何**——所以状态条「长在哪里」今天没有任何判据。⇒ AC-179 无认领者，本条不是重复。三条 AC（177/178/179）共用新建的 `e2e/resident-ui-layout.spec.ts`，但断言对象不同（177 断**可点击性**、178 断**是否渲染**、179 断**两盒不相交**），本条只实现 `-g "status bar does not cover the transcript"` 命中的那条 test，不为另两条实现任何东西。

**判据物（逐字取自 `goals/AC-179-常驻状态条不压住对话文字.md`）。** `criterion:` = `npx playwright test e2e/resident-ui-layout.spec.ts -g "status bar does not cover the transcript"`（命令逐字含文件路径与 `-g` 过滤，不用 glob）。`expect` 逐字（同文件 :7-11）：「视口 780x493 下已常驻会话有一条助手消息时，状态条的边界框与该消息文字块的边界框不相交，且消息文字块在视口内可见。正控制：非常驻会话没有状态条，同一消息读数可见。取假形态：状态条改成绝对定位盖在消息上 ⇒ 必须红，且红落在边界框相交读数上。」`origin` 逐字（同文件 :12-13）：「人 yale 2026-09-29 指令「现在建」。来源：同日验证截图里 Resident Idle 状态条压在 Claude 消息行上。」

**红态基线（本轮实测，不是推断）。** `ls e2e/resident-ui-layout.spec.ts` → `No such file or directory`（本机实测，同 AC-177/AC-178 立案时读数一致）；`ls e2e/ | grep -i resident` → `resident-busy-send.spec.ts` / `resident-enable-consent.spec.ts` / `resident-running-view.spec.ts` / `resident-shell-tab.spec.ts` / `resident-status-bar.spec.ts`（5 个，无 ui-layout）。所以判据今天必然红，红因是「该文件不存在」；命令形状本身可用（同形状对既有文件 `npx playwright test e2e/resident-status-bar.spec.ts --list` 能收集）。

**现状（本轮直读的代码事实）—— 状态条是一个落在滚动子树里的 sticky 浮层**

- **落点在滚动容器内部。** `src/modules/chat/transcript/ChatMessagesPane.tsx:217` 逐字 `` className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${paneBottomPadding}`} `` 是滚动容器本身；`:225` 逐字 `<div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex justify-start empty:hidden sm:px-4">`，`ResidentStatusBar` 渲染在这层包装里（`:226-229`）。
- **`sticky right-4 top-3` 的语义就是浮层。** sticky 元素虽在流内，但一旦内容向上滚过 `top-3`（12px），它就**固定在滚动视口顶部**，后面的消息从它下面滑过去——这正是 origin 截图「Resident Idle 状态条压在 Claude 消息行上」的几何。同一容器里紧随其后的 `ChatExportMenu` 包装 `:230` 也带 `sticky right-4 top-3`，同为浮层。
- **会话打开时 pane 会被滚到底。** transcript-follow 的滚动所有权机制（e2e 侧读数见 `e2e/transcript-follow.spec.ts` 的 `[data-message-timestamp]` 行集与 `.chat-messages-pane` 滚动读数）把新内容钉在底部 ⇒ 内容一高于视口，pane 就停在底部，状态条于是浮在该消息之上。
- **窄视口放大了它。** 780x493 下输入区还吃掉大半高度（AC-178 的 origin 逐字：「占掉大半个输入区，把对话挤得几乎看不见」）⇒ pane 可用高度很小，**一条**助手消息即可让内容溢出，判据的读数条件（resident 会话 + 一条助手消息 + 780x493）正好落在浮层发生的区间里。
- **已钉的 DOM 契约（本条只读、不改）。** `ResidentStatusBar.tsx:159-166` 逐字发布 `data-resident-status-bar` / `data-resident-ui-state` / `data-resident-host-state` / `data-resident-host-id` / `data-resident-close-reason` / `data-resident-close-detail` / `data-resident-pid`；弹层与关闭钮见 `:213` / `:244`。

**要建的东西（AC-179 的最小充分集）**

1. **量红态（Plan 步 1），按读数选最小改动。** 不在没量之前先改布局——「被盖」与「被裁」都能产生同一个截图。
2. **判据** `e2e/resident-ui-layout.spec.ts`（新建；**与 AC-177/AC-178 共用本文件，见 DoD 的并集语义**），`-g "status bar does not cover the transcript"` 命中的那条 test：真浏览器、真服务；复用 `e2e/resident-status-bar.spec.ts` 的 debug-agent scenario 写法（`armScenario` → `POST /api/debug-agent/scenarios`，`seed: { lifecycleMode: 'resident' }` 建会话；`POST /api/debug-agent/clock` 推进/落地一条助手消息）。arm 一条 `lifecycleMode='resident'` 的会话 R（带一条助手消息）与一条 `lifecycleMode='per-run'` 的会话 P（同一条消息），`page.setViewportSize({ width: 780, height: 493 })` 后 `page.goto('/session/<id>')` 打开各自 pane 再读。
3. **门控并集。** `playwright.config.ts:1378` 的 `DEBUG_AGENT_SPEC_FILES` 追加 `'resident-ui-layout.spec.ts'` 并加一行注释——没有这条，选中本 spec 时 `webServer.env` 不含 `DEBUG_AGENT`/`DEBUG_AGENT_HOME`，控制面根本不挂载，判据必红（该常量被多条常驻 e2e 任务各自追加，合并冲突时**取并集**，不取单边）。
4. **假形态。** 把状态条改回浮层（`sticky`/`absolute` 盖在消息上，等价于 origin 的截图形态）⇒ 判据必须红，且红落在**边界框相交**那条读数上。
5. **结构不变量 vitest。** `src/modules/chat/tests/residentStatusBarClearsTranscript.test.tsx`（新建），含**反向腿**——给 scoped gate 一条可跑的非 e2e 判据。
6. **预算。** 判据打印整体墙钟并断言 `< 55_000`（`playwright.config.ts:317 SINGLE_SPEC_CEILING_MS = 55_000`；60s 是外层闸门的击杀处，超过会被从外面杀掉而什么都不报）。

## Plan

1. **量红态。** 先在**未修改**的树上跑等价探针（真服务 + debug-agent scenario + 780x493），打印 `resident.session=<id>` / `session.lifecycle_mode=resident` / `bar.exists=true` / `bar.box=<x,y,w,h>` / `msg.box=<x,y,w,h>` / `intersect=<bool>` / `msg.visible=<bool>`，确认 `intersect=true`（或 `msg.visible=false`）是红态本体。读数登记进 Evidence；任何一条读不到就说明选错了读法，先改读法而不是先改代码。
2. **按读数选最小改动。** 目标：状态条占**自己的布局行**，使消息内容不可能滑到它下面。候选 (a)：把状态条移出 `.chat-messages-pane` 的滚动子树——在 `ChatInterface.tsx:473` 的 `<ChatMessagesPane>` 之上作为兄弟行渲染，仍常驻可见（比 sticky 更满足「不随它所描述的那一轮滚走」），并**保持** `data-resident-status-bar*` 全家族与弹层/关闭语义不变；候选 (b)：留在 pane 内但去掉浮层语义（`relative` 流内），代价是它随内容滚走，与既有意图相悖。**优先 (a)**，除非步 1 的读数证明 (b) 已满足「两盒不相交 + 消息在视口内」。不改 AC-172 已钉的 `data-resident-status-bar*` / `data-resident-status-bar-trigger` / `data-resident-close` DOM 契约；不新增常驻关闭入口；不实现 AC-177（弹层可点击性）与 AC-178（已常驻会话隐藏开关）。
3. **写判据。** `e2e/resident-ui-layout.spec.ts` 的 `status bar does not cover the transcript` test：arm R/P；两个视口尺寸由本 test 自己 `setViewportSize`；AC2/AC3 两条读数 + 原始输出行 + 墙钟断言。
4. **写结构不变量。** `src/modules/chat/tests/residentStatusBarClearsTranscript.test.tsx` 正/反两腿（读法只用 DOM 结构，不依赖任何 i18n 键）。
5. **门控并集追加** `playwright.config.ts`。
6. **假形态真跑真红**：登记变异 diff、逐字失败行、退出码；恢复后 AC1 复绿。
7. `npm run lint` / `npm run typecheck` 绿；`git diff --stat` 与 Touches 逐条对齐；写完成记录。

## AC

- [ ] AC1 判据绿：`npx playwright test e2e/resident-ui-layout.spec.ts -g "status bar does not cover the transcript"` 退出 **0**，打印 `elapsed=<n>ms` 且 `< 55000`。红态基线（本轮实测）：`ls e2e/resident-ui-layout.spec.ts` → `No such file or directory`（判据文件不存在）。
- [ ] AC2 窄视口不相交（承重）：780x493、`lifecycleMode=resident` 的会话 R、一条助手消息时，打印 `bar.box=<x,y,w,h>` / `msg.box=<x,y,w,h>` / `intersect=false` / `msg.visible=true`；断言两盒不相交（`bx1 >= mx2 || mx1 >= bx2 || by1 >= my2 || my1 >= by2` 之一成立）**且** `msg.box` 完整落在视口内（`my1 >= 0 && my2 <= innerHeight`）。`bar.box` 取自 `[data-resident-status-bar]`，`msg.box` 取自 `.chat-messages-pane` 内**最外层**的 `[data-message-timestamp]` 行（与 transcript-follow 同一条筛选：`!row.parentElement?.closest('[data-message-timestamp]')`），其 `data-message-style` 为助手类型；另打印 `bar.exists=true` 与 `msg.count=1` 证明读数不是空页面的假读数。
- [ ] AC3 正控制（证明读法不是恒假/恒红）：同一次运行里 arm 的 per-run 会话 P 打印 `per-run.session=<id>` 与 `session.lifecycle_mode=per-run`，`[data-resident-status-bar]` 计数 `bar.exists=false`（`expect(...).toBe(0)`），同一读法下 `msg.visible=true`。AC2 的「有状态条且不相交」与 AC3 的「无状态条且消息可见」来自**同一条消息读数函数、同一次运行**。
- [ ] AC4 假形态必须红（承重）：把状态条改回浮层（`sticky`/`absolute` 定位盖在消息上，等价于 origin 截图形态）⇒ 判据退出非 0，**红在 AC2 的边界框相交读数断言上**（`intersect=true`；控制腿 AC3 无状态条仍绿，故红不落在 AC3）；登记变异 diff、逐字失败行、退出码；恢复后 AC1 复绿。
- [ ] AC5 结构不变量（非 e2e，给 scoped gate 一条可跑文件）：`npx vitest run src/modules/chat/tests/residentStatusBarClearsTranscript.test.tsx` 退出 **0**；该文件断言承载 `[data-resident-status-bar]` 的节点**不在** `.chat-messages-pane` 的滚动子树内（其祖先链上不存在 `overflow-y-auto` 的滚动容器），即「消息不可能滑到状态条下面」这一机制本身（按 Proposal 步 2 实际选定的最小改动写；读法只用 DOM 结构，不依赖任何 i18n 键）；**含反向腿**（把状态条放回 `.chat-messages-pane` 内 ⇒ 该 vitest 红），证明它不是恒绿。
- [ ] AC6 门控与契约：`playwright.config.ts:1378` 的 `DEBUG_AGENT_SPEC_FILES` 含 `'resident-ui-layout.spec.ts'`，且非本 spec 选择下 `webServer.env` 逐字不变（`git diff` 只多这一项与一行注释）；AC-172 已钉的 `data-resident-status-bar*` / `data-resident-status-bar-trigger` / `data-resident-close` 契约逐字未改（`git diff` 里这些属性不出现在删除行）；`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**。

## DoD

- 判据在**真浏览器**里跑：真服务、真 `GET /api/session-hosts` 读回 `lifecycleMode=resident`、debug-agent scenario 驱动，**不拉起真 claude**。
- AC2/AC3 的读数都是判据的**原始输出行**（`bar.box=` / `msg.box=` / `intersect=` / `msg.visible=` / `bar.exists=`），不是转述；几何读数由 `getBoundingClientRect`（或 Playwright `boundingBox()`）在同一时刻一次取全。
- 假形态**真跑过、真红**，红落在承重的相交断言上（不是任何一条断言都行）；恢复后判据复绿。
- 与 AC-177/AC-178 共用 `e2e/resident-ui-layout.spec.ts` 与 `playwright.config.ts` 的 `DEBUG_AGENT_SPEC_FILES`：若兄弟任务已创建该 spec / 已加该条，则**追加**本条的 test 与其所需 helper（取并集），不重写别人已写的用例、不改其 `-g` 命中的 test 标题；各自只认领自己 AC 的范围。
- 不改 AC-172 已钉的 `data-resident-status-bar*` / `data-resident-status-bar-trigger` / `data-resident-close` DOM 契约；不新增常驻关闭入口；不实现 AC-177（弹层可点击性）与 AC-178（已常驻会话隐藏开关与知情提示）。
- 单文件判据在 **55s** 内自己结束（打印墙钟），不是被看门狗或 60s 闸门外部击杀。
- 只动 Touches 列出的文件；`DEBUG_AGENT_SPEC_FILES` 的改动是并集语义（该常量跨任务被多条追加，合并冲突取并集，不取单边）。

## Touches

- `src/modules/chat/transcript/ChatMessagesPane.tsx`
- `src/modules/chat/transcript/ResidentStatusBar.tsx`
- `src/modules/chat/ChatInterface.tsx`
- `e2e/resident-ui-layout.spec.ts` (new)
- `src/modules/chat/tests/residentStatusBarClearsTranscript.test.tsx` (new)
- `playwright.config.ts`
- `tasks/gap-resident-status-bar-covers-transcript.md`（自触）