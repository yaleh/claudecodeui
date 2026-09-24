---
id: gap-asr-proxy-provider-dispatch
title: 服务端代理按 provider 分派到适配器：dashscope-omni 的请求进它自己的适配器（替身读到 chat/completions 的
  JSON 体），openai-compatible 的 multipart 线上字节与宽松解析逐字节不变，AsrErrorCode→HTTP
  映射十项各有读数（AC-139）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-dashscope-omni-wire-and-degradation
goal_ac: AC-139
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不引入任何被当作要求的前置；真正的前置是 frontmatter 的 depends_on）：立案时 `grep -rn "^goal_ac:.*AC-139" tasks/*.md` 零命中；`AC-139` 在 `tasks/` 下只出现在两条同族任务的范围让渡文字里 —— `tasks/gap-asr-omni-prompt-frozen-snapshot.md`（`goal_ac: AC-137`）与 `tasks/gap-asr-dashscope-omni-wire-and-degradation.md`（`goal_ac: AC-138`），后者边界原文即「本任务不把适配器注册进 `REGISTERED` —— 注册与「服务端按 provider 分派」是 AC-139 的范围」「不改 `voice.service.ts`（AC-139）」。也就是说：适配器本体与线协议那半条由那两条产出，本条是它们白纸黑字让出的那一半，不是它们的重述。

**现状（立案时实测，可复验）**：

| 缺什么 | 实测 |
|---|---|
| 判据文件 | `ls server/modules/voice/tests/` = `voice-config.routes.test.ts` / `voice.service.test.ts` / `voiceHealth.test.ts` / `voiceTranscribeGaps.test.ts`，**没有** `voice-provider-dispatch.test.ts` |
| 分派 | `server/modules/voice/voice.service.ts` 的 `transcribe` 自己调 `createTranscriptionRequest(...)` 造 multipart 体（约 `:335`）；全文件不出现 `adapter.transcribe` / `AsrInvocation`，解析出的 `adapter` 只被用来做 MIME 与预算两个闸 |
| 注册 | `shared/asr/asrRegistry.ts:262-275` 的 `REGISTERED` 只有 `openai-compatible` 与 `multimodal-v2` 两条，`tryResolve('dashscope-omni')` 返回 `null` |
| 错误映射 | 无「码→HTTP」表：`backendFailure` 按上游**数字**就地判断（401/403→502），`unreachableBackendFailure` 按 AbortError 判断（→504），`AsrErrorCode` 只出现在两处预先拒绝里（`containerRefusal` 415 / `budgetRefusal` 413） |
| 适配器本体 | 由 AC-137（四条提示词常量）与 AC-138（`capabilities` / `transcribe` / `wire: 'chat-audio'`）产出，本条不重新实现 |

**本任务做什么（一条判据两条命令，逐条对应 AC-139 的 `criterion:`）：**

1. **注册（追加在末尾，不是插到首位）**：`REGISTERED` 追加 `dashscope-omni` 一条，`capabilities` / `transcribe` 从 AC-137/138 落下的模块按名导入。**必须追加在末尾**：注册顺序是承重的（`asrRegistry.ts:247-261` 与 `voice.service.ts` 里 `effectiveProviderId` 的注释）—— 首条是「未点名 provider 时生效的那一个」，`scripts/asr-pause-cues-source-check.mjs` / `scripts/asr-trim-capability-check.mjs` / `getHealth().provider` / 客户端的 `DEFAULT_*PROVIDER` 回退都读首条。把 dashscope-omni 插到首位会改掉默认识别器（GOAL-009 非目标「不改变默认识别器」）并把这些读数一起改掉。

2. **分派（`voice.service.ts` 的 `transcribe`）**：解析出的 `adapter` 不再只用来做两个闸，而是**由它发请求** —— 组装 `AsrRequest` + `AsrInvocation`（`baseUrl` / `apiKey` / `model` 取自既有配置解析，`timeoutMs` 取自依赖，`fetchImpl` 接到既有的 `fetchBackend` 依赖上），把 `AsrResult` 映射回 `VoiceServiceResult`。两个预先闸（415 / 413）留在原处 —— 它们是既有 AC 的读数，且在发请求之前。

