---
id: gap-mcp-ui-navigate-frontend
title: 前端执行 ui.navigate：按本设备策略（接受/询问/拒绝）分流，确认提示条（跳转/忽略/总是接受/总是拒绝），导航到会话并定位消息，回
  ack 与最终结果
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mcp-ui-device-settings
  - gap-mcp-ui-device-identity-hello
---
## Proposal

**背景（2026-10-07 与 yale 的讨论）：** `ui_open_session` 让外部 agent 在**指定设备**的浏览器里打开某个会话、翻到固定位置。策略与确认都在前端，每台设备各自决定。本任务交付前端半边：收到服务端的 `ui.navigate` 帧后，按本设备策略分流并执行；服务端半边在 `gap-mcp-ui-open-session`。

**已定的行为：**

- 策略（来自 `gap-mcp-ui-device-settings` 的 `readMcpNavigationPolicy()`，默认 `ask`）：
  - `reject`：不显示任何界面，直接回 ack `declined`（原因 `policy`）。
  - `accept`：直接导航，回 ack `applied`。**输入框有未发送草稿时仍然保持「接受」的行为**：本项目已按会话保存草稿（见 `src/modules/chat/hooks/useChatComposerState.ts`，草稿随会话持久化），跳转不会丢失草稿，所以不降级。
  - `ask`：显示非阻塞的确认提示条，先回 ack `shown`；用户操作后再发最终结果帧。
- 提示条内容：请求方客户端名、目标会话标题、定位说明（例如「第 N 条消息附近」或「最新」）；按钮：**跳转**、**忽略**、**总是接受**、**总是拒绝**。「总是接受 / 总是拒绝」点击时写回本设备策略（`useMcpNavigationSettings`），并在按钮旁明示「会修改设置」；其效果是本次请求立即按新策略处理（总是接受 = 本次跳转；总是拒绝 = 本次忽略）。
- 提示条 30 秒无操作自动失效，视为 `ignored`；新请求到来时旧提示条立刻失效，视为 `superseded`；同一时刻只保留一个提示条。
- 定位只支持两种：`{ latest: true }`（翻到底部，默认）与 `{ messageId }`（翻到该消息）。消息 id 不存在或无法定位时，仍打开会话，ack 带 `reason: MESSAGE_NOT_FOUND`，状态 `applied`（部分成功）。

**现状（已读代码核实）：**

- 路由 `/session/:sessionId`（`src/App.tsx`），工作区内导航在 `src/modules/project-workspace/ProjectMainRegion.tsx` 的 `navigate(\`/session/${targetSessionId}\`)`。
- 「以某条消息为中心取窗口」后端已有（`fetchWindowAround`，`/api/providers/sessions/:sessionId/messages?around=`），前端 `useSessionStore.ts`、`useChatSessionState.ts` 里有相关的窗口与滚动逻辑；**其中是否已有可直接复用的「跳到某条消息」入口尚未核实**，实现的第一步是读这两个文件并把结论写进 Proposal 的末尾补记。
- WS 入站帧在 `src/shared/context/WebSocketContext.tsx` 处理；设备身份与响应原语由 `gap-mcp-ui-device-identity-hello`、`gap-mcp-ui-visible-context` 提供。

**帧约定：**

- 服务端到前端：`{ type: 'ui.navigate', navigationId, requester, sessionId, at }`。
- 前端到服务端：`{ type: 'ui.navigate_ack', navigationId, status: 'shown' | 'applied' | 'declined', reason? }`（送达确认，服务端只等这一帧）；用户在提示条上操作后再发 `{ type: 'ui.navigate_result', navigationId, status: 'applied' | 'declined' | 'ignored' | 'superseded' | 'expired', reason? }`。

**要交付：** 新 hook `src/modules/chat/hooks/useUiNavigate.ts` 与提示条组件 `src/modules/chat/components/UiNavigatePrompt.tsx`（遵守 `$frontend-module-standards`），在 `WebSocketContext.tsx` 挂接 `ui.navigate`；新增键的 i18n 文案补全各语言（`src/modules/i18n/locales/*/chat.json` 12 种语言）。

## AC

- [ ] `npx vitest run src/modules/chat/tests/uiNavigate.test.tsx` 退出码 0：策略 `reject` 时不渲染提示条且回 `declined`/`policy`；`accept` 时直接导航并回 `applied`，且输入框有草稿时同样直接导航、草稿内容保持；`ask` 时先回 `shown` 并渲染提示条，点「跳转」后导航并发 `applied`，点「忽略」发 `ignored`。
- [ ] 同一测试文件断言：提示条 30 秒无操作发 `expired`；新请求到来时旧提示条发 `superseded` 且只剩一个提示条；点「总是接受」把本设备策略写成 `accept` 并立即跳转，点「总是拒绝」写成 `reject` 并发 `declined`。
- [ ] 同一测试文件断言：`at: { messageId }` 存在时调用定位入口，不存在时仍打开会话且 ack 带 `MESSAGE_NOT_FOUND`；`at: { latest: true }` 翻到底部。
- [ ] 12 种语言的 `chat.json` 都含提示条新增的键（逐文件 `grep` 或沿用现有 i18n 完整性测试的方式断言），`npm run typecheck` 与 `npx oxlint src/modules/chat` 退出码 0。
- [ ] Proposal 末尾已补记对 `useSessionStore.ts` / `useChatSessionState.ts` 定位入口的核对结论，且实现与该结论一致。

## DoD

在真实运行的前端里：本设备策略为「询问」时，用一个模拟的 `ui.navigate` 帧触发，提示条出现，点「跳转」后打开目标会话并滚到目标消息；点「总是接受」后再触发一次，直接跳转且无提示条；Settings 里能看到策略已变为「接受」。仅有测试通过不算完成。

## Touches

- src/modules/chat/hooks/useUiNavigate.ts
- src/modules/chat/components/UiNavigatePrompt.tsx
- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/shared/context/WebSocketContext.tsx
- src/shared/types.ts
- src/modules/chat/tests/uiNavigate.test.tsx
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- tasks/gap-mcp-ui-navigate-frontend.md
