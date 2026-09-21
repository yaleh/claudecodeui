---
id: gap-transcript-follow-on-pane-shrink
title: 贴底跟随在 pane 自身变矮时也成立：观察滚动容器自身尺寸（键盘弹出等价），视口 844→420 后第一个采样点 gap
  ≤1px、离开底部时零写入（AC-107 判据 e2e/transcript-follow.spec.ts 由红转绿）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-transcript-follow-on-content-resize
goal_ac: AC-107
---
## Proposal

本任务的前置是 `gap-transcript-follow-on-content-resize`（todo，AC-106），已用 depends_on 声明：它建成 `e2e/transcript-follow.spec.ts` 这条判据仪器（`playwright.config.ts` 里服务器启动前播种的长 transcript、手势到位的约定、布局与 ResizeObserver 回调之后的采样约定），并把「贴底」的触发从 React 信号（`chatMessages.length`）换成**内容几何**。本条判据的命令 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-107"` 跑的是同一个文件——但 pane 变矮这一半**不改变内容层的盒子**（变的只有容器自己的 clientHeight），前置的内容层观察器看不见它。两条任务都要新增/改写同一个 spec 文件，物理上不能并发落地，故用 depends_on 串起来，而不是各写一份。

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提）：本任务采用的 e2e 夹具与登录后置锚点约定出自 gap-session-filter-real-browser-e2e（done）与 gap-e2e-onboarding-anchor-seeded-transcripts（done）；本任务不重复申领 e2e 工具链本身，也不回退它们的播种。

### 现象（2026-09-21 源码核对 + AC 记录里的实测）

- 跟随只由 `src/modules/chat/hooks/useChatSessionState.ts` 的 follow `useLayoutEffect`（当前 563–589 行）驱动，依赖数组 `[chatMessages.length, isActive, isUserScrolledUp]`，命中时写一次 `container.scrollTop = container.scrollHeight`。**行数不变就不写**，而 pane 变矮不改变行数。
- 滚动容器是 `src/modules/chat/transcript/ChatMessagesPane.tsx:170` 的 `div.chat-messages-pane`（`min-h-0 flex-1 overflow-y-auto`）；ref 由 hook 持有（`useChatSessionState.ts:209` 的 `scrollContainerRef`）并 return 给 `ChatInterface.tsx` 再传给 pane，**因此观察容器自身不必改 pane 的标记**。
- pane 的高度**跟随视口**：shell 是 `fixed inset-0`，iOS 键盘经 `useVisualViewportKeyboardOffset.ts` 发布的 `--keyboard-height` 把 shell 底边上移（`docs/architecture/05-scrolling.md` 的 Mobile, keyboard and CSS 一节）。视口 844→420 时 pane 的 clientHeight 同幅变小。
- **这次收缩不产生 scroll 事件**：clientHeight 变小只会让可滚区间变大，scrollTop 不需要被 clamp，浏览器不派发 scroll，`isUserScrolledUp` 也就不会被重算。任何以 `scroll`/`wheel`/`touchmove` 为唤醒源的实现都看不见它。
- **内容层的盒子在这次收缩里完全不变**，所以「只观察内容列」的实现必然漏掉这一半——这正是本条判据的取假形态。
- 实测（AC-107 记录 origin，真实实例 390×844）：收缩后 gap 424、1.5s 内零次 scrollTop 写入、视图不回到底。
- 当前必红的**表层**原因与 AC-106 相同：`e2e/transcript-follow.spec.ts` 不存在，playwright 报 No tests found（红先行）。

### 方案

1. 在 hook 里给**滚动容器自身**挂 ResizeObserver（观察 `scrollContainerRef.current`），回调里按**意图**判定并重贴底：
   - `isUserScrolledUpRef.current === false`（用户意图仍是贴底）⇒ 写 `container.scrollTop = container.scrollHeight`；
   - 为 true（用户已离开底部）⇒ **不写**，让 pane 变矮原样把 gap 增大。
   ⛔ **不得用「回调里现测 gap ≤ 阈值」当判定**：pane 变矮的瞬间 gap 已经是 424，现测必然把它判成「已离开底部」而放弃写入——那正是本条判据现在红着的机制。判定的唯一依据是意图状态（`isUserScrolledUpRef`，`useChatSessionState.ts:227` 定义、436 镜像）。
2. 写入放在 RO 回调里**同步**执行（RO 回调在布局之后、绘制之前），这样「改变后的第一个采样点」已经是贴底态；rAF 里可再补一次，但**不得只在 rAF 里判定**。
3. 两个观察目标各承担一半，不能互相替代：内容层（前置任务，覆盖内容长高）与容器自身（本任务，覆盖 pane 变矮）。
4. 不改变既有语义：`isUserScrolledUp`、`pendingScrollRestoreRef`（会话切换/分页恢复）、`nearBottom < 50`、搜索跳转、`handleScroll` 里的 `loadOlderMessages` 一律保持；观察器在会话切换与组件卸载时 disconnect；贴底 pin 不得反过来置位/清位 `isUserScrolledUp`（程序写入的 scroll 回声由既有 `handleScroll` 处理，其语义由 AC-111 承载）。

### 判据 spec（`e2e/transcript-follow.spec.ts` 内新增，用例标题必须含字面量 AC-107）

