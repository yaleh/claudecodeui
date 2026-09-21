---
id: gap-voice-identifier-harness-in-repo
title: 把标识符修复的验证工装移入仓库并使 AC-112/AC-113 由红转绿
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-112
---
## Proposal

<!-- dedup-ref --> 本任务把仓库外的语音标识符验证工装移入仓库，使 GOAL-005 的两条判据 AC-112 与 AC-113 在 CI 里可复跑。两条判据命令分别是 `node experiments/voice-identifiers/run-false-positive.mjs` 与 `node experiments/voice-identifiers/run-recovery.mjs`；今天二者必红，红因是 `experiments/voice-identifiers/` 目录不存在（红先行）。

### 现状与缺口

- 工装现存于仓库外：`/data/home/yale/work/tc-verify/tools/identifier-repair.mjs` 与 `/data/home/yale/work/tc-verify/tools/identifier-fidelity.mjs`；它们依赖工装侧的绝对路径取候选集与语料，仓库内不可复现。
- 候选集今天应由 `git ls-files` 现取（≥1000 条，含 basename 与裸符号名两种形态），不引用任何仓库外文件。
- 语料（TTS 合成音频与转写）不入库，可由脚本再生成；入库的只有 fixtures（负样本与 recovery 转写集）。

### 方案

1. 移入 `experiments/voice-identifiers/identifierRepair.mjs`（两遍匹配 + 四重护栏）与 `experiments/voice-identifiers/identifierFidelity.mjs`（标识符逐字存活率指标，保留标点与大小写），去掉对工装绝对路径的依赖，候选改由 `git ls-files` 现取。
2. `experiments/voice-identifiers/run-false-positive.mjs`：负样本 ≥40 条普通中英文句子（不含任何标识符），其中 ≥12 条含与真实文件名仅差一个编辑距离的近似词；全部负样本经修复后必须逐字不变；输出 `candidates=<n> negatives=<n> falsePositives=<n>`，`falsePositives != 0` 即 exit 1。
3. `experiments/voice-identifiers/run-recovery.mjs`：在 recovery fixture（≥12 条实测形态，`voice.seluis.ts` / `Use voice input` / `voice.module.t` 等）上输出 `survivalBefore=… survivalAfter=… misRepairs=0`；`misRepairs != 0` 或 `survivalAfter <= survivalBefore` 即 exit 1。
4. fixtures：`experiments/voice-identifiers/fixtures/negative.json`（负样本）与 `experiments/voice-identifiers/fixtures/recovery.json`（实测形态转写集）。

### 四重护栏的来历

首版误报严重，CER 反升 +9.4%；根因是 `editDistance` 提前退出返回 `cap+1`——那是真实距离的下界，转成相似度即成上界，用上界做阈值必然误报。因此长度差必须提前退出返回 Infinity（而不是 cap+1）。带点/不带点名互斥、共享首三字符、以及跨词符号走去空格去大小写的精确相等（而非相似度）三条同属护栏，一条都不能省。

### 边界（不做）

不实现 AC-114 的语音链路读数与 AC-115 的浏览器判据；不改 `src/` 与 `server/` 的生产代码；语料不入库。

## AC

- [ ] `node experiments/voice-identifiers/run-false-positive.mjs` 退出码 0，输出 `falsePositives=0`
- [ ] `node experiments/voice-identifiers/run-recovery.mjs` 退出码 0，输出 `misRepairs=0` 且 `survivalAfter > survivalBefore`
- [ ] `experiments/voice-identifiers/fixtures/negative.json` 含 ≥40 条负样本，其中 ≥12 条为与真实文件名仅差一个编辑距离的近似词
- [ ] `experiments/voice-identifiers/fixtures/recovery.json` 含 ≥12 条实测形态转写
- [ ] 工装无仓库外绝对路径依赖（`git grep -n "/data/home/yale/work/tc-verify" experiments/voice-identifiers/` 输出为空），候选由 `git ls-files` 现取且 ≥1000 条
- [ ] 语料未入库（可再生成）
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是目录存在，而是两条判据命令在真实仓库（候选由 `git ls-files` 现取）上可重复地退出 0，并把 `candidates=… negatives=… falsePositives=…` 与 `survivalBefore=… survivalAfter=… misRepairs=…` 两组读数记入完成记录。取假形态必须在场：只用相似度阈值而无护栏的实现（把 `Recording.G` 修成 `tests`）必须使 false-positive 判据红；恒等函数（不修复）必须使 recovery 判据红——两个负对照各跑一次、留输出、再还原。

L_D 该轴仍暗，理由：本目标未涉及领域数据轴，本任务只把库外验证工装移入仓库并使其判据可复跑，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务是验证工装的入库与判据转绿，不产出生成质量轴读数。

## Touches

- experiments/voice-identifiers/identifierRepair.mjs (new)
- experiments/voice-identifiers/identifierFidelity.mjs (new)
- experiments/voice-identifiers/run-false-positive.mjs (new)
- experiments/voice-identifiers/run-recovery.mjs (new)
- experiments/voice-identifiers/fixtures/negative.json (new)
- experiments/voice-identifiers/fixtures/recovery.json (new)
- tasks/gap-voice-identifier-harness-in-repo.md
