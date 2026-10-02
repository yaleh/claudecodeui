---
id: gap-ac173-ledger-red-is-uncommitted-composer-wip
title: "AC-173 判据在净检出（HEAD 0faf62fa = develop）直跑为绿（3 passed / exit 0 /
  elapsed=35453ms）；台账 2026-10-02T13:57:23.642Z 的 spec :1119 红由主检出的未提交 composer
  布局 WIP 造成——判据运行途中该 WIP 被保存，Vite 把这次保存当 HMR 推给正在跑的页面，页面崩（pageError:
  useWebSocket must be used within a WebSocketProvider），GET
  /api/providers/sessions/running 轮询自 13:57:08.888Z 起停摆 ⇒ 徽标恒读
  0。verification-only 归因入档（remedy 归该 WIP 作者：改到可编译并提交／勿在判据运行期保存）"
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-173
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-10-02，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `0faf62fac4cf6cb2f4f73cf5f350a4c59db84852` = `develop`）：`grep -l '^goal_ac: *AC-173' tasks/*.md` → 3 份，`status:` 逐字皆 **done**（`gap-claude-resident-running-view`、`gap-resident-running-view-criterion-bounded-boot-guard`、`gap-ac173-badge-source-mismatch-after-dock-consolidation`）。在飞扫描（逐份读 `tasks/*.md` 的 `^status:`，status ∈ todo/ready/needs-human）→ 全库在飞只有 `tasks/gap-activity-dock-human-gate.md`（`goal_ac: AC-190`），**无一认领 AC-173** ⇒ 无在飞认领者，本条不是重复。机制词扫描 `grep -rln 'resident-running-view' tasks/*.md` 命中 15 份；其中最近的三份 done 分别修「徽标读数源被坞合并换成忙碌集」（`gap-ac173-badge-source-mismatch-after-dock-consolidation`）、「启动守卫」、「徽标初版」——**没有一份**是「主检出的未提交 WIP 在判据运行期被 Vite HMR 推给页面把树打崩」这一机制。本条与 `tasks/gap-ac175-criterion-red-is-uncommitted-composer-wip`（同形：verification-only 归因）同族但不同判据、不同失败行、不同触发路径（那条是 `cn` 未导入在启动期崩，本条是运行期 HMR 崩）。

来源与判据物（逐字取自 `goals/AC-173-真实浏览器里-running-视图分正在运行与常驻-空闲-两组-侧栏徽标只计正在运行的会话.md`）：`criterion:` = `npx playwright test e2e/resident-running-view.spec.ts`。`expect` 逐字：「调试 agent 场景造出一个运行中的会话与两个空闲常驻会话：侧栏 Running 徽标读数为 1；Running 视图两组各列出对应会话，第二组每行有关闭按钮，点击后该会话宿主关闭、从该组消失。取假形态：徽标计入空闲常驻会话 ⇒ 读数 3，必须红。」该 AC `status: achieved`，其 GOAL-013 已 achieved 且不再活，且未声明 `long-term: true`。

**本轮两处直跑（读数不是推断，也不是台账尾巴）**：

（1）**净检出（隔离 worktree，起点 = `0faf62fa` = 当前 `develop`，无任何未提交物）直跑 → 绿**。worktree `/data/home/yale/work/claudecodeui-worktrees/ac173-clean-probe`（`git worktree add --detach … 0faf62fa`，`git status --porcelain` 空），命令逐字 `npx playwright test e2e/resident-running-view.spec.ts` → **EXIT=0**，`3 passed (35.1s)`，`elapsed=35453ms`（< `SINGLE_SPEC_CEILING_MS`）。AC 点名的每条读数都在场（判据自己打印，逐字）：`residents.running=0 residentIdle=2`、`hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=1`、`badge.text="1" badge.label="1 running sessions"`、`badge.source=runningSessions poll (socket frames seen=13, of them stream frames=0)`、`group.running.count=1`、`group.residentIdle.count=2`、`close.request=200`、`hosts.beforeClose=2 hosts.afterClose=1`、`group.residentIdle.count.after=0`、`badge.reading.after=1`、`badge.reading.final=1`、`badge.afterExtra=2`、`shared.perBinding=1 shared.perHost=2 badge.reading=1`、`DEBUG_AGENT_RUN_SEAM_UNAVAILABLE=0 controlPlane.responses=8`。**台账里红掉的那条 `shared.*` 臂这一次读到 `badge.reading=1`**。⇒ **被提交的树满足 AC-173**。

（2）**主检出（带未提交 WIP）直跑 → 红，且红在 boot 之前**。同一命令 → EXIT=1，日志逐字 `[WebServer] 10:02:05 PM [vite] Internal server error: /data/home/yale/work/claudecodeui/src/modules/chat/composer/ChatComposer.tsx: Unexpected token, expected "," (816:31)`（`Plugin: vite:react-babel`），页面随后拿到 `500 (Internal Server Error)`，看门狗逐字 `this run crossed its own 55000ms ceiling at 55006ms and is ending here with exit 1`。该文件**此刻仍是语法错的**（不是历史）：`node -e` 以 `@babel/parser`（plugins `typescript`,`jsx`）解析工作树版本 → `SyntaxError: Unexpected token, expected "," (816:31)`；mtime `2026-10-02 22:02:06 +0800`——作者仍在改它。