- 复用前置任务在 `playwright.config.ts` 里、**服务器启动前**、仅 `isDataDirOwner` 进程里种下的**同一份**长 transcript 夹具（本任务不重建夹具、不回退播种；测试运行中写入会被 watcher 捕获并逐个广播 session_upserted，把会话标成「需关注」导致随机红）。
- 打开该会话（经侧边栏会话行，不直接操纵 store），`page.setViewportSize({ width: 390, height: 844 })`，用**用户手势** `page.mouse.wheel` 到达底部（⛔ 不得用 evaluate 直接设 scrollTop 冒充手势）。
- 贴底半：`page.setViewportSize({ width: 390, height: 420 })`；采样点必须在**布局与 ResizeObserver 回调之后**（页面内一个**后注册**的 ResizeObserver——RO 回调按注册顺序派发，测试的观察者在应用之后跑——或 rAF 内再 setTimeout 0）；⛔ 在 rAF 内直接读 scrollHeight 读到的是 pin 之前的状态，不得当作绘制态。
- 对照半：先用**手势**离开底部（gap > 阈值），再做同样的收缩。
- 程序写入计数：`page.addInitScript` 包裹 `Element.prototype.scrollTop` 的 setter（保留原 descriptor，只追加 `{ t, value, stack }` 到 `window.__scrollWrites`，**只计数、不改语义**）；取「收缩前 mark → 第一个采样点」之间的增量。用户手势与浏览器 clamp 不走这个 setter，所以它读到的就是「程序写入」。
- 抗假变体（真跑、留输出、须还原）：把实现换成「只观察内容列、不观察 pane 自身尺寸」（即前置任务的形态）⇒ 贴底半必须红，且红的是 gap ≈ 424，而不是夹具/端口问题。
- 登录后置锚点不得等 Choose Your Project 空态（播种会让该 workspace 自动成为项目），锚在真实视图里必然存在的元素（如 Settings 按钮）上。

## AC

- [ ] `npx playwright test e2e/transcript-follow.spec.ts -g "AC-107"` 退出码 0（真实 Chromium 打 playwright webServer 起的真实后端 + 真实 Vite，隔离数据目录；不得 stub 后端、不得用 evaluate 直接设 scrollTop 冒充用户手势）。
- [ ] 同一 spec 的**贴底半**：390×844 下用真实手势贴底（gap=0）后把视口高度改为 420，改变后的**第一个采样点**（布局与 ResizeObserver 回调之后）gap ≤ 1px。
- [ ] 同一 spec 的**对照半**：先用手势离开底部后做同样的收缩 ⇒ 程序写入 scrollTop 计数为 0（init script 计数）、scrollTop 不变（±1）、gap 恰好增加该次收缩实测的 clientHeight 减少量（±1）、期间 pane 的 scroll 事件计数为 0。
- [ ] **抗假变体真跑并留输出后还原**：只观察内容列、不观察 pane 自身尺寸的版本使贴底半变红（gap ≈ 424）；`git diff` 证明 spec 的真实断言一条未删、未经 stub/skip，实现已还原。
- [ ] `src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 新增用例：用可手动触发的 ResizeObserver stub（仿 `lazyMessageRow.test.tsx` 的 IntersectionObserver stub）驱动容器尺寸变化——意图=贴底时恰好写一次 scrollTop，意图=离开底部时零写入；`npm run test:client`、`npm run typecheck`、`npm run lint` 退出码 0。
- [ ] `docs/architecture/05-scrolling.md` 中与本条冲突的表述已改正（键盘弹出/pane 变矮不再只是「不重贴底」的注脚），且未改动该节之外的内容（`git diff --stat` 可见）。

## DoD

真实落地判据：不是 spec 文件存在，也不是某一次恰好绿。要求在真实实例（vite + 后端，隔离数据目录）上由该 spec 驱动真实浏览器走完 AC-107 全文——真实手势贴底、真实视口收缩、布局与 ResizeObserver 回调之后的采样——判据命令**可重复地**退出 0（连续 ≥2 次），并把抗假变体的红灯输出（gap ≈ 424）与还原证据记入完成记录；AC-107 在驱动器下一轮经 `goal_ac: AC-107` 独立核验时由红翻绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。

实现这一半必须在 `src/` 内真实落地：⛔ 不得靠 spec 里 `evaluate` 打补丁、不得靠注入 CSS/脚本模拟贴底来换绿——判别方式就是抗假变体必须红。

⛔ 已知仪表风险，如实记录而不是谎报绿：goal gate 的 `runAcceptance` 有 60s 硬超时，而本条判据要起两个 webServer（后端 tsx + vite）再跑一次 Chromium。取得读数时**同时记 wall time**；若某次以「acceptance timed out」收场，那是判据仪表的读数丢失，点名它，不要把超时当成绿、也不要把超时当成代码缺陷。

登记（避免下一轮踩同一坑）：`src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 是既有单元测试文件，扩展它即可（不新建测试文件就不受 boundaries lint 对新增测试文件的桶导入要求；若确实要新建，必须经模块 barrel 导入）。e2e 端口 47101/47173 写死在 `playwright.config.ts`：并发 worktree 的 e2e 会撞死端口，取得读数前先确认端口空闲。`scripts/test.sh` 的 scoped 门对 `e2e/*.spec.ts` 判 thin，照常跑判据命令、`npm run test:client`、`npm run typecheck`、`npm run lint`，并把真实输出记入证据。预期不需要改 `ChatMessagesPane.tsx`（容器 ref 已在 hook 内）；若确实需要，先把它加进 Touches 再改。

L_D 该轴仍暗，理由：本任务只改前端滚动几何与新增一条浏览器判据，不新增领域数据能力，没有可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是浏览器里的像素几何（gap / clientHeight / scrollTop 写入计数），不是生成质量轴。

## Touches

- e2e/transcript-follow.spec.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/tests/transcriptScrollOwnership.test.tsx
- playwright.config.ts
- docs/architecture/05-scrolling.md
- tasks/gap-transcript-follow-on-pane-shrink.md