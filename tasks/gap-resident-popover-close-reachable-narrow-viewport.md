---
id: gap-resident-popover-close-reachable-narrow-viewport
title: AC-177 窄视口（780x493）下常驻状态条弹层的关闭按钮必须可点：elementFromPoint 命中自身，真实点击后宿主读回
  closed；1440x900 正控制；假形态（知情提示层叠高于弹层）必须红在命中读数上
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-177
---
## Proposal

<!-- dedup-ref --> 机制去重读数（2026-09-29 本轮实测）：`grep -rl '^goal_ac: *AC-177' tasks/ | wc -l` → **0**；`grep -rln 'AC-177' tasks/` → **0`（全库无任何任务提到 AC-177）。同机制扫描：`grep -rln 'elementFromPoint' tasks/` 只命中 `gap-model-settings-layout-overflow-assertions` 与 `gap-model-env-editor-full-width-layout`（模型设置页的溢出断言，机制与常驻状态条无关）；`grep -rln 'resident-ui-layout' tasks/` → **0**。⇒ AC-177 无认领者，本条不是重复。AC-178（同文件、已常驻会话隐藏开关与知情提示）与 AC-179（同文件、状态条不压消息）与本条共用 `e2e/resident-ui-layout.spec.ts`，但三者断言的对象不同（本条断**可点击性**，178 断可见性，179 断不重叠）；本条只认领 AC-177 的范围，不为另两条实现任何东西。另：`tasks/gap-resident-i18n-duplicate-key-shadows-toggle-and-notice.md` 的 DoD 逐字写着「弹层关闭被盖、已常驻会话仍显示开关、状态条压消息 三类界面缺陷不在本任务」，本条正是其中第一类，与该任务机制不相交。

**来源与判据物。** 判据逐字取自 `goals/AC-177-窄视口下常驻状态条弹层里的关闭按钮必须点得到-不被输入区的知情提示遮挡.md` 的 `criterion:`：`npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"`（命令逐字含文件路径与 `-g` 过滤，不用 glob）。`expect` 逐字（同文件 `:8-11`）：「视口 780x493 下新建常驻会话并发出一条消息，打开状态条弹层，关闭常驻进程按钮中心点的 elementFromPoint 命中该按钮自身；真实点击后会话宿主读回 state 为 closed，进程退出。正控制：视口 1440x900 下同一读数同样命中。取假形态：让输入区知情提示的层叠高于弹层 ⇒ 必须红，且红落在 elementFromPoint 命中读数上。」`origin` 逐字记录了现场：「真浏览器验证 971428c4 时，Playwright 报 resident.notice.bypass 拦截了关闭按钮的指针事件（780x493 视口），真实用户在窄屏上无法关闭常驻进程。AC-172 只读状态呈现、没有读可点击性，所以全绿。」

**红态基线（本轮实测，不是推断）。** `ls e2e/resident-ui-layout.spec.ts` → `No such file or directory`；`ls e2e/ | grep -i resident` → `resident-busy-send.spec.ts` / `resident-enable-consent.spec.ts` / `resident-running-view.spec.ts` / `resident-shell-tab.spec.ts` / `resident-status-bar.spec.ts`（5 个，无 ui-layout）。所以判据今天必然红，红因是「该文件不存在」。命令形状本身是好的：同命令形状对既有文件 `npx playwright test e2e/resident-status-bar.spec.ts --list` 能收集（既有 spec 已在跑）。

**现状（本轮直读的代码事实）—— 弹层与输入区是一对 flex 兄弟，「被盖」与「被裁」都说得通，必须先量再修**

