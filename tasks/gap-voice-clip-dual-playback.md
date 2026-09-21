---
id: gap-voice-clip-dual-playback
title: 录音槽两条回放：原始与裁剪后并存
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-debug-switch
goal_ac: AC-122
---
## Proposal

<!-- dedup-ref --> 本任务落地 AC-122：录音槽同时提供**原始录音**与**裁剪后音频**两条回放，人能核对「剪掉了什么」。

### 现状与缺口

录音槽今天只保留最后一条录音（`useVoiceInput` 的 `voiceClip` + `VoiceClipButton` 的 pill），且上传的就是这一条。接入裁剪后，上传体与录音槽里的不再是同一份音频 —— 若回放只给一条，人就无法判断裁剪是否剪掉了不该剪的东西（说话人自己听不出来，指标也只覆盖了转写文本）。人 yale 2026-09-21 定：**两种都提供**。

### 方案

1. `src/modules/chat/hooks/useVoiceInput.ts`：录音槽同时持有两条 clip —— `original`（原始 blob 的 object URL）与 `trimmed`（裁剪后重编码的 object URL，即实际上传的那份）；两者各自可播，任一时刻最多一条在播（第二条开始时第一条停）。`fallback === true` 时裁剪那份不存在（或等于原始），UI 要如实反映，不得造一条假的。scope/isActive 的既有规则（换会话清空、离屏停播）对两条同样生效。
2. `src/modules/chat/composer/VoiceClipButton.tsx`：两个回放控件，accessible name 稳定可辨（例如 `Replay original` / `Replay trimmed`）；文案不得只靠翻译键而无可断言的名字（参照 `tabs.git` 的教训：可访问名是翻译后的标签，e2e 不能凭直觉猜）。
3. `src/modules/chat/composer/ChatComposer.tsx`：把两条 clip 传到按钮。
4. `e2e/voice-trim.spec.ts`：一次真实录音后断言两个控件都存在、指向不同的音频源、裁剪那条的字节数与时长严格更小、且第二条开始时第一条停；回放不改变 composer 文本。

### 边界（不做）

不做持久化、不做波形图、不做逐段试听；不改变既有「换会话清空 / 离屏停播」语义；不让回放影响上传体（上传永远用裁剪后那份）。

## AC

- [ ] `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 退出码 0
- [ ] 录音完成后同时存在两个回放控件，accessible name 稳定可辨
- [ ] 两者指向不同的音频源（不同 object URL / 不同字节）
- [ ] 裁剪那条的字节数与时长严格小于原始那条
- [ ] 任一时刻最多一条在播（第二条开始时第一条停）
- [ ] 回放不改变 composer 文本
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是多了一个按钮，而是**同一个录音槽里两条真实音频并存且可判别**（不同源、裁剪那条更短、不混播）。承重性由取假形态证明：只留一个控件必须使第一条断言红；两个控件指向同一个 object URL 必须使「不同源」与「更短」两条红；两条同时出声必须使「最多一条在播」红。`fallback` 情况下不得伪造一条裁剪回放。

L_D 该轴仍暗，理由：本任务只让录音槽多保留一条派生音频并提供回放，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是两条回放的存在性、时长与互斥性，不是生成质量轴读数。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/VoiceClipButton.tsx
- src/modules/chat/composer/ChatComposer.tsx
- e2e/voice-trim.spec.ts
- tasks/gap-voice-clip-dual-playback.md
