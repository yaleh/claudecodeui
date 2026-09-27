---
id: gap-claude-resident-running-view
title: AC-173 真实浏览器里 Running 视图分「正在运行」与「常驻（空闲）」两组、侧栏 Running
  徽标只计正在运行的会话（徽标计入空闲常驻 ⇒ 读数 3 必须红）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-api-smoke-human-gate
  - gap-lifecycle-mode-matrix-and-host-api
  - gap-claude-resident-status-bar
goal_ac: AC-173
---
## Proposal

<!-- dedup-ref --> **机制去重读数（本轮立案时实测，2026-09-27）**：`grep -rn '^goal_ac: *AC-173' tasks/*.md | wc -l` → **0**；`grep -rln 'AC-173' tasks/*.md` → **1**，唯一命中是 `tasks/gap-claude-resident-status-bar.md:57` 的**非目标段让位**（逐字「AC-173 的 Running 视图与侧栏徽标分组」），该文件顶层 `goal_ac: AC-172`，不认领本条。按机制词再扫一遍：`grep -rln 'running-view\|Running 视图\|resident-running-view' tasks/*.md | wc -l` → 1（同一条非目标）；`grep -rln '常驻（空闲）' tasks/*.md | wc -l` → **0**。⇒ AC-173 无认领者，本条不是重复。

**来源与判据物。** 判据逐字取自 `goals/AC-173-真实浏览器里-running-视图分正在运行与常驻-空闲-两组-侧栏徽标只计正在运行的会话.md` 的 `criterion:`：`npx playwright test e2e/resident-running-view.spec.ts`（命令逐字含文件路径，不用 glob）。`expect` 逐字（同文件 `:8-9`）：「调试 agent 场景造出一个运行中的会话与两个空闲常驻会话：侧栏 Running 徽标读数为 1；Running 视图两组各列出对应会话，第二组每行有关闭按钮，点击后该会话宿主关闭、从该组消失。取假形态：徽标计入空闲常驻会话 ⇒ 读数 3，必须红。」

**红态基线（本轮直跑，读数不是推断）：** `npx playwright test e2e/resident-running-view.spec.ts --list` 退出 **1**，输出逐字 `Error: No tests found.` / `Make sure that arguments are regular expressions matching test files.` / `Total: 0 tests in 0 files`（`--list` 只收集、不起 webServer，所以这条读数与判据同为「该文件不存在」这同一个事实）。`ls e2e/resident-running-view.spec.ts` → `No such file or directory`；`ls e2e/ | grep -ci resident` → **0**。

**现状（本轮实测的读数）—— 徽标与 Running 视图今天都读客户端忙集，组只有一个、收起也关不掉**

