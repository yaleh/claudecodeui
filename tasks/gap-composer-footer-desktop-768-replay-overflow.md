---
id: gap-composer-footer-desktop-768-replay-overflow
title: 桌面 768px 档含录音回放时 composer footer 横向溢出 25px（scrollWidth 470 > clientWidth
  445）：非本方案引入，前序两任务已如实标注但无人认领
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

来源：本任务是 `gap-mobile-layout-e2e-viewport-matrix` 的永久回归矩阵在取证时读出的既有缺陷；此前已由两个 `done` 任务如实标注但均未认领——`gap-mobile-voice-clip-row-below-textarea` 的 DoD 表里 768×900 双条回放行写 `false（470/445）`，其正文第 108 行把它列为「边界如实标注（不在 DoD 断言集合内）」；`gap-mobile-composer-footer-single-row-more-menu` 的同名标注又把含回放的单行性推给回放任务。两者都只证明「非本次引入」，没有任务承接修复。

现状（真浏览器读数，实现树与基线树逐字段相同）：`src/modules/chat/composer/ChatComposer.tsx` 的桌面分支把两条回放按钮（`Replay original` / `Replay trimmed`）渲染在左侧工具组 `[data-slot="prompt-input-tools"]` 内；恰在 768px 宽、且左侧已放长模型名时，footer 的 `scrollWidth 470 / clientWidth 445`，即内容横向溢出 25px，footer 会横向滚动。320/360/390/767 四个移动档与 1280 桌面档的同一读数都是 `scrollWidth === clientWidth`（0 溢出）。

目标：768px 档在含两条回放时 `footer.scrollWidth === footer.clientWidth`（0 溢出），且不改变 1280 档与四个移动档的既有读数、不改变 768 档无回放时的 footer 高度 93px 与两组控件的落位。

## Plan

范围仅前端 `src/modules/chat/composer/`。断点边界必须继续用 `md`（768px），与 `useDeviceSettings().isMobile` 一致；不得用 `sm`（640px）决定这一组控件，否则 640–767px 会出现第三种布局。候选方向（实现者自行判断，不预先钉死机制）：给左侧工具组在 768 档一个可收缩的最小宽度、或让模型按钮在该档更早截断、或允许工具组内部换行而 footer 本身不滚动。修完必须留下真浏览器读数。

## AC

- [ ] AC-1：真浏览器（Playwright，headless Chromium）在 768×900 视口、含两条回放（original + trimmed）、界面为 de 或 zh-CN、模型为长名时，读 `[data-slot="prompt-input-footer"]` 的 `scrollWidth === clientWidth`（0 溢出），并打印两个数字与 `innerWidth`。
- [ ] AC-2：同一次读数里 1280×720 与 320/360/390/767 四档的 `scrollWidth === clientWidth` 仍为 true，footer 高度分别保持 77px 与 57px，左组/右组 top 差保持 4px（移动档）与 4px（1280 档），768 档无回放时 footer 高度仍 93px。
- [ ] AC-3：失败信息必须打印实际读数（`scrollWidth`、`clientWidth`、`innerWidth`、footer 高度、工具组与右组的 `getBoundingClientRect()`），不得只断言布尔。
- [ ] AC-4：反假：把本次改动还原（`git checkout`）后同一读数必须重新变成 470/445（即判据真的钉住了这次改动），且 1280 与四移动档读数不变。
- [ ] AC-5：`npm run typecheck`、`npm run lint`、`npm run build:client` 退出码 0；相关 vitest 文件退出码 0。

## DoD

- 逐视口读数表（768 含/不含回放、1280 含/不含回放、320/360/390/767 含/不含回放），列 `innerWidth` / `scrollWidth` / `clientWidth` / 溢出量 / footer 高度 / 左组与右组 top 与 bottom / top 差。
- 整段调用（配置求值、seed、服务启动、浏览器启动）的墙钟总时长与通过/失败计数。
- AC-4 还原后变回 470/445 的那一次读数，原文贴出。
- 如实标注：headless Chromium 的视口/触摸模拟不等于真机；该档位此前两个任务已登记为既有边界，本次是首次认领修复。
- 与量化修前路径：修前读数已在本仓两处 DoD 里留档（470/445），修后必须并排给出。
- 人不介入的机械判据不设人审项；若未跑 MCP 人工复核，Evidence 必须写「未执行，理由：…」，不得留空。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/composer/PromptInput.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- tasks/gap-composer-footer-desktop-768-replay-overflow.md
