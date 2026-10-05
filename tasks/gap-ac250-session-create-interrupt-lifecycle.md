---
id: gap-ac250-session-create-interrupt-lifecycle
title: AC-250 session_create 与 session_interrupt：创建会话（可带首条消息）随即返回 sessionId 与
  runId、不带消息零运行、项目名模糊匹配多义不创建、中止常驻运行但宿主 pid 不变、对空闲会话如实 aborted:false；判据
  server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac239-sdk-zod-declared-in-dependencies
  - gap-ac240-mcp-stateless-transport-mount-order
  - gap-ac241-mcp-token-auth-shares-service
  - gap-ac244-mcp-audit-log-outcomes-and-retention
  - gap-ac245-mcp-read-tools-fixture-readings
  - gap-ac246-mcp-resolve-target-fuzzy-match
  - gap-ac249-session-send-immediate-runid
goal_ac: AC-250
---
## Proposal

AC-250（GOAL-020 退出条件 8 的第二条；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 工具清单 `session_create` §278、`session_interrupt` §279、阶段 4 §523、scope 表 §328–§329）要求 MCP 写工具 `session_create` 在指定项目下创建应用会话（带 `message` 时随即启动首轮并**同时**返回 `sessionId` 与 `runId`，不带时**不启动任何运行**），`session_interrupt` 中止正在运行的常驻会话的运行但**保留常驻进程**（宿主 pid 不变），对空闲会话如实返回 `aborted: false` 并明说没有可中止的运行。判据文件 `server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts` 当前不存在，AC-250 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`。

现状（红态基线）：`session_create` / `session_interrupt` 尚未有真实行为——AC-249 在写工具集合 `MCP_STAGE4_WRITE_TOOLS` 里按 SPEC 注册这两个工具（scope 分别为 `cloudcli:session:create` / `cloudcli:session:control`），但 handler 主体返回占位 `isError`（`code: 'MCP_TOOL_NOT_IMPLEMENTED'`，注明归 AC-250/AC-251）。本任务只**替换这两个 handler 的主体**，不改工具集合、不改 scope 字面量、不改 AC-249 的判据。

可读且已存在的底层能力（各经 barrel）：
- `sessionsService.createAppSession(provider, projectPath, initialMessage)`（`@/modules/providers/index.js`，`sessions.service.ts:396`）：铸造 `sessionId` 并**同步写行**（`sessionsDb.createAppSession`），只是用 `initialMessage` 造会话名；**它自己不启动运行**——所以「带 message 随即启动首轮」必须由 MCP 适配层在创建后调用同一个控制服务 `send` 完成，这正是 (a) 的读数与「只调 createAppSession」的区别。
- `sessionsService.switchSessionLifecycleMode(provider, sessionId, mode)`（同 barrel）：记录生命周期偏好（创建后、任何 send 之前调用时无 live host，只落库）；调试 agent 的 provider 声明 `lifecycleModes: ['per-run','resident']`（`debug-agent.host-driver.ts:833`），所以 `session_create({ lifecycleMode: 'resident' })` 造出的会话能真正成为常驻。
- `chatControlService.send(caller, { sessionId, content })` 与 `chatControlService.abort(caller, { sessionId })`（`@/modules/websocket/index.js`，`chat-control.service.ts:512`）：`abort` 返回 `{ ok: boolean; aborted: boolean; code?; message? }`——`aborted` 为 `false` 表示**没有可中止的运行**（provider runtime 的 abort 返回假）；成功路径里它同时向注册表写终止 `completeRun(…, { aborted: true })`，即客户端「终止帧」的终止态。
- `chatRunRegistry`（`@/modules/websocket/index.js`）：`getRun(sessionId)`（`{ runId, source, status, userId }`）、`getRunById(runId)`（`status: 'running' | 'completed' | 'aborted'`，`chat-run-registry.service.ts:247` 由 complete 帧的 `aborted` 位决定）、`listRunningRuns()`。
- `sessionHostManager.snapshot()`（`@/modules/session-hosts/index.js`）：`ProcessHost[]`，每项带 `appSessionId`、`state`、`pid`（常驻驱动交出 pid）——(d) 的「宿主 pid 不变」读这里。
- `getProjectsWithSessions()`（`@/modules/projects/index.js`）：`ProjectListItem = { projectId, path, displayName, … }`——`session_create` 的 `project` 被 AC-246 的解析门改写成 `projectId` 后，handler 要用它取回 `path` 交给 `createAppSession`。
- AC-246 的 `resolveInputTargets` 解析门：对输入里名为 `project`（kind `project`）/`session`（kind `session`）的字符串字段，**在 handler 之前**解析成唯一 id；多义/无命中直接返回 `isError`、**绝不进入 handler**——所以 (b)「多义时不创建」是结构性保证，不是创建路径里的一个 if。
- AC-244 的 `withMcpAudit(registration)`：按 `requiredScopes` 在调用前检查，缺 scope ⇒ 不调 handler、写一行 `denied` 审计、返回 `isError`——(c)(f) 的拒绝与审计由它提供，本任务只保证工具的 `requiredScopes` 取自已注册的 `MCP_STAGE4_WRITE_TOOLS`。

要交付：

1. **`session_create` 实现（新文件 `server/modules/mcp-gateway/mcp-session-lifecycle.ts`；遵守 `$backend-module-standards`）**，导出可注入 deps 与实现：
   - `export type McpSessionCreateDeps = { projects: { list(): Array<{ id: string; title: string; path: string }> }; sessions: { create(provider: LLMProvider, projectPath: string, initialMessage: string): { sessionId: string }; switchLifecycle(provider: LLMProvider, sessionId: string, mode: string): unknown }; control: { send(caller: ControlCaller, input: { sessionId: string; content: string }): Promise<SendResult> } }`——全部可注入（判据传真 `sessionsService` / 真控制服务或 spy 驱动的实例）。
   - `export async function buildSessionCreate(input: { project: string; message?: string; provider?: LLMProvider; model?: string; lifecycleMode?: string }, ctx: { principal: McpPrincipal }, deps: McpSessionCreateDeps): Promise<SessionCreatePayload>`：
     - `project` 到达时已是 AC-246 解析门改写后的 **projectId**；用 `deps.projects.list()` 找出对应项的 `path`（找不到 ⇒ 结构化 `TARGET_NOT_FOUND`，不创建）。
     - `const created = deps.sessions.create(provider ?? 'claude', path, input.message ?? '')`。
     - `lifecycleMode` 存在时：在**任何 send 之前** `deps.sessions.switchLifecycle(provider, created.sessionId, lifecycleMode)`。
     - `message` **非空**时：`caller = { userId: ctx.principal.userId, via: 'mcp' }`，`const sent = await deps.control.send(caller, { sessionId: created.sessionId, content: input.message })`；`sent.ok === false` ⇒ 翻译成结构化 `isError`（`SESSION_NOT_FOUND` / `UNSUPPORTED_PROVIDER` / `RUN_IN_PROGRESS` / `FORBIDDEN`），但**会话行已创建**这一点如实体现在结果里（逐字给出 `sessionId` 与错误码）；`sent.ok === true` ⇒ 返回 `{ sessionId, runId: sent.runId }`。
     - `message` 缺失/为空时：**绝不调用 `deps.control.send`**，返回 `{ sessionId }`（**不带** `runId` 字段）。(a)：不带 message 零运行。
   - `export async function buildSessionInterrupt(input: { session: string }, ctx: { principal: McpPrincipal }, deps: McpSessionInterruptDeps): Promise<SessionInterruptPayload>`：
     - `deps.control.abort(caller, { sessionId })`（`session` 到达时已被 AC-246 解析门改写成 sessionId）。
     - `result.ok === false` ⇒ 结构化 `isError`（原样透出 `code` 与 `message`）。
     - `result.ok === true` 且 `result.aborted === true` ⇒ 返回 `{ aborted: true }`。
     - `result.ok === true` 且 `result.aborted === false` ⇒ 返回 `{ aborted: false, message: '该会话当前没有正在运行的运行，没有可中止的运行。' }`（`message` **必须逐字包含**「没有可中止的运行」；**绝不**把 `aborted` 报成 `true`）。(e)：不虚报。
     - 适配层**只调 abort**：不调 `closeResidentHost`、不 kill 进程、不碰宿主管理器。(d)：常驻进程保留。
   - `export function registerMcpSessionLifecycleTools(...)`（或等价名）把上面两个实现接到 AC-249 的注册缝，**替换**那两个占位 handler；`requiredScopes` 与 `inputSchema` 仍取 `MCP_STAGE4_WRITE_TOOLS`（不手写第二份 scope 字面量）。
2. **接线与导出**：`server/modules/mcp-gateway/mcp-gateway.write-tools.ts` 用本文件的实现替换 `session_create` / `session_interrupt` 的 handler（`session_start` / `session_close` 仍留占位，归 AC-251）；`server/modules/mcp-gateway/mcp-gateway.transport.ts` 把 `projects` / `sessions` / 解析门 deps 接到注册缝；barrel `server/modules/mcp-gateway/index.ts` 导出 `buildSessionCreate`、`McpSessionCreateDeps`、`buildSessionInterrupt`、`McpSessionInterruptDeps`，各写消费方注释。若这些形状要求改 AC-249/AC-246 已落地的注册缝文件，**先用 `task_write` 把该文件加进本任务 `## Touches` 再改**（`quay-touches-must-match-actual-write-sites`）。
3. **判据文件 `server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP + MCP SDK 客户端 + 真实 better-sqlite3 临时库 + 调试 agent）**：形制照 AC-249（`mkdtemp` + `process.env.DATABASE_PATH` 指临时库 + `initializeDatabase()` + owner 用户行 + `createAccessTokensService` 发真令牌 + 同一 app 上 `MCP_ENABLED=true` 装配 `mountMcpGateway`；SDK `Client` + `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`，避开 `listen(0)` 的 undici 坏端口——内存 `undici-bad-port-lottery-in-listen0-route-tests`）。会话与宿主用**调试 agent**（`DEBUG_AGENT_PROVIDER_ID` + `createDebugAgentHostDriver` + `armDebugAgentScenario`，一个 `lifecycle_mode='resident'`、一个 `per-run`）。控制服务用**真实** `createChatControlService`（注入计数 spy 包在 `send` / `abort` 上）。读数各自独立成断言并逐字写出原始值：
   - (a) **带 message**：`session_create({ project, message })` ⇒ 结果为 `{ sessionId, runId }`，`runId` 非空且与 `chatRunRegistry.getRun(sessionId)?.runId` 逐字相等、`getRunById(runId).source === 'mcp'`、`listRunningRuns()` 含该 sessionId；**不带 message**：`session_create({ project })` ⇒ 结果无 `runId` 字段、`chatRunRegistry.getRun(sessionId)` 为 `undefined`、`listRunningRuns()` 不含它、spy 的 `send` 计数为 0。逐字写出两侧 `sessionId`/`runId`/计数。
   - (b) **项目名模糊匹配**：夹具两个项目 `displayName` 含同一子串 ⇒ 用该子串调 `session_create` ⇒ `isError`、错误体 `code === 'TARGET_AMBIGUOUS'` 且候选逐条列出；`sessionsDb` 的会话行数前后相等（零副作用），`create` 计数 0。正例对照：唯一命中的项目名 ⇒ 创建成功且新行 `project_path` 等于该项目路径。逐字写出候选、两侧行数与路径。
   - (c) **scope `cloudcli:session:create`**：仅带 `['cloudcli:read','cloudcli:session:send']` 的令牌调 `session_create` ⇒ `isError`、`mcp_audit_log` 新增**恰好一行** `tool='session_create'`/`outcome='denied'`、`create` 计数 0；带 `cloudcli:session:create` 的令牌成功（正例）。逐字写出该行与前后计数。
   - (d) **中止常驻运行、进程保留**：常驻会话第一轮保持 running；先读宿主 `snapshot()` 里该 sessionId 的 `pid`，经 MCP `session_interrupt({ session })` ⇒ `aborted === true`；再读注册表 `getRunById(runId).status === 'aborted'`（终止帧的终止态；`chat-run-registry.service.ts:247` 由 complete 帧的 `aborted` 位决定）、宿主快照里该 sessionId 的 `pid` 与 `state`——pid **逐字相等**且宿主仍在。逐字写出 abort 前后的 pid 与两处 status。
   - (e) **空闲会话如实**：对一个没有 live run 的会话调 `session_interrupt` ⇒ `aborted === false` 且返回的 `message` 逐字包含「没有可中止的运行」；正例对照：(d) 的 `aborted === true`（防「一律 false」也通过）。逐字写出返回值。
   - (f) **scope `cloudcli:session:control`**：仅带 `['cloudcli:read','cloudcli:session:create']` 的令牌调 `session_interrupt` ⇒ `isError`、`mcp_audit_log` 恰一行 `tool='session_interrupt'`/`outcome='denied'`、`abort` 计数 0；带 `cloudcli:session:control` 的令牌成功。逐字写出该行与前后计数。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) `session_interrupt` 在 abort 之后顺手 `closeResidentHost`/kill 常驻进程 ⇒ (d) 的 pid 不变必须红；
   (ii) 空闲（`aborted === false`）也返回 `aborted: true` ⇒ (e) 必须红；
   (iii) 不带 message 也调用 `control.send` ⇒ (a) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-250" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-250`；`grep -rln "AC-250" tasks/` 只命中 AC-249/AC-246 的边界段（各自声明 `session_create`/`session_interrupt` 的行为不在本任务：AC-249 只按表注册这两个工具并留下 `MCP_TOOL_NOT_IMPLEMENTED` 占位 handler，注明归 AC-250/AC-251；AC-246 只交付它们必经的通用解析门，明确「写工具本体行为由 AC-249–AC-251 交付」）。AC-251（`session_start`/`session_close`）是不同读数与不同判据文件（`mcp-session-host-control.test.ts`），各自直接覆盖；AC-252（自指保护）、AC-253（装配与 barrel）、AC-254/255（设置页）、AC-256/257（冒烟）均不越界。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-239 未落地则判据无法 import SDK 客户端；AC-240 未落地则无 `/mcp` 传输与工具注册缝；AC-241 未落地则无令牌中间件与 `McpPrincipal`（(c)(f) 要发真令牌读主体）；AC-244 未落地则无 `withMcpAudit` 包装与 `denied` 审计（(c)(f) 依赖它）；AC-245 未落地则无注册缝的消费先例与 MCP 客户端夹具形制；AC-246 未落地则 (b) 的项目名解析门不存在；AC-249 未落地则写工具集合与这两个工具的注册占位都不存在（本任务只替换 handler）。