- **徽标的数来自客户端忙集，不是宿主接口**：`src/modules/sidebar/hooks/useSidebarController.ts:144` 逐字 `const runningSessionsCount = activeSessionIds.size;`（`:143` 逐字 `const activeSessionIds = activeSessions;`），而 `activeSessions` 是 `src/modules/sidebar/Sidebar.tsx:91` 逐字 `const activeSessions = useBusySessionIdSet();`。`useBusySessionIdSet()`（`src/shared/context/SessionProtectionContext.tsx:159`）读的是 `BusySessionIdsContext`，由 `:49` 的 `useBusySessionIds(processingSessions)`（`:142` 注入）填出，源头是 `src/shared/api.ts:264` 逐字 `runningSessions: () => get('/api/providers/sessions/running')` ⇒ **客户端事实，不是 `GET /api/session-hosts`**。全库 `grep -rn 'session-hosts' src/ --include=*.ts --include=*.tsx | wc -l` → **0**，前端今天没有宿主读路径。
- **徽标有读点但无 DOM 契约**：`src/modules/sidebar/SidebarHeader.tsx:80` 逐字 `const runningBadgeText = runningSessionsCount > 99 ? '99+' : String(runningSessionsCount);`，两处渲染（`:186` 与 `:326`，桌面/移动两支），外层都是 `<button … aria-label={t('search.runningTooltip', 'Running sessions')}>`（`:175`、`:315`）。没有 `data-*` 钩子 ⇒ 判据今天只能靠那个 aria-label 文案定位，而该 key（`search.runningTooltip`/`search.modeRunning`）在 12 个 locale 的 `sidebar.json` 里都**不存在**、跑的是 fallback 字面量。
- **Running 视图今天只有一个组、平铺**：`src/modules/sidebar/SidebarContent.tsx:425` 逐字 `searchMode === 'running'` 分支只渲染一个表头 `t('running.title', 'Running now')`（`:447`）带计数 `{runningSessionsCount}`（`:451`），随后是**平铺的** `<SidebarProjectList {...projectListProps} />`（`:457`）⇒ 没有「正在运行 / 常驻（空闲）」两组，也没有每行的 [关闭]。
- **`running.*` 文案在 12 个 locale 里都不存在**：`grep -rln '"running"' src/modules/i18n/locales/*/` 只命中 `en/settings.json`；`en/sidebar.json` 的顶层键逐字是 `['projects','app','sessions','tooltips','navigation','actions','branding','status','time','messages','version','search','recent','deleteConfirmation','sessionFilter','resizeHandle']` —— **没有 `running`**（`search` 下也没有 `runningTooltip`/`modeRunning`）。sidebar 的 `t` 绑的是 `useTranslation(['sidebar','common'])`（`src/modules/sidebar/Sidebar.tsx:73`），所以本条的文案面就是 `sidebar.json` × 12。
- **入口可驱动**：Running 模式的切换钮是 `src/modules/sidebar/SidebarHeader.tsx:311-333` 的 `<button onClick={() => onSearchModeChange('running')} aria-pressed={searchMode === 'running'} aria-label={t('search.runningTooltip','Running sessions')}>`，内含 `<span className="sr-only">{t('search.modeRunning','Running')}</span>`（`:332`）⇒ 判据可从这枚 `aria-pressed` 驱动。
- **宿主接口已在后端**：`GET /api/session-hosts` 挂在 `server/modules/session-hosts/session-hosts.routes.ts:61`，`server/index.ts:213` 装配；该路由文件今天只有这一个 GET（`wc -l` → 98），`POST /:sessionId/close` 由 AC-169 落地。
- **调试 agent 场景是「按会话」的**：`server/modules/debug-agent/debug-agent.routes.ts:63-68` 的 `driveScenario({ sessionId, cwd, projectPath, writer })`、`POST /scenarios`（`:196`，`SCENARIOS_PATH = '/scenarios'`）按 `sessionId` 装填、`POST /clock`（`:223`）推进，`/clock` 的 body 逐字只带 `sessionId`（`:226`）⇒ **三个会话 = 三份 scenario 各自装填/推进**，本判据要的「一运行 + 两空闲常驻」不必新造一个多会话场景类型。
- **e2e 的服务器今天不带调试 agent 门控**：`playwright.config.ts` 的 server `webServer.env`（`:1337-1342`）逐字只有 `SERVER_PORT/HOST/DATABASE_PATH/HOME`，没有 `DEBUG_AGENT`；而配置**已经会读本次选中的判据文件**：`playwright.config.ts:332` 的 `selectedSpecFiles()`（`:344` 的 `RUN_CEILING_MS` 正用它）⇒「只对含本判据的选择开门」有现成接缝。
- **判据有 55 秒上限**：`playwright.config.ts:285` 逐字 `const SINGLE_SPEC_CEILING_MS = 55_000;`；`SPEC_BUDGET_MS`（`:287-289`）只有 `mobile-workspace-composer-layout.spec.ts` 一个例外 ⇒ 单文件判据必须在 **55s** 内自己结束。

<!-- dedup-ref --> **三条真前置（关系边已写成顶层 `depends_on`，本段只作溯源）**：`gap-claude-resident-api-smoke-human-gate`（`goal_ac: AC-170`，status=todo）—— AC-170 的正文逐字「UI 相关 AC（AC-171 至 AC-175）的派工任务以本条对应的任务为前置」，人 yale 在 `docs/proposals/claude-resident-sessions-smoke.md` 写下 `冒烟验收：通过` 之前，本条不得开工。`gap-lifecycle-mode-matrix-and-host-api`（`goal_ac: AC-169`，status=todo）—— 本条要读的「这个会话是不是常驻、宿主现在什么状态」是它落的 `sessions.lifecycle_mode` 列与能力矩阵，第二组的 [关闭] 是它落的 `POST /api/session-hosts/:sessionId/close`。`gap-claude-resident-status-bar`（`goal_ac: AC-172`，status=todo）—— 本条读宿主列表要走它落的 `src/shared/api.ts` 的 `GET /api/session-hosts` 客户端与 `src/shared/hooks/useSessionHosts.ts`，本条**不得**在前端另写第二份 `/api/session-hosts` 取数；它同时把调试 agent 的「常驻但未运行 / 忙」在出厂控制面上的可达性与 `playwright.config.ts` 的门控接缝落地。三条机制与本条不相交（一条人工冒烟、一条偏好列与宿主 API、一条状态条与共享读路径），故硬串行、不并发。

