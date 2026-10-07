---
id: gap-mcp-ui-visible-context
title: MCP 只读工具 ui_visible_context：调用时服务端向已连接浏览器广播 ui.state_request 并发收集应答（1.5s
  超时），返回各窗口可见上下文的标识符与范围
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mcp-ui-last-opened-session
  - gap-mcp-ui-device-identity-hello
---
## Proposal

**目标：** 新增 MCP 只读工具 `ui_visible_context`（scope `cloudcli:read`），回答「用户此刻某台设备的窗口里能看到什么」。设计取自 2026-10-07 与 yale 的讨论：采用**拉取**而不是推送——工具被调用时服务端才向客户端要状态，没有常驻上报、没有 presence 存储、没有 TTL。设备身份来自 `gap-mcp-ui-device-identity-hello`（`deviceId` / `tabId` / 设备名），所以本任务依赖它；调用方可用可选参数 `client` 只查一台设备。

**现状（已读代码核实）：**

- 服务端不知道前端显示什么：`selectedSession` 只存在于 `src/modules/chat/ChatInterface.tsx` 的 React 状态；现有 WS 心跳（`server/modules/websocket/services/activity-heartbeat.service.ts`）是服务端发给客户端，反方向没有 UI 状态帧。
- `server/modules/websocket/services/websocket-state.service.ts` 的 `connectedClients` 是全部聊天 WS 连接的集合；`hosts-changed-broadcast.service.ts` 的 `broadcastHostsChanged` 已示范「遍历 `connectedClients`、跳过未打开的 socket、`client.send`」的广播写法。
- 服务端入站分派在 `chat-websocket.service.ts` 的 `switch (messageType)`；前端入站帧处理在 `src/shared/context/WebSocketContext.tsx`（`hosts_changed` 已在此处理）。
- 设备身份（`listUiClients()`、`ui.hello`）由 `gap-mcp-ui-device-identity-hello` 提供；本设备的导航策略与设备名由 `gap-mcp-ui-device-settings` 的 `readMcpNavigationPolicy()` / `readDeviceName()` 提供。
- 读工具表、annotations、错误码词汇、audit 与 barrel 同 `gap-mcp-ui-last-opened-session` 所述；该任务先新增 `mcp-ui-tools.ts`，本任务另建 `mcp-ui-visible-context.ts`。

**要交付：**

1. **服务端往返（新文件 `server/modules/websocket/services/ui-state-request.service.ts`，遵守 `$backend-module-standards`，经 websocket barrel 导出）：** `requestUiState({ timeoutMs = 1500, deviceId? })`：生成 `requestId`，向所有打开的、（指定了 `deviceId` 时只限该设备的）连接发送 `{ type: 'ui.state_request', requestId }`；并发收集带相同 `requestId` 的 `ui.state_response`，总超时到点即返回，已回答的进结果，未回答的标 `unresponsive`；迟到或 `requestId` 不匹配的应答丢弃，不串入下一次调用。在 `chat-websocket.service.ts` 的分派里加入 `ui.state_response`。本函数同时是 `ui_clients_list` 与 `ui_open_session` 复用的往返原语。
2. **前端应答（新 hook，遵守 `$frontend-module-standards`，在 `WebSocketContext.tsx` 挂接）：** 收到 `ui.state_request` 时当场读取并回复。内容只含标识符与范围：`deviceId`、`tabId`、`deviceName`、`navigationPolicy`（本设备当前策略）、`visibility`、`hasFocus`、`lastFocusedAt`、当前面板、选中的项目与会话、可见消息的 id 范围、待审批数、排队消息数。**不含消息正文，不含用户选中的文本，不含面板内容。**
3. **工具：** 在 `server/modules/mcp-gateway/` 新增 `mcp-ui-visible-context.ts` 并注册 `ui_visible_context { client? }`：`client` 接受 `deviceId` 或设备名子串，唯一命中才接受（多个命中列候选报错，不命中报错，沿用现有目标解析的规则与错误码词汇，不新造第二个「找不到」码）。返回 `devices[]`（每台设备带 `tabs[]`），按 `lastFocusedAt` 降序，每项带 `unresponsive` 标记；无任何设备时返回 `devices: []`，不报错。需要正文的调用方自行用 `session_read mode=around` 取，不在此重复实现。
4. **接入现有机制：** 加进读工具表、`mcp-tool-annotations.ts`（`readOnlyHint: true`、`openWorldHint: false`）、`mcp-tool-error-codes.ts`，走现有错误信封与审计，经 barrel 导出。
5. 新增 `server/**/*.test.ts` 会让 `quay-test-script` 的文件数 pin 变红：同步更新 `scripts/test.sh` 与 `server/shared/tests/quay-test-script.test.ts` 的 known/unknown 计数（与其他任务的计数更新合并时按 develop 上的最新值为准）。

## AC

- [ ] `node --import tsx --test server/modules/mcp-gateway/tests/mcp-ui-visible-context.test.ts` 退出码 0：用假的 WS 客户端断言工具广播带 `requestId` 的 `ui.state_request`，并发收集多个设备的应答，按 `lastFocusedAt` 降序返回；传 `client`（`deviceId` 或设备名子串）时只向该设备发请求。
- [ ] 同一测试文件断言：一个设备不应答时，整次调用在约 1.5s 内返回，该设备标 `unresponsive`，其余设备的结果不受影响；没有设备时返回 `devices: []`；迟到或 `requestId` 不匹配的应答被丢弃；`client` 多个命中或无命中时返回带候选或查询词的错误。
- [ ] 同一测试文件断言：应答里即使带了正文或选中文本字段，工具返回的 `structuredContent` 也不含它们（只放行白名单字段）；返回含 `deviceId`、`deviceName`、`navigationPolicy`。
- [ ] 前端单元测试 `src/modules/chat/tests/uiStateResponder.test.tsx` 退出码 0：收到 `ui.state_request` 后回复的帧含白名单字段且 `requestId` 原样回传；页面隐藏时回报 `visibility: hidden`；`navigationPolicy` 反映 localStorage 中的设置。
- [ ] `npm run typecheck` 退出码 0；已有的 `mcp-tool-annotations.test.ts`、`mcp-error-vocabulary.test.ts` 逐文件运行退出码 0；`quay-test-script.test.ts` 退出码 0。

## DoD

在真实运行的服务上实际操作一次：浏览器打开某个会话并保持可见，用 PAT 经 `/mcp` 调用 `ui_visible_context`，返回的设备含该会话的 id 与可见消息 id 范围；把标签页切到后台再调用，返回 `visibility: hidden`；用 `client` 按设备名选择该设备，只返回它；关闭浏览器再调用，返回 `devices: []`。仅有测试夹具通过不算完成。

## Touches

- server/modules/websocket/services/ui-state-request.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/index.ts
- server/shared/types.ts
- server/modules/mcp-gateway/mcp-ui-visible-context.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/index.ts
- server/index.ts
- src/shared/context/WebSocketContext.tsx
- src/shared/types.ts
- src/modules/chat/hooks/useUiStateResponder.ts
- server/modules/mcp-gateway/tests/mcp-ui-visible-context.test.ts
- src/modules/chat/tests/uiStateResponder.test.tsx
- scripts/test.sh
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-mcp-ui-visible-context.md
