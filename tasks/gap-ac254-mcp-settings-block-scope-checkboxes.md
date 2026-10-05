---
id: gap-ac254-mcp-settings-block-scope-checkboxes
title: AC-254 设置页 CloudCLI MCP 区块与令牌 scope 勾选：真实浏览器分别读 MCP_ENABLED 开/关，端点
  URL+复制+「已启用/未启用」、接入命令（含 Bearer 占位符、无真实令牌）、五个 scope 勾选（只读默认勾选、写 scope
  触发风险提示）、token-info scope 一致；判据 e2e/mcp-settings.spec.ts
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-254
---
## Proposal

AC-254（GOAL-020 设置页；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1「前端：设置 → API 页改造」§478–§485 与 scope 词汇 §326–§330）要求真实浏览器里 Settings → "API & Tokens" 页出现两件事：(1) CloudCLI MCP 区块——端点 URL（带复制按钮）与启用状态、以及一段本机 Claude Code 接入命令；(2) 个人访问令牌创建表单的五个 scope 勾选框——`cloudcli:read` 默认勾选、其余默认不勾、勾选任一写 scope 时出现风险提示。判据文件 `e2e/mcp-settings.spec.ts` 当前不存在，AC-254 的存在性闸以退出码 1 逐字输出 `缺判据文件：e2e/mcp-settings.spec.ts`（已实测）。

现状（红态基线）：
- 后端：MCP 启用状态与端点**没有**任何读出口。`server/modules/mcp-gateway/index.ts:14` 已导出 `readMcpGatewayGate` 与 `MCP_GATEWAY_PATH`(`/mcp`)，但 `server/modules/settings/settings.routes.ts:44–50` 只有 credentials/notifications/access-tokens 路由，没有返回 `{enabled, path, baseUrl}` 的读点；`server/index.ts:445` 只在挂载时读一次 gate。
- 前端：`src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx` 的创建表单只有 name + expiry（`:53–83`），**没有** scope 勾选框，也没有风险提示；`src/shared/api.ts:612` 的 `createAccessToken` 载荷是 `{name, expiresInDays}`，不带 `scopes`。`src/modules/settings/tabs/api-settings/CredentialsSettingsTab.tsx` 没有 MCP 区块。
- 已有可复用能力：`server/modules/settings/settings.service.ts:174–191` 的 `createAccessToken` **已接受** `input.scopes`（非空字符串数组即透传，否则回落到 `DEFAULT_TOKEN_SCOPES = ['cloudcli:read']`，`:79`）；`GET /api/oauth/token-info`（`server/modules/oauth/token-info.routes.ts:45`）已返回 `{userId, scopes, expiresAt}`；`src/shared/types.ts:2126` 的 `AccessTokenItem`/`CreatedAccessToken` 已含 `scopes`。五个 scope 字面量见 SPEC §326–§330：`cloudcli:read`（勾选、必选）、`cloudcli:session:send`、`cloudcli:session:create`、`cloudcli:session:control`、`cloudcli:approve`（后四者默认不勾）。

要交付：