**要建的东西（范围是 AC-173 的最小充分集）**

1. **共享读路径（消费 AC-172 的，不另写一份）**：Running 视图与徽标都从 `useSessionHosts()`（`GET /api/session-hosts`）读「某会话的宿主状态与 lease」；`src/shared/api.ts` 的客户端与 `useSessionHosts.ts` 的 hook 由 AC-172 落地，本条只在缺「整表读」时**扩展同一个 hook**。
2. **徽标只计正在运行（假形态的落点）**：`runningSessionsCount` 不再等于客户端忙集大小，而是宿主快照里 `state` 属于「正在运行」的会话数；空闲常驻（有宿主、无 in-flight turn）**不计入**。两处渲染点（`SidebarHeader.tsx:186`、`:326`）同源，加稳定 DOM 契约（如 `[data-running-badge]`，文本取数字）与可访问名。
3. **Running 视图分两组**：第一组「正在运行」列 `state ∈ 运行中` 的会话；第二组「常驻（空闲）」列有常驻宿主但当前无轮次的会话。每组一个稳定契约（如 `[data-running-group="running"]` / `[data-running-group="resident-idle"]`）与组内行数读数。
4. **第二组每行 [关闭]**：按钮有稳定契约与可访问名；点击调 `POST /api/session-hosts/:sessionId/close`，成功后该会话的宿主关闭、**从第二组消失**（组内行数减一），第一组与徽标读数不受影响。
5. **文案进 12 个 locale 的 `sidebar.json`**：`running.title`（今天的 fallback 是 `'Running now'`）、两个组名、[关闭] 与其可访问名、徽标可访问名；判据运行期从出货目录读句子，不抄进 spec。
6. **e2e 门控**：`playwright.config.ts` 在 `selectedSpecFiles()` 含 `resident-running-view.spec.ts` 时给 server `webServer.env` 加 `DEBUG_AGENT=1` 与 `DEBUG_AGENT_HOME=<本次 run 的 dataDir 下的 fixture 根>`；**其它选择逐字不变**（今天所有 e2e 都不带门控，这条改动不得把它们带上）。
7. **判据 `e2e/resident-running-view.spec.ts`**：真浏览器、真服务、按会话装填的调试 agent 场景（三个会话）；徽标读数、两组分组、[关闭] 的宿主存亡与移出各一段原始读数，一条假形态臂。

**非目标**：AC-172 的会话内状态条、popover、四态标记与停止语义；AC-171 的知情门控与开关；AC-174 的 Shell 标签禁用；AC-175 的忙时直发与撤回；AC-169 的 `lifecycle_mode` 列、能力矩阵与 `start|close` 路由**本身**；AC-164 的地址生成与改名不变；`src/shared/api.ts` 与 `useSessionHosts.ts` 的**首次落地**（AC-172 的）；任何真实 claude 二进制、任何 subprocess 形状。

## Plan

