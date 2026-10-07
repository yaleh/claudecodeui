---
id: gap-oauth-consent-spa-backend-contract
title: OAuth 授权页改为 SPA（后端半）：/oauth/authorize 先校验后跳转到 SPA 路由，新增已登录会话鉴权的
  context/decision JSON 接口，替换服务端 HTML 表单与其判据
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac260-oauth-consent-page
  - gap-ac261-oauth-consent-ratelimit
  - gap-ac268-oauth-e2e-flow
---
## Proposal

现状：`server/modules/oauth/oauth-consent.routes.ts` 用 `renderConsentPage` 服务端渲染一张裸 HTML 表单（CSP `default-src 'none'`、CSRF 台账、用户名+密码重输、`oauth-consent-ratelimit.service.ts` 的密码限速），无样式、与应用不一致。用户已裁定：授权页迁入 SPA（复用 `src/shared/ui` 与应用主题）。本任务是**后端半**；兄弟任务 `gap-oauth-consent-spa-ui` 是前端半，依赖本任务。

设计（下列不变量为强制，执行者可凭证据细化其余）：

1. `GET /oauth/authorize` 仍是已登记的 authorization_endpoint，**保留全部现有校验**（client_id 存在且未禁用、`response_type=code`、`redirect_uri` 逐字属于该客户端已登记集合——未登记者显示错误页且**绝不重定向**，RFC 6749 §3.1.2.4），校验通过后才 302（同源、相对路径）到 SPA 路由 `/oauth/consent?<原 query>`；路由路径作为常量，若前后端共享则放 `server/shared`（路由名由 UI 任务消费，此处定死）。非法请求仍返回纯文本/HTML 错误页。防嵌套头（`X-Frame-Options: DENY`、CSP `frame-ancestors 'none'`）与 `Cache-Control: no-store` 还必须出现在 SPA 文档该路由的响应上（先读 `server/index.ts` 如何提供 SPA 壳，加路由级头中间件）与新 JSON 接口上。
2. 新增 `/api/oauth/authorize/` 下的 JSON 接口：`GET context?<同 query>` 由常规应用 bearer JWT（`authenticateToken`；SPA 以头携带 JWT，故无跨站 CSRF）鉴权，重跑同一套 client/redirect 校验（失败 400 JSON），返回 `{clientName, callbackHost, redirectUri, scopes:[{scope, description, required, writable}], state}`；`POST decision` 入参 `{client_id, redirect_uri, state, code_challenge, code_challenge_method, scopes[], action:'allow'|'deny'}`，同样鉴权，**重新校验 redirect_uri 属于已登记集合**（deny 不得成为开放重定向器）；deny → `{redirectTo: redirect_uri?error=access_denied&state=…}`；allow → 强制并入 `cloudcli:read`、丢弃 `ACCESS_TOKEN_SCOPES` 之外的 scope、以 JWT 中的 userId 调 `provider.authorize`，返回 `{redirectTo: redirect_uri?code=…&state=…}`。最终 `window.location` 跳转由 SPA 执行（避开服务端 CSP form-action 问题，Google 的多跳回调链保持可用）。
3. 密码重输**取消**，改为已登录会话 + 显式点击 Allow。故本页的 CSRF 台账与密码限速退役——**但先核查** `oauth-consent-ratelimit.service.ts` 是否另有消费者（`credential-verifier`、`/login`），仍被消费的保留，有消费者的代码不得删除。若判断去掉密码不安全（如会话劫持风险），在 Notes 中提出，并以开关保留 `confirm password` 选项，不得静默决定。
4. `oauth-request-log.service.ts` 的请求日志/脱敏必须覆盖新路径（`state`、`code`、`code_challenge` 仍须脱敏），审计语义保持。
5. 遵守 `$backend-module-standards`：跨模块只经 barrel、路由保持薄、逻辑进 service 层、导出带消费方注释、不建模块内 types/utils 文件。

