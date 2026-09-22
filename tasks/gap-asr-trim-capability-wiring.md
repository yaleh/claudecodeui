---
id: gap-asr-trim-capability-wiring
title: 裁剪 × 识别器能力的接线：pauseCues 驱动裁剪且默认不变，capabilities 成为裁剪决策唯一来源（AC-135）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-extraction-parity-baseline
goal_ac: AC-135
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：全仓无任何任务声明 AC-135；`task_list` 全文检索「裁剪 × 识别器 / 能力接线」未命中以同一机制立案的任务。相邻但机制不同的是 `gap-asr-wire-single-implementation-boundary-probe`（AC-129）、`gap-asr-extraction-parity-baseline`（AC-130）、`gap-asr-second-adapter-inline-only`（AC-132，落适配器与能力声明）与 `gap-asr-mime-whitelist-and-size-layering`（AC-133）—— 都不把「裁不裁」接到能力声明上。本任务是 ADR-004「后续任务 9」的立案。

**现场。** 「裁不裁」今天不是一个可声明的属性：裁剪门逻辑住在客户端 hook 里，与识别器无关。而在 ADR-004 背景第二节里，这是一条**已测量**的设计级结论：裁剪把中文句读打到 −89%，而 CER 只 +0.52pp（CER 对标点损失失明）；同时裁剪省下 25.5%（中文）/ 13.3%（英文）的账单 —— 在按秒计费的服务上「裁了省钱」，在多模态大模型上「留着可能换回标点」。因此「裁不裁」必须成为**识别器自己声明的属性**（`capabilities.pauseCues`），而今天没有任何地方能表达它。

**本任务做什么。** `capabilities.pauseCues === 'destructive'` 走裁剪（这是 Whisper 系的实测结论）；裁剪决策的**唯一来源**收敛到 `capabilities` 的读取点；**默认行为不变** —— 既有的「裁剪开/关配对下上传体时长下降」端到端判据保持绿（`isVoiceTrimEnabled()` 默认 `true`，hook 里的裁剪门逻辑不动）。

**一条纪律（记录在案，不改默认）。** 把某个 provider 从 `destructive` 改成 `useful` **必须附带该 provider 自己的配对实验**（同语料、`flat` 负对照、四轴读数），不得只改一行声明；且裁剪与风格化的交互必须**测**，不能推（ADR-004 明确禁止用输出侧差异去解释输入侧变化）。

**边界（不做）。** 不改两条路径的路由与 UI（AC-129/AC-130/AC-133/AC-134）；不落第二个适配器（AC-132）；不做质量实验记录（决策 8）；不调 `PAUSE_CAPS` 与 VAD 参数（`voiceTrim.ts` 已定死）；不把「裁不裁」改成全局开关。

## Plan

- **S0 收敛读取点。** 把裁剪决策的依据收敛到 `capabilities.pauseCues` 的**唯一**读取点；`destructive` ⇒ 按现状裁剪。
- **S1 默认不变。** `isVoiceTrimEnabled()` 默认 `true`，既有裁剪门逻辑不动；既有时长下降端到端判据保持绿。
- **S2 探针与两条取假控制。** 各成一条独立可红用例；先证未变异为绿、再证变异为红。
- **S3 读数。** 逐条跑 AC，stdout 落进 Evidence。

## AC

- [ ] AC1 `pauseCues: destructive` 走裁剪：断言裁剪决策读到的取值与走裁剪一致。
- [ ] AC2 **默认行为不变**：既有的「裁剪开/关配对下上传体时长下降」端到端判据保持绿。取假变体：把默认改成「不裁」⇒ 既有时长下降判据必须红。
- [ ] AC3 `capabilities` 的读取成为裁剪决策的**唯一来源**：探针打印唯一读取点的**符号名**；出现第二处「自行判断裁剪」的读取点即红。取假变体：把裁剪决策仍留在客户端各自判断（不读能力）⇒ 「能力是唯一来源」必须红。
- [ ] AC4 两条取假形态各为 `scripts/asr-trim-capability-check.test.mjs` 内一条独立可红用例；`node --test scripts/asr-trim-capability-check.test.mjs` 退出码 0，且每条先证未变异为绿、再证变异为红。
- [ ] AC5 空读数不是绿：裁剪决策的读数条数为 0、或唯一读取点解析为空 ⇒ 探针非零退出。
- [ ] AC6 既有语音读数不变：`npx vitest run src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx` 退出码 0；`npm run typecheck` 与 `npm run lint` 退出码 0。
- [ ] AC7 纪律可核（不改默认）：探针打印 `pauseCues` 的当前取值与其对应的 provider；若某 provider 取值为 `useful`，必须能指到该 provider 自己的配对实验记录路径，否则红。

## DoD

真实落地判据：不是「多了一次 `capabilities` 读取」，而是**「裁不裁」由识别器的能力声明唯一决定，且默认行为与既有端到端读数都不变**。承重性由三组正面读数证明：

(a) `destructive` 走裁剪，且**默认不变** —— 既有的「裁剪开/关配对下上传体时长下降」判据仍绿（AC1/AC2 的读数）；
(b) 「能力是唯一来源」是可红的：把裁剪决策留在客户端各自判断的形态必须是红（AC3 及其取假变体）；
(c) 把默认改成「不裁」必须让既有时长下降判据红（AC2 的取假变体）—— 否则「默认行为不变」是一句没被测量的声明。

**本任务不证明**某个 provider 的 `pauseCues` 声明是对的 —— 那要靠该 provider 自己的配对实验（AC7 只要求「取值为 `useful` 时能指到实验记录」）。

L_D 该轴仍暗，理由：本任务只把裁剪决策接到能力声明上并保持默认，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/shared/voiceTrim.ts
- src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx (new)
- scripts/asr-trim-capability-check.mjs (new)
- scripts/asr-trim-capability-check.test.mjs (new)
- tasks/gap-asr-trim-capability-wiring.md
