---
id: gap-identifier-repair-harness-measures-a-copy
title: 判据必须量出货模块：收敛 identifierRepair 的两份实现，并修掉点号段正则与中文分词两处语义差异
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

`src/shared/identifierRepair.ts`（出货模块，AC-115 落地后 app 真正会调用的那一个）与 `experiments/voice-identifiers/identifierRepair.mjs`（AC-112/113 的判据所量的那一个）是同一算法的两份实现。2026-09-21 实测：在 AC-113 的 16 条 recovery 语料上、候选集取本仓库 `git ls-files`（1976 条），两者 10 条一致、**6 条不一致**，且 6 条全部是「出货模块不还原、副本还原」——即 AC-113 报出的存活率提升并不描述 app 的行为。

两处成因已分别隔离（探针为临时物、提交前已删，读数取自其 stdout）：

1. **点号段长度正则**。`DOTTED_TOKEN` 要求每个 `.段` 为 1–5 字符，于是段更长的名字永远进不了点号通道 —— 而真实文件名 `voice.service.ts` 的中间段 `service` 就是 7 字符。隔离读数：`voice.roue.ts → voice.routes.ts`（段长 4）**能还原**；`voice.servic.ts`（段长 6，编辑距离 1、相似度 0.94，三道护栏本应全过）**不还原**，仅被该正则挡下。后果是 GOAL-005 背景里点名的头号形态 `voice.seluis.ts`（`seluis` 6 字符）在出货模块上永不还原，而副本还原它（副本的相似度口径更宽，score 0.75）。
2. **分词按空白切分**。中文读码时标识符与汉字之间没有空格，整句成为**一个** token，永远不被考虑。隔离读数：纯 ASCII 的 `change voice.roue.ts now` 出货模块**还原**；同一个 token 放进 `改一下。voice.roue.ts` 则**不还原**，而副本还原。这正是 GOAL-005 的中文场景。

判据侧的现状：AC-113 的 criterion 已重指为 `npx tsx experiments/voice-identifiers/run-shipped-recovery.mjs`（当前必红：脚本不存在），该脚本是本任务的交付物之一；AC-112 的 criterion 指向的 `run-false-positive.mjs` 至今量的是副本，本任务一并收口。

方案：
1. **让判据量出货模块**：新增 `experiments/voice-identifiers/run-shipped-recovery.mjs` 与 `run-shipped-false-positive.mjs`，直接 import `src/shared/identifierRepair.ts`（经 tsx 运行）；`identifierRepair.mjs` 不再保留第二份算法 —— 或者改为从出货模块 re-export，或者删除并被两个新脚本取代，由实现者择一并写明理由。
2. **按已验证的行为定夺两处语义差异**：点号段规则须容纳真实文件名形状，分词须能在无空格的中文文本里找到标识符 token。这两条都是「让出货模块达到副本已验证的还原率」，不是放宽容忍度去迁就 —— 放宽点号规则会同时放宽误报面，AC-112 的负样本读数就是它的护栏，必须同时给。
3. **两份实现不得再各自演化**：补一条结构断言，使「仓库里只有一份算法」本身可被判据机械检查。

<!-- dedup-ref -->
追溯：`gap-voice-identifier-harness-in-repo`、`gap-voice-identifier-repair-module`、`gap-voice-identifier-fidelity-metric`、`gap-voice-identifier-browser-e2e` 均已 done，它们分别落地了工装入库、出货模块、度量与浏览器判据；本任务是这四者留下的缝合处 —— 无人负责对齐，实测 6/16 不一致。

## AC

- [ ] `npx tsx experiments/voice-identifiers/run-shipped-recovery.mjs` 退出码 0（即 AC-113 的判据转绿）
- [ ] `npx tsx experiments/voice-identifiers/run-shipped-false-positive.mjs` 退出码 0（出货模块在 AC-112 负样本语料上零改写；放宽点号规则后的反向读数）
- [ ] 单一实现：`grep -nE "function +(editDistance|splitIndex|nearestDottedCandidate|longestSplitMatch)" experiments/voice-identifiers/identifierRepair.mjs` 无输出（grep 退出码 1）—— 副本不得再持有独立算法
- [ ] 出货模块单测：`npx vitest run src/shared/tests/identifierRepair.test.ts` 退出码 0，新增用例覆盖本轮两个成因：长段错拼（`voice.seluis.ts` → `voice.service.ts`）与中文无空格邻接（`改一下。voice.roue.ts` → `改一下。voice.routes.ts`）
- [ ] 取假形态：把 `repairIdentifiers` 临时换成 `return text` 后，两条 `npx tsx …run-shipped-*.mjs` 必须双双变红（记录原始终端读数）
- [ ] `npm run lint` 与 `npx tsc --noEmit -p tsconfig.json` 退出码 0

## DoD

真实落地判据：AC-113 的判据必须**真的是出货模块在跑**，不以「副本绿了」代替。须逐条给读数：(a) 三条判据命令的实测退出码与输出尾行（survivalBefore / survivalAfter / misRepairs）；(b) 按 AC-5 注入恒等函数重跑，登记红读数与原文，随后还原并确认工作树干净；(c) `voice.seluis.ts` 与 `改一下。voice.roue.ts` 两条用例改动前后的逐字输出对照；(d) 两处语义差异各自的修法（点号规则放宽到什么形状、分词按什么切），并如实登记放宽后的负样本零改写读数 —— 没有这一条读数，放宽就是单侧的。若某处差异经实测判定**不该**跟副本对齐（例如放宽后误报面不可接受），则如实登记「出货模块维持更窄口径」并把 AC-113 的语料期望按实际口径重标，不得让判据与实现各说各话。

L_D 该轴仍暗，理由：本任务是把两份实现收敛成一份并对齐已验证口径，不新增领域能力。
L_G 该轴仍暗，理由：同上；本任务的读数是语料存活率、误修数与负样本零改写。

## Touches

- src/shared/identifierRepair.ts
- src/shared/tests/identifierRepair.test.ts
- experiments/voice-identifiers/identifierRepair.mjs
- experiments/voice-identifiers/run-recovery.mjs
- experiments/voice-identifiers/run-false-positive.mjs
- experiments/voice-identifiers/run-shipped-recovery.mjs (new)
- experiments/voice-identifiers/run-shipped-false-positive.mjs (new)
- tasks/gap-identifier-repair-harness-measures-a-copy.md
