---
id: gap-voice-silence-flush-and-inflight-dot
title: 连续语音：语音结束后静音 5 秒即发出（不论多短）、最小段长降到 20 秒、请求在途时麦克风红方块上加脉动点
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-live-vad-readings
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` 与人（yale）的裁定：**语音结束、静音足够久就应该触发识别，不能等累计到 30 秒语音**。接在 `gap-voice-live-segmenter`（切段器）、`gap-voice-single-continuous-input-path`（接线）之后，修的是它们留下的一个缺口：切段只看「累计语音够不够 30 秒」，没有「最早的未发语音已经等了多久」的规则，稀疏的短句要等到点停止才出字。只面向 `dashscope-omni`。

### 为什么现在可以切短

最小段长 30 秒当初的理由是成本（每个请求 407 个固定提示词 token）。用实际单价（输入 0.8、输出 2.7 元/百万 token）重算：一次 15 秒语音的请求只要 ¥0.001–0.006；一天 30 分钟语音即使切成 180 个请求，日费用也只有约 ¥0.16–1.06。**成本不是障碍，延迟才是。** omni 自身延迟实测约 15–22 秒，所以静音阈值再加 5 秒是可接受的增量。

### 方案

三层规则（切段器内，用 VAD 的**帧计数**判断，不用墙钟定时器，标签页被节流时也不失准）：

1. **静音触发（新增）**：已缓冲语音之后，静音连续达到 `DEFAULT_FLUSH_SILENCE_SEC = 5` 秒，立即发出已缓冲的语音，**不论多短**。发出的那一段不含这 5 秒静音（只带既有的尾留白）。之后继续静音不产出任何段；新的语音开始新的一段。
2. **软切（既有，调参）**：已缓冲语音 ≥ `DEFAULT_MIN_SEGMENT_SEC` 且遇到停顿 ≥ `DEFAULT_CUT_PAUSE_SEC`（2.0 秒）时发出。**`DEFAULT_MIN_SEGMENT_SEC` 由 30 降到 20。**
3. **硬切（既有）**：缓冲到 `DEFAULT_MAX_SEGMENT_SEC`（60 秒）仍无停顿则强制切。
4. 点停止仍然立即发出所有缓冲（不变）。
5. 调试覆盖项 `voiceFlushSilenceSec`（仅 `voiceDebug` 下读取，写进 `voiceDebug.ts` 已知开关），让 e2e 用短样本验证。
6. **在途指示（最小的界面反馈）**：监听中只要有任一请求在途，麦克风按钮上的红色方块旁加一个**小的脉动点**；没有请求在途时不显示；不新增任何控件、文案或语言包键。`VoiceInputButton` 新增一个可选布尔属性 `inFlight`，由 hook 的在途请求数导出。脉动动画用 `motion-safe:` 前缀，尊重「减少动态效果」设置。

### 边界（不做）

不改 `cutPauseSec`、`maxSegmentSec`；不处理 Groq；不新增控件、分段条或摘要；`flushSilenceSec` 的 5 秒是**临时默认值**，由 `gap-voice-pause-split-selfcorrect-eval` 的实验结果最终确定。

## AC

- [ ] `npm run test:client -- src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts src/modules/chat/tests/voiceInputButton.test.tsx` 退出码 0
- [ ] 静音触发时刻：一句 2 秒的语音后接静音，段在**语音结束后第 5.0 秒**（± 1 帧）发出；静音只有 4.9 秒时**不**发出（用 ≥100 个固定种子的随机语音长度验证）
- [ ] 发出之后：继续静音（再 60 秒）不产出任何新段，也不抛异常；随后到来的新语音形成序号加一的新段
- [ ] 稀疏输入：`corpus/long/L3-sparse`（8 句，间隔 15–45 秒）恰好切出 8 段，每段对应一句，发出延迟（从该句语音结束起算）≤ 5 秒 + 1 帧
- [ ] 停顿 < 5 秒不触发：句间停顿都 < 5 秒、累计语音 < 20 秒的时间线（harness 生成，≥100 条）恰好 1 段，speechKeptRatio ≥ 0.99
- [ ] 过滤与既有不变量仍成立：段内静音压到 ≤ 1.0 秒、分块不变（按 1、160、320、4800 个样本分块喂入产出相同）、`L4-nonstop` 全部是强制切且每段 ≤ 60 秒
- [ ] 默认值：`grep -rnE "^export const (DEFAULT_FLUSH_SILENCE_SEC|DEFAULT_MIN_SEGMENT_SEC) =" src/modules/chat/utils/voiceLiveSegmenter.ts` 输出两行，值分别为 5 与 20，且各只定义一处
- [ ] `node experiments/voice-vad/run.mjs --detector=live-segmenter --offline` 退出码 0，快照 `fixtures/live-segmenter.json` 已按新默认值重新生成
- [ ] `npx playwright test e2e/voice-continuous.spec.ts e2e/voice-live-vad-ab.spec.ts` 退出码 0（假 provider，零费用），且包含下列各项
- [ ] 不点停止也出字：说一句话后静音超过 `voiceFlushSilenceSec`，**尚未点停止**时请求数为 1，文字已进入输入框
- [ ] 静音 < 阈值再开口：同一句话中间停顿短于阈值，请求数为 1
- [ ] 在途指示：假 provider 把响应压住时，麦克风按钮内存在 `data-testid="voice-inflight-dot"`；响应返回后消失；没有请求在途时不存在；停止收尾后（状态为 transcribing）不显示该点
- [ ] 界面不增加控件：composer 内按钮数量与 `data-testid` 集合，除麦克风按钮内部的这个点外，与改动前相同
- [ ] 取假形态（各自必须变红）：删掉静音触发 → 「不点停止也出字」红；圆点常驻 → 「没有请求在途时不存在」红；把 `motion-safe:` 去掉 → 渲染测试的类名断言红
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：在真实页面里，用假麦克风喂一句话后保持静音：**没有点停止**，文字就进入了输入框，且从请求发出到文字出现的整个过程中，麦克风按钮上能看到脉动点。把「语音结束 → 请求发出」的实际间隔（应约为 5 秒）写进验收记录。不要求任何识别质量读数；质量归 `gap-voice-pause-split-selfcorrect-eval`。

L_D 该轴仍暗，理由：本任务不新增领域数据能力；读数归既有的 `[voice:live]`。

L_G 该轴仍暗，理由：同上。

## Touches

- src/modules/chat/utils/voiceLiveSegmenter.ts
- src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/VoiceInputButton.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/voiceInputButton.test.tsx (new)
- src/shared/voiceDebug.ts
- e2e/voice-continuous.spec.ts
- e2e/voice-live-vad-ab.spec.ts
- experiments/voice-vad/run.mjs
- experiments/voice-vad/fixtures/live-segmenter.json
- tasks/gap-voice-silence-flush-and-inflight-dot.md
