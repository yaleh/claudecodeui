---
id: gap-asr-multimodal-adapter-real-gemini-wire
title: multimodal 适配器对真实 Gemini 可用：x-goog-api-key
  鉴权、适配器自有转写指令、generationConfig、停顿换行合并、400/finishReason 错误映射、style 诚实声明
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`tasks/` 全文检索 `x-goog-api-key` / `generateContent` 零命中；相邻任务 `gap-asr-second-adapter-inline-only`（done，落第二个适配器的**形状**：请求级预算、OVERSIZE 零请求、honors.prompt=false 不发）与 `gap-asr-adapter-invariant-suite`（done，离线不变量看板）都只对替身 fetch 取读数，从未对真实服务跑过 —— 本任务的机制是「适配器线协议与真实 Gemini 的差异」，与二者不同。

**现场（2026-09-23 首次对真实 Gemini 的读数，仓库内 8 条中文语料 `experiments/voice-provider-paired-quality/fixtures/d0*-o65.wav`，key 取自仓库内被 `.gitignore:82` 忽略的 `.env.test`）：**

1. **出货适配器原样调用 ⇒ 401。** `transcribe` 发 `Authorization: Bearer <apiKey>`，Gemini 回 `Request had invalid authentication credentials. Expected OAuth 2 access token…`。Gemini API key 走 `x-goog-api-key` 头。浏览器预检已实测：`access-control-allow-headers: content-type,x-goog-api-key`，直连路径可用。
2. **修好鉴权、不给指令 ⇒ 返回字幕格式。** 请求体只有 `inlineData`（`honors.prompt:false` 把「不转发调用方偏置提示」做成了「连转写指令都不发」），模型输出 `00:00:00.420 --> 00:00:00.800⏎Server⏎…`，8 条平均 CER 2.24。加上一句固定的逐字转写指令后，gemini-2.5-flash-lite 平均 CER 0.195（同口径 whisper-turbo 基线 0.132），均值 4.2s。
3. **书面化指令在本语料上更差**：2.5-flash-lite CER 0.456，出现编造（`Voice.exe`、`use strict`、`large-v2`）与标识符改写。而当前声明 `style: 'written'` + `WRITTEN_STYLE_TRANSFORMATIONS`，适配器却从不要求书面化 —— 声明与线上行为不符。
4. **停顿处按行切碎**：o65 语料停顿长，输出形如 `server⏎的⏎voice.se⏎…`。
5. **gemini-2.5-flash 默认开思考**：每条约 700–980 thoughts token、均值 9.7s。
6. **无效 key 返回 400**（不是 401）：`errorCodeForStatus` 会把它归为 `UPSTREAM_ERROR`，用户看不出是 key 错。
7. **webm/opus 被接受**：Chromium MediaRecorder 产出的 `audio/webm;codecs=opus` 在 2.5-flash-lite 与 3.5-flash-lite 上都返回非空文本（3.5-flash-lite 约 1.9s）。

**本任务做什么（只改 `shared/asr` 的 multimodal 适配器及钉住它的看板/测试）：**

- 鉴权头改为 `x-goog-api-key`，无 key 时不发该头。
- **适配器自有的固定转写指令**：作为 `contents[0].parts` 里的一个 text part 随请求发送，属于线协议而不是调用方 hint；`honors.prompt:false` 的语义保持为「调用方 prompt 不上线」（不得借 `systemInstruction` 发送，看板以 `systemInstruction` 的有无判定 prompt）。指令由 `buildInlineRequestBody` 产生，因而自动计入 `measureInlineRequestBytes` 的请求级预算。
- `generationConfig`：`temperature: 0`；2.5 系列 `thinkingConfig.thinkingBudget: 0`（按模型名前缀施加，未知模型不发该字段，避免对不支持的模型报 400）。
- 读结果时合并换行：相邻两侧都是 CJK 字符时直接拼接，否则以单个空格拼接；首尾去空白。
- 错误映射：400 且错误体 `reason`/`message` 表明 API key 无效 ⇒ `UNAUTHORIZED`；`candidates[0].finishReason` 为 `SAFETY`/`RECITATION`/`PROHIBITED_CONTENT`/`BLOCKLIST` 等非 `STOP`/`MAX_TOKENS` 且无文本 ⇒ `UPSTREAM_ERROR`（带 finishReason），不得报成 `NO_SPEECH_DETECTED`；`promptFeedback.blockReason` 同理。
- **style 诚实声明**：指令是逐字转写 ⇒ `style: 'verbatim'`，`transformations: ['punctuate']`。书面化留给轴 B 负对照测过之后另行立案，不在本任务。

**边界（不做）**：不接路由分派（S4：`src/shared/api.ts`、`voice.service.ts`、CLI 仍走 multipart）；不加设置页 provider 选择；不改 `pauseCues`、`acceptsMime`、预算数值；不写配对质量实验记录（另立案）；不改第一个适配器。

## AC

