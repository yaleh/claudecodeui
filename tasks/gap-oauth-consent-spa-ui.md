---
id: gap-oauth-consent-spa-ui
title: OAuth 授权页改为 SPA（前端半）：/oauth/consent
  路由用应用主界面组件与主题渲染授权确认页（客户端身份、回调主机、按风险分组的 scope、Allow/Deny），未登录先登录再回到授权
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-oauth-consent-spa-backend-contract
---
## Proposal

用户已裁定：用与主界面一致的 SPA 页面替换 `server/modules/oauth/oauth-consent.routes.ts` 渲染的无样式服务端授权 HTML。后端半是 `gap-oauth-consent-spa-backend-contract`：`GET /oauth/authorize` 校验后 302 到 SPA 路由 `/oauth/consent?<原 oauth 查询串>`；SPA 调 `GET /api/oauth/authorize/context?<查询串>`（JWT）取 `{clientName, callbackHost, redirectUri, scopes:[{scope, description, required, writable}], state}`，再 `POST /api/oauth/authorize/decision`（`{client_id, redirect_uri, state, code_challenge, code_challenge_method, scopes[], action}`）得 `{redirectTo}`，最后 `window.location.assign(redirectTo)`。**最终字段名以后端任务文件为准，与本摘要不符时以后端任务为准并回写本任务。** 本任务只做前端：路由、模块、i18n 与真实浏览器判据；不改后端机制。手机（375px 视口）是主要场景，因为 ChatGPT/Gemini 的授权常在手机上完成。

要交付：

1. **模块与路由**：新建 `src/modules/oauth-consent/`（含 `index.ts` barrel，遵守 `$frontend-module-standards`：`@/` 导入、跨模块只经 barrel、`type` 而非 `interface`、导出带消费方注释）；`src/App.tsx` 增加 `/oauth/consent` 路由，位于项目工作区布局之外。未登录访问时落入既有登录流，登录后带着完整查询串回到 `/oauth/consent`（读 `src/modules/auth` 现有的登录后跳转机制，最小扩展）。
2. **页面内容**（用 `src/shared/ui` 组件与应用主题 token，深/浅色，mobile-first）：客户端名称突出；回调主机突出且视觉上区别于普通文字（防钓鱼提示「You will be sent to <host>」）；明示「当前登录身份」一行；scope 按风险分组——Read 固定勾选且禁用；写/动作类 scope（`session:send`、`session:create`、`session:control`、`approve`、`navigate`）默认不勾选、各带描述，任一写 scope 勾选时出现警告样式（复用 `src/shared/constants` 的 `ACCESS_TOKEN_SCOPE_OPTIONS` 思路与设置页访问令牌的 `writeScopeRisk` 文案）；说明日后如何吊销（设置 → 已连接的应用）；Allow / Deny 按钮，提交中有 loading/禁用态；错误态：无效/未知客户端 → 可读错误且**没有** Allow 按钮；401 → 去登录；网络失败 → 可重试；成功后跳转 `redirectTo`。
3. **api/types**：`src/shared/api.ts` 增加 context/decision 两个调用，`src/shared/types.ts` 增加对应类型（`type`，带用途注释）。
4. **i18n**：所有字符串走 react-i18next，键加到 `src/modules/i18n` 下**全部** locale 文件（既有 e2e 会标记未翻译字面量）。
5. **不引入新依赖。**

<!-- dedup-ref -->
边界（dedup）：按机制检索 `oauth/consent` 在任务库中无命中。相邻但不重叠：`gap-ac260-oauth-consent-page`（已有的服务端渲染授权页，被本任务与后端半替换其呈现层）；`gap-ac266-connected-apps-settings-browser-ui`（设置页「已连接的应用」，只作形制与 e2e 约定参照，授权后吊销入口在那里）；`gap-oauth-consent-spa-backend-contract`（机械前置，本任务 `depends_on`，拥有 context/decision 端点与 302 重定向契约）。本任务不实现任何后端端点。

## AC

