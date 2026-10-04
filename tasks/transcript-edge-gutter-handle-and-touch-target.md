---
id: transcript-edge-gutter-handle-and-touch-target
title: AC-220
  右侧留白按显示的东西来留（手机像原生滚动条占一列、平板不收窄、宽屏用外侧边距），把手在任何视口固定在导出按钮下方且位置不被改写，滚动条触摸热区够大
status: ready
labels:
  - gap
  - priority:p1
  - delivery-critical
parent: null
children: []
extra:
  deliveryCriticalSource: adhoc
depends_on:
  - transcript-scrollbar-native-length-and-pixel-position
goal_ac: AC-220
---
## Proposal

人 yale 2026-10-04 的裁定：把手在手机上也固定在导出按钮下方；手机右侧留白与原生滚动条旁的排版一致（留出滚动条列宽度，文字紧贴其左边）；平板宽度下刻度不收窄；起草 AC 与任务，优先。

现状读数（2026-10-04，:3001 当前版本，61 轮 / 536 条真实会话，视口 390×844 与 820×1100，只读；读 `src/index.css:584`、`QuickSettingsHandle.tsx`、`useQuickSettingsDrag.ts`、`TranscriptScrollbar.tsx`）：

1. **右侧留白固定 72px。** `.chat-messages-pane { padding-right: 4.5rem }` 不分视口，手机上刻度列 `display:none` 仍预留：内容列 318px，消息 286px，文字 262px，只占屏宽的 67%，右侧只有一条 12px 的滚动条轨道。平板上右侧 88px 空着。
2. **把手位置。** 手机上（以 `bottom` 百分比定位，默认 50%）停在 y=384–422 的视口中段，右边缘贴着轨道左边缘；平板上被夹在刻度列顶部正上方 8px 处，距导出按钮约 200 多像素，不是「导出按钮下方」。
3. **把手位置被改写。** 视口 390→820→390 往返后 `localStorage.quickSettingsHandlePosition` 由 50→29.8→50：夹取后的值被写回，用户自己拖过的位置会在换视口时丢。
4. **触摸目标太小。** 滚动条在滑块垂直中线上命中检测，能抓到滑块的只有 8px（连轨道 12px），轨道紧贴屏幕右缘（缩进 4px）；Android 的系统返回手势占屏幕两侧边缘，可能冲突（未在设备上验证）。

要做的事：

**A. 右侧留白按显示的东西来留（纯函数，便于单测）。** 新增 `src/shared/transcriptEdgeLayout.ts` 里的 `transcriptGutterPx(paneWidthPx, hasTickColumn)`（与现有常量同处，不新建文件）并在 `ChatMessagesPane` 用内联样式 / CSS 自定义属性设置 `padding-right`，删除 `index.css` 里写死的 `4.5rem`：
- 手机（刻度列不渲染，视口 <768）：`padding-right` = 滚动条列占用宽度（轨道 12px + 缩进 4px = 16px），文字边缘紧贴滚动条列左边，像原生滚动条那样占自己的一列；消息列宽目标约 342px（现状 286px）。
- 平板（刻度列渲染且空边距不足）：保持现有 72px，**刻度列不收窄**（宽 16px、间距 30px 与 AC-217 一致）。
- 宽屏（内容列 `max-w-[54.25rem]` 两侧的空边距 ≥72px）：`padding-right` = `max(0, 72 − 空边距)`，通常为 0；刻度列与滚动条落在内容列外侧的空边距里，文字列宽与无刻度时相同。
注意：`.chat-messages-pane` 有 `contain: layout style paint`，滚动条与刻度列是它的兄弟绝对定位元素（`TranscriptTurnRail`），不要把它们放进 pane 里改变其含义；宽屏用「pane 宽度 − 内容列实际宽度」算空边距，随 `ResizeObserver` 更新（jsdom 无该 API 时按已有守卫处理）。

**B. 把手在任何视口固定在导出按钮下方。**
- 默认位置 = 导出按钮包围盒底 + 8px（`TRANSCRIPT_HANDLE_BAND_MARGIN_PX`），手机、平板、宽屏一致；手机不再用 `bottom` 百分比，改用与桌面相同的基于顶部的定位（现有按移动端分支设置 `bottom` 的逻辑删除）。
- 允许的带 = [导出按钮底 + 8px, 刻度列顶 − 8px − 把手高]；手机没有刻度列时带的下沿 = 视口高度的某个上限（例如导出按钮底 + 24px 之外不得再往下，使把手始终贴着导出按钮下方；若要允许用户拖更低，上限取输入区顶部 − 把手高，由实现者裁定并写入证据）。把手右边缘 ≤ 滚动条触摸热区左边缘 − 4px。
- **用户位置只在渲染时夹取，不写回存储。** `readHandlePosition` 之后的夹取只影响渲染；只有用户真实拖动并松手才写 `localStorage`；视口往返后存储值不变。拖出带外松手时位置被夹回带内，写入的是被夹回后的值。
- 与现有 `publishTranscriptEdgeBand` / `readTranscriptEdgeBand` 通信，不得让 `quick-settings-panel` 与 `chat` 互相深入导入。

