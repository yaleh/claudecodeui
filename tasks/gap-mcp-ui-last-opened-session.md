---
id: gap-mcp-ui-last-opened-session
title: MCP 只读工具 ui_last_opened_session：浏览器读取会话历史/outline 时落库
  last_opened，工具返回用户最后打开的会话（无记录返回 NOT_FOUND，不退回 lastActivity）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**目标：** 新增 MCP 只读工具 `ui_last_opened_session`（scope `cloudcli:read`），回答「用户最后打开的会话是哪个」，即使浏览器已关闭。该事实不能由 `lastActivity` 代替：90% 左右的会话由 quay worker 发起，`lastActivity` 会被后台刷新淹没。设计取自 2026-10-07 与 yale 的讨论：A 不向客户端拉取，由服务端在已有请求处记录。

**现状（已读代码核实）：**

- 前端打开会话时经 `src/shared/api.ts` 的 `/api/providers/sessions/:sessionId/messages` 与 `/outline` 读取历史；服务端处理在 `server/modules/providers/provider.routes.ts`（`router.get('/sessions/:sessionId/messages'` 与 `'/sessions/:sessionId/outline'`）。
- MCP 的 `session_read` 直接调用 `sessionsService.fetchHistory`，不经过这两个 HTTP 路由，所以 HTTP 路由天然只有浏览器调用方；但前端是否在用户未打开会话时预取（侧栏悬停、预加载）**尚未核实**。
- 全仓库没有「最后打开」的持久化；`mcp_audit_log` 之类的表结构与迁移在 `server/modules/database/schema.ts`、`migrations.ts`，仓库文件在 `server/modules/database/repositories/`，经 database barrel 导出。
- 读工具表在 `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 的 `MCP_STAGE3_READ_TOOLS`；annotations 在 `mcp-tool-annotations.ts`，错误码词汇在 `mcp-tool-error-codes.ts`，经 mcp-gateway barrel `index.ts` 导出。

**要交付：**

1. **第一步，先核对再动手：** 确认前端有无预取或悬停预加载会触发 `/messages` 或 `/outline`。若有，且无法区分「用户打开」与「预取」，则不要把这两个路由当信号；退回方案：前端在选中会话时发一次 WS 帧 `ui.session_opened { sessionId }`，由 `server/modules/websocket/services/chat-websocket.service.ts` 的消息分派处理。把核对结论写入本任务的 Finding 段。
2. **存储：** 新表 `ui_last_opened(session_id TEXT PRIMARY KEY, opened_at INTEGER)` 只保留最后一条（或单行表），新增迁移与仓库文件 `server/modules/database/repositories/ui-last-opened.db.ts`，经 database barrel 导出。
3. **记录点：** 按上面第 1 步的结论，在选定的信号处 upsert。MCP 令牌调用方绝不写入这张表。
4. **工具：** 新文件 `server/modules/mcp-gateway/mcp-ui-tools.ts` 注册 `ui_last_opened_session`：返回会话摘要（与 `session_get` 同形，含 `host` 与当前运行摘要）加 `openedAt`（相对时间加 ISO）。无记录时返回错误码 `NOT_FOUND` 类（沿用现有错误码词汇，不新造第二个「找不到」），**不得退回 `lastActivity`**。
5. **接入现有机制：** 加进读工具表与 `mcp-tool-annotations.ts`（`readOnlyHint: true`）、`mcp-tool-error-codes.ts`，走现有错误信封与审计，经 barrel 导出；遵守 `$backend-module-standards`。
6. 新增 `server/**/*.test.ts` 会让 `quay-test-script` 的文件数 pin 变红：同步更新 `scripts/test.sh` 与 `server/shared/tests/quay-test-script.test.ts` 里的 known/unknown 计数。

## AC

- [ ] `node --import tsx --test server/modules/mcp-gateway/tests/mcp-ui-last-opened.test.ts` 退出码 0：断言工具返回会话摘要加 `openedAt`；库里无记录时返回 `NOT_FOUND` 类错误码且结构化内容不含 `lastActivity` 回退；MCP 令牌调用 `session_read` 后表内容不变。
- [ ] 同一测试文件断言：浏览器路径（所选信号）会 upsert，重复打开同一会话只更新 `opened_at`，打开另一个会话后工具返回后者。
- [ ] `grep -n "ui_last_opened_session" server/modules/mcp-gateway/mcp-tool-annotations.ts server/modules/mcp-gateway/mcp-tool-error-codes.ts server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 三个文件均有命中，且已有的 `mcp-tool-annotations.test.ts`、`mcp-error-vocabulary.test.ts` 逐文件运行退出码 0。
- [ ] `npm run typecheck` 退出码 0；`bash scripts/with-memory-cap.sh` 下运行 `server/shared/tests/quay-test-script.test.ts` 退出码 0（计数 pin 已同步）。
- [ ] 本任务 Finding 段记录了预取核对结论（有或无预取，选定的信号是什么），且该结论与测试选用的信号一致。

## DoD

在真实运行的服务上实际操作一次：用浏览器打开某个会话，再用 PAT 经 `/mcp` 调用 `ui_last_opened_session`，返回的就是该会话及其 `openedAt`；随后用 PAT 调用 `session_read` 读另一个会话，再次调用结果不变。仅有测试夹具通过不算完成。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/ui-last-opened.db.ts
- server/modules/database/index.ts
- server/modules/providers/provider.routes.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/mcp-gateway/mcp-ui-tools.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/index.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-ui-last-opened.test.ts
- scripts/test.sh
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-mcp-ui-last-opened-session.md