- [ ] AC1 红态基线逐字记录：改动前运行 `for f in e2e/oauth-consent-page.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done`，退出码 1 并逐字输出 `缺判据文件：e2e/oauth-consent-page.spec.ts`。
- [ ] AC2 判据绿：存在性闸通过后 `npx playwright test e2e/oauth-consent-page.spec.ts` 退出 0，写下 passed/总数与墙钟；真实 Chromium + 真实后端，不 stub 任何请求。
- [ ] AC3 (a) 已登录用户打开授权 URL → 落在 `/oauth/consent`，显示客户端名称、回调主机；Read scope 勾选且禁用；scope 共 6 个；写 scope 全部未勾选。逐字写下读数。
- [ ] AC4 (b) 勾选一个写 scope → 风险警告出现；点 Allow → 浏览器到达已注册回调且带 `code` + `state`；该 code 在 `/oauth/token`（PKCE）换得令牌，令牌访问 `/mcp` 成功，且授予的 scope == read + 所勾选项。逐字写下。
- [ ] AC5 (c) 点 Deny → 回调带 `error=access_denied` 且**无** `code`。
- [ ] AC6 (d) 未登录用户打开授权 URL → 登录 → 回到 `/oauth/consent` 且查询串完整（client_id、redirect_uri、state、code_challenge 逐项相等）。
- [ ] AC7 (e) 未注册的 redirect_uri / 未知 client → 错误视图，没有 Allow 按钮，浏览器**未**导航到该坏 uri。
- [ ] AC8 (f) 视口 375x812 截图：`scrollWidth <= clientWidth`（无横向溢出），Allow 按钮包围盒完全在视口内；同时轮询文本与几何，不以空占位行满足几何等待。
- [ ] AC9 (g) 页面无未翻译 i18n 字面量（沿用兄弟 spec 的 `UNTRANSLATED_KEY`，命名空间含新增的授权页命名空间）；全部 locale 文件键集合与 `en` 一致。
- [ ] AC10 (h) 反嵌入：`/oauth/consent` 文档响应带 `X-Frame-Options: DENY`。
- [ ] AC11 取假形态必须红：(i) 让页面忽略所勾选的 scope ⇒ AC4 红；(ii) 让 Deny 调用 allow ⇒ AC5 红。每条记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿。
- [ ] AC12 客户端 vitest：为页面组件补用例（若模块惯例有），`npm run typecheck` 退出 0、`npm run lint` 无 `: error `、`npm run test:client` 退出 0（受影响测试单文件运行，不做无界并发）。
- [ ] AC13 若 `scripts/` 内存在 e2e 文件数 pin，则已 bump 并在 Touches 声明；否则写明「已核查无 pin」。
- [ ] AC14 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件标注 ASCII ` (new)`）。

## DoD

- 真实浏览器对真实服务端与真实 MCP 客户端注册，走完整流程：桌面与 375px 视口各走一遍并附截图；与设置页做主题一致性对比（按 `quay-webui-bootstrap-methodology` 技能做整体视觉审阅，执行者须先查阅该技能）。
- 授权结果由服务端真实决策：勾选的 scope 真的进入令牌，Deny 真的不发 code，坏 redirect_uri 真的不被导航；两条取假形态必须先红后恢复。
- 页面真的用应用主题与 `src/shared/ui` 组件，不是另一份无样式 HTML；未登录路径真的登录后回到授权。
- 遵守 `$frontend-module-standards` 与 AGENTS.md，无新依赖；测试按 `docs/operations/process-isolation-and-memory-caps.md` 单文件运行，不做无界 fan-out。

## Touches

- e2e/oauth-consent-page.spec.ts (new)（判据）
- src/App.tsx
- src/modules/oauth-consent/index.ts (new)
- src/modules/oauth-consent/ 下页面组件、hook 与其 vitest 文件 (new)（实现时逐个列出具体文件名）
- src/modules/auth/ 下登录后跳转相关的具体文件（实现时读码确定并逐个列出）
- src/shared/api.ts
- src/shared/types.ts
- src/shared/constants.ts（仅当共享 scope 选项时）
- src/modules/i18n/locales/{en,de,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW}/ 下新增的授权页命名空间 json 及其注册处（实现时列出具体文件）
- scripts/ 下 e2e 文件数 pin（仅当存在；已核查则写明）
- tasks/gap-oauth-consent-spa-ui.md

## Notes

- 后端半 `gap-oauth-consent-spa-backend-contract` 是机械前置；字段名、重定向与错误语义以其任务文件为准。
- e2e 形制参照 `e2e/connected-apps-settings.spec.ts`（`warmClientStartup`/`navigateBounded`/`UNTRANSLATED_KEY`、`selectedSpecFiles()` 的 env 注入缝：OAuth 端点需 `MCP_ENABLED`/`MCP_OAUTH_ENABLED`/`PUBLIC_BASE_URL` 仅对本 spec selection 注入，若需改 `playwright.config.ts` 须补入 Touches）。
- 避开仓库 e2e 教训：onboarding 走查中不得有无界裸点击；有界等待；文本与几何同谓词轮询；守卫不得替用例下结论。
- e2e spec 不受 server 测试文件数 pin 约束，但 scripts/ 下若有 e2e 计数 pin 须 bump 并声明。
- Touches 中带「实现时列出」的条目在执行时须替换为具体文件，不得留裸目录。
