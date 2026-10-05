---
id: gap-ac246-mcp-resolve-target-fuzzy-match
title: AC-246 项目与会话按名称模糊匹配：id 优先、大小写不敏感子串唯一命中、多义/无命中列候选报错、归档不参与，且目标不明时写操作零副作用；判据
  server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac240-mcp-stateless-transport-mount-order
  - gap-ac244-mcp-audit-log-outcomes-and-retention
  - gap-ac245-mcp-read-tools-fixture-readings
goal_ac: AC-246
---
## Proposal

AC-246（GOAL-020 退出条件 7 的名称解析条；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1「MCP 工具 / 通用约定」§259：项目接受 `projectId` 或名称子串、会话接受 `sessionId` 或标题子串，唯一命中才接受、多个命中列候选并报错）要求 MCP 网关先把调用方给的项目/会话引用解析成唯一 id，再执行任何操作；目标不明时任何写操作都不发生。判据文件 `server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts` 当前不存在，AC-246 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`。

现状（红态基线）：`server/modules/mcp-gateway/` 目录不存在（由 AC-240 创建）；全仓库无任何项目/会话引用解析器（`grep -rn "resolveMcpTarget\|resolveInputTargets\|resolveSessionRef" server/ --include=*.ts` 为空）；唯一相近的实现在 websocket 模块内部（`resolveSendTarget`，`server/modules/websocket/services/chat-websocket.service.ts:609`），它按 socket 协议报错、不可被非 WebSocket 调用方复用，不能当作公共解析器。可读的数据源已存在并各经 barrel 导出：活跃项目 `getProjectsWithSessions`（`server/modules/projects/services/projects-with-sessions-fetch.service.ts`，经 `server/modules/projects/index.ts`；项目条目有 `projectId`、`displayName`、`path`，会话摘要 `id`/`summary`）、活跃会话 `sessionsService.listRecentSessions(limit, offset)`（返回 `conversations[]`，含 `sessionId`、`sessionTitle`、`projectId`）与 `sessionsService.getProjectSessionsPage`（经 `server/modules/providers/index.ts`）、归档条目 `getArchivedProjectsWithSessions` 与 `sessionsService.listArchivedSessions()`（活跃列表不含归档，解析器只读活跃列表即自然排除归档）。

要交付：

1. **解析器（新文件 `server/modules/mcp-gateway/mcp-resolve-target.ts`；遵守 `$backend-module-standards`）**：纯函数、依赖全部可注入（判据传真单例或自己驱动的实例）。导出：
   - `export type McpTargetKind = 'project' | 'session'`
   - `export type McpResolveCandidate = { id: string; title: string }`
   - `export type McpResolveResult = { ok: true; id: string } | { ok: false; code: 'TARGET_AMBIGUOUS' | 'TARGET_NOT_FOUND'; query: string; kind: McpTargetKind; candidates: McpResolveCandidate[]; message: string }`
   - `export type McpResolveDeps = { listProjects(): Array<{ id: string; title: string }>; listSessions(): Array<{ id: string; title: string }> }`（两者都只返回**活跃**条目）
   - `export function resolveMcpTarget(ref: string, kind: McpTargetKind, deps: McpResolveDeps): McpResolveResult`
   解析规则（逐条对应读数）：
   - (a) 去掉首尾空白后，**大小写不敏感**的子串匹配 `title`；**恰好一个**命中 ⇒ `{ ok: true, id: 该条目 id }`。
   - (b) **精确 id 优先**：若 `ref` 逐字等于某条目的 `id`，无论是否有别的条目标题子串命中，一律取该 id（精确 id 命中即唯一命中，不再看子串）。`ref` 与 id 的比较不去改写大小写（id 逐字相等才算命中）。
   - (c) 多处子串命中 ⇒ `{ ok: false, code: 'TARGET_AMBIGUOUS', candidates: [{ id, title }...], message }`，候选**逐条**给出 `id` 与 `title`，`message` 明确「多个匹配，请指定其中一个，不要替用户挑一个」；结果里**没有**「已选中 id」字段。
   - (d) 无命中（含 `ref` 为空/纯空白）⇒ `{ ok: false, code: 'TARGET_NOT_FOUND', candidates: [], message }`，`message` 说明所查的 `query` 与 `kind`（例如「没有标题包含 "xyz" 的会话」）；不抛错。
   - (e) 已归档的项目与会话不参与匹配（实现只读活跃列表；判据另造归档条目并断言它们既不唯一命中、也不出现在候选里）。
2. **解析门（把「先解析、后副作用」做成通用机制）**：导出一个包装（例如 `export function resolveInputTargets<TInput>(handler, deps)` 或等价物），使**任何**输入 schema 里含 `project`（kind `'project'`）或 `session`（kind `'session'`）字符串字段的工具，在**调用其 handler 之前**先解析该字段：解析成功则把字段改写为解析出的 id 后交给 handler；解析失败则**直接返回** `isError` 的结构化结果（错误体含 `code`、`query`、`candidates`），**绝不进入 handler 主体**。这样写工具（`session_send`、`session_interrupt`、`session_close`）与读工具共享同一条闸：目标不明时控制服务与宿主服务一次都不会被调用。**若 AC-240/AC-244 落地的注册缝形状不允许在此处统一包一层，先用 `task_write` 把需改的文件加进本任务 `## Touches` 再改**（`quay-touches-must-match-actual-write-sites`）。
3. **接线与导出**：在 AC-240/AC-244 落地的工具注册路径（`server/modules/mcp-gateway/mcp-gateway.transport.ts`，或 AC-244 的审计包装所在文件）应用上面的解析门；barrel `server/modules/mcp-gateway/index.ts` 导出 `resolveMcpTarget`、`McpResolveResult`、`McpResolveDeps`、`resolveInputTargets`（各写消费方注释：AC-245 的读工具、AC-249–AC-251 的写工具消费）。
4. **判据文件 `server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`（红先行；真实解析器 + 真实注册缝/派发，计数用间谍注入）**：夹具构造若干活跃项目与会话，使标题子串可造出唯一命中、多义命中、无命中；另造**归档**项目与会话（经仓储写 `isArchived`）。读数各自独立成断言并逐字写出原始值：
   - (a) **大小写不敏感的标题子串唯一命中**：如查询 `"foo"` 命中标题 `"Foo Bar"`，断言 `ok:true` 且 `id` 为该条目 id；正例对照：换一种大小写（`"FOO"`）仍命中同一 id。逐字写出查询与结果。
   - (b) **精确 id 优先于子串命中**：构造会话 X 的 id 恰等于另一会话 Y 标题的子串，查询该字符串，断言解析出 X 的 id（不是 Y）；逐字写出 id、相撞标题与结果。（这条即取假形态 (ii) 要红的点。）
   - (c) **多义列候选**：两个会话标题都含查询子串 ⇒ `ok:false`、`code:'TARGET_AMBIGUOUS'`，`candidates` 逐字列出每个候选的 `id` 与 `title`（集合等于夹具两个），结果里没有任何「被替用户选中」的 id；逐字写出原始 `message`。
   - (d) **无命中说明所查**：⇒ `ok:false`、`code:'TARGET_NOT_FOUND'`、`candidates:[]`，`message` 含所查 `query` 与 `kind`；逐字写出原始文案。
   - (e) **归档不参与**：一个归档项目与一个活跃项目可辨时，查询归档名 ⇒ 无命中或只命中活跃的那个；一个归档会话的标题子串唯一可辨 ⇒ **不**解析到它；正例对照：同名活跃条目**能**被解析到（防「一律无命中」也通过）；逐字写出两侧读数。
   - (f) **目标不明时写操作零副作用**：经同一工具注册缝注册三个 handler，名字分别为 `session_send`、`session_interrupt`、`session_close`，各自带 `session` 输入，并在**被调用时**递增注入的「控制服务」与「宿主服务」计数间谍；分别以 (c) 的多义 `session` 与 (d) 的无命中 `session` 调用这三个工具，断言三者的控制服务计数与宿主服务计数**都为 0**，且工具返回 `isError`（错误体含 `code`/`candidates`/`query`）；正例对照：给一个**唯一命中**的 `session`，同一 handler 的控制/宿主计数**变为 1**（防「什么都调用不到」也通过）。逐字写出两组计数。说明：写工具**本体行为**由 AC-249–AC-251 交付，本任务交付的是它们必经的通用解析门；本判据用同缝注册的同名 handler 证明该门对写路径成立，不在本任务实现 `send`/`abort`/`close` 的语义。
   取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) 多义时取第一个（`candidates[0]`）⇒ (c) 与 (f) 必须红；
   (ii) 子串优先于精确 id（先查子串再查 id）⇒ (b) 必须红；
   (iii) 归档参与匹配（deps 改喂归档列表）⇒ (e) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->机制上去重已核对：`grep -rl "goal_ac: AC-246" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-246`；`grep -rln "resolveMcpTarget|resolveInputTargets|子串命中|模糊匹配" tasks/` 只命中 `tasks/gap-ac245-mcp-read-tools-fixture-readings.md`，其 Notes 明确「名称模糊匹配（AC-246）不在本任务：本任务 `session_get`/`session_read` 的 `session` 参数先按精确 id 取；AC-246 落地后在解析前加子串解析」，并把 AC-246/247/248 各自列为独立判据文件（`mcp-resolve-target.test.ts` 等），说明 AC-245 不覆盖本读数。与 AC-250（`session_create` 项目名模糊匹配、多义时不创建）及 AC-249/AC-251（写工具）是**消费**关系而非重复：它们复用本任务导出的解析门，各自测自己的读数；本任务不测 `send`/`create`/`interrupt`/`close` 的行为，不写它们的判据文件。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-240 未落地则无 `/mcp` 工具注册缝；AC-244 未落地则无 `withMcpAudit` 包装与注册缝；AC-245 未落地则无带 `project`/`session` 输入的读工具可供解析门接线与集成验证。