**台账 13:57:23.642Z 那条红的机制（从失败跑自己的 trace.zip 读出，不是猜）**：`.quay/gate-events.jsonl` 里 AC-173 `gate=goal` 的尾巴是 `pass` `pass` `fail`：

```
2026-10-02T13:43:56.051Z  goal-cli  pass  acceptance passed (exit 0)
2026-10-02T13:50:34.230Z  goal-cli  pass  acceptance passed (exit 0)
2026-10-02T13:57:23.642Z  goal-cli  fail  acceptance failed (exit 1) — [WebServer] [BABEL] Note: …（490 chars of stderr omitted）
```

该 fail 对应运行数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-mFZhBO`（`test-results/.last-run.json` = `{"status":"failed","failedTests":[…3 条…]}`，`watchdog-state.json` = `{"armed":true,"fired":false,"ceilingMs":55000}` ⇒ 不是被看门狗击杀，是判据自己失败在 21:57:23 本地）。其 `test-results/resident-running-view-resi-44a96-s-the-process-it-belongs-to/` 里：

- `error-context.md` 逐字：`Error: the badge to settle on the turn count — the badge read 0 ("") throughout`，`Location: e2e/resident-running-view.spec.ts:870:3`（即当前 spec 文本 `:1116-1120` 的 `waitForBadge(page, (reading) => reading.reading === perBinding.length, 'the badge to settle on the turn count')`，8s 预算）。
- `trace.zip` 内 `6-trace.trace` 的 console/pageError 事件（时间是 trace 相对毫秒）：

```
32183.498 debug  [vite] hot updated: /src/modules/chat/composer/ChatComposer.tsx
32213.777 PAGEERROR: useWebSocket must be used within a WebSocketProvider
32217.447 PAGEERROR: useWebSocket must be used within a WebSocketProvider
32232.537 PAGEERROR: useWebSocket must be used within a WebSocketProvider
32484.418 debug  [vite] hot updated: /src/modules/chat/composer/ChatComposer.tsx
```

  页面 console 紧接逐字 `The above error occurred in the <ProjectWorkspaceRouteContent> component` —— 承载页面的 React 树被这次 HMR 更新崩掉。
- 同一 trace 的 `*-trace.network` 里，页面自己的 `GET /api/providers/sessions/running`（徽标唯一读数源，`SessionProtectionContext` 5s 一轮）**只到这几拍**：`13:56:53.888Z`、`13:56:58.888Z`、`13:57:03.888Z`、`13:57:08.888Z` —— 之后**再无一次**（下一拍应为 `13:57:13.888Z`）。轮询随树一起死了 ⇒ `waitForBadge` 在整个 8s 窗口里恒读 0 ⇒ 红落在 `:1119`。

⇒ **台账的红 = 「主检出的未提交 composer 布局 WIP 在判据运行途中被保存，Vite 把这次保存作为 HMR 更新推给正在跑的页面，页面崩掉、徽标读数源随之停摆」**，不是 AC-173 的承诺退化。旁证：同一跑的 `armed.session=…` 五条与 `[e2e] client startup: the project row for resident-running-view-workspace landed after 3099ms (attempt 1)` 都正常，说明**启动期是好的**，坏在运行期；同一个未提交 WIP 在本轮立案时的另一次直跑里已经语法错到 boot 都过不去（见上（2））。

**为什么不是「读数源那一版修法没兜住」**：`gap-ac173-badge-source-mismatch-after-dock-consolidation` 的修法 `915e92a0`（`server/index.ts` 的 `driveScenario` 为 per-run 回合先开 run + `teeWriter`）**在 HEAD 里**（`git merge-base --is-ancestor 915e92a0 HEAD` → YES），且 `git log --oneline 915e92a0..HEAD -- server/modules/debug-agent/ server/index.ts src/shared/hooks/useSessionHosts.ts src/shared/context/SessionProtectionContext.tsx src/modules/sidebar/` → **空**（落地后无人再动这些面）。净检出的 `shared.perBinding=1 shared.perHost=2 badge.reading=1` 正是这条修法在起作用。

**该 WIP 无归属任务**：`git log --oneline -S isShortViewport -- src/` 与 `git log --oneline -S areToolsInline -- src/` → 均**空**（从未提交）；在飞任务里没有一份认领它；它只存在于主检出工作树（10 个已改文件，`git diff --stat` = 674 insertions / 62 deletions）+ 未跟踪的 `docs/proposals/mobile-workspace-and-composer-layout.md`。

**本条交付面（verification-only，不改实现/判据/宿主配置一个字节）**：把上面两处直跑读数与 trace 归因做成**可复核的入档读数**，并钉住判法「未提交 WIP 在运行期被 HMR 推崩 ≠ AC-173 回归」。⛔ **不在未提交物上改代码**：那份 composer 布局 WIP 归其作者，正确 remedy 是作者把它改到可编译并提交（或至少别在判据运行期保存它）；⛔ 本条**不 stash、不回退、不编辑**主检出的活 WIP（作者正在改它，mtime `22:02:06 +0800`），也**不**把这条红记成产品回归。

## AC

- [ ] AC1 判据在**净检出**直跑：在隔离 worktree（起点 = `develop`；`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）跑 `npx playwright test e2e/resident-running-view.spec.ts`，退出 0、`3 passed`，把判据自己打印的读数行**逐字**抄进完成记录（至少含 `hosts.running=1 hosts.residentIdle=2 hosts.total=2 badge.reading=1`、`group.running.count=1`、`group.residentIdle.count=2`、`close.request=200`、`hosts.beforeClose=2 hosts.afterClose=1`、`badge.reading.after=1`、`badge.reading.final=1`、`shared.perBinding=1 shared.perHost=2 badge.reading=1`、`elapsed=<n>ms`），并给出跑动时刻（`date -u`）。红态基线（本轮立案读数）：主检出直跑 EXIT=1、`[vite] Internal server error … ChatComposer.tsx: Unexpected token, expected "," (816:31)`、看门狗 `55006ms`。
- [ ] AC2 归因读数逐字入档：从 `.quay/gate-events.jsonl` 打出 AC-173 `gate=goal` 尾巴的 `verdict` 序列与 `timestamp`（本轮读数：`13:43:56.051Z pass` → `13:50:34.230Z pass` → `13:57:23.642Z fail`），并从该 fail 对应的 `trace.zip`（路径 `~/.cache/quay-e2e-tmp/quay-e2e-mFZhBO/test-results/…/trace.zip`，若已被回收则写明并给出可用替代读数）里打出：`[vite] hot updated: …/ChatComposer.tsx` 与 `pageError: useWebSocket must be used within a WebSocketProvider` 的时刻、以及 `GET /api/providers/sessions/running` 的**最后一拍**（本轮读数 `13:57:08.888Z`，之后无）。⚠️ **若某条读数在本条 dispatch 时已不可复现**（WIP 被作者改掉/提交、或 e2e 数据目录已被清理），按不变量改写并在完成记录里显式登记（照 `gap-ac175-criterion-red-is-uncommitted-composer-wip` 的 AC2 做法：用同机制假变异在**本条自己的隔离 worktree**里复现，跑完立即回退并证明零残留），⛔ 不得照抄本轮读数冒充现测。
- [ ] AC3 无归属读数（机械）：`git log --oneline -S isShortViewport -- src/` 与 `git log --oneline -S areToolsInline -- src/` 均空；在飞任务扫描（`tasks/*.md` 的 `^status:` ∈ todo/ready/needs-human 且带 `^goal_ac:`）显示无任务认领该 WIP；两条命令与逐字输出入档。
- [ ] AC4 承重面未被本条触碰：`git diff --name-only develop..HEAD` 只含 `tasks/<本条 id>.md`；主检出的未提交文件集合与本条启动时逐字相同（`git status --porcelain` 与立案快照一致、`git diff --stat` 逐字相同）——⛔ 本条未 stash / 未 `git checkout --` / 未编辑任何 `src/**`、`e2e/**`、`server/**`、`playwright.config.ts`。
- [ ] AC5 如实登记：若 driver 独立复核时台账尾巴**仍是 fail**，完成记录逐字写明「台账尾巴仍是 fail」并附 AC1 的净检出直跑读数，不得写成已通过；若已转 pass，写明转绿时刻与当轮读数。⛔ 不得用组件层/jsdom 的绿替代浏览器层的绿，不得用「净树绿」替代出货命令本身。

