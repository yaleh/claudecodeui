---
id: gap-voice-asr-provider-seam-adr
title: ADR-004：语音识别 Provider 缝 —— 环境中立的适配器契约与能力声明（只落设计文档，不实现）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
---
## Proposal

**交付物：一份已落盘设计文档的评审立案，不是实现，也不是新建文档。** `adr/ADR-004-语音识别-provider-缝-环境中立的适配器契约与能力声明.md` 已落盘（frontmatter `status: proposed`）。本任务把它的评审与验收立成一条可判定的任务：核实文档确实承载了九条决策（各带代价与被否决的替代）、十条带判据与取假变体的后续任务草案、能力声明的逐字段出处、以及它与设计提案的分工与权威顺序。**本任务不写代码、不改任何既有实现、不改任何目标或判据。**

**为什么需要这条任务。** 语音链路今天只支持 OpenAI-compatible 一种识别服务，而「支持任意识别服务」是配置层面的假象：协议形状硬编码在三处——客户端直连分支自拼 multipart、服务端代理分支同样、响应只认单字段文本；服务之间的能力差异（内联大小上限、计费单位、是否承认提示词、停顿线索对该识别器是破坏性还是有用）在代码里没有任何地方可以表达。已有实测证据表明这些轴是承重的而非预留：提示词偏置在中文加裁剪下使句读与标识符双双退化；换模型无收益且两语种 CER 都更差；裁剪把中文句读打到接近全失，而 CER 只动约半个百分点，即 CER 对该损失失明。

**文档承载的九条决策**（正文各成一个以「决策 N：」开头的三级小节）：

1. 差异用适配器缝加能力声明表达，不用配置字段表达。
2. 适配器必须环境中立，落点为仓库根 `shared/`（唯一被前后端两套 tsconfig 同时 include 的目录），由此推出四条硬约束。
3. 边界探针是一个闸，且后备方案写死在 ADR 里。
4. 三处既有缺口由能力声明驱动修复，不新增全局常量。
5. 输出信封扩为 text / style / transformations 三字段，指标随之分轴。
6. 上下文偏置默认关闭，按服务分别测。
7. 保留直连拓扑，故 provider id 的真相源必须在用户级配置。
8. 区分「进 AC」与「只进实验记录」。
9. 既有「服务端保持纯透传」是阶段性约束，现提议修订（只提议，不执行）。

**文档还要给出**（否则不足以支撑下一步派工）：能力声明表的逐字段出处；文件布局与边界探针的三步；三处真实缺口各自的修改要求；以及五条评审时优先裁决的开放问题。

**本任务不做**：不实现适配器、不写命令行、不改任何服务端或前端代码；不改 `goals/` 下任何目标或判据；不新增任何阈值；不在正文点名任何未完成任务 id。

**同机制去重结论（仅溯源，非前置）**：`tasks/` 内无同机制任务——按「语音识别 provider / ASR 适配器 / 能力声明」检索无命中。相邻但机制不同的既有语音任务分别处理静音裁剪模块、标识符修复、语音设置存储、录音回放与调试开关，与本任务的「可插拔识别服务缝的设计记录」不是同一机制。

## AC

