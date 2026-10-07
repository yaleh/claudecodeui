---
id: gap-mcp-token-last-used-never-stamped-for-oauth
title: OAuth 访问令牌与授权(grant)的 last_used 从不落库：/mcp 走 OAuth 路径不打点，Settings
  里令牌与已连接应用永远显示"从未使用"
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
机制去重读数（立案时实测）：`task_list({search:"last_used"})` 只命中 `gap-ac224-access-token-service`（done，建的是 PAT 令牌服务，其 AC3 只钉 PAT `verifyToken` 首次打点）、`gap-ac241-mcp-token-auth-shares-service`（done，AC7 (e) 只钉 PAT 令牌经 /mcp 后 `last_used` 非 null）、`gap-ac258-oauth-store-hash-and-revoke-cascade`（done，建 OAuth 三表与 `oauth_grants.last_used` 列但不写它）。三者都不认领「OAuth 路径不打点 + grant 无写入方 + 打点无节流 + 历史数据回填」这一机制 ⇒ 本条不是重复。

**现象（只读实测 `~/.cloudcli/auth.db`）**：`access_tokens` 有 13 行 `oauth_access` + 13 行 `oauth_refresh`、0 行 `pat`，其中 `last_used` 非 null 的为 **0** 行；`oauth_grants` 6 行，`last_used` 非 null 的为 **0** 行；而 `mcp_audit_log` 里却有 **16933** 次调用、涉及 12 个不同 `token_id`。即令牌明明在被大量使用，Settings 的令牌列表与「已连接应用」(connected apps) 行却永远显示"从未使用"。

**根因**：只有 PAT 路径 `createAccessTokensService().verifyToken`（`server/modules/oauth/access-tokens.service.ts:224`）调用 `accessTokensDb.updateLastUsed`。`/mcp` 的 OAuth 路径（`server/modules/mcp-gateway/mcp-gateway.auth.ts` 的 `resolvePrincipal` → `oauth.verifyAccessToken`，`server/modules/oauth/oauth-provider.service.ts` 约 :391）从不写 `last_used`；`oauth_grants.last_used` 列存在于 `server/modules/database/repositories/oauth-grants.db.ts`，但全仓没有任何写入方。另外 PAT 路径现在是"每次校验必写"，/mcp 高频调用下若对 OAuth 路径照搬同样写法会变成每请求一次写库，故需要节流。

**用户已裁定**：节流间隔 **60 秒**。

**要交付**：
1. 节流打点：校验成功时，仅当库中 `last_used` 为 null 或相对**注入时钟**已早于 60s 才写 `access_tokens.last_used`；PAT 的 `verifyToken` 与 OAuth 的 `verifyAccessToken` 两条路径都适用。OAuth 路径同时对所属 `oauth_grants.last_used` 适用同一 60s 规则（在 `oauth-grants.db.ts` 新增写入方，经 database barrel 导出并带消费方注释）。节流判定逻辑只放在**一处**共享 helper，不在两个服务里各抄一份。
2. 一次性回填（`server/modules/database/migrations.ts` 内的迁移，幂等、只填 NULL）：`access_tokens.last_used` = 该 `token_id` 在 `mcp_audit_log` 中的最大时间戳；`oauth_grants.last_used` = 该 grant 名下各令牌的最大值。**先核对 `mcp_audit_log` 的真实列名**（时间戳列与 token 关联列）再写 SQL，不凭记忆。
3. 遵守 `$backend-module-standards`：跨模块只经 barrel、不新建模块私有 types/utils 文件、导出符号带消费方注释。

**需要调和的既有判据（逐个读、原地更新、写进 Touches）**：`server/modules/oauth/tests/access-tokens.service.test.ts` 的 case (b)「a live token verifies and stamps last_used from the injected clock」（首次使用仍须成立；新增：60s 内第二次校验不重写，超过 60s 后重写）；`server/modules/oauth/tests/oauth-provider.test.ts`（新增 OAuth 打点 + grant 打点 + 节流用例）；`server/modules/oauth/tests/oauth-store.test.ts` 与 `server/modules/oauth/tests/oauth-settings.routes.test.ts` 若有断言 `lastUsed` 为 null 的地方需同步调整。

## AC

