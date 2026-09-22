---
id: gap-asr-wire-single-implementation-boundary-probe
title: 语音识别线协议只有一份实现：前端/服务端/命令行三处解析到同一路径，边界探针可红可绿（AC-129）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-129
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`tasks/` 内无同机制任务（唯一提及「线协议」的任务都不在 GOAL-008 上）。相邻但**机制不同**的是 `gap-identifier-repair-harness-measures-a-copy`：那条处理的是裁剪／标识符修复模块，本条处理的是语音识别线协议；仅在溯源上指向它，不引用它作为任何前置。AC-129 的 origin 恰好引用了那次失效（「一次判据量的是工装副本而非出货实现，与出货实现 16 条里 6 条不一致」）—— 本任务在语音链路上落同一条纪律。

### 现场：判据今天不可跑，因为线协议有两份生产实现

AC-129 自己的判据命令是 `node scripts/asr-single-implementation-check.mjs`，**该文件今天不存在**；而它要断言的形态今天是反的。

「线协议」在本任务里指识别服务的请求构造（multipart：音频文件 + 模型名，POST 到 `<baseUrl>/audio/transcriptions`，带 Authorization）与转写响应解析：

| 消费者 | 请求构造 | 响应解析 |
| --- | --- | --- |
| 前端（直连） | `src/shared/api.ts` 的 `transcribeVoice` 直连分支 | `src/modules/chat/hooks/useVoiceInput.ts`：`res.json()` 取 `data?.text`，**严格**（非 JSON 直接抛） |
| 服务端（代理） | `server/modules/voice/voice.service.ts` 的 `createTranscriptionFormData` | 同一文件：JSON 取 `text`，**解析失败回落原文**，比直连宽松 |
| 命令行 | 不存在 | 不存在 |

两条路径的容忍度已经分叉：同一个上游异常在直连路径上报错，在代理路径上会被当成一段转写文本填进 composer（ADR-004 事实 2 的更正的读数）。AC-129 要终结的正是这个形态：**实现只有一份，三处消费者导入到同一路径**。

### 方案

1. **先做一次有界的落点尝试，由实证决定落点。** ADR-004 决策 2/3 给出两条候选：**(a) 仓库根 `shared/asr/`**（需要为前端造一条别名，登记点在三处：根 `tsconfig.json` 的 `paths`、`vite.config.js` 的 `resolve.alias`、`.oxlintrc.json` 的 import resolver），或 **(b) `src/shared/asr/`**（ADR 的后备方案）。人 yale 2026-09-22 已预先授权 (b) 作为回落，因此本任务可自主跑完并出结论，不必再开第二轮裁定。ADR 决策 2 自陈的一项**未验证前提**（oxlint 的 resolver 能否吃下一条新别名）在本步出结论。
2. **落一份环境中立的实现。** 请求构造与响应解析各一个纯函数，环境依赖（fetch、密钥、baseUrl）一律注入；响应容忍度**显式参数化**，让两条路径各自的容忍度都能被逐字复现 —— 否则会撞上 AC-130 的逐字节基线。实现须同时满足两套 tsconfig 的编译面（根侧 `lib` 只到 ES2020 + DOM、`types` 只有 `vite/client`；服务端侧是 ES2022 + NodeNext）：不得碰 node 内建，也不得用 ES2021+ 的库特性。
3. **三处消费者改为导入它。** 前端两处（`src/shared/api.ts` 的直连分支、hook 里的响应解析）、服务端一处（`server/modules/voice/voice.service.ts`）、命令行新增一处（`experiments/voice-asr-cli/transcribe.ts`，按 ADR 决策 2 落在 `experiments/` 下并以 `npx tsx` 启动）。本步是**纯重构**：不改任何线上字节。
4. **落探针。** `scripts/asr-single-implementation-check.mjs` 逐个消费者**解析其真实的 import 说明符**到绝对路径（不是读一张硬编码清单 —— 读清单正是「判据量工装」的复发形态），断言实现的绝对路径与三处解析结果四者 realpath 相同；再扫全仓生产源，断言不存在第二处构造转写 multipart、也不存在第二处解析转写响应。一个 `--root` 参数让同一份探针能对工装根跑，于是两条取假形态都成为可执行的用例。

### 边界（不做）

不做能力声明与第二个 provider（那是 AC-132/133/134/135 的词）；不做 `--dry-run` / `--offline` 语义（AC-131）；不录逐字节基线（AC-130）；不改两条路径的**线上行为**（字段名、URL、Authorization、两条路径各自的容忍度差异都必须与改前一致）；不把命令行提升为 `cloudcli` 子命令。

## Plan

- **S0 有界尝试 (a) 与落点判定**：最小实现模块落在 `shared/asr/transcriptionWire.ts`，登记三处配置点，并把落点目录加进 `npm run lint` 的路径列表（否则只买到「没被判红」，买不到「被覆盖」）；从 `src/modules/**` 与 `server/modules/**` 各导入一次，跑 `npm run typecheck` 与 `npm run lint`。绿 ⇒ 落 (a)；红 ⇒ 落 (b)，并把红的原始判词（失败行原文）记进 Evidence。AC2 的 `--landing` 读数即本步的产物。
- **S1 落实现**：写实现模块（纯函数 + 注入依赖 + 显式容忍度参数），保持两条路径的线上字节与各自容忍度不变。
- **S2 三处接线**：前端两处、服务端一处改为导入；命令行入口新增为第三个消费者。本步只要求它是**真实消费者**并能在 `npx tsx` 下加载；`--dry-run` / `--offline` 属 AC-131 的任务。
- **S3 落探针与取假控制**：探针 + 其测试；两条取假形态在测试里各成一条独立可红的用例，工装根在测试运行时于临时目录构造（不往仓库里放一份固定的「第二份算法」fixture —— 那会让唯一性扫描自伤）。
- **S4 读数**：逐条跑 AC，把 stdout 落进 Evidence。

