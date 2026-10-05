---
id: gap-ac266-connected-apps-settings-browser-ui
title: AC-266 真实浏览器设置页管理已连接的应用与 OAuth 客户端：列表显示客户端名称/回调主机/scope，吊销后该行消失且其令牌 /mcp
  401，手工创建客户端密钥只显示一次（刷新后页面任何文本节点不含它），禁用客户端后其令牌被拒；判据
  e2e/connected-apps-settings.spec.ts
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac259-oauth-provider-semantics
  - gap-ac260-oauth-consent-page
  - gap-ac263-oauth-mcp-challenge-audience
  - gap-ac264-oauth-dcr-policy-and-manual-clients
  - gap-ac265-oauth-settings-routes
goal_ac: AC-266
---
## Proposal

AC-266（GOAL-021 退出条件 6 的浏览器一半；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §152、§483–§485「已连接的应用 / OAuth 客户端（高级）」、§511 阶段 5、§521「设置页能创建 PAT 且明文只显示一次」同款约定）要求真实浏览器里设置页能管理 OAuth 授权与客户端。读数：(a) 「已连接的应用」列出预置的授权，显示客户端名称、回调主机、scope；(b) 吊销后该行消失，且用该授权的令牌访问 `/mcp` 得到 401；(c) 在「OAuth 客户端（高级）」手工创建客户端，密钥只在创建后的提示里出现一次，刷新后页面任何文本节点都不含它；(d) 禁用客户端后其授权的令牌被拒。判据文件 `e2e/connected-apps-settings.spec.ts` 当前不存在，存在性闸 `for f in e2e/connected-apps-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done` 以退出码 1 逐字输出缺失的文件名。

现状（红态基线）：

- `grep -rn "oauthGrants\|oauthClients\|connectedApps\|oauthClients\|createOAuthClient" src/` 为空——前端没有消费任何 OAuth 设置接口。
- `src/modules/settings/tabs/api-settings/CredentialsSettingsTab.tsx` 只挂个人访问令牌区块（`AccessTokensSection`）与 GitHub 凭证区块（`GithubCredentialsSection`），没有「已连接的应用」或「OAuth 客户端（高级）」区块。
- `playwright.config.ts` 的服务器 `webServer[].env`（约 1949–1976 行）不含 `MCP_ENABLED`/`MCP_OAUTH_ENABLED`/`PUBLIC_BASE_URL`，故 `/mcp` 与 OAuth 端点在 e2e 服务器上根本没挂载——(b)/(d) 的 `/mcp` 读数需要本 spec 专属的 selection 注入（参照既有 `voiceRawCaptureSelection`/`shortenActivityHeartbeat`/`debugAgentFixtureHome` 的 `selectedSpecFiles()` 缝）。
- 既有 `e2e/access-tokens-settings.spec.ts`（AC-228）是同类「设置页真实浏览器」判据：真实 Chromium + playwright.config 起的真实后端与 Vite、隔离临时目录、`warmClientStartup`/`navigateBounded`/`UNTRANSLATED_KEY` 约定，本任务照其形制。

**真实前置**（frontmatter `depends_on` 已声明，均为机械前置；本任务复用、不重写）：

- `gap-ac259-oauth-provider-semantics`：PKCE/授权码/refresh/受众语义与 `createOAuthProvider`；spec 用它预置真令牌。
- `gap-ac260-oauth-consent-page`：服务端渲染的 `GET/POST /oauth/authorize` 授权页、CSRF 令牌与密码校验；spec 预置授权时走这一真实流程。
- `gap-ac263-oauth-mcp-challenge-audience`：OAuth 开启后 `/mcp` 的认证（令牌被吊销/禁用后下一次调用 401）与 `MCP_ENABLED`/`MCP_OAUTH_ENABLED` 的挂载语义。
- `gap-ac264-oauth-dcr-policy-and-manual-clients`：`POST /api/oauth/clients` 手工创建（须登录、密钥只返回一次、库里只存哈希）与 `/oauth/register` DCR。
- `gap-ac265-oauth-settings-routes`：`/api/settings/oauth-grants`（列出/吊销）与 `/api/settings/oauth-clients`（列出/禁用）的接口契约与字段。

