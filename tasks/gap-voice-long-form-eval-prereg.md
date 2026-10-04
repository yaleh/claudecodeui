---
id: gap-voice-long-form-eval-prereg
title: 长语音评估：预注册 + 在 L1–L4 与一小批真人录音上读 endpointMs / maxSegmentSec / 16 kHz 的影响
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-upload-16khz-mono
  - gap-voice-streaming-vad-endpointing
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` 的「依据」与「验收标准」。沿用 `experiments/voice-dashscope-omni-paired-quality` 的做法（预注册先于取数、冻结快照、取假形态证明量具敏感），不与它重复：那条比的是 provider/裁剪，本条比的是切分参数与采样率。

### 现状与缺口

`gap-voice-streaming-vad-endpointing` 里 `endpointMs`（0.8 s）与 `maxSegmentSec`（30 s）只是临时默认值，`gap-voice-upload-16khz-mono` 的「识别不下降」也只有预期没有读数。本轮已有的数据只够界定方向：4 条合成长样本（`/data/home/yale/work/tc-verify/corpus/long/`，由 `tools/long-corpus.mjs` 确定性生成，`manifest.json` 带逐句真值），3 段 TTS 的 audio token 读数（约 7 个/秒，输出 reasoning token 波动 77–2328，大于音频节省）。样本全是 TTS 合成音，没有真人录音、没有真实环境噪声。

### 方案

1. 先写 `experiments/voice-long-form/PREREG.md` 并**提交**，再取数：登记主指标（逐句标识符存活率、句读标记数、段边界偏差）、次指标（CER、端到端延迟、`usage`）、参数网格（`endpointMs` ∈ {0.5, 0.8, 1.2} s，`maxSegmentSec` ∈ {15, 30, 60} s，上传 48 kHz 对 16 kHz）、判定规则与容差；登记**负对照**：把切点强制放在句中，量具必须看见标识符存活率下降。
2. `experiments/voice-long-form/run.mjs`：在 L1–L4 上跑网格，输出冻结快照 `fixtures/long-form.json`；需要真实 provider 的读数由 adapter 现有的 `meta.usage` 取，不另写解析。
3. 补一小批真人录音（≤10 条，由 yale 提供或现场录制，须有逐字脚本作真值），至少覆盖一条 >60 s 的连续口述；缺它的结论一律标「仅方向」。
4. `docs/experiments/` 下写结果记录，给出 `endpointMs` / `maxSegmentSec` 的推荐初值，并回写到上面两个任务的默认值。

### 边界（不做）

不做 `reasoning_effort` 的配对实验（单独立）；不改任何运行时代码；不把真人录音原文放进仓库（只放聚合数字，原文留仓库外，沿用 voice-draft 系列的约定）。

## AC

- [ ] `test -f experiments/voice-long-form/PREREG.md && git log --format=%H -1 -- experiments/voice-long-form/PREREG.md` 有输出，且该提交早于 `experiments/voice-long-form/fixtures/long-form.json` 的首次提交（`git log --diff-filter=A --format=%ct -- <文件>` 比较两个时间戳）
- [ ] `node experiments/voice-long-form/run.mjs --offline` 从冻结快照重算全部读数，退出码 0，不联网、不用凭据
- [ ] 负对照：`node experiments/voice-long-form/run.mjs --offline --variant=cut-mid-sentence` 的主指标方向与 PREREG 登记一致（标识符存活率下降）；该变体退出码 0 且输出「负对照红」字样
- [ ] 快照里 L1–L4 四条样本各有一行读数，参数网格 3×3×2 全部有格，缺格数为 0
- [ ] 真人录音：快照里 `human` 组 n ≥ 5 且至少一条时长 > 60 s；若 n < 5，结果记录必须在结论首句标明「仅方向」，`grep -c "仅方向" docs/experiments/<记录>.md` ≥ 1
- [ ] 结果记录给出 `endpointMs` 与 `maxSegmentSec` 的推荐值，并且 `gap-voice-streaming-vad-endpointing` 里的默认值与之一致（`grep` 两处数值相同）
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：读数来自真实服务，不是全假 provider；每个结论写明依据的样本组与 n，并保留未解释项（如 reasoning token 波动、d01/d02 方向相反这类上一轮已留的未解释点），不为让表格好看而填数。取假形态：把句中强制切点接进来，标识符存活率必须下降，否则量具不敏感、整份记录作废重做。

L_D 该轴仍暗，理由：本任务产出的是实验记录，不新增领域数据能力。

L_G 该轴有读数：切分参数与采样率对识别质量（标识符存活率、句读标记）的影响，由快照给出。

## Touches

- experiments/voice-long-form/PREREG.md (new)
- experiments/voice-long-form/run.mjs (new)
- experiments/voice-long-form/fixtures/long-form.json (new)
- docs/experiments/2026-10-04-voice-long-form.md (new)
- docs/experiments/README.md
- tasks/gap-voice-long-form-eval-prereg.md
