---
id: gap-voice-error-classification-and-status-table
title: 适配器按响应体错误码串分类为稳定 code（403 Unpurchased 与 400 Arrearage 归
  ACCOUNT_ACCESS、429 配额类归 QUOTA_EXHAUSTED、5xx/超时/连不上归 UPSTREAM_UNAVAILABLE），词汇表
  13 码且状态表恰有一行，同 400 不同码串必须不同（AC-149）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-149
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rn "^goal_ac: *AC-149" tasks/*.md` → 0 命中；全量 163 条任务里 `goal_ac` 等于 `AC-149` 的 0 条；`ls server/modules/voice/tests/voice-error-classification.test.ts` → `No such file or directory`；`grep -rn "classifyUpstreamFailure\|ASR_ERROR_CODES\|ACCOUNT_ACCESS" shared/ server/ src/ scripts/` → 0 命中（新词汇表一个字都还没进树）。在飞的两条任务（`gap-ac103-worktree-state-drag-and-unbudgeted-confirm`、`gap-asr-cli-dry-run-offline-replay`）与本条机制无关；同族另外四条判据（AC-150 契约 / AC-151 文案 / AC-152 单一实现 / AC-153 真实浏览器）都还没有任务认领，本条只认领「分类与状态表」这一格。

**这条判据要的是什么（AC-149 原文拆开）**

1. 分类依据是**响应体里的错误码串**，响应体里没有码串时才按状态兜底；表外的码串落到兜底而不是被错误归类。
2. 逐行的（上游状态、响应体码串）→ 预期 code：`AccessDenied.Unpurchased`@403 与 `Arrearage`@400 → `ACCOUNT_ACCESS`；`InvalidApiKey`@401 与不带任何已知码串的 403 → `UNAUTHORIZED`；`AllocationQuota.FreeTierOnly`@429 与 `Throttling.AllocationQuota`@429 → `QUOTA_EXHAUSTED`；`Throttling.RateQuota`@429 → `RATE_LIMITED`；`ModelNotFound`@404 → `MODEL_NOT_FOUND`；`InvalidParameter` 且指向音频时长@400 → `AUDIO_REJECTED`；`DataInspectionFailed`@400 → `CONTENT_FLAGGED`；5xx、超时、连不上 → `UPSTREAM_UNAVAILABLE`；格式正确但既无指令也无转写的答案 → `NO_SPEECH_DETECTED`。
3. **同为 400 但码串不同的两行必须得到不同的 code**（这一条就是「只按状态分类」的取假形态）。
4. 码到 HTTP 状态的表对词汇表里的每个 code **恰有一行，不多不少**。

**现状（立案时实测，可复验）**

| 项 | 实测 |
|---|---|
| 判据文件 | 不存在（见上） |
| 分类实现 | **每个适配器各一份**：`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts:569`、`shared/asr/list/multimodal/multimodal.asr-provider.ts:449`、`shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts:148` 三个同名 `errorCodeForStatus(status)`，都只读状态（`401\|403→UNAUTHORIZED`、`429→RATE_LIMITED`、其余 `UPSTREAM_ERROR`）——**响应体一个字节都不看**，所以 `AccessDenied.Unpurchased` 与普通 403 同码、`Arrearage` 与 `DataInspectionFailed` 同码 |
| 词汇表 | `shared/asr/asrRegistry.ts:132-142` 的 `AsrErrorCode` = NOT_CONFIGURED / INVALID_BASE_URL / UNAUTHORIZED / RATE_LIMITED / TIMEOUT / UNREACHABLE / OVERSIZE / UNSUPPORTED_MIME / NO_SPEECH_DETECTED / UPSTREAM_ERROR；没有 ACCOUNT_ACCESS / QUOTA_EXHAUSTED / MODEL_NOT_FOUND / AUDIO_REJECTED / CONTENT_FLAGGED / UPSTREAM_UNAVAILABLE |
| 状态表 | `voice.service.ts:349` 的 `PROVIDER_ERROR_STATUS`，10 行，与今天的词汇表等长（类型 `Readonly<Record<AsrErrorCode, number>>` 只保证**不缺**，不保证**不多**） |
| 状态表的唯一例外 | `voice.service.ts:375-381` 的 `providerFailureStatus`：`UPSTREAM_ERROR` 且带 `status` 的失败按上游状态原样放行（AC-139 的判据读的就是这一格：`passthrough upstream=404 client=404`） |
| 会被本条顶到的既有读数 | (a) `scripts/asr-dashscope-omni-check.mjs:1204-1208`（AC-138 的判据：`403-unpurchased→UNAUTHORIZED`、`500→UPSTREAM_ERROR`）与 `:1259` 超时钉 `TIMEOUT`、`:1287` 连不上钉 `UNREACHABLE`；(b) `server/modules/voice/tests/voice-provider-dispatch.test.ts:365-487`（AC-139 的判据）驱动 `TIMEOUT`/`UNREACHABLE`/`UPSTREAM_ERROR` 并逐项钉 `PROVIDER_ERROR_STATUS` 的数；(c) `shared/asr/asrInvariants.ts:1037-1047` 的错误行（500/503/400→`UPSTREAM_ERROR`、transport→`UNREACHABLE`、timeout→`TIMEOUT`），被 `src/shared/asr/tests/asrContractInvariants.test.ts` 与 `scripts/asr-contract-invariants-check.mjs` 两个 runner 驱动；(d) 两处取假形态按**源码行**变异：`scripts/asr-contract-invariants-check.test.mjs:167-191`、`scripts/asr-dashscope-omni-check.test.mjs:266-267` |
| 类型期的边界 | `PROVIDER_ERROR_STATUS` 是 `Readonly<Record<AsrErrorCode, number>>` ⇒「缺一行」在 `npm run typecheck` 就红；「多一行」只有运行期读键集才红——而词汇表今天是 type union，运行期被擦除 ⇒「恰有一行」这条读数**需要一个运行期词表**可读 |
| 类型使用的其它落点 | `server/shared/types.ts:1418` 的 `code?: AsrErrorCode`（外部形状不变，本条不动它）、`server/modules/voice/voice-capture.ts:486` 的 `input.code === 'UPSTREAM_ERROR'` 从句、`src/shared/asr/tests/asrContractInvariants.test.ts:49,102` 从 multimodal 适配器 import 的 `errorCodeForStatus` 与它自带的替身（`TIMEOUT`/`UNREACHABLE`/`UPSTREAM_ERROR` 三个字面量） |

**词汇表（本条定死，13 个 code）**

`ACCOUNT_ACCESS`（新：未开通 / 欠费 / 授权失效）· `UNAUTHORIZED` · `QUOTA_EXHAUSTED`（新：免费额度或配额耗尽）· `RATE_LIMITED` · `MODEL_NOT_FOUND`（新）· `AUDIO_REJECTED`（新）· `CONTENT_FLAGGED`（新）· `NO_SPEECH_DETECTED` · `UPSTREAM_UNAVAILABLE`（新：**合并**今天的 5xx、超时、连不上）· `NOT_CONFIGURED` · `INVALID_BASE_URL` · `OVERSIZE` · `UNSUPPORTED_MIME`。

⇒ `TIMEOUT` / `UNREACHABLE` / `UPSTREAM_ERROR` 从词汇表里**消失**。这不是顺手清理：AC-149 的夹具行原文就是「5xx、超时、连不上都是 UPSTREAM_UNAVAILABLE」，留着三个旧 code 会让同一条件有两个 code，而 AC-152 之后还要求直连与代理两条路径对同一上游失败给出**同一个** code；`docs/proposals/voice-error-messages.md:83` 的词汇表「沿用」一栏也只列了 NOT_CONFIGURED / INVALID_BASE_URL / OVERSIZE / UNSUPPORTED_MIME。

**要交付的事**

1. **词汇表与运行期词表只有一处**（`shared/asr/asrRegistry.ts`）：`AsrErrorCode` 改成上面 13 个；同一文件导出运行期常量（名字由实现定，如 `ASR_ERROR_CODES`），并对它做静态对齐（`satisfies` / `Record<AsrErrorCode, true>` 一类），使「union 与运行期数组不一致」在 `npm run typecheck` 就红。运行期词表是「状态表恰有一行」这条读数的**唯一**来源：判据不再另抄一份字符串数组。
2. **分类只有一份实现，且落在 registry 里**（不在适配器里）：一个纯函数（名字由实现定），入参是**上游状态（可能缺席）＋响应体文本**，出参 `AsrErrorCode`。放这里的两个理由要写进注释：(a) 直连路径与代理路径都要用它（AC-152 读的是两条路径同码）；(b) 适配器从 registry 取 `baseMimeType`/`declaredAcceptsMime` 已经是一条值边，反方向再让 registry 引适配器就成环（`server/modules/voice/tests/voice-provider-dispatch.test.ts:17-37` 记了这个 TDZ）。三个适配器各自那份映射的**逻辑**由它取代；是否保留同名导出由实现定，但保留的那份只能是**转发**，不得再有自己的映射表。
3. **码串表（响应体优先）**：`AccessDenied.Unpurchased`→ACCOUNT_ACCESS；`Arrearage`→ACCOUNT_ACCESS；`InvalidApiKey`→UNAUTHORIZED；`AllocationQuota.FreeTierOnly`→QUOTA_EXHAUSTED；`Throttling.AllocationQuota`→QUOTA_EXHAUSTED；`Throttling.RateQuota`→RATE_LIMITED；`ModelNotFound`→MODEL_NOT_FOUND；`DataInspectionFailed`→CONTENT_FLAGGED；`InvalidParameter` 且文本指向音频时长（含 `audio` / `duration` / `seconds` 之一，或官方那句 `1 to 300`）→AUDIO_REJECTED。匹配是**子串**匹配（上游把码串包在 `error.code` 或消息里，夹具形状见 `scripts/asr-dashscope-omni-check.mjs:1199-1201`），但**顺序敏感**：`Throttling.AllocationQuota` 与 `AllocationQuota.FreeTierOnly` 必须先于任何更宽的 `Allocation` 规则判定，`Throttling.RateQuota` 不得被更宽的 `Throttling.` 规则抢走——用「长码串优先」还是别的手段不限，判据只读结果。
4. **状态兜底（表外的码串与无码串都落这里，不误归类）**：401/403→UNAUTHORIZED（AC-149 原文点名「不带任何已知码串的 403」是 UNAUTHORIZED）；429→RATE_LIMITED；其余（其它 4xx、5xx、408、以及**没有状态**的连不上 / 超时）→UPSTREAM_UNAVAILABLE。⇒ `AccessDenied.Unpurchased` 之外的 403 仍是 UNAUTHORIZED，`Throttling.*`/`AllocationQuota.*` 之外的 429 仍是 RATE_LIMITED：这两格正是让 AC-138 的 `403-plain` 与 `429` 两条既有读数不被顶掉的原因。
5. **状态表补齐且恰有一行**（`voice.service.ts` 的 `PROVIDER_ERROR_STATUS`）：13 行，键集逐字等于运行期词表。既有数**一个都不许动**（别的判据钉着）：`NOT_CONFIGURED 503`、`INVALID_BASE_URL 400`、`UNAUTHORIZED 502`、`RATE_LIMITED 429`、`OVERSIZE 413`、`UNSUPPORTED_MIME 415`、`NO_SPEECH_DETECTED 422`（`voice-provider-dispatch.test.ts:477-482` 逐项钉，且 `voice-provider-dispatch-falsify.test.ts:101` 的变异体锚的就是 `  UNAUTHORIZED: 502,` 这一行原文）。新增行的数由实现定，但必须让「带的失败按上游状态放行」那一格继续成立：`providerFailureStatus` 的例外从句从 `UPSTREAM_ERROR` 改名到 `UPSTREAM_UNAVAILABLE`（`voice-provider-dispatch.test.ts:504-512` 的 `passthrough upstream=404 client=404` 是这条读数的既有形态）。
6. **三个适配器接到同一份分类上**：`dashscope-omni`（响应分支把响应体文本交给分类器；`AccessDenied.Unpurchased` 的**文案**分支与 `isModelNotPurchased` 保留——`scripts/asr-dashscope-omni-check.mjs:1236-1249` 读的是「未开通/余额不足」这句文案与两条文案互不相同，只有 code 换）、`multimodal`、`openai-compatible`（后两者 abort / 连不上分支同样落 `UPSTREAM_UNAVAILABLE`）。抽掉的三段 per-adapter 映射不得以第二张表的形式留在任何地方。
7. **判据文件**（`server/modules/voice/tests/voice-error-classification.test.ts`，AC-149 的 `criterion:` 文件，只有这一个文件能认领该判据）：夹具表逐行；同状态不同码的分组断言；状态表键集与运行期词表的**双向**相等；再用一个**离线替身 fetch** 把出货的 dashscope 适配器按同一批（状态、响应体）驱动一遍，读到的 code 与纯函数、与夹具预期逐行相同（否则那张夹具表只是在描述一个没人用的函数——替身形状沿用 `voice-provider-dispatch.test.ts`）。**导入形状**：`from '../../../../shared/asr/asrRegistry.js'`（NodeNext 要求 `.js` 后缀，与 `voice-provider-dispatch.test.ts:40` 同形）；**不要静态 import dashscope 适配器**（registry↔adapter 是值边、成环，静态进入会在 registry 初始化前求值 → TDZ），要驱动它就用顶层 `await import(...)`（同文件 `:37` 的形状）。
8. **取假形态是可执行旁证**（`server/modules/voice/tests/voice-error-classification.false-forms.test.ts`，三段形状沿用 `voice-capture-audio.false-forms.test.ts`：未变异副本先绿 → 变异体在预测族里红一条并打印红的是哪一条 → 族外至少一条仍绿；变异体写在与被测文件同树的临时路径、跑完即删、`git status --porcelain` 不变）：
   - (i) `status-only`：分类改回只读状态（等价于今天的 `errorCodeForStatus`）⇒ 同为 400 的两行（`Arrearage` vs `DataInspectionFailed`）必须红，429 三行也必须塌成两码；
   - (ii) `429-all-rate-limited`：`429` 一律 `RATE_LIMITED` ⇒ 两条 QUOTA_EXHAUSTED 行必须红；
   - (iii) `table-missing-a-code` / `table-extra-a-code`：状态表删一行、加一行 ⇒ 键集相等那条读数必须红（缺与多各一例）。
9. **既有面不退化（逐条打印退出码，不是空过）**：被词汇表变更顶到的既有读数在**同一次改动**里改成新词汇表下的正确期望——`shared/asr/asrInvariants.ts` 的错误行、`src/shared/asr/tests/asrContractInvariants.test.ts` 的替身适配器、`scripts/asr-dashscope-omni-check.mjs` 的 `statusCases` 与超时 / 连不上两行、`scripts/asr-dashscope-omni-check.test.mjs` 与 `scripts/asr-contract-invariants-check.test.mjs` 的按行变异、`server/modules/voice/tests/voice-provider-dispatch.test.ts` 的三个驱动与逐项钉的数、`voice-capture.ts:486` 的从句。这些文件是**同一次语义变更的落点**，不是顺手改：每一处只把旧 code 换成新词汇表下的对应 code，读数结构、判据语义与取假形态一个都不放松；改了哪一行、原来钉什么、现在钉什么，写进完成记录。

**边界（不做）**：不做 ADR-004 词汇表修订与 `voice.service.ts` 里「传输层失败不带码」注释的更新（GOAL-011 的范围内事，由契约那条任务承担）；不做路由响应体带 `code` / `upstreamCode`（AC-150）；不做十二语言文案（AC-151）；不把分类另抄一份给直连路径（AC-152 的读数）；不做真实浏览器（AC-153）；不改 `voice.transcribe` 日志行的逐字节形状（AC-143）；不改识别行为、提示词（`PROMPT_VERSION`）与模型；不加失败重试、不做上传前静音检查；不改 `acceptsMime` 契约、不改 `server/shared/types.ts` 的 `code?: AsrErrorCode` 形状；不联网、不跑真实 DashScope。

## AC

- [ ] AC1 判据入口与预算：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.test.ts` 退出 0；判据自身零子进程、零真实监听端口、零网络（离线替身 fetch）；末尾打印 `elapsed-ms=<n>`，实测 < 15000（目标侧判据门 60 秒硬上限且不可调）。打印 `subprocess-or-socket-imports=<n>`。
- [ ] AC2 夹具逐行：AC-149 原文那 12 类行各一条，逐行打印 `row=<上游状态>|<码串> expected=<code> observed=<code>` 并断言相等。必须覆盖：403 `AccessDenied.Unpurchased`→ACCOUNT_ACCESS、400 `Arrearage`→ACCOUNT_ACCESS、401 `InvalidApiKey`→UNAUTHORIZED、403 无码串→UNAUTHORIZED、429 `AllocationQuota.FreeTierOnly`→QUOTA_EXHAUSTED、429 `Throttling.AllocationQuota`→QUOTA_EXHAUSTED、429 `Throttling.RateQuota`→RATE_LIMITED、404 `ModelNotFound`→MODEL_NOT_FOUND、400 `InvalidParameter`+音频时长→AUDIO_REJECTED、400 `DataInspectionFailed`→CONTENT_FLAGGED、500 与 503 各一条→UPSTREAM_UNAVAILABLE、408→UPSTREAM_UNAVAILABLE、连不上（transport reject）→UPSTREAM_UNAVAILABLE、超时（AbortError）→UPSTREAM_UNAVAILABLE、200 且 envelope 里既无 instruction 也无 transcript→NO_SPEECH_DETECTED。**表外码串兜底**另一条：403 带一个不在码串表里的码（如 `SomethingElse.New`）→UNAUTHORIZED（不是被猜成别的 code）。打印 `rows=<n> matched=<n> unknown-code-fallback=<code>`。
- [ ] AC3 同状态不同码必须不同（「只按状态分类」的直接读数）：按状态分组后断言 400 组内码集大小 ≥ 2 且 `Arrearage` 与 `DataInspectionFailed` 两行码不等；429 组内码集大小 == 2 且两条 QUOTA_EXHAUSTED 与 `Throttling.RateQuota` 那条不等；**正对照**：同状态同码的两行确实存在（401 与 403 无码串同为 UNAUTHORIZED），使「不等」不是空集上的断言。打印 `status=400 codes=<a,b> status=429 codes=<c,d> distinct400=<n> distinct429=<n> same-code-control=<b>`。
- [ ] AC4 状态表对词表恰有一行（不多不少）：从 registry 读运行期词表、从 `voice.service.ts` 读 `PROVIDER_ERROR_STATUS`，断言两者排序后**逐字相等**且 `length === 13`；逐行打印 `table-row <CODE>=<status>`；再断言词表里每个 code 都能索引到且不是 `undefined`。打印 `vocab=<n> table=<n> sameSet=<b> missing=<…> extra=<…>`。
- [ ] AC5 分类只有一个实现、且是出货适配器在用的那一份：判据用离线替身 fetch 把出货的 **dashscope 适配器**按 AC2 的全部（状态、响应体）夹具驱动一遍（`await import(...)` 动态进入），断言适配器读到的 code 与纯函数、与 AC2 预期三者逐行相同；并读源码断言三个适配器里不再存在各自的映射表（三份 per-adapter 映射要么不存在、要么函数体只有一次转发调用）。打印 `adapter=<id> rows=<n> adapter-vs-pure-same=<b> per-adapter-tables=<n>`。
- [ ] AC6 取假形态可执行：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.false-forms.test.ts` 退出 0；三例各自「未变异副本先绿 → 变异体在预测族里红一条并打印红的是哪一条 → 族外仍绿」，并逐例指名：`status-only` 红同 400 两行与 429 组、`429-all-rate-limited` 红两条 QUOTA_EXHAUSTED、状态表缺一行与多一行各红键集相等那条；跑完 `git status --porcelain` 与本文件启动时逐字相同、无临时副本残留。打印 `mutation=<name> baseExit=0 mutantRed=<b> whichReading=<…> outsideFamilyGreen=<b>`。
- [ ] AC7 既有面不退化（逐条打印 `exit=<n> name=<…>`，不是空过）：`voice-provider-dispatch.test.ts`（AC-139 的判据，含其 `passthrough upstream=404 client=404` 与 `UNAUTHORIZED: 502` 锚）、`voice-provider-dispatch-falsify.test.ts`（AC-139 的取假形态）、`src/shared/asr/tests/asrContractInvariants.test.ts`、`node scripts/asr-dashscope-omni-check.mjs`（AC-138 的判据）、`node scripts/asr-contract-invariants-check.mjs` 各退出 0；`voice.service.test.ts`、`voiceHealth.test.ts`、`voice-config.routes.test.ts`、`voiceTranscribeGaps.test.ts`、`voice-capture-off.test.ts`、`voice-capture-text.test.ts`、`voice-capture-audio.test.ts` 各退出 0；`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json`）与 `npm run lint` 退出 0。
- [ ] AC8 词汇表与运行期词表同源（类型期读数）：判据打印 `shared/asr/asrRegistry.ts` 里那次静态对齐的构造存在（读源码一行即可），并如实说明它是类型期而非运行期读数；实测旁证：临时删掉 union 里一个 code 而运行期数组不动（或反之）⇒ `npm run typecheck` 必红。打印 `alignment=<构造名> typecheck-reds-on-drift=<b>`。
- [ ] AC9 如实登记：判据输出与本任务完成记录里写明「本条只做词汇表、单一分类函数、三个适配器的接线、状态表补齐与三处取假形态；未做 ADR-004 修订、路由响应体的 `code`/`upstreamCode`（AC-150）、十二语言文案（AC-151）、直连路径的统一（AC-152）、真实浏览器（AC-153）；未改 `voice.transcribe` 行形状；未联网、未跑真实上游」。

## DoD

真实落地判据：不是「多了一张码串表」，而是**出货的三个适配器**对同一批（上游状态、响应体）夹具真的给出 AC-149 逐行点名的那些 code——由执行读数证明，不由段落文字声明。承重性由四件读数证明：

(a) **响应体优先于状态**（AC2/AC3）：`AccessDenied.Unpurchased`@403 与无码串@403 在同一次运行里读到**两个不同**的 code，`Arrearage`@400 与 `DataInspectionFailed`@400 也是；取假形态 (i) 指名打红同 400 的两行——「按状态分类」与「按码串分类」是两条读数。

(b) **429 不是一码**（AC2/AC3 + 取假形态 (ii)）：两条配额类与一条频率类三行落在**两个** code 上，取假形态 (ii) 指名打红 QUOTA_EXHAUSTED 那两行。

(c) **表与词表互为倒影**（AC4 + 取假形态 (iii)）：键集相等是双向读数，缺一行与多一行各有一例打红；词表来自 registry 的运行期常量，判据不另抄一份。

(d) **夹具不是描述**（AC5）：同一批夹具再经**出货的 dashscope 适配器**（离线替身 fetch）跑一遍，逐行同码——纯函数与适配器之间不允许有第二张表。既有绿读数（AC-139 的 `UNAUTHORIZED: 502` 锚与 404 放行、AC-138 的 `403-plain`/`429` 行与两条文案互不相同）在改动后逐条仍绿，由 AC7 的退出码读出。

**跨判据的连带改动必须如实登记**：`TIMEOUT`/`UNREACHABLE`/`UPSTREAM_ERROR` 三个 code 从词汇表消失是本条交付的一部分（AC-149 的夹具行原文要求超时 / 连不上落 UPSTREAM_UNAVAILABLE），因此 AC-138 的判据脚本与 AC-139 的判据测试里钉着这三个 code 的行必须在**同一次改动**里改成新词汇表下的期望值，且只改期望值、不放松任何读数结构；这两处改动在完成记录里逐条列出（改了哪一行、原来钉什么、现在钉什么）。

**已知不等价点**：官方错误码页是通用表，`InvalidParameter`＋音频时长那一行对 `qwen3.8-omni-flash` 是否适用没有验证（提案 `docs/proposals/voice-error-messages.md:137` 已记），所以码串表按**子串**匹配 + 状态兜底，表外的码串一律落兜底。判据跑在离线替身 fetch 上，不等于真实 DashScope 的响应体形状。

L_D 该轴仍暗，理由：本条读数全是枚举与集合相等（code 字符串、键集大小），没有可比的数值量。
L_G 该轴仍暗，理由：目标层的读数是真实浏览器里页面上的文案与提示持续显示（AC-153），本条只到适配器与状态表。

## Touches

- shared/asr/asrRegistry.ts
- shared/asr/asrInvariants.ts
- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
- shared/asr/list/multimodal/multimodal.asr-provider.ts
- shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/voice-capture.ts
- server/modules/voice/tests/voice-error-classification.test.ts (new)
- server/modules/voice/tests/voice-error-classification.false-forms.test.ts (new)
- server/modules/voice/tests/voice-provider-dispatch.test.ts
- src/shared/asr/tests/asrContractInvariants.test.ts
- scripts/asr-dashscope-omni-check.mjs
- scripts/asr-dashscope-omni-check.test.mjs
- scripts/asr-contract-invariants-check.test.mjs
- tasks/gap-voice-error-classification-and-status-table.md