1. **量三条前置落地后的实际形状**（任一尚不具备时判据**点名拒绝**，缺哪件就打印哪件，不写假读数）：`GET /api/session-hosts` 里「正在运行 / 常驻空闲」分别对应哪个 `state`/`lease` 形状（逐字字段名）；`POST /api/session-hosts/:sessionId/close` 的调用形状与状态码；`useSessionHosts()` 今天暴露的粒度（单会话还是整表）。
2. **三个会话的替身**：按 `debug-agent.routes.ts` 的按会话装填（`POST /scenarios` + `POST /clock`）装出「一运行 + 两空闲常驻」；先量这条链今天把会话绑不绑成常驻宿主、空闲态在控制面上可不可达（读不到就如实登记缺口并**点名**，不静默补假读数）。
3. **门控**：`playwright.config.ts` 按 `selectedSpecFiles()` 条件为 server 加 `DEBUG_AGENT*`；同步验证 `npx playwright test e2e/model-env-kind-explanations.spec.ts` 仍退出 0。
4. **前端读路径**：`useSessionHosts()` 的整表读（必要时扩展同一 hook）；`useSidebarController.ts:144` 的 `runningSessionsCount` 改由宿主快照派生；徽标加稳定 DOM 契约。
5. **Running 视图两组 + 关闭**：`RunningView.tsx`（新）承载两组渲染与 [关闭]；`SidebarContent.tsx` 的 `running` 分支改用它；关闭走宿主接口。
6. **12 个 locale 的 `sidebar.json` 文案**。
7. **写判据**：真浏览器驱动 Running 模式 → 三行读数（徽标 = 1、第一组 = 1、第二组 = 2）→ 点第二组一行的 [关闭] → 打印 `hosts.before/after`、组行数 `before/after`、`badge.after`；断言整体墙钟 `< 55_000`。
8. **假形态承重变异**：把徽标改回「计入空闲常驻」（改回 `activeSessionIds.size`，或把空闲宿主也计进）⇒ 判据退出**非 0**，红**落在徽标读数那条断言**（`badge.reading=3` 或 `badge.reading !== 1`）上；登记变异 diff、失败断言逐字、退出码；恢复后回到 0。
9. **正控制**：同一次运行里再开一个真在飞的会话 ⇒ 徽标与第一组各 +1（证明读数不是常量 1）。
10. `npm run lint` / `npm run typecheck` 绿；`npx playwright test --list` 的收集总数与改动前逐字相同；`git diff --stat` 与 Touches 对齐；写完成记录。

## AC