**C. 滚动条触摸热区。** 在粗指针（`(pointer: coarse)`）上，滑块的可抓取区加宽到 ≥32px、高 ≥44px，视觉仍是 8px 宽的滑块；热区向内容一侧（左）扩展，贴屏幕右缘的 8px 内不作为唯一抓取区（避开系统边缘手势）；热区不得与把手包围盒相交。细指针（鼠标）保持现有 12px 的抓取区。

不在本任务内：点击落点与行占位（AC-221，另一任务）、长度与位置的像素估算（AC-219，在前置任务）。

## Plan

1. 先写判据：新建 `e2e/transcript-edge-layout.spec.ts`（用例标题含 `AC-220`，用种子 `e2e-transcript-jump`，视口 390×844、820×1100、1440×900；触摸用 `hasTouch` 的上下文与 `page.touchscreen`），按 AC-220 的 (a)–(g) 读数；若 `e2e/transcript-rail-geometry.spec.ts` 里 AC-217 v2 对把手默认位置/写回存储的断言与新规则冲突，只改冲突的断言（不放宽其余）。先看 AC-220 红。
2. 纯函数与单测：`transcriptGutterPx` 与 `src/modules/chat/tests/transcriptGutter.test.ts (new)`（手机 / 平板 / 宽屏三档与边界宽度 767/768、空边距恰为 72px）；把手的「默认位置、带、夹取不写回」纯函数与 `src/modules/quick-settings-panel/tests/quickSettingsHandleBand.test.ts` 的更新。
3. 实现 A、B、C；`index.css` 删除写死的 padding-right；`ChatMessagesPane` 设置内联 padding 并给导出按钮容器保持现有定位锚点。
4. 跑守卫：AC-220、AC-217 v2、AC-214 v3、AC-218、AC-219、AC-213 v2、AC-215、AC-216、`transcript-follow` 全部绿；把手机 / 平板 / 宽屏三种视口改动前后的读数（padding-right、消息列宽、把手位置、热区尺寸）并排写进证据，并附手机与平板截图。

## AC

- [ ] AC1 判据绿：`npx playwright test e2e/transcript-edge-layout.spec.ts -g "AC-220"` 退出 0。红态基线：spec 文件不存在，playwright 报 No tests found。
- [ ] AC2 既有守卫不回退，逐字写下各自读数：AC-217 v2（`e2e/transcript-rail-geometry.spec.ts -g "AC-217 v2"`）、AC-214 v3、AC-218、AC-219、AC-213 v2、AC-215、AC-216、`e2e/transcript-follow.spec.ts` 均退出 0。
- [ ] AC3 取假形态必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(a) `padding-right` 恢复 4.5rem ⇒ AC-220 (a)(c) 红；(b) 手机不渲染刻度但仍预留 72px ⇒ AC-220 (a) 红；(c) 把手恢复 `right-0` 与 50% 默认 ⇒ AC-220 (d) 红；(d) 夹取后把值写回 localStorage ⇒ AC-220 (e) 红；(e) 热区仍为 8px ⇒ AC-220 (g) 红；(f) 平板把刻度列收窄 ⇒ AC-220 (b) 红。
- [ ] AC4 单测绿：`npx vitest run src/modules/chat/tests/transcriptGutter.test.ts src/modules/quick-settings-panel/tests/quickSettingsHandleBand.test.ts` 退出 0，并含 Plan 第 2 步列的全部用例；其余 chat 与 quick-settings 客户端测试保持绿（写下运行的文件清单）。
- [ ] AC5 手机与平板截图写进证据：文字列宽、把手位置、滚动条一列的样子，与改动前并排。
- [ ] AC6 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 读数全部来自我们自绘的元素与几何 / 计算样式，不读原生滚动条布局（e2e 里 Playwright 带 `--hide-scrollbars`）；不放宽阈值。
- 手机：padding-right 约 16px，文字紧贴滚动条列左边，消息列宽 ≥ 视口宽 85%；平板：72px 且刻度列不收窄；宽屏：padding-right ≤8px。
- 把手在三种视口（含手机）默认都在导出按钮下方，且与导出按钮、刻度列、滚动条热区两两不相交；localStorage 的值只被用户拖动改写。
- 触摸热区 ≥32×44px，向内容一侧扩展；细指针行为不变。
- 模块边界：`quick-settings-panel` 与 `chat` 之间无互相导入，只经 `src/shared`；新增测试文件对其他模块只经其 barrel 导入（oxlint `boundaries/dependencies`）；遵守 `frontend-module-standards`；若实现被迫写 `## Touches` 之外的文件，先用 task_write 把它加进 Touches 再写。

## Touches

- src/index.css
- src/shared/transcriptEdgeLayout.ts
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/TranscriptTurnRail.tsx
- src/modules/chat/transcript/TranscriptScrollbar.tsx
- src/modules/quick-settings-panel/QuickSettingsHandle.tsx
- src/modules/quick-settings-panel/QuickSettingsPanelView.tsx
- src/modules/quick-settings-panel/hooks/useQuickSettingsDrag.ts
- src/modules/chat/tests/transcriptGutter.test.ts (new)
- src/modules/quick-settings-panel/tests/quickSettingsHandleBand.test.ts
- e2e/transcript-edge-layout.spec.ts (new)
- e2e/transcript-rail-geometry.spec.ts
- tasks/transcript-edge-gutter-handle-and-touch-target.md