3. **错误映射逐项**：`AsrErrorCode` 的十个成员各占一行，写成一张显式的表并逐项断言。**今天的值不在表里被改动就是硬约束**：`NOT_CONFIGURED`→503、`INVALID_BASE_URL`→400、`UNAUTHORIZED`→502（今天 401/403→502）、`TIMEOUT`→504、`OVERSIZE`→413、`UNSUPPORTED_MIME`→415 必须逐字保持；且上游非 2xx 今天按自身状态透传（`backendFailure`），适配器的 `AsrFailure.status` 带着那个数字，这张表要能把它透传出去（例如上游 404 到客户端仍是 404）—— 这六项与透传这一条不进表，就是把线上行为改了。其余四个码（`RATE_LIMITED` / `UNREACHABLE` / `NO_SPEECH_DETECTED` / `UPSTREAM_ERROR`）是新的，实现者定值即可，但必须进表、必须有断言、且判据要把值打印出来。

4. **字节与宽松解析不变（AC 的另一半，也是最容易被做丢的一半）**：`scripts/asr-extraction-parity-check.mjs` 的四组基线（`inbound` / `direct-outbound` / `proxy-outbound` / `response-tolerance`）必须继续 `equal`，且**不得重录基线**（重录等于把改动后的行为当作基线）。基线把三件事钉死了，分派必须在它们之下仍然成立：
   - `proxy-outbound`：`{baseUrl}/audio/transcriptions` + `Authorization: Bearer <key>` + 边界归一化后逐字节的 multipart 体（`file` 部分含文件名与 Content-Type、`model` 部分）；
   - `response-tolerance.proxy` 五例：非 JSON body **当文本**、`{"text":"…"}`、`{"text":0}`、无 `text`、`null` 各给出 `ok` 与基线里那个字符串（`null` 那例是 `'null'`：宽松分支先读 `text()`、JSON.parse 抛错后回落到原文）；
   - **空文本是成功**：今天代理对空文本返回 `ok` + 空串，而 `openai-compatible` 适配器的 `transcribe` 在空文本上返回 `NO_SPEECH_DETECTED`。**因此「整条路径一律换成 `adapter.transcribe` 再照搬其语义」会直接让这半条基线变红** —— 宽松容忍度必须随调用一起传下去（例如 `AsrInvocation` 增一个可选 `tolerance`，缺省 `'strict'` 保持直连路径今天的行为；`AsrInvocation` 今天的构造者只有不变量板与测试/实验，新增可选字段向后兼容）。另一个可行机制是按 `adapter.wire` 分流（multipart 那条沿用既有构造），但它同样必须让 dashscope-omni 的用例红得起来才成立。两种机制本条都接受，判据只看下面的读数。

5. **判据与取假形态**：`server/modules/voice/tests/voice-provider-dispatch.test.ts`（`criterion:` 逐字指定的路径），`node:test`，`tsx --tsconfig server/tsconfig.json --test` 运行（与同目录四个文件同形、同注入 `fetchBackend` 替身、不联网）。取假形态「代理路径仍写死 multipart ⇒ dashscope-omni 用例必须红」必须是**可执行用例**（AC7），且**不放进 criterion 文件本身** —— 目标层判据门对 criterion 有 60 秒硬上限且不可上调；criterion 保持只读读数（实测本机 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts` 0.65s、`node scripts/asr-extraction-parity-check.mjs` 0.75s，余量充足，不要把子进程塞进 criterion）。

**承接 AC-138 的一条已存在读数（本条注册的强阳性对照）**：`scripts/asr-second-adapter-check.mjs` 的 AC6 要求**磁盘上每个 provider 模块都能被注册表按 id 解析出来**，且返回的 `capabilities` 与模块导出逐字段相同。AC-138 落下 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` 后、本条注册之前，这条检查是红的；本条注册之后它绿 —— 它既是「注册真的发生了」的读数，也是「注册的声明就是模块自己那份」的读数（`capabilities` 不得在注册表里重写一遍）。