- **状态条在滚动裁剪容器内部。** `src/modules/chat/transcript/ChatMessagesPane.tsx:217` 逐字 `` className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${paneBottomPadding}`} ``；`:225` 逐字 `<div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex justify-start empty:hidden sm:px-4">`，`ResidentStatusBar` 渲染在这里面。
- **弹层。** `src/modules/chat/transcript/ResidentStatusBar.tsx:213` 逐字 `className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"`；关闭按钮 `:244` `data-resident-close="true"`，是弹层里**最后一行**控件（其上方依次是地址块、pid/uptime 行、复制按钮）——窄视口下弹层高度吃掉消息区剩余高度时，关闭按钮正是最先掉出或被盖的那一个。
- **输入区是后置兄弟。** `src/modules/chat/composer/ChatComposer.tsx:448` 逐字 `className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6"`；`ChatInterface.tsx` 把 `ChatMessagesPane` 与 `ChatComposer` 放进同一个 `flex h-full min-h-0 flex-col`（消息区在前、输入区在后）。知情提示 `src/modules/chat/composer/ResidentConsentNotice.tsx:29` 的 `data-slot="resident-consent-notice"` 由 `ChatComposer.tsx:646` 在常驻开关下渲染，文案键 `resident.notice.bypass`（`ResidentConsentNotice.tsx:35`）——origin 记录的拦截元素正是它。
- **两种机制，读数才能定。** 若拦截来自**层叠**（后置兄弟或同层叠的输入区画在弹层之上），抬弹层/状态条的层叠级别即可；若来自 `.chat-messages-pane` 的 `overflow-y-auto overflow-x-hidden` **裁剪**（弹层 `top-full` 向下展开、在矮视口下溢出 pane 的盒子被裁掉下半部），则裁剪 z-index 救不了，弹层必须移出该裁剪盒子。这一步必须由读数判决，不许猜。

**要建的东西（AC-177 的最小充分集）**

1. **先量（承重，先于任何修改）。** 在 780x493 下建常驻会话、开宿主、打开弹层后，打印 `close.box=<boundingBox>`、`popover.box`、`pane.box`、`composer.box`、`hit.element=<elementFromPoint(close 中心) 的描述（tag + 最近的 data-* / aria 名）>`、`hit.isClose=<bool>`、以及 `popover.bottom > pane.bottom ? 'clipped' : 'inside'`。只有读到 `hit.isClose=false` 才动手修；读到 true 也要如实登记（说明红在别处，重新判因）。
2. **修（按读数选最小改动）。** 目标：弹层在任何视口下都画在输入区之上且不被裁剪。(a) 层叠因：抬弹层/状态条所在层叠级别到输入区之上；(b) 裁剪因：把弹层移出 `.chat-messages-pane` 的裁剪盒子（渲染到 `document.body` 的 portal，或把状态条移到滚动容器之外），并**保持**既有的外点关闭（`mousedown` outside）与 Escape 关闭语义，以及 AC-172 已钉的 `data-resident-status-bar*` / `data-resident-close` DOM 契约。不改 AC-179 要的状态条位置语义（仍不压消息）。
3. **判据 `e2e/resident-ui-layout.spec.ts`（新建）**，`-g "close is reachable"` 命中的那条 test：真浏览器、真服务、调试 agent 常驻场景（复用 `e2e/resident-status-bar.spec.ts` 建 `lifecycleMode: 'resident'` 会话、开宿主、`POST /api/debug-agent/clock` 的写法），两次视口各一段读数（`page.setViewportSize`，先例 `e2e/model-env-kind-explanations.spec.ts:38`）。elementFromPoint 的写法先例：`e2e/model-library-layout.spec.ts:90`。
4. **假形态。** 临时把输入区的知情提示抬到弹层之上（用测得的机制做最小变异：层叠因就抬高它的 z/后置顺序，裁剪因就使弹层重新落回裁剪盒子）⇒ 判据必须红在 elementFromPoint 命中读数那条断言上；跑完恢复。
5. **结构不变量（非 e2e 的 vitest，给 scoped gate 一条可跑的文件）。** 把本次修复赖以成立的、jsdom 可判的那条结构（弹层不在裁剪容器内、或状态条/弹层的层叠级别以可读的 class / `data-*` 暴露）钉成 `src/modules/chat/tests/` 下一条 vitest，并附**反向腿**。若本次修复确实没有 jsdom 可判的结构（纯几何），则以 `data-*` 把「弹层归属容器 + 其层叠级别」暴露出来，作为可判代理。
6. **接门控（并集语义）。** `playwright.config.ts:1378` 的 `DEBUG_AGENT_SPEC_FILES` 追加 `'resident-ui-layout.spec.ts'`，并给一行注释。该常量被多条常驻 e2e 任务各自追加（现状 3 条：status-bar / busy-send / running-view），合并冲突时**取并集**，不取单边——少一条就让它自己的 spec 在没开门的服务器上红。非本 spec 的选择，`webServer.env` 逐字不变。
7. **预算。** 判据打印整体墙钟并断言 `< 55_000`（`playwright.config.ts:317` `SINGLE_SPEC_CEILING_MS = 55_000`；60s 是外层闸门击杀处，超过会被从外面杀掉而什么都不报）。

## Plan