1. **后端读点**（遵守 `$backend-module-standards`，跨模块只经 barrel）：在 settings 模块加一条只读路由（建议 `GET /api/settings/mcp-gateway`），返回 `{ enabled: boolean, path: '/mcp', baseUrl: string }`。`enabled` 取自 `readMcpGatewayGate()`（**不要**在 settings 里二次解析 `MCP_ENABLED`），`path` 取自 `MCP_GATEWAY_PATH`，`baseUrl` 取 `PUBLIC_BASE_URL`（未设时用请求自身的 origin）。`settings.module.ts` 以依赖注入方式把 gate 读取与 path 交给 `createSettingsService`（便于路由测试注入两种 env），`settings.service.ts` 增加 `getMcpGatewayStatus()`，`settings.routes.ts` 增加 GET。跨模块导入走 `@/modules/mcp-gateway/index.js`。
2. **前端 MCP 区块**：新增 `src/modules/settings/tabs/api-settings/sections/McpGatewaySection.tsx`，`CredentialsSettingsTab.tsx` 在 AccessTokensSection 之前渲染它。开启时显示端点 URL（`data-testid` 供判据读）、一个复制按钮与「已启用」状态；关闭时显示「未启用」与启用方法，且**不渲染**可用的接入命令。接入命令里含端点 URL 与 `Authorization: Bearer <token>` 占位符，页面上任何文本节点都不得出现真实令牌。所有文案经 i18n（`settings` namespace）。
3. **scope 勾选框与风险提示**：`AccessTokensSection.tsx` 的表单加五个 checkbox（`cloudcli:read` 默认勾选且必选，其余默认不勾），任一写 scope 被勾选时渲染风险提示。`useCredentialsSettings.ts` 持有 scope 选择状态、把勾选集合作为 `scopes` 传给 `createAccessToken`；`src/shared/api.ts` 的 `createAccessToken` 载荷加上 `scopes: string[]`。
4. **i18n**：为上述新键在全部 12 个 `src/modules/i18n/locales/<locale>/settings.json` 补齐译文，避免真实浏览器里出现未翻译键或英文回退。
5. **判据文件 `e2e/mcp-settings.spec.ts`（红先行）**：真实 Chromium、真实后端、临时数据目录，**分别**在 `MCP_ENABLED` 开与关两种配置下驱动真实设置页，读数 (a)–(e) 见 `## AC`。因为 playwright 的共享 `webServer` 每轮只有一个固定 env，两态由本 spec 自己产生：用真实入口 `npx tsx --tsconfig server/tsconfig.json server/index.ts` 在核分配的空闲端口上另起实例（先例：`scripts/resident-smoke.mjs:381`、`scripts/voice-capture-process-check.mjs:499`），临时数据目录，`MCP_ENABLED` 按态设置；`dist/` 存在时该实例直接服务 SPA（`server/index.ts:455–464` 仅在 dist 缺失时跳转 Vite），浏览器直连该 origin。**不得**对后端做 page.route 桩接；两态的进程/端口/env 与读数命令逐字记录。

取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令；恢复后重跑判据回绿）：
(i) 让写 scope 默认勾选 ⇒ (d) 必须红；
(ii) 关闭时仍渲染接入命令 ⇒ (b) 必须红；
(iii) 命令里内嵌真实令牌 ⇒ (c) 必须红。

## AC

- [ ] AC1 红态基线逐字记录：改动前运行 AC-254 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：e2e/mcp-settings.spec.ts`（写下完整命令与完整输出）。
- [ ] AC2 判据绿：`for f in e2e/mcp-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/mcp-settings.spec.ts` 退出 0；写下 tests/passed/failed 读数与所用两态 env。
- [ ] AC3 (a) 开启态：DOM 读出端点 URL 形如 `<base>/mcp`、存在复制按钮、状态为「已启用」；逐字写出该节点 textContent/attribute 与复制按钮的读数。
- [ ] AC4 (b) 关闭态：DOM 读出「未启用」与启用方法，且页面**不含**可用的接入命令（断言命令节点不存在或为空）；逐字写出读数。
- [ ] AC5 (c) 命令安全：接入命令字符串含端点 URL 与 `Authorization: Bearer` 占位符；对整页所有文本节点扫描，断言**不含**本用例真实创建的令牌明文；逐字写出命令串与扫描结果。
- [ ] AC6 (d) 五个 checkbox 初始状态：`cloudcli:read` 勾选、其余四个不勾；勾选任一写 scope 后风险提示从无到有；逐字写出五个 checkbox 的初始 checked 与提示的 before/after 读数。
- [ ] AC7 (e) scope 一致：用勾选集合创建令牌，携带其明文请求 `GET /api/oauth/token-info`，返回的 `scopes` 与勾选集合完全一致（含一个多 scope 正例）；逐字写出请求与响应。
- [ ] AC8 取假形态 (i) 写 scope 默认勾选 ⇒ (d) 红；记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿。
- [ ] AC9 取假形态 (ii) 关闭态仍显示接入命令 ⇒ (b) 红；记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿。
- [ ] AC10 取假形态 (iii) 命令内嵌真实令牌 ⇒ (c) 红；记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿。
- [ ] AC11 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；`e2e/access-tokens-settings.spec.ts`（AC-228）与既有 settings 后端判据（`settings.service.test.ts`、`token-info.routes.test.ts`、`access-tokens.routes.test.ts`）不改一字仍通过。
- [ ] AC12 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 真实浏览器、真实后端、临时数据目录下，`MCP_ENABLED` 开与关两态都**真的**被渲染并读出（两态由本 spec 用真实入口起进程产生），不是桩接产物。
- 端点 URL、复制按钮、启用/未启用状态**真的**渲染在设置页；接入命令**真的**含 URL 与 `Bearer` 占位符，整页文本节点**真的**没有真实令牌。
- 五个 scope 勾选框**真的**呈现正确默认（只读勾选、写不勾），勾选写 scope **真的**触发风险提示，创建出的令牌经真实 `GET /api/oauth/token-info` **真的**返回与勾选一致的 scope。
- 三条取假形态都先红后恢复；变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$frontend-module-standards`（src/）与 `$backend-module-standards`（server/）及 AGENTS.md；不越界实现 AC-255 的 i18n 完整性判据、AC-256/257 的冒烟记录。