## DoD

- 判据本体（出货命令 `npx playwright test e2e/resident-running-view.spec.ts`，逐字不改）在**净检出**上被真的跑过一次，读数行逐字入档——不是复述 `expect` 的文字，不是读台账尾巴，也不是只跑 `-g` 那一条。
- 归因的每一条读数（HMR 行、pageError 行、`running` 轮询最后一拍、从轮询停摆到 `waitForBadge` 恒 0 的因果链）都能由任何人在同一 checkout 上从那份 `trace.zip` 复现；trace 路径与解包命令写进完成记录。
- 完成记录明确写出「**被提交的树满足 AC-173**；台账红是主检出的未提交 composer 布局 WIP 在运行期被 HMR 推给页面把树打崩」，并指出 remedy：该 WIP 的作者把它改到可编译并提交（或停止在判据运行期保存它）。
- 交付物只动 `tasks/<本条 id>.md`：判据文件、实现、未提交工作树、宿主配置一个字节未动（`git status --porcelain` 与立案快照逐字相同）。

## Touches

- tasks/gap-ac173-ledger-red-is-uncommitted-composer-wip.md（自触）
- e2e/resident-running-view.spec.ts（本条只跑不改：AC1 的判据本体，出货命令逐字不改）
- src/modules/chat/composer/ChatComposer.tsx（本条只读不改：未提交 WIP 的语法错误 / HMR 推送源证据）
- goals/AC-173-真实浏览器里-running-视图分正在运行与常驻-空闲-两组-侧栏徽标只计正在运行的会话.md（本条只读不改：`criterion` / `expect` 的逐字来源）
