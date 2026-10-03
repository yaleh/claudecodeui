---
id: transcript-global-scrollbar-track
title: AC-214 自绘全局滚动条：滑块位置 = 整段历史中的消息序号位置，可拖动、可点击、可键盘操作，拖动只对最终位置取页
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - transcript-turn-rail-and-jump
goal_ac: AC-214
---
## Proposal

现状：转录区只有原生滚动条，它反映的是「已加载那一段」的像素位置。拖到顶并不意味着到了会话开头；已加载窗口在前插时滑块还会因行高被测量而抖动。人 yale 裁定（2026-10-04）：滚动条走自绘轨道，按消息序号（不是像素）计位置。

要做的事：在轮次导航轨道（前置任务交付的 TranscriptTurnRail）上叠加滚动条语义——一个滑块，位置比例 p = (窗口首行的绝对序号 + 窗口内当前首行的偏移序号) / total，只依赖 store 窗口模型的 startIndex 与行的序号，不读 scrollTop/scrollHeight 的像素比，所以前插与行高修正都不会让它抖。交互：(1) 拖动：拖动期间只更新滑块与预览气泡（含该处轮次摘要与时间，摘要来自大纲，不发请求），松手并停顿后才对最终位置发起一次取页（`loadWindowAround`），拖动期间取页请求数 ≤1；(2) 点击轨道空白处跳到该位置；(3) 键盘：滑块是 role="scrollbar" 的可聚焦元素，带 aria-valuenow/min/max 与 aria-orientation，Home/End/PageUp/PageDown/方向键移动；(4) 触屏窄屏也可拖动（Pointer Events，touch-action 设置得当）。滑块位置按序号线性，一轮里有很长的工具输出时像素上会显得走得慢，这是已裁定的取舍。拖动与滚动写入必须走 `writeScrollTop` 通道，不得直接写 container.scrollTop。

不在本任务内：隐藏原生滚动条（下一任务）。本任务完成后两条滚动条会并存。

## Plan

1. 先写判据文件 `e2e/transcript-global-scrollbar.spec.ts` 的 AC-214 用例（共用种子 `e2e-transcript-jump`，读滑块几何、网络层取页计数、键盘与点击）。先看它红。
2. 在 useTurnNavigation 中加入 p 的计算与拖动状态机；TranscriptTurnRail 渲染滑块、预览气泡与 ARIA。
3. 补 i18n 键（滚动条与预览的 aria 文案）。

## AC

- [ ] AC1 判据绿：`npx playwright test e2e/transcript-global-scrollbar.spec.ts -g "AC-214"` 退出 0。红态基线：spec 文件不存在。
- [ ] AC2 取假形态必须红（先提交再变异，逐条记录 diff、逐字失败行与恢复命令）：(a) p 取自 scrollTop/scrollHeight ⇒ 跳转后位置断言红；(b) 拖动时每个 pointermove 都取页 ⇒ 取页计数断言红；(c) 窗口前插时 p 随已加载行数变化 ⇒ 单调性断言红。
- [ ] AC3 既有行为不回退：`npx playwright test e2e/transcript-follow.spec.ts` 与 `e2e/transcript-jump-to-turn.spec.ts` 保持绿；写下读数。
- [ ] AC4 i18n 完整（全语言 chat.json 含新键）。
- [ ] AC5 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

- 滑块位置来自序号而非像素，判据里有「窗口还在尾部而 p≈0.10」的读数。
- 拖动期间零中间位置取页。
- 滑块可被读屏识别为 scrollbar 并可键盘操作。
- 遵守 `frontend-module-standards`；只动 `## Touches` 列出的文件。

## Touches

- src/modules/chat/transcript/TranscriptTurnRail.tsx
- src/modules/chat/hooks/useTurnNavigation.ts
- src/modules/chat/hooks/useChatSessionState.ts
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
- e2e/transcript-global-scrollbar.spec.ts (new)
- tasks/transcript-global-scrollbar-track.md