- [x] AC1 `adr/ADR-004-*.md` 存在，frontmatter 的 `id: ADR-004` 与 `status: proposed` 可按行读出。命令：`ls adr/ADR-004-*.md && head -5 adr/ADR-004-*.md`。失败时输出 `missing ADR-004 file`，或逐行打印实际 frontmatter。取假形态：把 status 擅自改成 accepted 而未经人评审，本判据仍绿——故本判据只覆盖「文件与 frontmatter 存在」，评审状态由 DoD 承担。
- [x] AC2 九条决策各成一个以「决策 N：」开头的三级小节。命令：`grep -c '^### 决策 ' adr/ADR-004-*.md` 必须等于 9，且打印实际计数；不足时逐条打印命中的标题。
- [x] AC3 每条决策都写明代价与被否决的替代。命令：`awk '/^### 决策 /{n++} /^\*\*代价：\*\*/{c++} /^\*\*被否决的替代：\*\*/{a++} END{printf "decisions=%d cost=%d alt=%d\n",n,c,a; if(n!=9||c!=9||a!=9) exit 1}' adr/ADR-004-*.md`，退出码 0。取假形态：删掉任一条决策的「被否决的替代」段使 a 变 8，本判据必须红。
- [x] AC4 后续任务草案为 10 条，且每条带判据与取假变体。命令：`grep -c '^### 后续任务 ' adr/ADR-004-*.md` 等于 10，且 `grep -c '取假变体' adr/ADR-004-*.md` 不小于 10；打印两个实际计数。
- [x] AC5 文档内引用一律用符号名，不出现「文件加行号」的引用形式。命令：`grep -nE '[A-Za-z0-9_/.-]+\.(ts|tsx|js|mjs):[0-9]+' adr/ADR-004-*.md` 无输出（退出码 1）；命中时逐行打印。
- [x] AC6 文档不写本机绝对路径。命令：`grep -nE '/data/(home|scratch)/' adr/ADR-004-*.md` 无输出；命中时逐行打印。
- [x] AC7 设计提案与设计文档互引，且写明冲突时的权威顺序。命令：`grep -c 'voice-asr-provider-seam.md' adr/ADR-004-*.md` 不小于 1，`grep -c 'ADR-004' docs/proposals/voice-asr-provider-seam.md` 不小于 1，且两处都能命中「为准」二字；打印四处实际命中。取假形态：只保留单向引用使其中一条计数为 0，本判据必须红。
- [x] AC8 本任务未产生任何代码、未改动任何既有文档或目标。命令：`git diff --name-only "$(git merge-base develop HEAD)" -- . ':!adr/ADR-004-*.md' ':!tasks/gap-voice-asr-provider-seam-adr.md'` 无输出；命中时逐行打印。用 merge-base 而非裸 develop：develop 会随其它任务的 fan-in 前进，拿裸 develop 比会把别人的提交读成本任务的改动。

## DoD

真实落地判据（不是「文件存在」）：这份 ADR 必须**能被下一步直接引用**——评审判定它的九条决策（含代价与被否决的替代）、能力声明的逐字段出处、文件落点与边界探针（含后备方案）、以及十条带判据与取假变体的后续任务，足以支撑立目标与派工，而**不需要回来补设计**。承重性由三件事正面证明：

(a) 每条决策都点得出替代与代价（AC2/AC3 的读数），而不是单方面陈述；
(b) 文档引用的每处机制都能在代码里按符号名 grep 到（AC5 反向保证它不以易变的行号定位）；
(c) 文档描述的能力**今天确实不存在**——对语音链路做一次「provider / 能力声明 / 适配器」的检索应当无命中。这条空读数既是本任务存在的理由，也防止把已实现的东西重述一遍冒充设计。

另需在完成记录里如实登记两点：三处缺口的现场依据来自一次对语音链路的完整通读（路由、服务、共享配置、客户端采集路径、既有测试与端到端替身），**未做运行期复现**；文档中引用的 20MB、25MB、10 秒下限、−89%、25.5% 等数字均为既有代码、官方文档或既有实验记录里的既成值，本 ADR 未新立任何阈值。

人评审是本任务 DoD 的一部分：结论（通过 / 要求修订）须记录在正文的 Adjudication 小节里；**未获评审前不得置 done**。若评审要求修订，修订落在同一份 ADR 内，本任务的 AC 随修订重跑。

L_D 该轴仍暗，理由：本任务只落一份设计文档并送评审，不新增产品领域能力，也没有可读出的领域读数；判定面由 AC 的文件级机械检查与人的评审承担。
L_G 该轴仍暗，理由：同上——目标层判据（新识别服务在直连、代理、命令行三条路径上真的可换）属于评审通过后另立的目标，本任务不新增 goal 判据。

## Touches

- adr/ADR-004-语音识别-provider-缝-环境中立的适配器契约与能力声明.md
- tasks/gap-voice-asr-provider-seam-adr.md

## 完成记录

**本任务不产生代码、不改任何既有文档。** 交付物是对**已落盘**的 `adr/ADR-004-*.md`（由此前提交落盘，frontmatter `status: proposed`）的评审立案：逐条核实该文档确实承载 Proposal 所列的九条决策、能力声明出处、文件落点与边界探针、以及十条带判据与取假变体的后续任务。以下为逐条实测读数。

**AC1** `ls adr/ADR-004-*.md` → 命中 1 个文件；`head -5` 逐行读出 `id: ADR-004` 与 `status: proposed`。

**AC2** `grep -c '^### 决策 ' adr/ADR-004-*.md` = **9**（等于 9）。