本任务只做前端区块、前端 api/types/i18n、e2e selection 的 env 接线与真实浏览器判据；不重写任一后端机制。

要交付：

1. **前端区块**（只改 `src/modules/settings/tabs/api-settings/` 与相关 hook/api/types，不新开 tab；遵守 `$frontend-module-standards`）：
   - `sections/ConnectedAppsSection.tsx`（new）：「已连接的应用」区块，标题/说明 + 列表。每行 `data-testid="connected-app-row"` + `data-grant-id`，显示客户端名称（`clientName`）、回调主机（`redirectHost`）、scope（`scopes`）、授权时间与最近使用；逐行「吊销」按钮（确认后调 DELETE）。空状态。
   - `sections/OAuthClientsSection.tsx`（new）：「OAuth 客户端（高级）」区块，标题/说明 + 手工创建表单（客户端名称 + 回调 URI）+ 列表。每行 `data-testid="oauth-client-row"` + `data-client-id`，显示名称、回调主机、来源（DCR/手工 `createdVia`）与启用/已禁用状态；「禁用」按钮（确认后调 PATCH）。空状态。
   - `sections/NewOAuthClientAlert.tsx`（new）：手工创建成功后的一次性提示，展示 `client_id` 与 `client_secret`（`data-testid="new-oauth-client-secret"`），含复制与「我已保存」关闭；密钥只存在于组件状态直到关闭，**不得**写入 `localStorage`/`sessionStorage`，也不得出现在任何列表行。
   - `hooks/useOAuthSettings.ts`（new）：拉取 grant/client 列表；`revokeGrant`（调 DELETE，成功后 `fetchData`）、`createManualClient`（调 POST，成功把 `{ client_id, client_secret }` 存进一次性状态）、`disableClient`（调 PATCH，成功后 `fetchData`）。错误走既有 `console.error` 约定。
   - `CredentialsSettingsTab.tsx`：挂上上述两个区块与 `NewOAuthClientAlert`。
   - `src/shared/api.ts`：settings 段新增 `oauthGrants()` → GET `/api/settings/oauth-grants`、`revokeOAuthGrant(id)` → DELETE `/api/settings/oauth-grants/:id`、`oauthClients()` → GET `/api/settings/oauth-clients`、`disableOAuthClient(id)` → PATCH `/api/settings/oauth-clients/:id/disable`、`createOAuthClient(payload)` → POST `/api/oauth/clients`（`{ clientName, redirectUris }`）。字段名以 AC-265/AC-264 实际契约为准。
   - `src/shared/types.ts`：新增 `ConnectedAppGrant`（id/clientId/clientName/redirectHost/scopes/createdAt/lastUsed）、`OAuthClientItem`（clientId/clientName/redirectHost/createdVia/disabledAt）、`CreatedOAuthClient`（clientId/clientName/redirectUris/clientSecret——明文只在创建响应里）。全部用 `type`，带用途注释。

2. **i18n**：在全部 12 种 locales 的 `settings.json` 新增 `connectedApps` 与 `oauthClients` 两个命名空间，值非空且不等于键名，键集合与 `en` 完全一致（完整性判据由 AC-267 另行守护）。本任务交付的必需键清单（供 AC-267 镜像）：
   - `connectedApps`：`title, description, list.empty, list.redirectHost, list.scopes, list.createdAt, list.lastUsed, list.never, list.revokeButton, list.revokeConfirm`
   - `oauthClients`：`title, description, newButton, form.namePlaceholder, form.redirectUrisPlaceholder, form.createButton, form.cancelButton, newClient.alertTitle, newClient.alertMessage, newClient.copy, newClient.iveSavedIt, list.empty, list.redirectHost, list.createdVia, list.dcr, list.manual, list.active, list.disabled, list.disableButton, list.disableConfirm`

