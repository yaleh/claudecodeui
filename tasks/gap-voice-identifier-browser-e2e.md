---
id: gap-voice-identifier-browser-e2e
title: 真实浏览器里经语音按钮的修复端到端判据
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-identifier-repair-module
  - gap-voice-identifier-fidelity-metric
goal_ac: AC-115
---
## Proposal

<!-- dedup-ref --> 本任务落地 GOAL-005 的浏览器端到端判据（AC-115）：用假麦克风注入一段含 `voice.service.ts` 的音频，经真实语音按钮完成一次录制→转写→填回，断言 composer 中该标识符逐字等于项目真实文件名（大小写与点号一致）。

### 现状与缺口

`e2e/voice-identifier-repair.spec.ts` 不存在，playwright 报 No tests found（红先行）。前端语音链路是 push-to-talk：一次按键 = 一段录音 = 一次请求（`useVoiceInput.ts` → `transcribeVoice()` → composer），今日无任何浏览器级判据覆盖标识符还原。

### 方案

1. `e2e/voice-identifier-repair.spec.ts`：chromium launch args 加 `--use-file-for-fake-audio-capture`，注入含 `voice.service.ts` 的音频；经真实语音按钮完成录制→转写→填回；断言 composer 文本中的该标识符逐字等于项目真实文件名。⛔ 不得 stub 后端、不得用 evaluate 改 store 冒充转写。
2. `playwright.config.ts`：承接假麦克风与语音配置的种入。已知陷阱（必须写进实现）：该文件被 worker 重新求值，夹具须在服务器启动前播种；语音配置须走 `uiPreferences` / `user-preferences` 镜像 + legacy `voiceConfig` 双写。

### 边界（不做）

不做单元测试冒充浏览器判据（取假形态）；不改语音交互；不改 `server/modules/voice/` 的接口契约；不做时间轴压缩与 prompt 偏置。

## AC

- [ ] `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` 退出码 0
- [ ] 用假麦克风（chromium `--use-file-for-fake-audio-capture`）注入含 `voice.service.ts` 的音频，经真实语音按钮完成录制→转写→填回
- [ ] 断言 composer 中的该标识符逐字等于项目真实文件名（大小写与点号一致）
- [ ] 未 stub 后端、未用 evaluate 改 store 冒充转写
- [ ] `playwright.config.ts` 的夹具在服务器启动前播种，且 worker 重新求值安全
- [ ] 语音配置走 `uiPreferences` / `user-preferences` 镜像 + legacy `voiceConfig` 双写
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是 spec 文件存在，而是真实 Chromium 打真实 vite + 后端，经真实语音按钮走完录制→转写→填回，且填回的标识符逐字等于项目真实文件名。承重性由取假形态证明：只做单元测试而不经浏览器 → 本条红；把断言放宽成模糊匹配 → 也须红。夹具播种必须证明「在服务器启动前」这一时序（worker 会重新求值 config，晚播种会随机红）。

L_D 该轴仍暗，理由：本任务只加一条浏览器端到端判据并接入既有语音链路，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是浏览器 composer 文本与真实文件名的逐字相等，不是生成质量轴读数。

## Touches

- e2e/voice-identifier-repair.spec.ts
- playwright.config.ts
- tasks/gap-voice-identifier-browser-e2e.md
