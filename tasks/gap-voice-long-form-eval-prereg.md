---
id: gap-voice-long-form-eval-prereg
title: VAD 评估与参数选定：T1 合成真值扫描 + T2 真人标注，识别仅作 T4 小样本确认
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-vad-truth-harness
  - gap-voice-streaming-vad-endpointing
  - gap-voice-upload-16khz-mono
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md`「验证梯度」。沿用 `experiments/voice-dashscope-omni-paired-quality` 的做法（预注册先于取数、冻结快照、取假形态证明量具敏感），不与它重复：那条比的是 provider/裁剪，本条选的是 VAD 的切分参数。**重点是 VAD：参数由本地、无网络的真值扫描选定；识别只在最后用 ≤10 条样本确认切点没有伤到识别，不参与选参。**

### 现状与缺口

`gap-voice-streaming-vad-endpointing` 里 `endpointMs`（0.8 s）与 `maxSegmentSec`（30 s）只是临时默认值，没有依据。本轮已有的数据只够界定方向：4 条合成长样本（`/data/home/yale/work/tc-verify/corpus/long/`）与 3 段 TTS 的 audio token 读数（约 7 个/秒；输出 reasoning token 波动 77–2328，远大于音频节省，所以**识别读数噪声太大，不能用来区分两个相近的参数**）。真值度量工具由 `gap-voice-vad-truth-harness` 提供。

### 方案

1. 先写 `experiments/voice-vad/PREREG.md` 并**提交**，再取数：登记主指标（起点/终点偏差 p50/p95、漏检率、误触发/小时静音、过切率、中途切率、`maxSegmentSec` 违反数）、参数网格（`endpointMs` ∈ {0.4, 0.6, 0.8, 1.0, 1.5} s，`maxSegmentSec` ∈ {10, 20, 30, 60} s，噪声 SNR ∈ {5, 10, 15, 20, 30} dB 与 −50 dBFS 房间底噪）、判定规则与容差；登记**负对照**（把切点强制放在句中，中途切率必须变红）。
2. **T1**：在 ≥5000 条合成真人语音时间线 × 参数网格上跑流式 VAD（本地 CPU，无网络，无凭据），产出冻结快照；用配对比较（同一时间线只改一个参数）画出各指标随参数的曲线，找出拐点。
3. **T2**：在 CORAAL 人工标注段（490 段，即兴访谈）上重复同一套指标，确认 T1 的结论方向在即兴语音上不变；超出预注册容差的差异列为未解释项，不静默放过。
4. **T4（最后一档，付费）**：用 T1–T2 选定的参数，取 ≤10 条样本（含至少一条 >60 s 的连续口述，真人录音由 yale 提供或现场录制并带逐字脚本），对比「整段识别」与「切段识别再拼回」的文本（标识符存活率、句读标记）；同时对比 16 kHz 与 48 kHz 上传。读数只作确认，**不用来比较两个相近的参数**。n < 5 时结论首句标「仅方向」。
5. `docs/experiments/` 下写结果记录，给出 `endpointMs` / `maxSegmentSec` 的推荐初值，并回写到 `gap-voice-streaming-vad-endpointing` 的默认值。

### 边界（不做）

不做 `reasoning_effort` 的配对实验（单独立）；不改任何运行时代码（默认值回写除外，且只改常量）；不把真人录音原文放进仓库（只放聚合数字，原文留仓库外，沿用 voice-draft 系列的约定）；不用识别结果选参。

## AC

- [ ] `test -f experiments/voice-vad/PREREG.md` 成立，且 PREREG 的首次提交时间早于 `experiments/voice-vad/fixtures/sweep.json` 的首次提交时间（`git log --diff-filter=A --format=%ct -- <文件>` 比较两个时间戳）
- [ ] `node experiments/voice-vad/run.mjs --sweep --offline` 从冻结快照重算全部读数，退出码 0，不联网、不用凭据
- [ ] 快照覆盖 ≥ 5000 条时间线，参数网格（5 × 4 × 6）全部有格，缺格数为 0；每格的样本数写在快照里
- [ ] 负对照：`node experiments/voice-vad/run.mjs --sweep --offline --variant=cut-mid-sentence` 的中途切率方向与 PREREG 登记一致（变红），退出码 0，输出含「负对照红」字样
- [ ] T2：快照里有 CORAAL 段的读数（≥ 300 段），与 T1 同指标；与 T1 的差异超出 PREREG 容差的格全部列入结果记录的「未解释项」
- [ ] T4：快照里有 `recognition` 组，n ≤ 10；若 n < 5，`grep -c "仅方向" docs/experiments/2026-10-04-voice-vad-sweep.md` ≥ 1
- [ ] 结果记录给出 `endpointMs` 与 `maxSegmentSec` 的推荐值，并且 `src/shared/voiceEndpoint.ts` 里的默认值与之一致（`grep` 两处数值相同）
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：推荐参数来自 **≥5000 条带精确真值的真人语音时间线**，不来自识别；每个结论写明依据的样本组与 n，并保留未解释项，不为让表格好看而填数。取假形态：把句中强制切点接进来，中途切率必须变红，否则量具不敏感、整份记录作废重做。T4 的识别读数只出现在「确认」一节，且明确写出它为什么不能用来选参（本轮实测：同类输入的 reasoning token 从 77 到 2328，d02 的裁剪臂总量反而是不裁臂的 2.7 倍）。

L_D 该轴有读数：切分参数对边界偏差、漏检、误触发、过切、中途切的影响，由 sweep 快照给出。

L_G 该轴有读数（仅确认性质）：T4 里切段识别与整段识别的标识符存活率、句读标记差异。

## Touches

- experiments/voice-vad/PREREG.md (new)
- experiments/voice-vad/run.mjs
- experiments/voice-vad/fixtures/sweep.json (new)
- src/shared/voiceEndpoint.ts
- docs/experiments/2026-10-04-voice-vad-sweep.md (new)
- docs/experiments/README.md
- tasks/gap-voice-long-form-eval-prereg.md
