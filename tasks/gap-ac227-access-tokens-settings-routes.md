---
id: gap-ac227-access-tokens-settings-routes
title: AC-227 令牌设置接口 /api/settings/access-tokens
  创建/列表/吊销：明文只在创建响应、列表无明文无哈希、非法有效期 400 不落库、归属 404、旧 api-keys 不再被处理，判据
  server/modules/oauth/tests/access-tokens.routes.test.ts
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac224-access-token-service
  - gap-ac226-retire-api-agent-and-plaintext-keys
goal_ac: AC-227
---
## Proposal

AC-227（GOAL-018 退出条件 4；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「认证与令牌」节）要求 `/api/settings/access-tokens` 提供令牌的创建、列表、吊销：明文只在创建响应里出现一次；列表既无明文也无哈希；有效期只接受 7/30/90；归属校验；旧的 `/api/settings/api-keys` 不再被设置路由处理。判据文件路径由 AC 钉死为 `server/modules/oauth/tests/access-tokens.routes.test.ts`（GOAL-018 的判据统一落在 oauth 模块的 `tests/` 下，AC 范围优先于「测试放本模块」的一般规则）。

现状（红态基线）：判据文件 `server/modules/oauth/tests/access-tokens.routes.test.ts` 不存在，判据的存在性闸以退出码 1 输出缺失的文件名；`server/modules/settings/settings.routes.ts` 只有旧 `/api-keys` 四条路由，没有 `/access-tokens`；`settings.service.ts` 无令牌相关方法与依赖契约；`settings.module.ts` 未接线令牌服务；`settings/index.ts` 只导出 `settingsRoutes`。

要交付（后端设置面；实现在 settings 模块，令牌逻辑复用 oauth 模块的令牌服务）：

1. 服务层 `server/modules/settings/settings.service.ts`：在 `SettingsDependencies` 增加 `accessTokens` 注入契约，并新增三个方法（保持 route/service 薄，业务只委托令牌服务）：
   - `listAccessTokens(userId)` → `{ tokens: [...] }`，每项只含 `id`、`tokenPrefix`、`name`、`scopes`、`expiresAt`、`lastUsed`、`createdAt`、`revokedAt`；投影里**不得**出现 `token_hash`，更不得出现明文。
   - `createAccessToken(userId, input)`：`name` 走 `requiredString`；`expiresInDays` 只接受 7/30/90（不传时缺省 30，与 AC-224 令牌服务一致），其余值抛 `AppError('expiresInDays must be one of 7, 30, 90', { code: 'INVALID_EXPIRES_IN', statusCode: 400 })` 且**不写库**；成功返回 `{ token: { id, name, tokenPrefix, scopes, expiresAt, lastUsed, createdAt, plaintext } }`，`plaintext` 来自令牌服务签发返回，形态 `ccp_` + 64 hex。
   - `revokeAccessToken(userId, tokenId)`：调令牌服务的吊销，按「是否命中且属于该用户」的返回值判定；未命中或不属该用户 ⇒ `assertFound(false, 'Access token', 'ACCESS_TOKEN_NOT_FOUND')` 抛 404；成功返回 `{ success: true }`。
   - 保留凭证/通知/推送/`getVapidPublicKey` 等既有方法不变；`accessTokens` 只经注入契约调用，service 不直接 import oauth 实现。
2. 路由层 `server/modules/settings/settings.routes.ts`：在 `createSettingsRouter` 内新增
   - `GET /access-tokens` → 200 `service.listAccessTokens(userId(req))`；
   - `POST /access-tokens` → 成功时 `res.status(201).json(...)`，body 取 `{ name, expiresInDays }`；非法有效期/缺名 ⇒ 服务抛 AppError(400)，由错误中间件翻译；
   - `DELETE /access-tokens/:tokenId` → 200，缺/越权 ⇒ 404。
   路由只做「解析输入 → 调一个服务 → 翻译响应」，业务与持久化不落在路由。
3. 接线 `server/modules/settings/settings.module.ts`：从 `@/modules/oauth/index.js` 取 `createAccessTokensService`，构造实例并作为 `accessTokens` 依赖注入 `createSettingsService`；服务端挂载点不变（`server/index.ts` 已有 `app.use('/api/settings', authenticateToken, settingsRoutes)`），因此本任务不改 `server/index.ts`。
4. 对外导出 `server/modules/settings/index.ts`：除既有 `settingsRoutes` 外，导出 `createSettingsRouter` 与 `createSettingsService`（消费者：本任务判据，需在进程内用真实服务装配生产路由工厂）。
5. 旧接口 (f)：`/api/settings/api-keys` 的 GET 与 POST 不再被设置路由处理。删除旧 api-keys 路由/服务方法/接线/桩由 `gap-ac226-retire-api-agent-and-plaintext-keys` 承担；本任务不新增旧接口，也不保留任何返回 `apiKeys` 形状的分支。

