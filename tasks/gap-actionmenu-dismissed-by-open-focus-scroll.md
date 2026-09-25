---
id: gap-actionmenu-dismissed-by-open-focus-scroll
title: AC-101 判据 case 5 红：⋯ 菜单被它自己那次打开点击引发的浏览器焦点滚动关掉——ActionMenu 在捕获期监听 window
  scroll，部分被裁切的行第一次点 ⋯ 只会把菜单闪开又关掉，Hide similar menuitem 永不出现
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
---
## Proposal

2026-09-25 gap 轮次：AC-101（GOAL-002「会话列表过滤在真实应用中可用」）的 GOAL 不再活跃且未声明 `long-term`，台账把它记为 CURRENTLY FALSE。本轮**直接重跑判据**（不是读台账尾巴）取到读数（canonical checkout，树 = develop `3bd758df`）：

- `npm run test:e2e -- e2e/session-filter.spec.ts`：case 1–4 绿（2.2s / 0.32s / 0.98s / 1.8s），case 5 永不结束；自带看门狗在 55006ms 判红退出，`EXIT=1`，两次重跑一致；判词 `stuck at stage "browser-launch-or-cases"`。
- `DEBUG=pw:api` 下最后一条 API 行是 `waiting for getByRole('menuitem', { name: 'Hide similar' })` —— 永不解析；它前一步点 `getByRole('button', { name: 'Session options for human-alpha' })` 是**成功**的。
- 同序浏览器探针（临时探针 spec 用完已删，读数如下）点击前：`scroller{clientHeight:388, scrollTop:0, scrollHeight:673, top:169, bottom:557}`、`button{top:555, bottom:583}` ⇒ **⋯ 按钮有 26px 落在侧栏折叠线之下**。第一次点击 → `{menus:0, items:[], scrollTop:26}`（菜单开过又自己关了，容器被滚了 26px）；先 `scrollIntoViewIfNeeded()` 再点 → `{menus:1, items:[Rename session / Copy Claude session / Fork session / Hide similar / Archive or delete session], scrollTop:32}`。既有 diag spec 的事件序：`mousedown@37:BUTTON → focusin@38:Session options for human-alpha → mouseup@38 → click@38 → win-scroll@48 → scroll@48:DIV(overflow-auto) top=26`，rAF 采样 `48:1/true → 65:0/false`。

机制：`src/shared/ui/ActionMenu.tsx:112-124` 的 portal 关闭策略在**捕获期**监听 `window` 的 `scroll`（`window.addEventListener('scroll', closeOnViewportChange, true)`），后代容器的任何滚动都会命中。⋯ 按钮部分被裁切时，mousedown 让它获得焦点，浏览器为了让焦点可见会**滚动最近的滚动祖先**（此处是 `ScrollArea` 内层 `h-full w-full overflow-auto` 的 div，26px）；该 scroll 事件在渲染步骤里派发，约 10ms 后到达 ⇒ 菜单刚打开就被**它自己那次打开点击**引发的事件关掉。第二次点击不再引发滚动（按钮已在视野内），所以第二下才正常。对真实用户一样：部分可见的行上第一次点 ⋯ 只会闪一下、什么都不发生（菜单项打不开，`Hide similar` 也就无从点起）。

为什么此前六个 AC-101 任务都没压住：`gap-session-filter-real-browser-e2e`（建真实浏览器判据）、`gap-ac101-criterion-bounded-under-gate-cap`（Playwright spawn 前探测无 deadline）、`gap-ac101-criterion-concurrency-determinism`（并发撞死写死端口）、`gap-canonical-checkout-node-modules-missing-compression`（主 checkout 缺 compression ⇒ 后端起不来）、`gap-session-filter-editor-locator-unscoped`（过滤入口定位器未限定项目）、`gap-session-filter-criterion-bounded-boot-guard`（启动阶段无界 + 有界预热/启动探针）——六个全是**装置侧**（夹具/端口/依赖/启动/定位器），没有一个动过 `ActionMenu` 的关闭策略。这一轮的红落在 case 5 **用例体内部**，case 1–4 全绿。

<!-- dedup-ref --> 回归窗口（本地 21:03 最后绿 `adb481f9` → 21:41 `c556834e`，首次红 22:05）里 `src/` 无改动，case 5 的用例体逐字节相同（对两端的该文件尾部做 diff = IDENTICAL）；窗口内唯一的夹具变化是 `playwright.config.ts` 新加的 `seedMobileLayoutWorkspace()`（新增 workspace `mobile-layout-workspace` 与长名会话 `e2e-mobile-layout`）。夹具集对未限定作用域的定位器是 load-bearing 的（本项目已有同族先例），但本树**没有**做反向移除来定因：canonical checkout 上有活跃 anchor 与在跑 worker。所以本任务只把「窗口内 `src/` 无改动、case 5 首次转红」当事实，不把定因当前提。