1. 量红态与现场：`--list` 退出与逐字输出；780x493 下弹层/关闭按钮/输入区的 boundingBox、elementFromPoint 命中元素、是否被 `.chat-messages-pane` 裁剪（Proposal 1 的全部打印）。把读数登记进 Evidence。
2. 按读数定修点、最小改动落地（Proposal 2）。
3. 写 `e2e/resident-ui-layout.spec.ts` 的 `close is reachable` test：建 resident 会话、发一条消息、开宿主、开弹层；780x493 命中读数；真实点击 close → 读回 `GET /api/session-hosts`（`state=closed`、`closeReason=user`、live host 消失）；1440x900 正控制；打印整体墙钟并断言 `< 55000`。
4. 写 `src/modules/chat/tests/` 下的结构不变量 vitest，含反向腿。
5. `playwright.config.ts` 门控并集追加。
6. 假形态真跑真红，登记变异 diff、逐字失败行、退出码；恢复后 AC1 复绿。
7. `npm run lint` / `npm run typecheck` 绿；`git diff --stat` 与 Touches 逐条对齐；写完成记录。

## AC

- [ ] AC1 判据绿：`npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"` 退出 **0**，打印 `elapsed=<n>ms` 且 `< 55000`。红态基线本轮实测：`ls e2e/resident-ui-layout.spec.ts` → `No such file or directory`（判据文件不存在）。
- [ ] AC2 窄视口命中（承重）：780x493 下打印 `hit.element=<…> hit.isClose=true close.box=<…>`，断言关闭按钮中心点的 `document.elementFromPoint` 就是该按钮自身；并打印 `hit.element` 不是 `[data-slot="resident-consent-notice"]`、不在 `.chat-composer-shell` 内（两条否证读数一并打印）。
- [ ] AC3 真实点击与宿主读回：点击后 `GET /api/session-hosts` 读回该会话 `state=closed`、`closeReason=user`、该会话不再有 live host；**正控制**：点击前同一 hostId 在快照里（打印 `host.present=true`），保证「关闭后消失」不是恒真。
- [ ] AC4 正控制视口：1440x900 下同一 `hit.isClose=true` 读数（打印 `viewport=1440x900 hit.isClose=true`，证明 AC2 的读数不是恒假）。
- [ ] AC5 取假形态必须红（承重）：把输入区知情提示抬到弹层之上 ⇒ 判据退出非 0，**红在 elementFromPoint 命中读数那条断言上**；登记变异 diff 与逐字失败行；恢复后 AC1 复绿。
- [ ] AC6 结构不变量：`npx vitest run src/modules/chat/tests/residentStatusBarCloseReachable.test.tsx` 退出 **0**；该文件含**反向腿**（把弹层放回裁剪容器/降层叠 ⇒ 该 vitest 红），证明它不是恒绿。
- [ ] AC7 门控与契约：`playwright.config.ts` 的 `DEBUG_AGENT_SPEC_FILES` 含 `'resident-ui-layout.spec.ts'`，且非本 spec 选择下 `webServer.env` 逐字不变（`git diff` 只多这一项与一行注释）；`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**。

## DoD

- 判据在**真浏览器**里跑：真服务、真 resident 会话、调试 agent 常驻场景驱动，**不拉起 claude**。
- AC2/AC3/AC4 的读数都是判据的**原始输出行**（`hit.*` / `close.box` / `host.*`），不是转述。
- 假形态**真跑过、真红**，红落在承重的 elementFromPoint 命中断言上；恢复后判据复绿。
- 不改 AC-172 已钉的 `data-resident-status-bar*` / `data-resident-close` DOM 契约与 AC-179 要的状态条位置；不实现 AC-178 的隐藏逻辑。
- 单文件判据在 **55s** 内自己结束（打印墙钟），不是被看门狗或 60s 闸门外部击杀。
- 只动 Touches 列出的文件；`DEBUG_AGENT_SPEC_FILES` 的改动是并集语义（该常量跨任务被多条追加，合并冲突取并集，不取单边）。

## Touches

- `e2e/resident-ui-layout.spec.ts` (new)
- `playwright.config.ts`
- `src/modules/chat/transcript/ResidentStatusBar.tsx`
- `src/modules/chat/transcript/ChatMessagesPane.tsx`
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/ChatInterface.tsx`
- `src/modules/chat/tests/residentStatusBarCloseReachable.test.tsx` (new)（结构不变量 vitest）
- `tasks/gap-resident-popover-close-reachable-narrow-viewport.md`（自触）