- [ ] AC1 红态基线逐字记录：在改动前，用 oauth-provider 判据所用的真实临时库驱动一次 OAuth `verifyAccessToken` 成功，读回该令牌行与所属 grant 行，输出 `last_used` 为 NULL（写下完整命令与原始输出）。
- [ ] AC2 节流（注入时钟，PAT 与 OAuth 两路各一组）：t0 首次校验 `last_used` 从 NULL 变为 t0；t0+59s 再校验 `last_used` 仍为 t0（未重写）；t0+61s 再校验 `last_used` 变为 t0+61s。命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/access-tokens.service.test.ts` 与 `npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/oauth-provider.test.ts` 各退出 0，并写下 `# pass` / `# fail` 读数。
- [ ] AC3 grant 打点：OAuth 校验成功后 `oauth_grants.last_used` 非 null 且等于注入时钟当时值，同样遵守 60s 节流（59s 不重写、61s 重写）；在 `oauth-provider.test.ts` 中逐字写下读回值。
- [ ] AC4 回填：在 `server/modules/database/tests/` 下**既有**的迁移判据文件里新增用例（不得新增测试文件）：造含 NULL `last_used` 的令牌/grant 与若干 `mcp_audit_log` 行，跑迁移后 NULL 被填为 audit 最大时间戳，grant 取其名下令牌最大值，已非 null 的值不被覆盖，重跑迁移结果不变（幂等）；写下该文件路径与 `# pass` 读数。
- [ ] AC5 既有判据已调和：`access-tokens.service.test.ts` case (b) 首次使用断言仍成立；`oauth-store.test.ts` 与 `oauth-settings.routes.test.ts` 各单文件运行退出 0，不存在残留的"lastUsed 恒为 null"断言（写下 grep 读数）。
- [ ] AC6 取假形态必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿）：(i) 去掉节流（每次校验都写）⇒ AC2 的 59s 不重写用例红；(ii) 去掉 OAuth 路径打点 ⇒ AC2 的 OAuth 用例红；(iii) 去掉 grant 打点 ⇒ AC3 红；(iv) 回填改为无条件覆盖 ⇒ AC4 的"不覆盖非 null"用例红。
- [ ] AC7 仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；节流逻辑只在一处共享 helper（`grep` 读数显示两条校验路径调用同一个 helper，无第二份 60s 比较）；新增导出带消费方注释。⛔ 不得新增任何 `server/**/*.test.ts`（仓库按文件数 pin 测试，新增会让它全线变红）；每个测试文件按 `docs/operations/process-isolation-and-memory-caps.md` 单文件运行，不做无界 `--test` 扇出。
- [ ] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐；列出实际改动文件清单。

## DoD

真实落地：对真实运行的服务实例，用一个 OAuth 访问令牌调用一次 `/mcp`，随后通过真实的 `GET /api/settings/oauth-grants` 读回，该授权所在行的 `lastUsed` 在节流窗口内变为非 null（写下请求与响应原文）；对应令牌列表接口读回的令牌 `lastUsed` 也非 null。对真实 `~/.cloudcli/auth.db` 的副本跑回填迁移后，13 行 oauth_access 令牌中凡在 `mcp_audit_log` 里出现过的均获得非 null `last_used`。仅「单测通过」不算达标。

## Touches

- server/modules/oauth/access-tokens.service.ts
- server/modules/oauth/oauth-provider.service.ts
- server/modules/database/repositories/access-tokens.ts
- server/modules/database/repositories/oauth-grants.db.ts
- server/modules/database/index.ts
- server/modules/database/migrations.ts
- server/modules/oauth/tests/access-tokens.service.test.ts
- server/modules/oauth/tests/oauth-provider.test.ts
- server/modules/oauth/tests/oauth-store.test.ts
- server/modules/oauth/tests/oauth-settings.routes.test.ts
- tasks/gap-mcp-token-last-used-never-stamped-for-oauth.md

## Notes

- 回填迁移的测试用例放进 `server/modules/database/tests/` 下已有的迁移判据文件（执行者选定后须把该文件补进 Touches，`quay-touches-must-match-actual-write-sites`）；若确无合适的既有文件，则把用例并入上面已列的 oauth 测试文件，不得新建。
- 共享节流 helper 的落点由执行者按 `$backend-module-standards` 决定（两个消费者都在 oauth 模块内，可放 oauth 模块既有服务文件并导出；若选择别处，先把该文件补进 Touches 再写）。
- `mcp_audit_log` 列名、`token_id` 与 `access_tokens.id` 的对应关系以真实 schema 为准，立案时未核对，是执行者的第一步。
- 节流间隔 60 秒是用户裁定值，不要改成可配置项。
