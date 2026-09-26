---
id: gap-session-hosts-rest-list-endpoint
title: AC-156 `GET /api/session-hosts` 需鉴权：列出所有 provider
  的宿主（状态/绑定/保活理由/pid/关闭原因），lingering 可见，关闭原因有可注入时钟的保留窗口
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-session-hosts-default-wrap-four-providers
goal_ac: AC-156
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rln 'goal_ac: *AC-156' tasks/*.md` → 0 命中；`grep -rln 'session-hosts-routes' tasks/*.md` → 0 命中；`ls tasks/ | grep session-hosts` → 只有 `gap-session-hosts-default-wrap-four-providers`（ready）与 `gap-session-hosts-per-run-frame-parity`（todo）两个。两条邻居都不重复，且都明确让出这一格：前者把 `session-hosts.routes.ts` 写进非目标，后者把「AC-156 的两条 REST」写进非目标，两条都只读 manager 快照、都不建 HTTP 面。本条认领的是判据要求的那一格：**一个需鉴权的 `GET /api/session-hosts`，数据来自宿主层快照（不是 run 表），并带一个钟可注入的「关闭后保留窗口」**。

这条判据必须跑在**宿主层已经接进分派入口**的树上 —— 否则「一个 codex 宿主运行中、一个 Claude 宿主 lingering」只能由测试自造，失去「经真实分派入口登记」这一半，判据也就无法区分「列表来自宿主层」与「列表来自 run 表」。故顶层 `depends_on` 指向 AC-154 的落地任务：先让包装接进 `provider-runtime.service.ts`，本条再在其上加读口与 HTTP 面。

**来源与判据物。** 判据逐字取自 `goals/AC-156-get-api-session-hosts-列出所有-provider-的宿主-含状态-绑定-保活理由与关闭原因-需鉴权.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts`。红态基线（本轮**直跑**，读数不是推断）：该命令在当前树上退出 **1**，文案逐字 `Could not find 'server/modules/session-hosts/tests/session-hosts-routes.test.ts'`；`ls server/modules/session-hosts/` → `No such file or directory`。

**现状（本轮实测的读数，逐条都有出处）**

- **「列表即 run 表」是判据点名的假形态，它在仓里有真实先例**：`server/modules/providers/services/sessions.service.ts:201` 的 `listRunningSessions()` 就是 `chatRunRegistry.listRunningRuns()`；而 `server/modules/websocket/services/chat-run-registry.service.ts:220` 的 `listRunningRuns()` 只返回 `status === 'running'` 的 run，`:216` 的 `isProcessing()` 同理只看 run 状态。lingering（complete 已发、`run()` 的 promise 未结算、宿主仍在）在 run 表里**没有对应物** ⇒ 映射出来的列表恰好缺这一条。这就是本判据「必须读宿主层」的分辨力来源，也是假形态的实现路径。
- **鉴权面照生产**：`server/index.ts:199-209` 每个受保护路由都是 `app.use('/api/<x>', authenticateToken, <router>)`；`server/modules/auth/auth.middleware.ts:53` 缺凭据时 `401 { error: 'Access denied. No token provided.', code: 'AUTH_TOKEN_INVALID' }`。
- **200 不是挂载证据**：未挂载的 `/api` 路径落到 SPA catch-all 返回 `200 text/html` —— `server/index.ts:215` 的注释逐字写了这一点，`server/index.ts:250-258` 是那段 catch-all（dev 下 302 到 Vite）。所以判据断言内容类型与形状，并把「未挂载的路径在这套 harness 里长什么样」做成一条正控制。
- **路由测法的现成先例**：`server/modules/voice/tests/voice-config.routes.test.ts:36-52` 在动态 import 之前设 `process.env.JWT_SECRET`（`auth.middleware.ts` 在模块加载期解析它，否则会去读并创建开发者真实的 `~/.cloudcli/auth.db`）、删 `VITE_IS_PLATFORM`；`:108-175` 用 `express()` + **真实** `authenticateToken` + 临时 `DATABASE_PATH` + `addUser`/`signToken` 起真实 HTTP 服务并挂生产同形的错误中间件。本条照这份写。
- **驱动链的现成先例**：`server/modules/debug-agent/tests/debug-agent-frames.test.ts:224-241` 就是「`chatRunRegistry.startRun(...)` 拿 run → `providerRuntimeService.run(provider, cmd, {sessionId}, run.writer)`」这条链，注释逐字说明「链是产品的、不是绕过」；`server/modules/scheduled-messages/tests/scheduled-messages.test.ts:103` 同形。`chatRunRegistry` 经 `server/modules/websocket/index.ts:3` 的 barrel 导出，跨模块 import 合规。
- **run 在 complete 帧上自动收尾**：`chat-run-registry.service.ts:84-113` 的 `decorateAndRecordEvent` 在 `kind === 'complete'` 过 writer 时把 `run.status = 'completed'`。所以「Claude 那轮的 `isProcessing() === false` 而宿主仍 lingering」可以**纯由真实链产生**，不需要测试手改 run 状态。
- **注入缝**：`server/modules/providers/services/provider-runtime.service.ts:42` 的 `createProviderRuntimeService(overrides)`；最小假 `IProviderRuntime`/`IProvider` 形态与注入写法在 `server/modules/providers/tests/provider-runtime.service.test.ts:10-69`。AC-154 的包装加在 `createProviderRuntimeService` 内部 ⇒ 经它分派的一轮会被登记进 manager。
- **响应封装**：`server/shared/utils.ts:71` 的 `createApiSuccessResponse<TData>(data)` → `{ success: true, data }`；列表型路由写法见 `server/modules/scheduled-messages/scheduled-messages.routes.ts:37`。

**要建的东西**

1. **manager 侧的保留窗口与钟**（落在 AC-154 建的 `server/modules/session-hosts/session-host-manager.service.ts` 上，不新起第二份状态）：
   - 关闭的宿主不立刻从表里消失；`snapshot()` 在**读时**过滤掉「`closedAt + closedHostRetentionMs <= now()`」的条目。读时过滤让 (3) 的「窗口内可读、窗口过后消失」不需要任何定时器、也不依赖真实 sleep。
   - 钟与窗口都注入：`createSessionHostManager({ now, closedHostRetentionMs })`，默认 `now = Date.now`；`closedHostRetentionMs` 钉成模块内具名的导出常量（建议 5 分钟，AC-156 只要求「有窗口、可注入」，数值实现时定并写进完成记录）。
   - AC-154 落地后按其 `snapshot()` 的实际形状做**最小**改动（若它已经把关闭宿主丢掉或返回全部宿主，照实际改这条读时过滤），**不改**它的运行中语义。
2. **把 manager 变成可注入依赖**（`server/modules/providers/services/provider-runtime.service.ts`）：`ProviderRuntimeServiceDependencies` 增加 `sessionHostManager`（默认取模块单例，生产行为不变）。AC-154 若已留了这个缝就直接用。**没有这个缝，(3) 的注入钟就没法既驱动分派、又读同一个 manager。**
3. **路由** `server/modules/session-hosts/session-hosts.routes.ts`：导出 `createSessionHostsRouter({ sessionHostManager })`，只做「读快照 → `res.json(createApiSuccessResponse({ hosts }))`」。每条宿主带 `hostId`、`provider`、`mode`、`state`、`pid`（没有则 `null`）、`startedAt`、`closeReason`（未关闭为 `null`）、`bindings`（数组，每项 `appSessionId`、`providerSessionId`、`state`、`leases`、`lastActivityAt`）。路由不查数据库、不 import `chatRunRegistry`（业务在 manager 里）。经 `server/modules/session-hosts/index.ts` 桶导出（后端规范：跨模块只走 barrel）。
4. **挂载**（`server/index.ts`）：在受保护 API 段落里加 `app.use('/api/session-hosts', authenticateToken, sessionHostsRoutes);`，与 `:199-209` 同形。**无条件挂载** —— 这条不是 debug agent 那种由 gate 决定存在性的面。
5. **判据测例** `server/modules/session-hosts/tests/session-hosts-routes.test.ts`（见下）。
6. 假 runtime 只在测试里，用 `createProviderRuntimeService` 的注入缝；**四个 runtime 文件一个字节不动**。

**判据测例怎么搭**（每个子例各起一份 manager + 一份 express app，确定性；钟是注入的，不用真实 sleep）

- 共享脚手架：动态 import 前设 `JWT_SECRET`、删 `VITE_IS_PLATFORM`；临时 `DATABASE_PATH` + `initializeDatabase()`；`addUser` + `signToken`；`express()` + `app.use('/api/session-hosts', authenticateToken, createSessionHostsRouter({ sessionHostManager }))` + 生产同形的错误中间件 + **一段 `200 text/html` 的 catch-all**（照生产 SPA 落点）。分派侧：`createProviderRuntimeService({ resolveProvider: …, sessionHostManager })`，provider 的 `runtime.run(command, options, writer)` 由测试控制（发帧 / 挂住不结算）。
- (1) 缺凭据 ⇒ `401`，`content-type` 含 `application/json`，`code === 'AUTH_TOKEN_INVALID'`。**正控制**：同一 app 上一个未挂载的邻居路径（如 `/api/session-hosts-does-not-exist`）读 `200` 且 `content-type` 含 `text/html` —— 证明这套 harness 里 401 不是恒真、也不是 200 的另一种说法。
- (2) 两个宿主同时在场：**codex** 的 per-run 一轮在飞行中（假 runtime 的 `run` 悬着不结算；经真实 `chatRunRegistry.startRun` 记成 running ⇒ `isProcessing === true`，宿主 `state=busy`）；**Claude** 的 per-run 一轮已经由假 runtime 经 `run.writer` 发出 `complete` 帧、此后 `run` 的 promise 仍不结算（⇒ 注册表自动 completed，`isProcessing === false`，宿主 `state=lingering`）。经路由断言列表**恰含这两条**，每条带 `provider`/`mode`/`state`/`pid`/`closeReason`/`bindings`（含本轮 `appSessionId` 与 `leases`）。两条 `isProcessing` 读数都打印。
- (3) 保留窗口：一个刚关闭的宿主（`closeReason=turn-complete`），钟不动时经**路由**读到它且 `closeReason` 就是 `turn-complete`；把钟推过 `closedHostRetentionMs` 后再读同一条路由，它消失。两个读数都打印。
- (4) 形状与内容类型：`content-type` 含 `application/json`、body `JSON.parse` 成功、`success === true`、`data.hosts` 是数组、每个元素键集 `deepEqual` 于断言的字面键集。**不以状态码 200 作为挂载证据。**
- **负控制**：manager 空表时路由返回 `data.hosts.length === 0`。
- **假形态（判据分辨力证明，必须实测）**：把路由的数据源换成 `chatRunRegistry.listRunningRuns()` 映射 ⇒ (2) 必须红（lingering 那条缺失），退出码 1，红态文案点名缺的那条。只改实现、判据文件一字不动；实测完 `git checkout --` 还原到 `git status --short` 只剩 Touches 里的文件 + 任务文件。

**非目标**：AC-154（宿主登记与关闭原因）、AC-155（逐帧不变）、AC-157（状态机/停机/关闭原因穷举）、AC-158（1:N 解绑与顶替）、AC-159（Claude 常驻 driver）、AC-160（调试 agent 场景 op）、能力矩阵字段、`POST /api/session-hosts/:sessionId/start|close`、`process-containment.service.ts`、`lifecycle_mode` 列、`chat-run-registry`/`scheduled-message-dispatcher` 的 run-source 字段。不改任何 per-run 的客户端可见行为。

## Plan

1. 读 AC-154 的落地提交：manager 的 `snapshot()` 实际形状、关闭宿主是否还在表里、`createProviderRuntimeService` 是否已能注入 manager。按实际形状改第 1/2 条。
2. manager 加 `now`/`closedHostRetentionMs` 注入与读时保留窗口过滤；`index.ts` 桶补路由工厂导出。
3. 写 `session-hosts.routes.ts`（读快照 → `createApiSuccessResponse`），在 `server/index.ts` 挂载。
4. 写判据测例：四个子例 + (1) 的正控制（未挂载邻居路径 200 html）+ 负控制（空表）+ 假形态实测。
5. 实测假形态（数据源换成 `listRunningRuns` 映射），抄退出码与红态文案，`git checkout --` 还原。
6. `npm run typecheck`、`npm run lint`、既有 `provider-runtime.service.test.ts` 与 AC-154 的 `session-host-default-wrap.test.ts` 全绿；写完成记录。

## AC

- [ ] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`。红态基线已测：同命令当前退出 1、文案逐字 `Could not find 'server/modules/session-hosts/tests/session-hosts-routes.test.ts'`。
- [ ] AC2 鉴权：无凭据请求 `GET /api/session-hosts` 得 **401** 且 `content-type` 含 `application/json`、`code === 'AUTH_TOKEN_INVALID'`（读的是生产 `authenticateToken`）。**正控制**：同一 app 上未挂载的邻居路径读 **200** 且 `content-type` 含 `text/html`。两个读数都打印（`no-credential=… unmounted-neighbour=…`）。
- [ ] AC3 (2) 列表含两条且每条形状完整：codex per-run 宿主（run 在飞行中，`chatRunRegistry.isProcessing === true`）与 Claude per-run 宿主（complete 已发、`isProcessing === false`、`state=lingering`）；逐条打印 `provider=… mode=… state=… pid=… closeReason=… appSessionId=… leases=…`，并打印两条 `isProcessing`。
- [ ] AC4 (2) 的两条来自宿主层而非 run 表：Claude 那条 `state=lingering` 与 `isProcessing === false` 同时成立（run 表里没有它）；列表条数为 2（打印 `hosts=2`）。
- [ ] AC5 (3) 保留窗口：刚关闭的宿主（`closeReason=turn-complete`）在注入钟不动时经路由可读且 `closeReason` 就是 `turn-complete`；把注入钟推过 `closedHostRetentionMs` 后再读同一条路由，它不再出现。两个读数都打印（`in-window=… after-window=…`）。
- [ ] AC6 (4) 形状与内容类型：`content-type` 含 `application/json`、body `JSON.parse` 成功、`success === true`、`data.hosts` 为数组、元素键集 `deepEqual` 于断言的字面键集；**不以状态码 200 作为挂载证据**（200 已被正控制那条 html 路径占用）。
- [ ] AC7 负控制：manager 空表时路由返回 `data.hosts.length === 0`（打印 `empty-hosts=0`）。
- [ ] AC8 假形态承重：把路由的数据源换成 `chatRunRegistry.listRunningRuns()` 映射 ⇒ 判据退出 **1**，红文案点名 (2) 里 lingering 那条缺失。实测退出码与红态文案抄进完成记录，用后还原。
- [ ] AC9 生产面零改动：`git diff --name-only` 里没有 `server/modules/providers/list/**`、没有 `server/modules/websocket/services/**`；落地的只有 Touches 列出的文件（`git diff --stat` 逐条对齐）。
- [ ] AC10 契约面不被改窄：`npm run typecheck`、`npm run lint` 退出 0；既有 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-runtime.service.test.ts` 退出 0；AC-154 的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-default-wrap.test.ts` 仍退出 0（manager 是共享文件，本条加读时过滤不得把它改红）。
- [ ] AC11 后端规范：路由只做「读快照 → 响应」（无业务逻辑、无数据库、不 import `chatRunRegistry`）；跨模块只经 barrel；模块内不建 `types.ts`/`interfaces.ts`/`utils.ts`（`ls server/modules/session-hosts/{types,interfaces,utils}.ts` 全不存在）；新增文件都是 TypeScript。
- [ ] AC12 如实登记：完成记录写明（a）`closedHostRetentionMs` 的实际取值与具名导出位置、钟注入的接缝（哪个文件、哪个字段）；（b）AC-154 落地后 `snapshot()` 的实际形状、本条改了什么；（c）假形态的实测退出码与红态文案；（d）`pid` 在默认包装下为 `null`（runtime 不对外暴露 pid），本条不谎报 pid；（e）未实现：AC-157…AC-160、`POST /start|close`、能力矩阵。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts`）重跑：退出码 0 且 `fail 0`。(1) 的 401 读数与正控制的 200 html 读数、(2) 两条宿主的逐字段读数与两条 `isProcessing`、AC5 的窗口内/窗口后两个读数、AC6 的键集、AC7 的空表读数、AC8 假形态的实测退出码与红态文案，一并写进完成记录。`npm run typecheck` 与 `npm run lint` 退出 0（含 AC-154 判据文件仍绿）。改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐；四个 runtime 文件不在其中）。完成后 AC-156 在驱动器下一轮经 `goal_ac: AC-156` 独立复跑时由红翻绿 —— 且这次翻绿有分辨力：AC8「列表由 `listRunningRuns` 映射」的变体必红，AC2 的正控制（未挂载邻居路径 200 html）保证 401 那条不是恒真。

## Touches

- server/modules/session-hosts/session-hosts.routes.ts (new)
- server/modules/session-hosts/session-host-manager.service.ts
- server/modules/session-hosts/index.ts
- server/modules/session-hosts/tests/session-hosts-routes.test.ts (new)
- server/modules/providers/services/provider-runtime.service.ts
- server/index.ts
- tasks/gap-session-hosts-rest-list-endpoint.md