判据 `server/modules/oauth/tests/access-tokens.routes.test.ts`（红先行；照 `server/modules/agent/tests/agent.routes.test.ts` 的 `withAgentServer` 做法：真实 `express()` + `app.listen(0)` + `fetch`，不用 supertest）：
   - 建库：`mkdtemp` + 临时 `DATABASE_PATH` + `closeConnection()` + `initializeDatabase()`（`access_tokens` 表由 AC-224 的迁移建出），插入两个 `users` 行（id 1 与 id 2）。注意导入时机：barrel 导入若会触碰连接，改用设置完 `process.env.DATABASE_PATH` 后的动态 `await import()`。
   - 生产装配：`createAccessTokensService({ now })`（可注入时钟，经 `@/modules/oauth/index.js` barrel）→ 作为 `accessTokens` 依赖注入 `createSettingsService`（其余凭证/通知/推送依赖用最小桩）→ `createSettingsRouter(service)`（经 `@/modules/settings/index.js` barrel）。装配用**真实令牌服务 + 真实 better-sqlite3 临时库**，不用内存桩。
   - 挂载：`app.use(express.json())`；`app.use('/api/settings', (req,_res,next)=>{ (req as any).user = { id: currentUserId }; next(); }, router)`（注入的认证中间件设置 `req.user`，可切换当前用户）；最后挂一个与生产等价的 `AppError → res.status(err.statusCode).json({ success:false, error:{ code, message } })` 错误中间件（镜像 `server/index.ts` 的全局错误处理）。
   - 读数 (a) 创建：对 7/30/90 各 POST 一次（带 `name`、`expiresInDays`），断言 201；在响应 JSON 里递归找匹配 `^ccp_[0-9a-f]{64}$` 的字符串（各恰 1 条），写下三条明文与各自 id。
   - 读数 (b) 列表：GET 的**整个响应体**（`JSON.stringify`）里不含 (a) 的任一条明文，也不含该令牌的 SHA-256 哈希（逐条与库中该行 `token_hash` 比对）；每项含 `tokenPrefix`（= 明文前 8 字符）、`name`、`scopes`、`expiresAt`、`lastUsed`，且无 `token_hash`/`plaintext` 键；写下响应体键集。
   - 读数 (c) 非法有效期：`expiresInDays` 取 0、1、6、10、365、−1 各 POST，断言一律 400；每次前后 `SELECT COUNT(*) FROM access_tokens` 不变（不创建任何记录），写下每条返回与前后计数。
   - 读数 (d) 吊销：DELETE `/access-tokens/:id` ⇒ 200；用同一令牌服务实例对该令牌明文 `validate` ⇒ 被拒（reason 为吊销）；再 DELETE 同一 id ⇒ 404。写下两次 DELETE 状态与 validate 结果。
   - 读数 (e) 归属：以用户 2 身份 DELETE 用户 1 的令牌 id ⇒ 404，且该令牌仍能被 validate（未被误吊销）；GET 列表在用户 2 身份下只含用户 2 的令牌（id 集合不含用户 1 的）。写下两个用户的列表 id 集合。
   - 读数 (f) 旧接口：GET 与 POST `/api/settings/api-keys` ⇒ 设置路由不处理（404；响应体不含 `apiKeys` 键、不返回旧形状）。写下两状态与响应体。
   - 红先行：先只提交判据文件（settings 侧未加 `/access-tokens`）⇒ 判据在 (a)(b)(c)(d)(e)(f) 上红；再落实现，记录红→绿全流程。

取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 列表直接返回整行（含 `token_hash`）⇒ (b) 必须红；(ii) 创建接受任意天数（去掉 7/30/90 白名单）⇒ (c) 必须红；(iii) 吊销不校验归属（不比对 userId）⇒ (e) 必须红；(iv) 在设置路由重新挂上 `/api-keys` 的 GET 或 POST ⇒ (f) 必须红。每条记录恢复命令与恢复后重跑绿。

<!-- dedup-ref -->
关联（非重复）：`gap-ac224-access-token-service`（goal_ac: AC-224）建 `access_tokens` 表与令牌服务（签发/校验/吊销、7/30/90 白名单、可注入时钟）——本任务经 `@/modules/oauth/index.js` 与 `@/modules/database/index.js` 两个 barrel 复用，不重造；`gap-ac226-retire-api-agent-and-plaintext-keys`（goal_ac: AC-226）删除旧 `/api-keys` 路由/服务方法/接线（settings.routes.ts、settings.service.ts、settings.module.ts、settings/tests/settings.service.test.ts）并退役 `apiKeysDb`——本任务读数 (f) 靠它满足，且两者改同一批 settings 文件（避免并发写同一文件），故以顶层 `depends_on` 随后两者。AC-225 只做删 `api_keys` 表迁移，与设置接口不相交。

