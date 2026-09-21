---
id: gap-voice-trim-harness-quality
title: 裁剪后的质量读数：标识符不降、CER 与句读在容差内（离线 fixture）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-trim-module
  - gap-voice-trim-harness-savings
goal_ac: AC-118
---
## Proposal

<!-- dedup-ref --> 本任务落地 GOAL-006 的质量读数（AC-118）：证明裁剪**省了时长的同时没有把内容弄坏**，判据离线可复跑。

### 现状与缺口

仓库内没有裁剪后的质量读数。已有证据在仓库外：`/data/home/yale/work/tc-verify/logs/test3-final.log`（zh，cap 阶段 CER 0.1389→0.1499 = +1.101%、最差 +9.68%、6/16 变差；句读 2.06→1.00；标识符 16.7%→16.7%）与 `logs/quality-en.log`（en，ΔCER +0.140%、标识符 77.8%→77.8%）。

关键事实（决定了本任务判据的形状）：**cap 阶段 CER 是升的，而标识符逐字存活率是中性**。所以「质量不降」不能写成「CER 不升」（那样一开始就是红的），也不能只用 CER（CER 对本项目最关键的失效——标识符被改写——失明，GOAL-005 已立过这条）。

### 方案

1. `experiments/voice-trim/fixtures/transcripts.json`（入库）：对 AC-117 入库的同一批 fixture 音频，各存 **baseline（未裁）** 与 **trimmed（出货模块裁后重编码）** 两条真实识别器转写，外加作者撰写的 reference 文本。生成方式：一次性用真实识别器（Groq whisper-large-v3-turbo，凭据在仓库外 `.env`）跑，命令与日期写进本任务完成记录；**判据本身不联网**（与 AC-112/113 的 fixture 同形）。trimmed 的音频必须由**出货模块**产出，不得用等价改写。
2. `experiments/voice-trim/run-quality.mjs`：
   - 标识符逐字存活率 `import` 自 `src/shared/identifierFidelity.ts`（既有模块，勿重写）。
   - CER 口径复用已入库的 `experiments/voice-identifiers/metrics.mjs`；句读标记数在脚本内按句末标点计数。
   - 输出 `idBaseline / idTrimmed / cerBaseline / cerTrimmed / cerDelta / boundaries / savedRatio`，并按 AC 的四条断言给退出码（不满足即 exit 1，原因写 stderr）。
3. 与 AC-117 的分工：AC-117 管时长，AC-118 管质量；两者都由同一批 fixture 支撑，互不重复。

### 边界（不做）

判据不联网、不调用识别器；不改出货模块；不重复 AC-117 的时长断言（本任务只要求 `savedRatio > 0` 作为配对前提）；不引入参数搜索。

## AC

- [ ] `node experiments/voice-trim/run-quality.mjs` 退出码 0
- [ ] 标识符逐字存活率 trimmed ≥ baseline（硬，允许相等）
- [ ] ΔCER ≤ +1.5%
- [ ] 句读标记数 ≥ 0.9 × baseline
- [ ] 同一 runner 打印 `savedRatio` 且断言 `savedRatio > 0` —— 「省了时长」与「质量不降」必须同时成立
- [ ] trimmed 的转写确实来自出货模块裁后的音频（fixture 里记明产出方式，脚本核对 fixture 与音频一一对应）
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是脚本与 JSON 存在，而是四条断言在真实转写上成立且能被假形态打红 —— 恒等实现（不裁）必须使 `savedRatio > 0` 红；把 cap 表换成会吃掉语音的激进参数必须使标识符断言红；把判据口径换成 CER 必须承认它对本失效恒绿（这正是本条必须取逐字口径的理由，写在脚本注释里）。阈值与参考读数（zh +1.101%、en +0.140%、句读 1.00）必须写进脚本注释，使容差不是凭空的。

L_D 该轴仍暗，理由：本任务只把已有的质量读数落成仓库内可复跑的判据，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是转写保真（标识符逐字存活/CER/句读），不是生成质量轴读数。

## Touches

- experiments/voice-trim/run-quality.mjs (new)
- experiments/voice-trim/fixtures/transcripts.json (new)
- tasks/gap-voice-trim-harness-quality.md