3. **e2e selection 的 env 接线**（`playwright.config.ts`；沿用既有 `selectedSpecFiles()` selection 缝，参照 `voiceRawCaptureSelection`）：新增 `const connectedAppsSelection = selectedSpecFiles().includes('connected-apps-settings.spec.ts');`，并在服务器 `webServer` 的 `env` 里仅当该 selection 为真时展开 `MCP_ENABLED: 'true'`、`MCP_OAUTH_ENABLED: 'true'`、`MCP_DCR: 'open'`、`PUBLIC_BASE_URL: \`http://localhost:${serverPort}\``（localhost 是 https 的例外，见 AC-262；若 AC-262 的实际校验对基址另有要求，以实际为准调整）。**不**把这些变量对其它 selection 泄漏——其余 selection 的 env 对象逐字节不变。若不改 selection，(b)/(d) 的 `/mcp` 读数恒为「未挂载」，取假形态也变不红。

4. **判据 `e2e/connected-apps-settings.spec.ts`**（红先行；真实 Chromium + playwright.config 起的真实后端（`tsx server/index.ts`）与 Vite、隔离临时目录、首次运行走建号/引导；形制照 `e2e/access-tokens-settings.spec.ts` 的 `warmClientStartup`/`navigateBounded`/`UNTRANSLATED_KEY`，不 stub 任何请求）：
   - **预置（经后端接口，不经设置 UI）**：spec 的 node 侧对 `http://127.0.0.1:${process.env.QUAY_E2E_SERVER_PORT}` 用 fetch 真跑一遍 OAuth 流程——`POST /oauth/register`（DCR open、public client、redirect_uri `http://127.0.0.1:<port>/callback`）→ 生成 PKCE S256 → `GET /oauth/authorize`（解析 CSRF 隐藏字段）→ 带密码 POST 授权页 → 302 拿 `code` → `POST /oauth/token`（authorization_code + code_verifier）拿 `access_token`。记下 client 名称、回调主机、scope、grant id 与 access token；`resource` 省略或取 `${PUBLIC_BASE_URL}/mcp`（AC-259 (e) 默认受众）。字段名以 AC-259/260/264 实际契约为准。
   - (a) 登录 → 设置 → API & Tokens →「已连接的应用」列出该预置授权：行含客户端名称、回调主机、scope；逐字写下该行读数。
   - (b) 用预置 access token `POST /mcp`（`Authorization: Bearer <token>`）⇒ **200**（正例对照）；点该行「吊销」并确认 ⇒ 该行从列表消失（reload 后仍不出现，服务端来源）；同一 token 再 `POST /mcp` ⇒ **401**。逐字写下两次状态码、吊销前后行数与回读。
   - (c) 「OAuth 客户端（高级）」点「新建」→ 填名称 + 回调 URI（如 `http://127.0.0.1:5173/cb`）→ 创建：`POST /api/oauth/clients` 返回 201，捕获 `client_secret` 明文，一次性提示里含它；`page.reload()` 后扫描 `page.content()`、`body.innerText`、`localStorage`、`sessionStorage`：明文出现次数**均为 0**；列表行显示名称与回调主机（不显示密钥）。逐字写下创建状态码与四处命中计数。
   - (d) 让某客户端的授权令牌先用起来：为其预置/登记一个 grant+token，`POST /mcp` ⇒ **200**（正例对照）；在「OAuth 客户端（高级）」点该行「禁用」并确认 ⇒ 同一 token 再 `POST /mcp` ⇒ **401**。逐字写下两次状态码与 `disabledAt` 读数。
   - 页面无未翻译的 i18n 字面量（沿用兄弟 spec 的 `UNTRANSLATED_KEY`，命名空间含 `settings`）。
   - 启动/测量有界：`warmClientStartup` + `navigateBounded`，守卫不得替用例下结论；整条 `npx playwright test e2e/connected-apps-settings.spec.ts` 须在 goal gate 的 60s 墙内。