边界：不实现令牌服务/`access_tokens` 表（AC-224）；不做删 `api_keys` 表的迁移（AC-225）；不退役 `/api/agent`、不删 `apiKeysDb`/旧 api-keys 路由（AC-226）；不改前端 `src/**` 与 i18n（AC-228/AC-229）；不改 `/api/agent` 路径或全局 `API_KEY` 校验中间件；不实现 OAuth（阶段 5）。

判定纪律：判据经真实 HTTP（`app.listen(0)` + `fetch`）打到**生产设置路由工厂**，装配用真实令牌服务 + 真实 better-sqlite3 临时库，不用内存桩；「明文/哈希不在响应体里」是整份 `JSON.stringify` 扫描与库列比对的计数读数，不是「我看了」。

## AC

- [ ] AC1 判据文件存在且绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/access-tokens.routes.test.ts` 退出 0，用例涵盖 (a)–(f)。逐字记录红态基线（改动前 `[ -f ... ]` 存在性闸退出码 1 并打印缺失文件名）。
- [ ] AC2 (a) 创建 201 且含明文：对 `expiresInDays` = 7/30/90 各 POST（带 `name`）返回 201；响应 JSON 里各恰有 1 个匹配 `^ccp_[0-9a-f]{64}$` 的字符串。写下三条明文与各自 id。
- [ ] AC3 (b) 列表无明文无哈希：GET 整个响应体 `JSON.stringify` 不含任一条明文，也不含对应 `token_hash`；每项含 `tokenPrefix`/`name`/`scopes`/`expiresAt`/`lastUsed`，无 `token_hash`/`plaintext` 键。写下响应体键集与两个「找不到」的计数。
- [ ] AC4 (c) 非法有效期 400 不落库：`expiresInDays` ∈ {0,1,6,10,365,−1} 各 POST 返回 400，且每次 `SELECT COUNT(*) FROM access_tokens` 前后相等。写下每条返回与前后计数。
- [ ] AC5 (d) 吊销：DELETE 某令牌 ⇒ 200；同一令牌服务实例对其实明文 `validate` ⇒ 被拒（吊销 reason）；再次 DELETE 同一 id ⇒ 404。写下两状态与 validate 结果。
- [ ] AC6 (e) 归属：用户 2 DELETE 用户 1 的令牌 id ⇒ 404 且该令牌仍 validate 通过（未被误吊销）；用户 2 的列表 id 集合不含用户 1 的令牌。写下两用户列表 id 集合。
- [ ] AC7 (f) 旧接口不再被处理：GET 与 POST `/api/settings/api-keys` 均 404，响应体不含 `apiKeys` 键。写下两状态与响应体。
- [ ] AC8 取假形态四条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 列表返回整行含哈希 ⇒ AC3 红；(ii) 创建接受任意天数 ⇒ AC4 红；(iii) 吊销不校验归属 ⇒ AC6 红；(iv) 重挂 `/api-keys` GET 或 POST ⇒ AC7 红。每条记录恢复命令与恢复后重跑绿。
- [ ] AC9 仓库门与该模块窄测：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级）；`npx tsx --tsconfig server/tsconfig.json --test server/modules/settings/tests/settings.service.test.ts` 退出 0（依赖工厂补 `accessTokens` 桩后不残留失败用例）；判据跨模块只经 barrel（`@/modules/settings/index.js`、`@/modules/oauth/index.js`、`@/modules/database/index.js`），无深导入。写明各命令退出码与 lint error 计数。
- [ ] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 设置接口真的被创建/列表/吊销操作过：判据经真实 HTTP 打到生产设置路由工厂（`createSettingsRouter`），装配真实令牌服务 + 真实 better-sqlite3 临时库，不是内存桩。
- 明文只在创建响应里出现：创建响应各恰 1 条 `^ccp_[0-9a-f]{64}$`；列表整份响应体里明文 0 次、哈希 0 次（扫描计数为证）。
- 非法有效期真的被拒且不落库（前后行数相等）；归属校验真的生效（他人令牌 DELETE 404 且未被误吊销，列表只含本人令牌）；吊销后同一令牌校验真的被拒、再删 404。
- 旧 `/api/settings/api-keys` 的 GET/POST 真的不再被设置路由处理（404，无 `apiKeys` 形状）。
- 四条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 遵守 `$backend-module-standards`（路由薄、服务薄、跨模块只经 barrel、仓储不在 settings 内、判据在 AC 钉死的路径）；不越界实现 AC-224/225/226 或前端。

## Touches

- server/modules/settings/settings.routes.ts
- server/modules/settings/settings.service.ts
- server/modules/settings/settings.module.ts
- server/modules/settings/index.ts
- server/modules/settings/tests/settings.service.test.ts
- server/modules/oauth/tests/access-tokens.routes.test.ts (new)
- tasks/gap-ac227-access-tokens-settings-routes.md