---
id: gap-voice-streaming-vad-endpointing
title: 流式 VAD：AudioWorklet 逐帧判定 + 端点（停顿切段）+ 最长段长，判定逻辑与批处理共用
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` P2。与已完成的 `gap-voice-debug-switch` / 裁剪链路相关：本条不改它的行为，只把判定逻辑抽出来供流式路径共用。

### 现状与缺口

VAD（`src/shared/voiceTrim.ts`）是录完后整段解码再裁的批处理：噪声基线取**整段**音频的第 15 百分位，没有端点判定，也没有最长段长。持续采集和超长语音需要边录边判、在停顿处切段。现有 VAD 在 `corpus/long/` 四条样本上的基线：L1 18 段、L2 28 段、L3 30 段（省 80.7%，底噪 −50 dBFS 下无回退）、L4 27 段；段数多于真值句数是预期的（一句内部的停顿也算段间隔），不是准确率。L4 没有真停顿，整段 126.6 s 只会成一个请求。

### 方案

1. 把帧判定与状态机从 `voiceTrim.ts` 抽成与来源无关的纯函数：输入一帧能量与当前状态，输出新状态与事件（语音开始 / 语音结束）。阈值常量（进入 3.0、退出 1.8、起 3 帧、止 15 帧、前留 120 ms、后留 180 ms）**只定义一份**，批处理与流式共用，批处理输出须与现行逐样本一致。
2. 噪声基线改为滑动估计（最近若干秒内的低百分位），流式路径用它；批处理路径仍用整段第 15 百分位，行为不变。
3. 端点：连续静音 ≥ `endpointMs` 判定一句结束并产出段边界；`maxSegmentSec` 到期仍无停顿则强制切，切点选该段末尾窗口内能量最低的帧；段间保留 0.3–0.5 s 重叠。`endpointMs` 与 `maxSegmentSec` 是配置项，**初值不在本任务定**，由 `gap-voice-long-form-eval-prereg` 的读数给出，本任务只保证可配置并给出临时默认值（0.8 s / 30 s）。
4. 采集：新增 `AudioWorklet` 处理器逐 20 ms 帧送入判定；单次按键的 `MediaRecorder` 路径保留，行为不变。

### 边界（不做）

不做分段上传、重试与拼接（属 `gap-voice-segment-pipeline`）；不引入模型 VAD；不改 provider 的 `pauseCues` 声明与裁不裁的结论。

## AC

- [ ] `npm run test:client -- src/shared/tests/voiceEndpoint.test.ts src/shared/tests/voiceTrim.test.ts` 退出码 0
- [ ] 回归：`voiceTrim.test.ts` 与 `voiceTrimShippedRecogniser.test.ts` 不改一行断言即通过；`trimVoiceAudio` 对 `corpus/long/L1`–`L4` 的输出采样数与抽取前逐样本一致
- [ ] 阈值常量在仓库内只有一处定义：`grep -rnE "ENTER_FACTOR|EXIT_FACTOR" src/ | grep -c "export const"` 的结果为各常量各 1
- [ ] 流式状态机喂 `L2-mixed` 的 `manifest.json` 所标 10 句：每个真值句起点至少有一个流式「语音开始」事件落在其 [起点−0.3 s, 起点+0.3 s] 内（容差在测试里写死并在 PREREG 登记）
- [ ] 喂 `L3-sparse`（底噪 −50 dBFS）：事件数不超过真值句数的 4 倍，静音区间（真值句之外超过 10 s 的间隔）内「语音开始」事件数为 0
- [ ] 喂 `L4-nonstop`：产出的每一段时长 ≤ `maxSegmentSec`，且强制切点处的帧能量不高于该窗口内最大帧能量的 50%
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：流式状态机在真实 `AudioWorklet` 里跑过——用 e2e 注入 `corpus/long/L2-mixed.wav` 作为麦克风输入，读到的段边界与纯函数在同一段样本上的输出一致。取假形态：把 `maxSegmentSec` 强制切删掉，L4 的段长断言必须红；把滑动噪声基线换成固定常数，L3 的静音区无误触发断言必须红。样本在仓库外 `/data/home/yale/work/tc-verify/corpus/long/`，由 `tools/long-corpus.mjs` 确定性生成，测试在样本缺失时必须**指名**缺失路径并失败，不得静默跳过。

L_D 该轴仍暗，理由：本任务不新增领域数据能力。

L_G 该轴仍暗，理由：没有新的生成质量轴读数。

## Touches

- src/shared/voiceTrim.ts
- src/shared/voiceEndpoint.ts (new)
- src/modules/chat/audio/voiceFrameProcessor.ts (new)
- src/modules/chat/hooks/useVoiceInput.ts
- src/shared/tests/voiceEndpoint.test.ts (new)
- src/shared/tests/voiceTrim.test.ts
- tasks/gap-voice-streaming-vad-endpointing.md