5. **取假形态**（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
   (i) 吊销只改前端状态（`revokeGrant` 不调 DELETE，仅本地过滤掉该行）⇒ (b) 的「同一 token 再 `/mcp` ⇒ 401」必须红（token 仍有效，返回 200）。
   (ii) 列表里渲染密钥（把一次性提示或列表行改成持久展示 `client_secret`，或把它写进 `localStorage`）⇒ (c) 必须红（刷新后扫描命中 > 0）。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：机制上去重已核对——`grep -rlE '^goal_ac:[[:space:]]*AC-266[[:space:]]*$' tasks/` 为空，本仓库无任何任务带 AC-266；`grep -rln "connected-apps-settings\|CredentialsSettingsTab\|已连接的应用\|OAuth 客户端（高级）" tasks/` 只命中 AC-228（个人访问令牌设置页 e2e，不同区块，已 done）、AC-229（令牌文案完整性，不同键集）、AC-254（MCP 设置区块 scope 勾选，不同区块）、AC-264/AC-265 的越界声明句（各自明确把「浏览器 UI」让给 AC-266）。AC-259/260/263/264/265 是**机械前置**（frontmatter `depends_on` 已声明）：本任务复用其授权流程、`/mcp` OAuth 认证、手工创建端点与设置接口。AC-267 是**相邻且不重叠**：它拥有 `connectedApps`/`oauthClients` 两命名空间在 12 种语言的**完整性判据**；本任务交付 UI 并按 AC-228 先例同时补齐 12 语言键，AC-267 以本任务的实际键集为基、正常路径下只核验不重写。AC-268 是**服务端无浏览器**的端到端流程判据（`server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts`），与本浏览器判据不同文件、不同机制。AC-266 判据自足：真实浏览器 + 真实后端 + 临时数据目录，授权记录经真实 OAuth 后端接口预置。

## AC

- [ ] AC1 红态基线逐字记录：改动前运行判据命令，存在性闸退出码 1 并逐字输出 `缺判据文件：e2e/connected-apps-settings.spec.ts`（写下完整命令与完整输出）。
- [ ] AC2 判据绿：`for f in e2e/connected-apps-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/connected-apps-settings.spec.ts` 退出 0；写下 passed/总数与墙钟（须 < 60s）。
- [ ] AC3 (a) 已连接的应用列出预置授权：行含客户端名称、回调主机、scope；逐字写下该行读数。
- [ ] AC4 (b) 吊销前 token `/mcp` 200（正例对照）；吊销后该行消失（reload 后仍不出现）且同一 token `/mcp` 401；逐字写下两次状态码与行数。
- [ ] AC5 (c) 手工创建客户端：201；一次性提示含 `client_secret`；reload 后 content/innerText/localStorage/sessionStorage 命中数均为 0；列表行含名称与回调主机；逐字写下。
- [ ] AC6 (d) 禁用客户端后其授权令牌 `/mcp` 401；禁用前 200（正例对照）；逐字写下两次状态码与 `disabledAt`。
- [ ] AC7 页面无未翻译 i18n 字面量（命名空间含 settings）。
- [ ] AC8 取假形态两条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 吊销只改前端状态 ⇒ AC4 的 401 一条红；(ii) 列表渲染密钥 ⇒ AC5 红。每条恢复命令 + 恢复后重跑绿。
- [ ] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）、`npm run test:client` 退出 0；`npx playwright test e2e/access-tokens-settings.spec.ts` 不改一字仍逐字通过（证明新 selection 未把 env 泄漏给其它 selection）。
- [ ] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 设置页**真的**在真实 Chromium + 真实后端上管理授权与客户端：列表、吊销、手工创建、禁用都由判据经真实 UI 驱动，不是「组件存在」或「接口存在」就算数。
- (b) 的拒绝**真的**是服务端拒绝：吊销前同一 token 真被 `/mcp` 接受（200），吊销后真被拒（401）；吊销只改前端状态的变异必须让该 401 断言变红。
- (c) 的一次性密钥在整个刷新后文档里 **0 次**出现（content/innerText/localStorage/sessionStorage 计数为证），且列表行不渲染它；列表渲染密钥的变异必须让该扫描变红。
- (d) 禁用客户端**真的**让其授权令牌下一次 `/mcp` 调用被拒（禁用前后 200/401 对照）。
- e2e selection 的 env **只对本 spec 生效**：`access-tokens-settings.spec.ts` 照旧通过（负例对照）。
- 遵守 `$frontend-module-standards`（`@/` 导入、跨模块只经 barrel、`type` 而非 `interface`、导出带消费方注释、不导出无消费者符号、类型/工具就近定义）与 AGENTS.md；不引入新依赖；不越界实现 AC-259/260/263/264/265（后端机制）与 AC-267/AC-268（文案完整性判据 / 服务端端到端判据）。
- 两条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。

