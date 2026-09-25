---
id: gap-ac101-actionmenu-arm-window-unverified
title: AC-101 台账连红是合并竞态：修法 35cd475c 不在 driver 那批红跑所用的树里（本轮实测 11/11 绿，含并发）；钉住
  ActionMenu「武装晚一帧」留下的未测窗口
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
---
## Proposal

2026-09-26 gap 轮次：AC-101（GOAL-002「会话列表过滤在真实应用中可用」）的 GOAL 不再活跃且未声明 `long-term`，台账把它记为 CURRENTLY FALSE（最后一条 goal 事件 `2026-09-25T15:37:44.753Z`，actor `goal-cli`，verdict `fail`）。本轮**直接重跑判据**（不是读台账尾巴），取到的读数与台账相反：判据在当前的树上是**绿**的。本任务记录该测量、给出台账为何仍读红的机械证据，并把修法留下的一个未测时序窗口钉住。

**本轮直接读数**（canonical checkout，HEAD `8b7745bd`，树内含 `35cd475c`）：`npm run test:e2e -- e2e/session-filter.spec.ts` → `EXIT=0`、`5 passed`，连续 5 次，墙钟 24.3s / 38s / 37s / 37s / 39s；另加两次**并发**（同一时刻跑两份该 e2e）各自 `EXIT=0`、`5 passed`（31.3s / 26.7s）。合计 11/11 绿，含并发条件。

**台账为什么读红——driver 的 pre-filing 重跑与它自己的 fan-in 赛跑。** 机械判据：`git merge-base --is-ancestor 35cd475c 72c0ec46` → **NO**。`72c0ec46` 是 develop 在 23:30:10 的位置，也正是 canonical checkout 在 23:37:53 之前所处的 HEAD；修法 `35cd475c`（"fix(sidebar): arm ActionMenu viewport dismissal on the next frame"，提交于 23:19:15）到达 develop 是 23:37:25（reflog `8b7745bd develop@{2026-09-25 23:37:25}: push`），canonical checkout fast-forward 到它是 23:37:53。最后一条红的 dataDir `quay-e2e-TaQJfb` 在 23:37:03 被杀，即那次跑起点在 23:36:08 前后，**早于修法落地**；此前那 10 条红（本地 22:05 → 23:34）更全部早于 23:19:15 的修法提交。所以整条红串跑的都是不含修法的树：前一个任务的修法**是有效的**，只是它的落地与 driver 这一轮的复跑重叠了。

**红被保留下来的机制**（取自 `TaQJfb/trace.zip`，在该 dataDir 被回收前取出，仅作机制留档）：`e2e/session-filter.spec.ts:602` 点 ⋯ 成功（44ms），菜单 DOM 渲染出全部 5 个 menuitem（frame-snapshot #5），但 `:603` 的 `getByRole('menuitem', { name: 'Hide similar' })` 永不解析；跑随即被杀于 `Error: Channel closed`，`EXIT=1`；`error-context.md` 在 ~55s 的快照里显示 ⋯ 按钮 `[active]` 而 AX 树中没有 menu。

**本任务真正要补的缺口。** 落地的修法是**单帧**延后武装（`src/shared/ui/ActionMenu.tsx` 里 `window.requestAnimationFrame(() => { addEventListener(...) })`），它的正确性依赖一条没有被钉住的假设：「打开那次点击引发的焦点滚动与 rAF 回调在同一次渲染更新里，且滚动步骤在前」。`src/shared/tests/actionMenuViewportDismissal.test.tsx:54-67` 只钉住了滚动**早于**武装帧的那一支；滚动**晚于**武装帧（渲染变慢时会这样）时菜单会不会被关掉，既没有用例也没有读数。判据 `npm run test:e2e -- e2e/session-filter.spec.ts` 是本目标的退出条件之一、由 driver 每轮复跑，把一条未测的时序假设留在它的必经之路上，就是这一条 AC 反复回红的现实来源。

**做法（测在改之前，改动面限制在两个文件，不新增源文件）**：加一个用例把「滚动晚于武装帧」这一支测出来，并记录实际行为；只有当窗口确实为真（该用例显示菜单被关掉），才在产品侧关掉它，并且必须同时保住既有的对照用例 `a scroll from a later interaction still dismisses the menu`（同文件 `:69`）。若无法在保住对照的前提下关掉窗口，就把 `ActionMenu.tsx` 还原到本任务前的内容、在完成记录里写下这个否证结果——不得拿一个已知为绿的保证去换一个可能为红的改动。

<!-- dedup-ref --> 与同族已完成的 `gap-actionmenu-dismissed-by-open-focus-scroll` 的关系仅作溯源：那个任务的机制是「监听器在打开瞬间就装上，于是被打开点击自己引发的那次滚动命中」，已由 `35cd475c` 修掉且上面实测 11/11 为绿；本任务只处理「武装被推迟恰好一帧、于是晚于一帧到达的滚动仍会命中」这个未被测到的窗口，不是同一个机制，不重做前者。改动同样不得碰 `e2e/session-filter.spec.ts`、`goals/AC-101-*.md` 与夹具播种。

## AC

- [ ] AC1 判据在最终树上为绿：`npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 0 且输出含 `5 passed`；完成记录里写下该次跑的 dataDir 与墙钟毫秒。
- [ ] AC2 窗口被测量并钉住：`npx vitest run src/shared/tests/actionMenuViewportDismissal.test.tsx` 退出码 0，且该文件里存在一个「开到菜单、跑过武装帧、再派发滚动」的用例；该用例的实际读数（菜单仍在 / 菜单被关）逐字写进完成记录。
- [ ] AC3 对照仍在且为绿：同名文件里 `a scroll from a later interaction still dismisses the menu` 一例仍存在且通过——不许把关闭策略整段删成「永不关闭」。
- [ ] AC4 若 AC2 显示窗口为真并因此改了 `src/shared/ui/ActionMenu.tsx`，则 AC1 必须在**改后的树**上重跑并为绿；若在保住 AC3 对照的前提下关不掉窗口，则 `ActionMenu.tsx` 被还原为本任务前的内容，完成记录里写下否证。
- [ ] AC5 未走捷径：本任务的改动范围内 `git diff --stat` 不含 `e2e/session-filter.spec.ts`、`goals/AC-101-*.md`、`playwright.config.ts`；该 spec 里没有新增 `scrollIntoViewIfNeeded()` / retry / `skip`。

## DoD

落地标准是**对象真的被运行过**，不是「有用例存在」。完成记录必须逐字带上：(1) AC1 那次 criterion 跑的退出码、`5 passed`、dataDir、墙钟毫秒；(2) AC2 新增用例的名字与它的实际读数（菜单仍在 / 被关）；(3) 若做了产品侧修改，改后 AC1 的重跑读数；若走否证分支，给出 `git diff` 证明 `ActionMenu.tsx` 与本任务前逐字节相同；(4) AC3 对照用例通过的那一行 vitest 输出。夹具与用例是必要条件，不是充分条件。

## Touches

- src/shared/ui/ActionMenu.tsx
- src/shared/tests/actionMenuViewportDismissal.test.tsx
- tasks/gap-ac101-actionmenu-arm-window-unverified.md