## Touches

- e2e/mcp-settings.spec.ts (new)（判据）
- src/modules/settings/tabs/api-settings/sections/McpGatewaySection.tsx (new)
- src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx
- src/modules/settings/tabs/api-settings/CredentialsSettingsTab.tsx
- src/modules/settings/hooks/useCredentialsSettings.ts
- src/shared/api.ts
- server/modules/settings/settings.routes.ts
- server/modules/settings/settings.service.ts
- server/modules/settings/settings.module.ts
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/i18n/locales/zh-TW/settings.json
- src/modules/i18n/locales/de/settings.json
- src/modules/i18n/locales/es/settings.json
- src/modules/i18n/locales/fr/settings.json
- src/modules/i18n/locales/id/settings.json
- src/modules/i18n/locales/it/settings.json
- src/modules/i18n/locales/ja/settings.json
- src/modules/i18n/locales/ko/settings.json
- src/modules/i18n/locales/ru/settings.json
- src/modules/i18n/locales/tr/settings.json
- tasks/gap-ac254-mcp-settings-block-scope-checkboxes.md

## Notes

- 若两态实现改为经 `playwright.config.ts` 的既有 `selectedSpecFiles()` 逐 spec env 选择来表达，必须先把 `playwright.config.ts` 加入 `## Touches` 再落地，否则 scoped 门与 git diff 对不上。
- 新增测试文件会被边界 lint 拦（内存 `quay-boundaries-lint-blocks-new-test-files`）；`e2e/mcp-settings.spec.ts` 已列入 `## Touches`。若另加 spawn 辅助脚本，同样必须先列入 Touches。
- 判据内的 HTTP 客户端用基于 `node:http` 的 `fetch` 以避开 `listen(0)` 的 undici 坏端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`）。
- 后端改 settings routes 后，若某兄弟测试对该模块整体 `vi.mock`，需同步补上新增导出（内存 `adding-an-export-reds-sibling-wholesale-vimocks`）。
- `MCP_ENABLED` 只由 `readMcpGatewayGate` 解析（`server/modules/mcp-gateway/index.ts:14` 已 barrel 导出）；settings 侧不得二次解析。
- 端点基址优先 `PUBLIC_BASE_URL`，未设时用请求 origin；`path` 恒为 `MCP_GATEWAY_PATH`。

<!-- dedup-ref -->
边界：机制上去重已核对——`grep -rl "goal_ac: AC-254" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-254`；`grep -rln "AC-254" tasks/` 只命中 AC-240/242/243/244/245/247/248/249/250/251/253 的边界段（各自声明「设置页（AC-254/255）不在本任务」）。AC-228（令牌设置页 e2e，done）与 AC-229（accessTokens i18n 完整性，done）交付的是无 scope 勾选的令牌列表/创建与旧键完整性；本任务是**不同读数与不同判据文件**（`e2e/mcp-settings.spec.ts`）：新增 CloudCLI MCP 区块与五个 scope 勾选框（(d) 默认只读 + 写 scope 风险提示），并读 `GET /api/oauth/token-info` 的 scope 一致性。AC-243（签发期 scope 词汇校验）、AC-255（MCP 文案 12 语言完备性）、AC-256/257（冒烟）是不同机制，各自覆盖。
