---
id: gap-mcp-ui-visible-context-null-range-in-real-browser
title: ui_visible_context 在真实浏览器里 visibleMessages 恒为
  {first:null,last:null}、panel 为 null：定位成因并修到返回真实可见消息范围与当前面板
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**Finding（2026-10-07，对运行中的服务做真实调用）：** 用 PAT 经 `/mcp` 调 `ui_visible_context`，设备是 Chrome · Android，正停在一个有大量消息的会话上，返回的该标签页是 `visibleMessages: {first: null, last: null}`、`panel: null`，而 `selectedProject`、`selectedSession`、`visibility`、`hasFocus`、`navigationPolicy` 都正确。`gap-mcp-ui-visible-context` 的 AC 全部勾选，DoD 也写着「返回的设备含该会话的 id 与可见消息 id 范围」，但范围这一项在真实浏览器里没有出现。单元测试通过是因为它在 jsdom 里用了手工构造的 DOM。

**现状（已读代码核实）：**

- 应答在 `src/modules/chat/hooks/useUiStateResponder.ts`：`readVisibleMessages()` 遍历 `document.querySelectorAll('[data-message-anchor-id]')`，用 `getBoundingClientRect()` 与滚动容器的裁剪矩形判断可见，取文档顺序里第一个与最后一个可见行的 id；`readActivePanel()` 读 `[data-workspace-tab][aria-current="true"]` 的 `data-workspace-tab`。
- `data-message-anchor-id` 由 `src/modules/chat/transcript/LazyMessageRow.tsx:136` 的持久包装元素产生，只有 `anchorId` 非空时才有该属性；该文件头注释说明行是懒加载的（挂载时可能为空的占位）。
- **成因尚未确定，以下只是候选，实现第一步必须用真实浏览器复现并证伪其余：** (a) 当前可见的行没有 `anchorId`，所以没有该属性；(b) 行存在但 `rowIsVisible` 的几何判断在手机布局里失败（滚动容器是 `scrollClipOf` 没找到的元素，或被判为不相交）；(c) 响应时机取到的是尚未挂载内容的占位行；(d) `panel` 为 null 可能是手机布局根本不渲染 `data-workspace-tab`，此时 null 是合法值，不应当当作缺陷。

**要交付：**

1. 先在真实浏览器里复现（至少一个手机视口与一个桌面视口），逐个排查候选成因，把结论补记在本 Proposal 末尾的「成因」小节。
2. 修复 `readVisibleMessages`，使在会话有可见消息时返回真实的首尾消息 id（这些 id 必须能被 `session_read mode=around` 的 `around` 参数解析）；空会话或确无可见行时仍返回 `{first:null,last:null}`。
3. `panel`：若手机布局确实没有可读的面板标识，则按成因结论给出稳定的取值（例如手机布局上报当前视图名），或在返回里明确该字段对该布局不适用；不允许让「没有面板」和「读取失败」都表现为同一个 `null`。
4. 为防回归，补一条真实浏览器的 e2e：在手机与桌面两种视口下，经真实服务发出 `ui.state_request`，断言应答的范围非空且 id 命中页面上实际可见的消息行。
5. 不新增 `server/**/*.test.ts` 文件（避免触动 quay-test-script 的文件数 pin）；前端回归写进已有的 `src/modules/chat/tests/uiStateResponder.test.tsx`，e2e 放在 `e2e/` 下。

## AC

- [ ] 本 Proposal 末尾有「成因」小节，写明候选 (a)-(d) 各自被证实或证伪的依据，且其结论与修复一致。
- [ ] `npx vitest run src/modules/chat/tests/uiStateResponder.test.tsx` 退出码 0，且新增的用例使用与真实转录一致的结构（经 `LazyMessageRow` 渲染的行，而不是手工拼的 `div`），断言返回的首尾 id 非空且等于视口内第一个与最后一个行的 `data-message-anchor-id`。
- [ ] `npx playwright test e2e/ui-visible-context-range.spec.ts` 退出码 0：在手机视口与桌面视口各跑一遍，应答的 `visibleMessages.first` 与 `.last` 非空，且这两个 id 在页面上对应的行确实在视口内。
- [ ] 同一 e2e 的负控：把 `readVisibleMessages` 临时改回返回恒 null 的实现，该用例必须变红（在报告里写明红的断言行）。
- [ ] `panel` 在手机与桌面两种视口下的取值与成因结论一致，且「无面板」与「读取失败」不再是同一个值。
- [ ] `npm run typecheck` 退出码 0；`npx oxlint src/modules/chat` 退出码 0。

## DoD

在真实运行的服务上实际操作一次：浏览器打开一个有多页消息的会话并滚到中间，用 PAT 经 `/mcp` 调 `ui_visible_context`，返回的 `visibleMessages.first/last` 是你屏幕上第一条和最后一条可见消息的 id，并且用其中一个 id 调 `session_read mode=around` 能读到对应消息；再用手机视口重复一次。仅有测试夹具通过不算完成。

## Touches

- src/modules/chat/hooks/useUiStateResponder.ts
- src/modules/chat/transcript/LazyMessageRow.tsx
- src/modules/chat/tests/uiStateResponder.test.tsx
- e2e/ui-visible-context-range.spec.ts
- tasks/gap-mcp-ui-visible-context-null-range-in-real-browser.md