修法（**产品侧**，全部落在 `src/shared/ui/ActionMenu.tsx` 内部，不新增源文件）：让菜单不被「打开它的那次交互」引发的滚动关闭，同时保住原意——真实用户的滚动不能让菜单悬在错误位置（关闭，或重新定位到仍与触发按钮对齐）。实现者自选机制，推荐：把 `closeOnViewportChange` 的**武装**推迟到下一帧（滚动事件在渲染步骤里、动画帧回调**之前**派发，被同一次点击引发的那个 scroll 因此不会命中监听器）；等价机制亦可。⛔ 不许改 `e2e/session-filter.spec.ts`、`goals/AC-101-*.md`，不许在用例里加 `scrollIntoViewIfNeeded()` / retry / skip；⛔ 不许把 `closeOnViewportChange` 整段删掉就算完（AC3 的对照会红）；⛔ 不许把夹具播种条件化。worktree 内跑 e2e 按本仓既有办法：依赖装在仓库根，只跑这一份 spec。

## AC

- [ ] 判据翻绿：`npm run test:e2e -- e2e/session-filter.spec.ts` **5 passed**、`exit 0`、wall < 55000ms（一次都不触发自带看门狗），且输出里 `flaky` / `retries` 零次。验证：`echo $?` + wall time + 输出尾部写进完成记录。
- [ ] 机制级读数（构造先自证，再红-绿对照）：探针在同一夹具集下取 `⋯` 触发按钮与侧栏滚动容器的几何，**自证按钮被折叠线裁切 ≥1px**（必要时调小视口；裁切不成立则该读数作废并判红，防止「构造没复现」被当成绿）。裁切成立时**第一次**点击 ⋯ 后：`role=menu` 计数 1、5 个 menuitem 齐在（含 `Hide similar`）、其后 200ms 内容器 `scrollTop` 不再变化；回退修复后同一探针读到 `menus:0`、容器滚动 26px、`Hide similar` 永不解析并被看门狗击杀 `exit 1`。回退用 `git checkout <base> -- src/shared/ui/ActionMenu.tsx`（已提交的改动 `git stash` 是空操作）。两组读数都登记。验证：探针 stdout 逐字段抄进完成记录；探针不得留在 `e2e/` 下（用完删除）。
- [ ] 正对照（不许「永不关闭」的假修）：菜单打开时**故意**把侧栏容器滚 ≥100px（不经过点击 ⋯），随后读菜单 rect 与触发按钮 rect —— 必须**要么菜单已关闭**、**要么** `menu.top ≈ trigger.bottom + 6`（±2px，即重新定位后仍与按钮对齐）；若 `menu.top` 停在滚动前的旧值且与 `trigger.bottom + 6` 相差 ≥100px 则判红。另需 Escape、容器外 mousedown、点选任一项仍关闭菜单（`aria-expanded` 回到 false）。反形式：把 `closeOnViewportChange` 整段删除（「懒修」）时本对照必须**红**、而 AC1 仍绿。验证：两个方向的探针读数写进完成记录。
- [ ] 判据与夹具未被改弱：`git diff develop -- e2e/session-filter.spec.ts playwright.config.ts` 为空；`grep -nE "^\s*retries\s*:" playwright.config.ts` 无命中；`grep -c "reuseExistingServer: false" playwright.config.ts` 为 2；`goals/AC-101-*.md` 的 `criterion:` 仍是 `npm run test:e2e -- e2e/session-filter.spec.ts`。验证：上述四条命令的输出。
- [ ] 共享前端回归与静态门：`npm run test:client`、`npm run typecheck`、`npm run lint` 三者 `exit 0`，且 `npm run test:client` 输出里出现 `src/modules/sidebar/tests/sessionOptionsHideSimilar.test.tsx` 与新增的 `src/shared/tests/actionMenuViewportDismissal.test.tsx`（`$frontend-module-standards`：共享前端测试落 `src/shared/tests/`，导入走 barrel）。新增测试必须红-绿可辨：打开菜单后在**同一次交互内**派发的容器 scroll 不得关掉菜单，而一次独立交互之后再派发的同款 scroll 必须关掉它；若 jsdom 无法表达该时序，完成记录要写出被拒的构造与理由，并改为直接断言关闭策略的输入。

## DoD

真落地标准：driver 下一轮 goal-gate 重跑 `npm run test:e2e -- e2e/session-filter.spec.ts` 翻绿并把 pass 写进 `.quay/gate-events.jsonl`（台账尾部不再是 CURRENTLY FALSE）。这条绿必须是**产品行为**的绿：真实浏览器里一个部分被侧栏折叠线裁切的行，第一次点 ⋯ 就打开菜单并能点中 `Hide similar`（AC2 读数），而不是靠动判据/夹具/重试换来的绿（AC4 机械钉住）。完成记录必须写明：(1) 判据 5 passed 的 wall 与 exit；(2) 修复前 `{menus:0, scrollTop:26}`、修复后 `{menus:1, 5 items}` 与「懒修」（整段删除）下 AC3 对照判红的读数；(3) 定因的边界——本树未做反向移除，回归窗口内新增的 `mobile-layout-workspace` 夹具只是与「夹具集 load-bearing」这一既有机制一致，**不是已证的因**。

该轴仍暗，理由：纯前端交互时序修复，没有可独立度量的 L_D/L_G 读数；验收以判据重跑绿与 AC2/AC3 的浏览器读数为准。

## Touches

- src/shared/ui/ActionMenu.tsx
- src/shared/tests/actionMenuViewportDismissal.test.tsx (new)
- tasks/gap-actionmenu-dismissed-by-open-focus-scroll.md