待改写的判据（逐个读、原地改写，所有文件列入 Touches）：`oauth-consent-page.test.ts`（AC-260 的 (a) 转义、(b) 只读 checked+disabled、(c) 密码、(f) CSRF、(g) 头、(i) CSP 无 form-action、(j) 未登记 redirect_uri 的 GET/POST allow/deny、(l) 真浏览器两跳回调链、(m) 全 scope 供选仅 read 预勾、(n) 词表外伪造 scope 被丢弃）→ 转译到新契约：转义类改为 JSON 数据用例；密码/CSRF 类退役并写明理由；(j)(l)(m)(n)(g) 必须保留真实牙齿。`oauth-consent-ratelimit.test.ts`（AC-261）按第 3 点核查结果退役或改指向。`mcp-gateway/tests/oauth-flow.e2e.test.ts`（AC-268：`parseCsrf` + POST 表单流）→ GET authorize 302 → context → decision → token 交换，整条 PKCE 链保持绿。另有 `oauth-request-log.test.ts`、（若受影响）`oauth-provider.test.ts`、（若枚举了这些路由）`mcp-english-only.test.ts` 与 `mcp-error-envelope.test.ts`。

<!-- dedup-ref -->
边界（dedup）：机制去重已核对——`task_list` 搜索 `oauth-consent-spa` 与 `/api/oauth/authorize` 均无命中。相关但不同：`gap-ac260-oauth-consent-page`（done，服务端 HTML 授权页，本任务将其取代）、`gap-ac261-oauth-consent-ratelimit`（done，密码限速）、`gap-ac268-oauth-e2e-flow`（done，端到端流，本任务改写其判据）。三者的 AC 文本是历史记录，不改；前端半 `gap-oauth-consent-spa-ui` 是不同机制（SPA 页面），依赖本任务。

## AC

- [ ] AC1 红态基线逐字记录：改动前，对已起的服务 `GET /oauth/authorize`（合法参数）返回 `content-type: text/html` 的表单而非 302，且 `GET /api/oauth/authorize/context` 为 404；写下完整命令与输出。
- [ ] AC2 `GET /oauth/authorize` 合法请求 → 302，`location` 为同源相对路径 `/oauth/consent?…`，原 query 逐项保留；逐字写出 location。
- [ ] AC3 未登记 `redirect_uri`（及不存在/已禁用 client、非 `response_type=code`）→ 400 错误页且**无** `location` 头（不重定向）；逐字写出状态码与头。
- [ ] AC4 `GET /api/oauth/authorize/context`：无 JWT → 401；有 JWT → 200，`scopes` 含全部词表 scope、`cloudcli:read` 为 `required:true`，`state` 原样回显，`callbackHost` 正确；未登记 `redirect_uri` → 400 JSON。
- [ ] AC5 `POST /api/oauth/authorize/decision` allow：返回 `redirectTo` 含非空 `code` 与原样 `state`；经 `getConnection()` 读回的 `oauth_grants.scopes` 恰为「提交集 ∪ cloudcli:read − 词表外 scope」（含对伪造 scope 的丢弃）。
- [ ] AC6 decision deny：已登记 redirect_uri 时 `redirectTo` 含 `error=access_denied` 与 `state`、无 `code`；未登记 redirect_uri（allow 与 deny 两种）→ 400 且无 `redirectTo`、无授权码行新增。
- [ ] AC7 decision 无 JWT → 401 且无授权码行新增；`oauth_authorization_codes` 行数读数前后逐字写出。
- [ ] AC8 防嵌套/不缓存头：SPA 路由 `/oauth/consent` 文档与 context、decision JSON 响应均含 `X-Frame-Options: DENY`、CSP `frame-ancestors 'none'`、`Cache-Control: no-store`；逐字写出原始头值。
- [ ] AC9 全 PKCE 链 e2e 绿（`oauth-flow.e2e.test.ts` 新流：authorize 302 → context → decision → token 交换 → `/mcp` 调用）；(l) 多跳回调链真浏览器用例仍绿。
- [ ] AC10 取假形态必须红（逐条记录变异 diff、逐字失败行、恢复命令、恢复后重跑绿）：(i) decision 跳过 redirect_uri 校验 ⇒ AC6 红；(ii) 跳过 JWT 鉴权 ⇒ AC4/AC7 红；(iii) 保留词表外 scope ⇒ AC5 红；(iv) 去掉 SPA 路由头 ⇒ AC8 红。
- [ ] AC11 请求日志脱敏：`oauth-request-log.test.ts` 证明新路径的 `state`、`code`、`code_challenge` 在日志中仍为脱敏值。
- [ ] AC12 限速服务消费者核查已落 Notes：列出 `oauth-consent-ratelimit.service.ts` 的全部消费者；仍有消费者的保留，无消费者才退役（连同判据 `oauth-consent-ratelimit.test.ts` 改写/退役并写明理由）。
- [ ] AC13 仓库门：逐个单文件运行被触及的测试文件（遵守 `docs/operations/process-isolation-and-memory-caps.md`，不做无界 fan-out），`npm run typecheck` 退出 0，`npm run lint`（含 boundaries）无 `: error `；**不新增** `server/**/*.test.ts` 文件（仓库钉死文件数），只改既有文件。
- [ ] AC14 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件标 ` (new)`）；已改 `oauth/index.ts` barrel 导出与 `server/index.ts`、`oauth-server.mount.ts` 的消费一致。