## AC

- [ ] AC1 `node scripts/asr-single-implementation-check.mjs` 退出码 0；stdout 逐行给出实现文件的绝对路径与三处消费者（前端、服务端、命令行）各自解析到的路径，四行 realpath 相同，并有一行 `SECOND_IMPL none`。取假形态：任一处改回本地构造 ⇒ 该命令必须红（由 AC3/AC4 的工装用例机械证明）。
- [ ] AC2 `node scripts/asr-single-implementation-check.mjs --landing` 退出码 0；打印 `landing=` 两候选之一，并逐条打印该落点所依赖的配置登记（文件 + 命中行原文）；若落 (b)，同一命令还打印探针在 (a) 上红的原始判词（typecheck / lint 的失败行）。
- [ ] AC3 取假形态 (1)：`node --test scripts/asr-single-implementation-check.test.mjs` 退出码 0，其中一条用例对工装根跑同一探针（前端与服务端各写一份），断言探针非零退出且判词含 `paths differ`。
- [ ] AC4 取假形态 (2)：同一测试文件内另一条独立用例，在工装根里复制一份算法（第二处构造 multipart 或第二处解析转写响应），断言探针非零退出且判词含 `SECOND_IMPL`。
- [ ] AC5 空读数不是绿（正面控制）：同一测试文件内第三条用例，对一个**没有任何实现文件**的工装根跑探针，断言非零退出且判词含 `no implementation`（空 glob 不许退出 0）。
- [ ] AC6 唯一性（生产源）：`node scripts/asr-single-implementation-check.mjs --explain-scan` 退出码 0，打印被扫描的 glob 集合与命中集合（命中集合只含唯一实现文件）；独立读数 `grep -rn --include=*.ts --include=*.tsx "audio/transcriptions" src/ server/ shared/` 去重后的命中文件数为 1。
- [ ] AC7 `npm run typecheck` 退出码 0（根 tsconfig、服务端 tsconfig、scripts tsconfig 三条都在内 —— 同一份实现文件被两套配置同时编译）。
- [ ] AC8 `npm run lint` 退出码 0，且命令打印 oxlint 的路径列表并断言落点目录**在列表内**；取假形态：把落点目录从路径列表里去掉 ⇒ 这一半必须红（「没被判红」≠「被覆盖」）。
- [ ] AC9 纯重构、既有读数不变：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts` 与 `npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts` 各自退出码 0。
- [ ] AC10 命令行消费者可加载：`npx tsx experiments/voice-asr-cli/transcribe.ts` 无参数时打印用法并**非零**退出（断言退出码与用法行文本），证该入口在 ADR 决策 2 声明的启动方式下真的可加载，且其源码经探针解析到同一实现文件。

## DoD

真实落地判据：不是探针文件存在，而是**三处消费者真的经由同一条路径落到同一份线协议实现**，且**判据自己是可红的**。承重性由三组正面读数证明：

(a) **探针解析的是真实的 import 说明符，不是一张清单** —— 对工装根里「前端与服务端各写一份」的形态必红（AC3）；
(b) **唯一性扫描不是空读数** —— 对「工装里复制一份算法」必红（AC4），对「什么都没有」的工装根同样必红（AC5）；空 glob 退出 0 是本仓库已经付过代价的形态，不允许在这里复发；
(c) **纯重构** —— typecheck / lint / 既有语音测试全绿（AC7/AC8/AC9），两条路径各自的字段名与容忍度差异都与改前一致。

本任务**不证明**线上字节逐字节不变 —— 那要录两跳的基线，属 AC-130 的任务；本任务只保证重构不改变行为语义与容忍度分叉。若落 (b)，须如实登记「服务端能否消费该落点」的实测结论，以及它对 GOAL-008 缺口一／三（AC-133／AC-134）的后果。

**若两条落点都无法让三处消费者解析到同一路径**：不得自行放宽判据（例如把消费者从三处改成两处、或把命令行从三处里去掉），必须停在 needs-human 并给出两次尝试的原始判词。

L_D 该轴仍暗，理由：本任务只把一份线协议实现收敛到一处并落一条边界探针，不新增领域数据能力，也没有可读出的领域读数。

L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担，本任务只承担「实现只有一份、三处同一路径」这一条。

## Touches

- shared/asr/transcriptionWire.ts (new)
- src/shared/asr/transcriptionWire.ts (new)
- src/shared/api.ts
- src/modules/chat/hooks/useVoiceInput.ts
- server/modules/voice/voice.service.ts
- experiments/voice-asr-cli/transcribe.ts (new)
- scripts/asr-single-implementation-check.mjs (new)
- scripts/asr-single-implementation-check.test.mjs (new)
- tsconfig.json
- vite.config.js
- .oxlintrc.json
- package.json
- tasks/gap-asr-wire-single-implementation-boundary-probe.md
