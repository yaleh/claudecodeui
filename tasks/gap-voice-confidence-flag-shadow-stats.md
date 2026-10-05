---
id: gap-voice-confidence-flag-shadow-stats
title: 置信度标记的影子统计：按 θ 扫描「本来会画几条下划线」，写进语音数据记录（纯函数，与离线实验口径逐条一致，不出任何 UI）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-asr-token-confidence-contract
  - gap-voice-data-local-store-default-on
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on`）：`grep -il '影子\|shadow\|下划线' tasks/*.md | xargs grep -il voice` 无同机制任务。来源：`docs/proposals/voice-correction-feedback-loop.md` 阶段 0（「影子统计『本来会画几条下划线』『θ 不同时的标记数 / 100 字符』」）与 §5.9「置信度」；口径依据 `experiments/voice-index-loop/RESULT-v6.md` 的 R1。

### 目标

下划线 UI 还没有，但它会不会满屏噪声要在**做 UI 之前**知道。本任务把「按置信度会画几条下划线」作为**纯函数**实现，并在每次转写时把统计写进语音数据记录（`flagStats`）；**不出任何界面、不改任何识别结果**。

### 方案

1. **纯函数** `shared/asr/confidenceFlags.ts`：`flagStats(text, tokens, thetas = [0.5, 0.6, 0.7, 0.8]) → { chars, byTheta: Array<{ theta, flags, flagsLatin, flagsPer100Chars, flagsLatinPer100Chars }> }`。**口径与离线实验逐条一致**（`experiments/voice-index-loop/sim/sv-eval2.mjs`）：一个「标记」= 连续的置信度 `< θ` 的 token 构成的一段（相邻的低置信 token 合并成一个标记）；`flagsLatin` = 只计该段文字里含拉丁字母或数字的标记；每个 token 在文字里的字符区间按「token 文本把 `▁` 当空格、整串去掉前导空白」累加得到。
2. **写入**：转写成功且 `voiceDataRecording` 开启时，把 `flagStats` 写进该次记录（用 `gap-voice-data-local-store-default-on` 预留的 `flagStats?` 字段）；识别器没有声明 `tokens.confidence`（现有三个远程识别器）时**不写**该字段，也不报错。
3. 前后端共用：`shared/asr/` 下纯函数、无 DOM、无 Node 内建，将来下划线 UI 与离线报告脚本直接复用。

### 边界（不做）

不画下划线、不弹提示；不做候选生成；不改 `voiceDebug` 以外的任何日志；不依赖任何未声明置信度的识别器。

## AC

- [ ] `npx vitest run src/shared/asr/tests/confidenceFlags.test.ts` 退出码 0，已知答案用例至少含：①全部高置信 ⇒ 0 个标记 ②相邻两个低置信 token 合并成 1 个标记 ③两处分开的低置信 ⇒ 2 个 ④只有中文字符的低置信段：`flags` 计入而 `flagsLatin` 不计 ⑤`θ` 增大时标记数单调不减 ⑥空文本与空 tokens ⇒ 全零且不抛
- [ ] 与离线口径逐条一致：用 `experiments/voice-index-loop/sim/sv-eval2.mjs` 里同一段「token 区间与标记」逻辑，对 ≥ 5 条由**非私人合成句子**得到的 token 序列（fixture 入库，来源是 `experiments/voice-context-asr` 的合成句，不含用户消息原文）逐 θ 比较标记数，两边完全相等（测试里同时调用两份实现）
- [ ] 能红的负对照：把「相邻合并」改成「每个低置信 token 单独成标记」的变体，用例②必须变红
- [ ] 写入：对一个声明了 `tokens.confidence` 的假识别器转写一次，对应记录里有 `flagStats` 且 `byTheta.length === 4`；对未声明的现有识别器转写一次，记录里**没有** `flagStats` 字段且请求成功（服务端测试）
- [ ] MCP 浏览器验证：用 playwright MCP 打开 `http://localhost:3001/`，用 `?voiceDebug=1` 的上传入口转写一个 wav（识别器选 `sensevoice-local`）；读取 `~/.cloudcli/voice-data/` 下对应记录的 `flagStats`，把四个 θ 的 `flagsPer100Chars` 记入 `## Evidence`
- [ ] `npm run typecheck`、`npm run lint`、`npm run build` 退出码 0

## DoD

真实落地判据：**真实的 SenseVoice 转写**产生真实的 `flagStats`，且与离线脚本在同一输入上逐 θ 相等——线上采到的统计和实验里读到的统计是**同一把尺**。没有声明置信度的识别器不受影响。

L_D 该轴有读数：新增的是每次转写的标记统计，由真实记录给出。

L_G 该轴有读数：不同 θ 下每 100 字符的标记数，是下划线 UI 噪声预算的直接读数（实验里 θ = 0.5 为 2.3、θ = 0.6 为 3.9）。

## Touches

- shared/asr/confidenceFlags.ts (new)
- src/shared/asr/tests/confidenceFlags.test.ts (new)
- src/shared/asr/tests/fixtures/confidence-flags-tokens.json (new)
- server/modules/voice/voice-data.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-data.test.ts
- tasks/gap-voice-confidence-flag-shadow-stats.md