## DoD

- 真实运行的服务 + 真实 JWT，用 curl 驱动授权码流程端到端：`/oauth/authorize` 302 → context → decision allow → `/oauth/token` 交换，最终以签发的令牌成功调用 `/mcp`；逐字记录每步状态码与响应。
- redirect_uri 校验**真的**在 GET authorize、context、decision 三处生效：未登记者真不重定向、真无授权码、deny 不是开放重定向器；变异掉后对应 AC 真变红。
- JWT 鉴权**真的**是闸：无 JWT 的 context/decision 真 401；变异掉后真变红。
- 词表外 scope **真的**被丢弃、`cloudcli:read` 真被强制并入（真库 grant 行读数）。
- 防嵌套/不缓存头**真的**在 SPA 路由文档与 JSON 接口响应上（真 HTTP 头原值）。
- 被取代的服务端 HTML 表单与 CSRF 台账已移除；仍有消费者的限速代码未被删除；遵守 `$backend-module-standards` 与 AGENTS.md；不引入新依赖。

## Touches

- server/modules/oauth/oauth-consent.routes.ts
- server/modules/oauth/oauth-server.mount.ts
- server/modules/oauth/oauth-provider.service.ts（仅在需要时）
- server/modules/oauth/oauth-consent-ratelimit.service.ts（视消费者核查结果）
- server/modules/oauth/index.ts
- server/modules/oauth/oauth-request-log.service.ts
- server/index.ts（SPA 路由头中间件）
- server/shared/constants.ts（若共享 SPA 路由常量；以实际写点为准）
- server/modules/oauth/tests/oauth-consent-page.test.ts
- server/modules/oauth/tests/oauth-consent-ratelimit.test.ts
- server/modules/oauth/tests/oauth-request-log.test.ts
- server/modules/oauth/tests/oauth-provider.test.ts（若被触及）
- server/modules/mcp-gateway/tests/oauth-flow.e2e.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts（若枚举了这些路由）
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts（若枚举了这些路由）
- tasks/gap-oauth-consent-spa-backend-contract.md

## Notes

- **取代声明（历史记录不改）**：`gap-ac260-oauth-consent-page`、`gap-ac261-oauth-consent-ratelimit`、`gap-ac268-oauth-e2e-flow` 已 done，其 AC 文本是历史记录，本任务不编辑它们。自本任务落地起，AC-260 的服务端 HTML 表单、转义用例 (a)、只读 checkbox (b)、密码 (c)、CSRF (f)、CSP 无 form-action (i) 以及 AC-261 的授权页密码限速语义，被本任务的 SPA + JSON 契约取代；AC-268 的 `parseCsrf` + POST 表单流被新流取代。(g)(j)(l)(m)(n) 的意图保留并转译到新契约。
- **安全提请**：取消密码重输后，授权完全依赖已登录会话 + 显式 Allow。会话被劫持（XSS 盗取 JWT）的攻击者可静默授权第三方客户端。若执行者判断风险不可接受，在此处记录并以开关保留 `confirm password` 选项，不得静默取舍；最终取舍交人裁定。
- 限速服务核查先于任何删除：`credential-verifier`、`/login` 若仍消费 `oauth-consent-ratelimit.service.ts`，则保留并让 `oauth-consent-ratelimit.test.ts` 继续覆盖其真实消费者。
- 新增 barrel 导出/删除导出可能使整体 `vi.mock('@/modules/oauth/index.js')` 的兄弟测试变红，按实际写点补 mock 并加入 Touches。
- 前端半 `gap-oauth-consent-spa-ui` 依赖本任务；SPA 路由名在此处定死并以常量传递。
- 内存提示：新增 `server/**/*.test.ts` 会令测试文件计数钉死判据全面变红，故只改既有测试文件。