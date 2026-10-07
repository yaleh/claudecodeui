---
id: gap-settings-access-tokens-list-mixes-oauth-internal-tokens
title: Settings「Access tokens」列表混入 OAuth 内部令牌（全显示 Unnamed token）：只列 PAT，OAuth
  令牌移入只读「高级」折叠区，PAT 创建给默认名
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->
机制去重读数（立案时实测）：`task_list({search:"Unnamed token"})` 零命中；相关但不同的任务是 `gap-mcp-token-last-used-never-stamped-for-oauth`（供给 OAuth 令牌真实的 lastUsed 值，管「写入」不管「列表过滤」），二者机制不同 ⇒ 本条不是重复；无硬依赖，DoD 中 lastUsed 读数仅在该任务落地后才有真实值。

**现象**：Settings →「Access tokens」列表里全是 "Unnamed token"。用户真实 DB 实测 26 行，**全是 OAuth**（13 个 oauth_access + 13 个 oauth_refresh，其中 18 个已 revoked），**0 个 PAT**。用户看不出哪个是自己建的、哪个能删。

**根因**：`GET` settings access-tokens 列表走 `server/modules/settings/settings.module.ts:60` 的 `accessTokensDb.listByUser(userId)`（`server/modules/database/repositories/access-tokens.ts`），**没有 kind 过滤**，所以每一行 OAuth 的 oauth_access / oauth_refresh 都被列出（refresh 轮换每次还新增一对）。这些行的 name 为 NULL（`server/modules/oauth/oauth-store.service.ts:243` 写入 `name: null`），被 `src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx:138` 渲染为 "Unnamed token"。手动创建 PAT 本就要求 name（`settings.service.ts` 的 `createAccessToken` → `TOKEN_NAME_REQUIRED`），所以 PAT 永远不会无名——"Unnamed" 只来自 OAuth 行。

**用户裁定**：OAuth 令牌**不得整个隐藏**，要保留一个只读的「高级」折叠区供排障。

**交付**：
1. 服务端：PAT 列表只返回 `kind='pat'`；新增只读读取 OAuth 令牌的途径（`GET /api/settings/oauth-tokens` 或 `kind` 查询参数，读 settings.module.ts/路由后选改动更小者），每个令牌返回 id、kind、tokenPrefix、所属 grant 的 client 名（join oauth_grants/oauth_clients）、scopes、createdAt、expiresAt、lastUsed、revokedAt；**绝不返回 token_hash**（沿用 `projectAccessToken` 的白名单投影纪律）；该面不提供创建/撤销（撤销仍在 Connected-apps 的 grant 级）。
2. 前端（遵循 `$frontend-module-standards`，用 `src/shared/ui`）：`AccessTokensSection` 只列 PAT；其下新增默认折叠的「Advanced: OAuth tokens (read-only)」区，显示 client 名（替代 "Unnamed"）、kind、前缀、状态（active/expired/revoked）、创建时间、最近使用；列表长时已撤销/已过期行默认藏在开关后；最近使用显示相对时间并以 tooltip/title 给绝对时间（`toLocaleDateString` 太粗），null 显示 "Never"；i18n 键加到 `src/modules/i18n` 下**所有**语言文件，不留未翻译字面量；新建 PAT 表单预填默认名如 "MCP token · 2026-10-07"（仍可编辑、仍必填）。
3. `src/shared/types.ts` 与 `src/shared/api.ts` 同步更新。

## AC

- [ ] AC1 红基线→绿：`server/modules/oauth/tests/access-tokens.routes.test.ts` 先种一行 oauth_access，断言改前 PAT 列表会返回它（记录红文案）；改后 PAT 列表**不含**该行，且保留原 ~223 行 `'lastUsed' in item` 断言。单文件运行 `node --import tsx --test server/modules/oauth/tests/access-tokens.routes.test.ts` 全绿。
- [ ] AC2 OAuth 只读端点：同文件（或 `server/modules/settings/tests/settings.service.test.ts`）断言新读取面包含该 oauth 行且带 grant 的 client 名，返回项 key 集合恰为 {id, kind, tokenPrefix, clientName, scopes, createdAt, expiresAt, lastUsed, revokedAt}，**不含 `token_hash`/`tokenHash`**；并断言该面无创建/撤销方法（对其发 POST/DELETE 得 404/405）。
- [ ] AC3 假形态承重：临时去掉 kind 过滤 ⇒ AC1 必须变红；临时把 token_hash 漏进投影 ⇒ AC2 的 key 集合断言必须变红；各自还原后转绿，红文案写进完成记录。
- [ ] AC4 前端：`e2e/access-tokens-settings.spec.ts` 与 `e2e/connected-apps-settings.spec.ts` 单文件运行全绿（可就地更新，不得删弱断言），并新增/更新断言：PAT 列表中无 "Unnamed" 行；Advanced 区默认折叠、展开后显示 OAuth 令牌及 client 名；新建表单默认名已预填且可编辑、清空后仍被拒；复用现有的「无未翻译 i18n 字面量」检查并通过。
- [ ] AC5 相关 client vitest（覆盖 AccessTokensSection / 设置 hook 的现有测试，就地更新）单文件运行全绿；所有 locale 文件含新键（逐文件 grep 新键名，计数一致）。
- [ ] AC6 工具链：`npm run typecheck` 退出码 0；`npm run lint` 对触及文件无新增告警；⛔ **不得新增任何 `server/**/*.test.ts`**（仓库按文件数 pin 测试，新增会全线变红）；按 `docs/operations/process-isolation-and-memory-caps.md` 单文件方式跑测试，不做无界 `--test` 扇出。

## DoD

真实落地：真实浏览器（MCP 浏览器）连真实 server 与真实 DB 副本，打开 Settings →「Access tokens」：**0 个 "Unnamed token" 行**；展开「Advanced: OAuth tokens (read-only)」能看到那些 OAuth 令牌并显示 client 名；新建 PAT 表单默认名已预填；截图附入完成记录。若 `gap-mcp-token-last-used-never-stamped-for-oauth` 已落地，再读一次最近使用相对时间与 title 绝对时间（未落地则只确认 null 显示 "Never"）。仅「单测通过」不算达标。

## Touches

- server/modules/settings/settings.module.ts
- server/modules/settings/settings.service.ts
- server/modules/database/repositories/access-tokens.ts
- server/modules/database/index.ts
- server/modules/oauth/tests/access-tokens.routes.test.ts
- server/modules/settings/tests/settings.service.test.ts
- src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx
- src/modules/settings/tabs/api-settings/CredentialsSettingsTab.tsx
- src/shared/types.ts
- src/shared/api.ts
- src/modules/i18n (所有 locale 文件，具体文件由执行者枚举后逐一声明)
- e2e/access-tokens-settings.spec.ts
- e2e/connected-apps-settings.spec.ts
- tasks/gap-settings-access-tokens-list-mixes-oauth-internal-tokens.md

## Notes

- 加载令牌列表的 settings hook 文件名待执行者读 `src/modules/settings/` 后定位并补进 Touches，连同覆盖该 section 的 client vitest 测试文件。
- 选端点还是 `kind` 查询参数：读 settings.module.ts 后选改动更小者，并在完成记录写明理由。
- 相关任务：`gap-mcp-token-last-used-never-stamped-for-oauth`（lastUsed 真值来源，无硬依赖）。