**边界（不做）**：不加 `transport` 字段与 SSRF 主机白名单、不做 proxy-only 在直连路径零请求（AC-140）；不加用户配置（`providerId` / dashscope key / 工作空间地址 / 模型）、key 掩码、健康检查的 `configured` 语义（AC-141）；不做前端与浏览器端到端（AC-142）；不改 `shared/asr/list/dashscope-omni/*` 的线协议、解析降级与错误码（AC-137/138 的范围），不改不变量板的 `chat-audio` 行与其探针（AC-138）；不改直连路径（`src/shared/api.ts` 的 `transcribeVoice` 与 `parseTranscriptionResponse` 今天都是 `strict`）；不重录、不编辑 `scripts/__fixtures__/asr-extraction-parity-baseline.json`，不改 `scripts/asr-extraction-parity-check.mjs`，不改 `experiments/voice-asr-parity/` 的两个 reader（它们是判据的观测者）；不联网（替身 + 注入的 `fetchBackend`）。

## AC

- [ ] AC1 主读（criterion 第一条命令）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-provider-dispatch.test.ts` 退出 0；输出含 `fail 0`，且每条用例的名字点在它量的是哪条 provider 的哪个形状（不得是同一个断言换个名字）。
- [ ] AC2 dashscope-omni 走它自己的适配器（取假形态的正对侧）：只注入一个记录器 `fetchBackend`，以 `overrides.providerId = 'dashscope-omni'` 调 `transcribe` ⇒ 记录器恰好收到 1 个请求，`url` 逐字等于 `{baseUrl}/compatible-mode/v1/chat/completions`、method 为 POST、`body` **不是** `FormData`（`!(body instanceof FormData)`）而是 JSON 文本，解析后含 `messages` 数组、`model` 等于 invocation 给的模型、`Authorization` 头带该 key。同一读数在同一文件里有阳性对照：`overrides.providerId = 'openai-compatible'` ⇒ 记录器收到的那一个请求 `url` 是 `{baseUrl}/audio/transcriptions`、`body instanceof FormData` 且含 `file` 与 `model` 两个部分（「什么都不发」与「两种 provider 发同一种形状」都过不了这一对）。
- [ ] AC3 线上字节不变：`node scripts/asr-extraction-parity-check.mjs` 退出 0，四组各打印 `equal`，`pre-extraction ok` 仍在，且 **`scripts/__fixtures__/asr-extraction-parity-baseline.json` 未被本任务改动**（`git diff --stat` 对该文件为空，且 `git log -1 --format=%H -- scripts/__fixtures__/asr-extraction-parity-baseline.json` 指向本任务之前的那次提交）。
- [ ] AC4 宽松解析那半条基线在判据里也有独立读数：新测试对五个容忍度输入（非 JSON body、`{"text":"…"}`、`{"text":0}`、无 `text`、`null`）各断言代理结果与基线 `response-tolerance.proxy` 逐项一致（`ok` 与那个字符串），并断言空文本仍是成功 —— 这三件事一旦被适配器的 `strict` / `NO_SPEECH_DETECTED` 语义吃掉，本项与 AC3 同时红。
- [ ] AC5 错误映射逐项有读数：判据打印一张 `code → status` 表，十个 `AsrErrorCode` 成员各占一行（表里缺谁就把谁打印成 `UNMAPPED` 并计失败）；其中 `NOT_CONFIGURED`→503、`INVALID_BASE_URL`→400、`UNAUTHORIZED`→502、`TIMEOUT`→504、`OVERSIZE`→413、`UNSUPPORTED_MIME`→415 逐字断言（这六项是今天的行为，改一个数就红），另有独立断言：上游非 2xx 透传自身状态（例如替身答 404 ⇒ 客户端拿到 404）。取假形态：把 `UNAUTHORIZED` 改成 401 ⇒ 本项必红。
- [ ] AC6 注册顺序承重：判据打印 `listProviders().map(p => p.id)` 并断言首条仍是出厂那一个、`dashscope-omni` 在末尾；`getHealth().value.provider` 与改动前一致；新条目的 `capabilities` 是适配器模块导出的那个对象（引用相等或逐字段相等），不是注册表里另抄的一份。
- [ ] AC7 取假形态是可执行用例（不放进 criterion 文件）：把出货的 `server/modules/voice/voice.service.ts` 连同其模块图复制到临时树，改成「无论什么 provider 都写死 multipart」，用与 criterion 相同的驱动跑 dashscope-omni 那条 ⇒ **非零退出且输出指名 dashscope-omni 那一条**；同一临时树**未变异**时同一命令退出 0（正向控制先行 —— 一个恒红的工装不能证明任何事）。提示（立案时已核）：该服务模块图只含类型导入与 `shared/asr/*`（无第三方依赖），临时树不必装 `node_modules`。criterion 文件本身保持零子进程。
- [ ] AC8 注册没有把别人的读数改红：`node scripts/asr-second-adapter-check.mjs` 退出 0（它对「磁盘上的 provider 模块是否都被注册、声明是否与模块一致」给出 `registered-count` 与逐字段读数 —— 这是本条注册生效的强读数）；`node scripts/asr-contract-invariants-check.mjs` 退出 0 且读数里含新 provider 的行（不是空过）；`node scripts/asr-health-provider-check.mjs` 退出 0；`node scripts/asr-pause-cues-source-check.mjs` 退出 0；`node scripts/asr-mime-size-gaps-check.mjs` 退出 0。若某一条因为新行而红，修的是适配器/线协议那一行或本条的注册，**不得**改窄这些检查。
- [ ] AC9 静态门：`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json` 三套）退出 0 —— `shared/asr/asrRegistry.ts` 被前后端两套编译同时编译；`npm run lint` 退出 0。
- [ ] AC10 如实登记：判据输出与本任务的完成记录里写明「本条不做 proxy-only 与 SSRF 白名单（AC-140）、不做用户配置与 key 掩码（AC-141）、不做浏览器端到端（AC-142）；全程替身与注入 transport，未接触真实 DashScope（ADR-004 决策 8：真实冒烟归人工）」。

## DoD

真实落地判据：不是「多了一个测试文件」，而是**同一个 `createVoiceService` 对两条 provider 说出两种线形状、且出厂那一条的形状与它的响应容忍度一个字节都没动** —— 由**执行**证明，不由段落声明。三件承重读数：

(a) **一对互斥的形状断言是产物**（AC2）：同一个服务、同一份音频、只换 provider id，一个记录器读到 `chat/completions` 的 JSON 体，另一个读到 `/audio/transcriptions` 的 multipart 体。这两条互为对方的取假形态 —— 把代理写死成任意一种形状，另一条必红，且这个「必红」是可执行用例（AC7）而不是承诺。

(b) **不变的那一半有自己的读数**（AC3、AC4）：`proxy-outbound` 与 `response-tolerance.proxy` 五例逐项相等，空文本仍是成功，且基线文件未被改动过 —— 「没顺手把基线重录一遍」是可查的（`git log -1 -- <baseline>` 指向本任务之前）。

(c) **错误映射是表、不是散落的 if**（AC5）：十个成员逐行打印，六个今天的值逐字钉住、上游状态透传有独立断言，缺项打印 `UNMAPPED` 并计失败 —— 一个「漏掉某个码」的实现不可能靠沉默过关。

**必须如实登记**（写进判据输出与本任务的完成记录）：本条只做「按 provider 分派 + 码↔状态映射 + 保持出厂路径不变」，不做 proxy-only / SSRF（AC-140）、不做用户凭据与设置（AC-141）、不做浏览器端到端（AC-142）；判据跑在替身与注入 transport 之下，**不等于**真实 DashScope（ADR-004 决策 8）；注册新 provider 会让 `getHealth()` 的 `providers[]` 多一行，这是本条的后果而非 AC-141 的配置语义（新条目的 `configured` 仍读同一份用户后端配置，逐字段与新字段的语义留给 AC-141）。

L_D 该轴仍暗，理由：本条不新增用户数据通路、不新增持久化结构（用户级 provider 选择与 DashScope 凭据在 AC-141）；它只把一条既有请求按 provider 交给对应适配器，并把错误码翻译成既有的 HTTP 状态。

L_G 该轴仍暗，理由：目标层判据（真实浏览器里经语音按钮拿到书面指令并写入 composer）还要求设置页选择、凭据分离与 proxy-only 的直连归零（AC-140/141/142）；本条只让服务端具备了分派能力，用户侧还没有可达入口。

## Touches

- server/modules/voice/voice.service.ts
- shared/asr/asrRegistry.ts
- shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts
- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts
- server/modules/voice/tests/voice-provider-dispatch.test.ts (new)
- server/modules/voice/tests/voice-provider-dispatch-falsify.test.ts (new)
- tasks/gap-asr-proxy-provider-dispatch.md