- [ ] AC1 判据绿：`npx playwright test e2e/resident-running-view.spec.ts` 退出 **0**，并打印整体墙钟 `elapsed=<n>ms` 且 `< 55_000`（`playwright.config.ts:285` 的单文件上限）。红态基线本轮实测：`--list` 退出 **1**、`Error: No tests found.` / `Total: 0 tests in 0 files`。
- [ ] AC2 徽标只计正在运行（**假形态的落点**）：判据同时打印 `hosts.running=<n> hosts.residentIdle=<n> hosts.total=<n> badge.reading=<n>`，断言 `badge.reading === hosts.running`、`badge.reading === 1`（场景 = 一运行 + 两空闲常驻）、`badge.reading !== hosts.total`，并打印 `badge.source=hosts`（读数来自 `GET /api/session-hosts`，不是 `activeSessionIds.size`）。**正控制**：同一次运行里再开一个在飞会话 ⇒ 打印 `badge.afterExtra=<n>` 且 `> badge.reading`（证明不是常量 1）。
- [ ] AC3 两组各列对应会话：判据打印 `group.running.count=<n> group.running.ids=<…>` 与 `group.residentIdle.count=<n> group.residentIdle.ids=<…>`；断言 `group.running.count === hosts.running`、`group.residentIdle.count === hosts.residentIdle`，且两个 id 集合不相交、并集等于宿主快照里常驻且未被关闭的会话集（两侧集合逐条打印比对）。
- [ ] AC4 第二组每行有关闭按钮、点击后宿主关闭并从该组消失：判据打印 `row.close.selector=<…>`、`close.request=<POST …/close 的状态码>`、`hosts.beforeClose=<n> hosts.afterClose=<n>`（后者更小）、`group.residentIdle.count.before=<n> .after=<n>`（后者更小）、`badge.reading.after=<n>`（不变）。**正控制**：关闭前同一 hostId 在快照里（打印 `host.present=true`），且第一组行数不变（打印 `group.running.count.after=<n>`）。
- [ ] AC5 徽标不是「数所有宿主」（负控制）：AC4 的关闭操作之后重读，打印 `hosts.total.before=<n> .after=<n>`（3→2）与 `badge.reading.before=<n> .after=<n>`（1→1，不变），断言徽标跟随 `hosts.running` 而非 `hosts.total`；再对剩下的空闲常驻做一次同样的关闭，打印 `badge.reading.final=<n>` 仍为 1。
- [ ] AC6 文案取自运行期读的出货目录（`src/modules/i18n/locales/en/sidebar.json`），spec 里不抄句子；新增 key（`running.title`、两个组名、[关闭] 与其可访问名、徽标可访问名）在 **12 个 locale** 的 `sidebar.json` 里都存在且非空，任一缺失以非 0 退出并打印是哪个文件哪个 key。
- [ ] AC7 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --stat` 与 Touches 逐条对齐（多写的文件须由判据强制）。
- [ ] AC8 假形态必须红（承重）：把徽标改成计入空闲常驻会话（改回读客户端忙集 `activeSessionIds.size`，或把空闲常驻宿主也计进计数），判据命令退出**非 0**，且红**落在 AC2 的 `badge.reading === hosts.running` 那条断言**上（登记变异 diff、失败断言逐字、退出码）。恢复后判据回到 0。
- [ ] AC9 替身改动不波及别的判据：门控仅对含本判据的选择生效 —— `npx playwright test e2e/model-env-kind-explanations.spec.ts` 仍退出 **0**（打印退出码与墙钟），且 `npx playwright test --list` 的收集总数与改动前**逐字相同**（打印改动前后两个数）。
- [ ] AC10 出厂链路的常驻 idle 可达：判据打印 `scenario.sessions=<n> hosts.total=<n>`，断言三个会话各自在 `GET /api/session-hosts` 里出得来、两个空闲常驻的 `state` 与一个在飞会话的 `state` **不同**（打印三者 `state` 逐字）；`DEBUG_AGENT_RUN_SEAM_UNAVAILABLE` 出现次数为 **0**（打印计数）。

## DoD

- 判据在**真浏览器**里跑：真服务、真会话、调试 agent 的按会话场景驱动，**不拉起 claude**；徽标与两组读数来自 `GET /api/session-hosts` 的服务端事实，不是前端本地状态。
- 徽标读数、两组计数、[关闭] 的前后宿主数与组行数都是判据的**原始输出行**（`badge.reading` / `group.*.count` / `hosts.beforeClose` …），不是转述。
- 徽标有**正控制**（多开一个在飞会话 ⇒ 读数变大）与**负控制**（关掉空闲常驻 ⇒ 读数不变、`hosts.total` 变小），证明「只计正在运行」不是恒真也不是「数所有宿主」。
- 假形态**真的跑过并真的红**，红在 AC2 的徽标读数断言上（不是任何一条断言都行）。
- Running 视图的关闭入口与 AC-169 的 `POST /api/session-hosts/:sessionId/close` 同源；前端没有第二份宿主取数。
- 单文件判据在 **55s** 内自己结束（打印墙钟），不是被看门狗或 60s 闸门外部击杀。
- 只动 Touches 列出的文件；不改 AC-161/162/164/169/170/171/172/174/175 的范围。

## Touches

- `e2e/resident-running-view.spec.ts` (new)
- `playwright.config.ts`
- `src/modules/sidebar/SidebarHeader.tsx`
- `src/modules/sidebar/SidebarContent.tsx`
- `src/modules/sidebar/Sidebar.tsx`
- `src/modules/sidebar/hooks/useSidebarController.ts`
- `src/modules/sidebar/RunningView.tsx` (new)
- `src/shared/hooks/useSessionHosts.ts`
- `src/modules/i18n/locales/de/sidebar.json`
- `src/modules/i18n/locales/en/sidebar.json`
- `src/modules/i18n/locales/es/sidebar.json`
- `src/modules/i18n/locales/fr/sidebar.json`
- `src/modules/i18n/locales/id/sidebar.json`
- `src/modules/i18n/locales/it/sidebar.json`
- `src/modules/i18n/locales/ja/sidebar.json`
- `src/modules/i18n/locales/ko/sidebar.json`
- `src/modules/i18n/locales/ru/sidebar.json`
- `src/modules/i18n/locales/tr/sidebar.json`
- `src/modules/i18n/locales/zh-CN/sidebar.json`
- `src/modules/i18n/locales/zh-TW/sidebar.json`
- `tasks/gap-claude-resident-running-view.md`（自触）
