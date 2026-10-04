---
id: gap-voice-upload-16khz-mono
title: 语音上传改 16 kHz 单声道（请求体约 1/3，长音频的单请求上限随之放大）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` P1。与 `gap-asr-mime-whitelist-and-size-layering`（上传体积分层）相关但机制不同：那条管「超限怎么拒」，本条管「同样的音频发多少字节」。**验收用确定性的信号与字节检查，不使用语音识别。**

### 现状与缺口

`useVoiceInput.ts` 的 `prepare` 依次 `decodeVoiceBlob`（`DECODE_SAMPLE_RATE = 48000`）→ `trimVoiceAudio` → `encodeWavBlob`，上传的是 **48 kHz 16 位 PCM WAV，每秒 96 KB**，base64 后约 128 KB/秒。`dashscope-omni` 的 `maxInlineRequestBytes` 是 10 MB 且含整个请求，所以一次大约只能发 80 秒；本轮用 `corpus/long/L4-nonstop`（140.8 s）按字节推算，现行格式约 12.2 MB，会被 `OVERSIZE` 拒绝。ASR 本来就在 16 kHz 上工作，48 kHz 对识别没有预期收益。

### 方案

1. `src/modules/chat/utils/audioDecode.ts`：新增带抗混叠的降采样（不做隔点取样），把解码后的单声道样本降到 16 kHz；`encodeWavBlob` 按传入采样率写头，不改其签名。
2. `src/modules/chat/hooks/useVoiceInput.ts`：`prepare` 在 `trimVoiceAudio` 之后、`encodeWavBlob` 之前降采样。**VAD 仍在解码的原始采样率上跑**，不改变已上线的裁剪读数；`AudioReading` 的 `inputSec / outputSec` 语义不变。
3. 回退路径不变：任何 guard 触发时仍发原始 webm，不降采样。

### 边界（不做）

不改 VAD 的任何阈值与停顿封顶；不改 provider 声明；不碰服务端（服务端是字节透传）；不引入新的编码（仍是 WAV，不重新有损编码）；不调用识别服务（识别是否下降归 `gap-voice-long-form-eval-prereg` 的 T4 小样本确认）。

## AC

- [ ] `npm run test:client -- src/shared/tests/voiceUpload16k.test.ts` 退出码 0
- [ ] 降采样输出的采样率为 16000，时长与输入相差不超过 1 个输出采样点对应的时间，WAV 头的采样率字段为 16000
- [ ] 通带保真：一段 1 kHz 正弦在 48 kHz 输入下降采样后主频仍为 1 kHz，幅度变化 ≤ 1 dB；在 100 Hz–6 kHz 内扫频，幅度变化均 ≤ 1 dB
- [ ] 抗混叠：一段 20 kHz 正弦（高于 16 kHz 奈奎斯特频率）降采样后能量低于输入的 1%（不是隔点取样）
- [ ] 真实语音保真（无识别）：对 `corpus/long/L2-mixed.wav` 先上采到 48 kHz 再降回 16 kHz，与原 16 kHz 样本的信噪比 ≥ 40 dB
- [ ] VAD 不受影响：`prepare` 里 `trimVoiceAudio` 看到的采样率与样本数与改动前相同（测试里对 `trimVoiceAudio` 的入参断言），`AudioReading` 的 `inputSec / outputSec / vadSegments` 逐字段与改动前相同
- [ ] guard 触发（回退路径）时仍返回原始 webm，不是降采样后的 WAV
- [ ] 对 `corpus/long/L4-nonstop.wav` 规模的样本，上传 WAV 字节数 ≤ 现行 48 kHz 格式的 36%（约 1/3），测试里用同一段样本两种格式的字节数比较；并断言 base64 后的整请求在 `dashscope-omni` 的 10 MB 上限内（`measureChatRequestBytes`）
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是「函数能降采样」，而是 `prepare` 在真实录音路径上产出 16 kHz WAV，且整条链路没有被提前拒绝：用现有 e2e 夹具（`e2e/voice-trim.spec.ts` 的录音注入方式）走一次录音→上传，抓上传请求体，读 WAV 头采样率为 16000。取假形态：把降采样改成隔点取样，抗混叠与通带保真断言必须红。「识别是否下降」不在本任务判据内，由 `gap-voice-long-form-eval-prereg` 的 T4 在 ≤10 条样本上确认。

L_D 该轴仍暗，理由：本任务只改上传采样率，不新增领域数据能力。

L_G 该轴仍暗，理由：同上，没有新的生成质量轴读数。

## Touches

- src/modules/chat/utils/audioDecode.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/shared/tests/voiceUpload16k.test.ts (new)
- tasks/gap-voice-upload-16khz-mono.md