## Touches

- e2e/connected-apps-settings.spec.ts (new)（判据）
- src/modules/settings/tabs/api-settings/CredentialsSettingsTab.tsx
- src/modules/settings/tabs/api-settings/sections/ConnectedAppsSection.tsx (new)
- src/modules/settings/tabs/api-settings/sections/OAuthClientsSection.tsx (new)
- src/modules/settings/tabs/api-settings/sections/NewOAuthClientAlert.tsx (new)
- src/modules/settings/hooks/useOAuthSettings.ts (new)
- src/shared/api.ts
- src/shared/types.ts
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/de/settings.json
- src/modules/i18n/locales/es/settings.json
- src/modules/i18n/locales/fr/settings.json
- src/modules/i18n/locales/id/settings.json
- src/modules/i18n/locales/it/settings.json
- src/modules/i18n/locales/ja/settings.json
- src/modules/i18n/locales/ko/settings.json
- src/modules/i18n/locales/ru/settings.json
- src/modules/i18n/locales/tr/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/i18n/locales/zh-TW/settings.json
- playwright.config.ts
- tasks/gap-ac266-connected-apps-settings-browser-ui.md

## Notes

- `playwright.config.ts` 的 selection 是本任务唯一的「后端接线」：`MCP_ENABLED`/`MCP_OAUTH_ENABLED`/`MCP_DCR`/`PUBLIC_BASE_URL` 只对该 spec 注入，其余 selection 的 env 对象逐字节不变（参照 `voiceRawCaptureSelection` 的写法；纪律同内存 `scoped-gate-verdict-can-depend-on-ambient-anthropic-model-env` 一类「env 只对该 selection 生效」）。
- 若 AC-265 的字段名/路径（`redirectHost` vs `host`、`PATCH .../disable` vs `.../disabled` 等）与本文假设不符，以实际契约为准并更新正文、判据与 `## Touches`。
- 若 AC-259/260 的授权流程契约（CSRF 字段名、密码字段名、PKCE 参数名、`resource` 参数名）与本文假设不符，以实际为准——预置流程宁可直接读 SDK/路由实现逐字段对齐，不猜。
- `listen(0)`/undici 端口取舍按既有约定（内存 `undici-bad-port-lottery-in-listen0-route-tests`）：spec 侧 fetch 直连 `QUAY_E2E_SERVER_PORT`，不经 undici 的 listen(0)。
- 判据文件即 AC-266 `criterion:` 点名的那个 `e2e/connected-apps-settings.spec.ts`；不新建第二个判据文件。
- 内存提示：e2e specs 在 typecheck/lint 之外（`e2e-specs-are-outside-typecheck-and-lint`）；新 e2e 文件可能在边界 lint 被拦截；判据文件已列入 `## Touches`。