## AC

- [ ] AC1 判据红态基线逐字记录：改动前运行 AC-250 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts`（写下完整命令与完整输出）。
- [ ] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [ ] AC3 (a) 带 message 时返回 `sessionId` 与非空 `runId`，`runId` 与注册表当前运行逐字相等、`getRunById(runId).source === 'mcp'`、`listRunningRuns()` 含该会话；不带 message 时结果无 `runId` 字段、注册表无该运行、`listRunningRuns()` 不含它、`send` 计数为 0；逐字写出两侧 sessionId/runId/计数（正例对照：带 message 侧全成立）。
- [ ] AC4 (b) 项目名唯一命中 ⇒ 创建成功且新行 `project_path` 等于该项目路径；多义 ⇒ `isError`、`code === 'TARGET_AMBIGUOUS'` 且候选逐条列出、会话行数前后相等（零副作用）、`create` 计数 0；逐字写出候选、路径与两侧行数。
- [ ] AC5 (c) 仅 `cloudcli:session:send` 的令牌调 `session_create` 被拒（isError）、`mcp_audit_log` 新增恰好一行 `tool='session_create'`/`outcome='denied'`、`create` 计数为 0；带 `cloudcli:session:create` 的令牌成功；逐字写出该行与前后计数。
- [ ] AC6 (d) 对正在运行的常驻会话 `session_interrupt` 返回 `aborted === true`；`getRunById(runId).status === 'aborted'`；宿主快照里该会话的 `pid` 前后逐字相等且宿主仍在；逐字写出 abort 前后 pid 与 status。
- [ ] AC7 (e) 对空闲会话 `session_interrupt` 返回 `aborted === false` 且 `message` 逐字包含「没有可中止的运行」（不虚报已中止）；正例对照 (d) 为 `true`；逐字写出两侧返回值。
- [ ] AC8 (f) 仅非 `cloudcli:session:control` 的令牌调 `session_interrupt` 被拒（isError）、审计恰一行 `tool='session_interrupt'`/`outcome='denied'`、`abort` 计数为 0；带 `cloudcli:session:control` 的令牌成功；逐字写出该行与前后计数。
- [ ] AC9 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 中止后把常驻进程也关了 ⇒ AC6 的 pid 不变红；(ii) 空闲也回 `aborted: true` ⇒ AC7 红；(iii) 不带 message 也启动运行 ⇒ AC3 红。每条恢复命令 + 恢复后重跑绿。
- [ ] AC10 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；AC-249 判据 `mcp-session-send.test.ts`、AC-245 判据 `mcp-read-tools.test.ts`、AC-246 判据 `mcp-resolve-target.test.ts` 与控制服务既有判据 `server/modules/websocket/tests/chat-control-*.test.ts` 不改一字仍逐字通过（本任务只替换两个 handler 的主体，不改工具集合、不改控制服务）。
- [ ] AC11 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- `session_create` **真的**经真实 HTTP + MCP SDK 客户端驱动**真** `sessionsService.createAppSession` 落到**真** better-sqlite3 临时库，并在带 `message` 时经**同一个** `createChatControlService` 启动**真**运行：返回的 `runId` 就是注册表那次运行、`source` **真的**是 `'mcp'`、**真的**出现在 `listRunningRuns()` 里；不带 `message` 时 **真的**一行运行都没有（不是「函数被调用」或「判据文件存在」就算数）。
- 项目名 **真的**按模糊匹配解析：多义时 `isError` 且**真的**没有新行落库（创建零副作用），唯一命中时新行的 `project_path` **真的**是该项目路径。
- `session_interrupt` 对正在运行的常驻会话 **真的**中止了那一轮（注册表终止态 `aborted`），且常驻宿主 **真的**还在、pid **真的**不变；对空闲会话 **真的**返回 `aborted: false` 并逐字说明没有可中止的运行，**没有**虚报。
- scope **真的**由 `withMcpAudit` 按 `MCP_STAGE4_WRITE_TOOLS` 执行：`session:create`/`session:control` 不足的令牌**真的**被拒、**真的**写下一行 `denied` 审计、控制服务/创建路径计数**真的**为 0；足够 scope 的令牌**真的**放行。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖（SDK 由 AC-239 声明）；不改控制服务本体；不越界实现 AC-251（`session_start`/`session_close`）、AC-252–AC-257 的读数与判据。

## Touches

- server/modules/mcp-gateway/mcp-session-lifecycle.ts (new)
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts (new)（判据）
- tasks/gap-ac250-session-create-interrupt-lifecycle.md

## Notes

- 「终止帧为 aborted」的机械读数：注册表的 `status` 由 complete 帧的 `aborted` 位决定（`chat-run-registry.service.ts:247` `message.aborted === true ? 'aborted' : 'completed'`），所以判据读 `chatRunRegistry.getRunById(runId).status === 'aborted'` 即读的是客户端终止帧的终止态，不必额外开 WebSocket 订阅。
- (e) 的逐字文案固定在 `message` 里出现「没有可中止的运行」；控制服务的 `abort` 在空闲时返回 `{ ok: true, aborted: false }`（`chat-control.service.ts:543` 的 `runtime.abort` 返回假），适配层**只**补文案，不改 `aborted`。
- (d) 的常驻会话由判据用 `session_create({ project, lifecycleMode: 'resident', message })` 造出：`lifecycleMode` 分支必须在 `send` **之前**调 `switchSessionLifecycleMode`（此时无 live host，只落库），否则第一轮不会被宿主层按常驻处理。调试 agent provider 已声明 `lifecycleModes: ['per-run','resident']`。
- 判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`；AC-240–AC-249 同款说明）。
- 边界 lint 会拦新增测试文件（内存 `quay-boundaries-lint-blocks-new-test-files`）；本判据文件已列入 `## Touches`。给 mcp-gateway barrel 加导出后，若某兄弟测试对该 barrel 整体 `vi.mock`，需把新导出补进那个 mock 工厂（内存 `adding-an-export-reds-sibling-wholesale-vimocks`）。
- 写工具集合 `MCP_STAGE4_WRITE_TOOLS` 是写工具名与 scope 的唯一事实来源（AC-252 的自指保护读它取网关写工具名）；本任务只替换 `session_create`/`session_interrupt` 的 handler，不改集合、不改 scope 字面量。