## AC

- [ ] AC1 判据红态基线逐字记录：改动前运行 AC-246 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts`（写下完整命令与完整输出）。
- [ ] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [ ] AC3 (a) 大小写不敏感情形：标题子串唯一命中时 `resolveMcpTarget` 返回 `ok:true` 与正确 id；逐字写出查询、子串与解析结果（正例对照：换大小写仍命中同一 id）。
- [ ] AC4 (b) 精确 id 优先于其它条目的标题子串命中；逐字写出 id、相撞标题与解析结果。
- [ ] AC5 (c) 多处命中返回 `code:'TARGET_AMBIGUOUS'`，`candidates` 逐条含每个候选的 `id` 与 `title`（集合等于夹具），且结果不含被替用户选中的 id；逐字写出原始 `message` 与候选列表。
- [ ] AC6 (d) 无命中返回 `code:'TARGET_NOT_FOUND'`、`candidates:[]`，`message` 说明所查的 `query` 与 `kind`；逐字写出原始文案。
- [ ] AC7 (e) 已归档项目与会话不参与匹配（既不唯一命中也不出现在候选里），活跃同名条目仍可解析；逐字写出两侧读数。
- [ ] AC8 (f) 写工具 `session_send`/`session_interrupt`/`session_close` 在 (c)、(d) 下注入的控制服务与宿主服务调用计数均为 0 且返回 `isError`；唯一命中正例下计数为 1；逐字写出四组计数。
- [ ] AC9 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 多义取第一个 ⇒ AC5/AC8 红；(ii) 子串优先于 id ⇒ AC4 红；(iii) 归档参与 ⇒ AC7 红。每条恢复命令 + 恢复后重跑绿。
- [ ] AC10 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；AC-245 判据 `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 不改一字仍逐字通过；既有 websocket 判据（`resolveSendTarget` 相关 `server/modules/websocket/tests/*`）不改一字仍逐字通过（本任务只新增解析器与解析门，不改 websocket 模块）。
- [ ] AC11 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 解析器**真的**对真实夹具条目运行：唯一命中解析成功、精确 id 优先于子串、多义列出全部候选且不替用户选、无命中说明所查、归档条目不参与——每条读数附原始值，不是「函数被调用」。
- 解析门**真的**在工具 handler 之前生效：目标不明时控制服务与宿主服务**一次都不被调用**（计数 0），唯一命中时才进入 handler（计数 1）——证明「任何写操作在目标不明时一律不发生」是结构性保证，而非各工具各写一遍。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖。
- 不越界：本任务不实现 `session_send`/`session_create`/`session_interrupt`/`session_start`/`session_close` 的**行为**（归 AC-249–AC-251），只交付它们必经的通用解析门，并在本判据里用同缝注册的同名 handler 证明该门对写路径成立。

## Touches

- server/modules/mcp-gateway/mcp-resolve-target.ts (new)
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts (new)（判据）
- tasks/gap-ac246-mcp-resolve-target-fuzzy-match.md