**AC3** `awk '/^### 决策 /{n++} /^\*\*代价：\*\*/{c++} /^\*\*被否决的替代：\*\*/{a++} END{...}'` 读数 `decisions=9 cost=9 alt=9`，退出码 **0**。三类计数均为 9，说明不是靠某几条重复计数凑齐。

**AC4** `grep -c '^### 后续任务 '` = **10**；`grep -c '取假变体'` = **13**（≥10）。13 > 10 是因为第 8、10 条各自带两个方向的变体，属覆盖更严而非重复。

**AC5** `grep -nE '[A-Za-z0-9_/.-]+\.(ts|tsx|js|mjs):[0-9]+' adr/ADR-004-*.md` **无输出，退出码 1** —— 文档内引用一律以符号名给出。

**AC6** `grep -nE '/data/(home|scratch)/' adr/ADR-004-*.md` **无输出，退出码 1**。

**AC7** 互引与权威顺序四处读数：`grep -c 'voice-asr-provider-seam.md'`(ADR) = **1**；`grep -c 'ADR-004' docs/proposals/voice-asr-provider-seam.md` = **1**；`grep -c '为准'` ADR = **2**、提案 = **2**。两个「为准」命中均为权威顺序句而非无关用法：ADR 写「两者不一致时**以本 ADR 为准**」，提案写「两者不一致时**以 ADR 为准**」—— 方向一致、无矛盾。

**AC8** `git diff --name-only "$(git merge-base develop HEAD)" -- . ':!adr/ADR-004-*.md' ':!tasks/gap-voice-asr-provider-seam-adr.md'` **无输出** —— 本任务未触碰任何其它文件。

**DoD 承重性抽查（三件事，均实测）**

(a) **每条决策都点得出替代与代价** —— AC3 的 9/9/9 即该读数的机器形式；抽查决策 3 的代价写明「探针读数可判据化，但其结论（落点是否成立）是人读的」，替代写明「先按 `server/modules/voice/providers/` 开工」及其二选一后果，不是单方面陈述。

(b) **文档引用的机制按符号名可 grep 到**（逐条命中，故 AC5 禁行号不削弱可定位性）：`transcribeVoice` → `src/modules/chat/hooks/useVoiceInput.ts`；`resolveVoiceConfig` → `server/modules/voice/voice.service.ts`；`shared/networkHosts.js` → `server/index.ts`；`provider.registry` → `server/modules/providers/`；`AbstractProvider` → `server/modules/providers/README.md`；`voiceTrim.ts` → `src/modules/chat/utils/audioDecode.ts`。

(c) **文档描述的能力今天确实不存在**（空读数，既是本任务存在的理由，也防止把已实现的东西重述冒充设计）：`AsrCapabilities`、`asrRegistry`、`asrContract` 在 `src/`、`server/`、`shared/` 内命中数**均为 0**；`server/modules/voice/` 内 `provider|adapt` 只有 1 处命中，且是既有 SSRF 测试名 `blocks link-local metadata destinations before calling the fetch adapter`，与识别服务 provider 缝无关。故「能力声明 / 适配器缝」在语音链路上确无实现。

**DoD 另要求登记的两点**已由 ADR 正文 `## 完成记录` 承载并复核：三处缺口的现场依据来自对语音链路的一次完整通读（路由、服务、共享配置、客户端采集路径、既有测试与端到端替身），**未做运行期复现**；文中引用的 20MB、25MB、10 秒下限、−89%、25.5% 均为既有代码、官方文档或既有实验记录里的既成值，**本 ADR 未新立任何阈值**。

**scoped gate** `bash scripts/test.sh --for-task gap-voice-asr-provider-seam-adr --allow-thin` 退出码 **0**，输出 `no scoped test files for gap-voice-asr-provider-seam-adr (thin)` —— 本任务 `## Touches` 不含 `*.test.*`，thin 即该项的通过形态，非跳过失败。

**未决（人评审）**：DoD 明确「人评审是本任务 DoD 的一部分……未获评审前不得置 done」。ADR 的 `## Adjudication` 小节已就位并写明「**状态：待评审**」，并列出五条建议优先裁决的开放问题。本次只勾 AC，**不置 done** —— 评审结论（通过 / 要求修订）须由人记入该小节，若要求修订则落在同一份 ADR 内、AC 随修订重跑。