- [ ] AC1 鉴权：替身 fetch 记录到的请求带 `x-goog-api-key` 且**不带** `Authorization`；`apiKey` 为空时两者都不带。`npx vitest run src/shared/asr/tests/multimodalAdapter.test.ts` 退出 0，且其中有一条用例在把头改回 `Authorization: Bearer` 时必红（取假变体在 Evidence 贴出红读数）。
- [ ] AC2 转写指令：请求体 `contents[0].parts` 含适配器固定指令 text part；调用方传入 `hints.prompt` 时请求体仍**无** `systemInstruction` 且无该 prompt 文本（`honors.prompt:false` 不回退）；`hints.context` 仍在线上（阳性对照）。同一 vitest 文件覆盖，退出 0。
- [ ] AC3 预算含指令：`measureInlineRequestBytes` 的读数等于实际发送 body 的 UTF-8 字节数（对一条含 context 的请求逐字节相等），且临界用例（音频恰在预算内、加上指令后超）返回 `OVERSIZE` 且替身调用次数为 0。
- [ ] AC4 generationConfig：模型 `gemini-2.5-flash-lite` 的请求体含 `"temperature":0` 与 `"thinkingBudget":0`；模型名非 2.5 系列（如 `gemini-3.5-flash-lite`）时不含 `thinkingBudget`。vitest 覆盖。
- [ ] AC5 换行合并：`server⏎的⏎voice.se` ⇒ `server 的 voice.se`；`把默认模型换成⏎whisper` ⇒ `把默认模型换成 whisper`；`模块下的⏎目录` ⇒ `模块下的目录`（CJK–CJK 无空格）。vitest 覆盖。
- [ ] AC6 错误映射：400 + `API_KEY_INVALID` 体 ⇒ `UNAUTHORIZED`；`finishReason: 'SAFETY'` 且无文本 ⇒ `UPSTREAM_ERROR` 且 message 含 `SAFETY`；`finishReason: 'STOP'` 且无文本 ⇒ `NO_SPEECH_DETECTED`（阳性对照）。vitest 覆盖。
- [ ] AC7 style 诚实：`resolve('multimodal').capabilities.style === 'verbatim'`，成功结果的 `style` 为 `'verbatim'`、`transformations` 为 `['punctuate']`。vitest 覆盖。
- [ ] AC8 看板与既有判据不退化：`npx vitest run src/shared/asr/tests/` 退出 0；`node --test scripts/asr-contract-invariants-check.test.mjs scripts/asr-second-adapter-check.test.mjs` 退出 0；`node scripts/asr-contract-invariants-check.mjs` 与 `node scripts/asr-second-adapter-check.mjs` 退出 0（看板的凭据读数改为按 wire 模型声明的头名判定 present/absent，而不是写死 `Authorization`；multipart 那一路仍读 `Authorization`）。
- [ ] AC9 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0。
- [ ] AC10 真实服务读数（人跑，不进 CI）：在装有 `.env.test` 的检出里，`set -a; . ./.env.test; set +a` 后以**未包装**的 `fetch` 直接调用出货 `transcribe`（`baseUrl=https://generativelanguage.googleapis.com`，`model=gemini-2.5-flash-lite`）转写 `d03-o65.wav`（`audio/wav`）与一条 Chromium MediaRecorder 产出的 `audio/webm;codecs=opus`，两条都返回 `ok:true` 且文本非空、不含 `-->` 时间戳；再用一个错误 key 调用返回 `UNAUTHORIZED`。命令与输出贴进 Evidence（key 不得出现在输出或提交中）。

## DoD

真实落地判据：不是「单测绿了」，而是**出货的 `multimodal.transcribe` 不经任何包装、直接对真实 Gemini 返回可用转写**（AC10）—— 修前同一调用是 401，修鉴权不修指令是字幕格式，两条修前读数已在 Proposal 登记，作为本任务的「修前」行。承重性由三组读数共同证明：

(a) 鉴权与指令两处修复各有一条取假变体能红（AC1、AC2），不是只证「现在能跑」；
(b) 请求级预算把新增的指令算进去（AC3）—— 不然预算读数与实际 body 会分叉，这是第二个适配器立案时的核心不变量；
(c) 声明与线上行为一致（AC7）：`style` 不再宣称一个线上从未请求过的书面化。

`.env.test` 与其中的 key 不入 git：本任务提交前 `git status --short` 不得出现 `.env.test`，`git log -p` 不得出现 key 前缀。

L_D 该轴仍暗，理由：本任务修适配器线协议，不新增领域数据能力；质量读数归配对实验记录，不进本任务判据。
L_G 该轴仍暗，理由：目标层判据（换识别服务不改路由与 UI）需要 S4 路由分派，本任务不接路由。

## Touches

- shared/asr/list/multimodal/multimodal.asr-provider.ts
- shared/asr/asrInvariants.ts
- src/shared/asr/tests/multimodalAdapter.test.ts
- src/shared/asr/tests/asrContractInvariants.test.ts
- scripts/asr-contract-invariants-check.test.mjs
- scripts/asr-second-adapter-check.mjs
- scripts/asr-second-adapter-check.test.mjs
- tasks/gap-asr-multimodal-adapter-real-gemini-wire.md
