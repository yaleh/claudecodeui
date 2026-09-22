---
id: gap-asr-second-adapter-inline-only
title: 第二个适配器（多模态服务，仅内联）：超限返回 OVERSIZE 且零请求、预算按整个请求计、honors.prompt=false
  时不发提示字段（AC-132）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-extraction-parity-baseline
goal_ac: AC-132
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：全仓无任何任务声明 AC-132；`task_list` 全文检索「多模态 / 仅内联 / 第二个适配器」未命中以同一机制立案的任务。相邻但机制不同的是 `gap-asr-wire-single-implementation-boundary-probe`（AC-129，落契约、registry 与**第一个**适配器，且其边界里明确把「第二个 provider 与能力声明」让给 AC-132/133/134/135）与 `gap-asr-extraction-parity-baseline`（AC-130，录字节基线）。本任务是 ADR-004「后续任务 5」的立案。

**现场。** 今天全仓只有一种识别服务形状（OpenAI-compatible 的 `/audio/transcriptions`），因此「能力声明」这张表在代码里**没有第二个实例**，它的字段是否真的承重无从判定。本任务落第二个适配器：一个**仅内联**的多模态服务。它的内联上限是**整个请求的预算**（官方表述为「最大请求 20MB，含提示词与所有文件」），因此提示词与上下文会**挤占音频的可用预算** —— 这正是 ADR-004 决策 1 把该字段命名为 `maxInlineRequestBytes`（请求级）而不是「音频字节上限」的原因。

**本任务做什么。** 第二个适配器模块，能力声明 `oversize: 'reject'`（第一版只允许 `reject`，不得声明 `files-api`），在 registry 里按 id 登记。三条判据：超限返回 `OVERSIZE` 且**未发出任何请求**；预算按**整个请求**计（音频在预算内、加上长上下文后超预算必须被拒）；`honors.prompt` 为 false 时请求体**不含**提示字段。

**依赖与落点。** 适配器缝必须已存在（本任务 `depends_on` 含 `gap-asr-extraction-parity-baseline`，即 ADR-004 的 S0/S1 已闭合）。落点沿用 ADR-004 决策 2/3 的候选。若该服务需要引入服务商 SDK，ADR-004 允许它发生在**适配器落地任务**里，但**必须**在边界探针之后 —— 本任务的依赖已保证这一点。

**边界（不做）。** 不修三处既有缺口（AC-133/134）；不做裁剪 × 能力的接线（AC-135）；不做配对质量实验（按 ADR-004 决策 8 归实验记录）；不改两条路径的路由与 UI；不改第一个适配器与既有线上字节（AC-129/AC-130）。

## Plan

- **S0 落适配器模块。** 纯模块 + 注入全部环境依赖；能力声明含 `acceptsMime`、`maxInlineRequestBytes`（**请求级**预算）、`oversize: 'reject'`、`honors.{prompt,language,context}`、`billing`、`pauseCues`、`style`、`oneShot`。
- **S1 registry 登记。** 按 provider id 注册；未注册 id 的 fail-closed 行为由既有 registry 承担（健康检查面的 fail-closed 是 AC-134 的词，不在本任务）。
- **S2 探针与三条取假控制。** 各成一条独立可红用例；先证未变异为绿、再证变异为红。
- **S3 读数。** 逐条跑 AC，stdout 落进 Evidence。

## AC

- [ ] AC1 超过 `maxInlineRequestBytes` 的输入返回 `OVERSIZE`，且**未发出任何请求**（注入替身断言调用次数为 0）。取假变体：把超限音频直接塞进请求体 ⇒ 必须红（「调用次数为 0」这一半）。
- [ ] AC2 **提示词与上下文计入同一预算**：构造一个「音频本身在预算内、加上长上下文后超预算」的用例，必须被拒。取假变体：只按音频字节判定预算、不计提示词与上下文 ⇒ 上面那个用例必须红。
- [ ] AC3 `honors.prompt` 为 false 时，请求体**不含**提示字段（不发、而不是发空值）。
- [ ] AC4 取假变体：把响应解析写成宽松形式（把整个响应 JSON 当文本返回）⇒ 解析基线必须红。
- [ ] AC5 第一版只允许 `oversize: 'reject'`：能力声明里出现 `files-api` ⇒ 必须红（默认拒绝路径必须显式声明，不能靠「上游会报错」）。
- [ ] AC6 经 registry 按 id 解析到该适配器：`resolve(id)` 返回的 `capabilities` 与该模块导出的常量逐字段相等。
- [ ] AC7 离线：全程注入替身，零网络；发生真实网络调用即红。
- [ ] AC8 空读数不是绿：适配器未被 registry 解析到、或替身调用次数读数为空 ⇒ 探针非零退出。
- [ ] AC9 三条取假形态各为 `scripts/asr-second-adapter-check.test.mjs` 内一条独立可红用例；`node --test scripts/asr-second-adapter-check.test.mjs` 退出码 0。
- [ ] AC10 静态门：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0。

## DoD

真实落地判据：不是「多了一个 provider 目录」，而是**第二个识别器的形状差异真的由能力声明表达、且差异是可红的**。承重性由三组正面读数证明：

(a) 「未发出任何请求」这一半必须由替身的调用计数机械证明（AC1），而不是靠「返回了错误码」推断；
(b) 预算的**请求级**语义必须由「音频在预算内、加上长上下文后超预算」那个用例机械证明（AC2）—— 只按音频字节判定的实现会在该用例上把「音频字节上限」当成预算，因此必红；
(c) 声明为不承认的提示参数必须**不发**（AC3），这条与 AC-132 的能力声明面直接对应。

**本任务不证明**缺口一/二/三被修（AC-133/134），也不证明裁剪接线（AC-135）；它只证明「第二个适配器存在，且它的差异由能力声明驱动、可红」。

L_D 该轴仍暗，理由：本任务只落第二个适配器与其内联预算语义，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担。

## Touches

- shared/asr/list/multimodal/multimodal.asr-provider.ts (new)
- src/shared/asr/list/multimodal/multimodal.asr-provider.ts (new)
- shared/asr/asrRegistry.ts
- src/shared/asr/asrRegistry.ts
- shared/asr/tests/multimodalAdapter.test.ts (new)
- src/shared/asr/tests/multimodalAdapter.test.ts (new)
- scripts/asr-second-adapter-check.mjs (new)
- scripts/asr-second-adapter-check.test.mjs (new)
- package.json
- tasks/gap-asr-second-adapter-inline-only.md
