---
id: gap-voice-error-messages-i18n-fallback
title: 十二语言 chat 文案补齐 voice.errors.<code> 与兜底
  unknown（非英文不与英文逐字相同），code→文案映射只有一份实现，出货 composer 不再显示 transcribe+状态码
  的拼接句（AC-151）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-error-classification-and-status-table
goal_ac: AC-151
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rn "^goal_ac: *AC-151" tasks/*.md` → 0 命中；全量 165 条任务里 `goal_ac` 等于 `AC-151` 的 0 条；`grep -rln "AC-151" tasks/*.md` 只命中两条同族任务（`gap-voice-error-classification-and-status-table` 与 `gap-voice-error-envelope-contract`），两条都只是在边界段把 AC-151 列为「不做」，没有认领；`ls src/modules/chat/tests/voiceErrorMessages.test.tsx` → `No such file or directory`；`grep -rn "voice.errors" src/ shared/ server/` → 0 命中（十二个 `chat.json` 的 `voice` 块里没有任何错误键）；`grep -rn "voiceErrorMessage\|voiceErrorKey" src/` → 0 命中。同族另外两条判据（AC-152 直连与代理同码、AC-153 真实浏览器）也还没有任务认领，本条只认领「十二语言文案 + 兜底 + 映射函数」这一格。

<!-- dedup-ref --> 词表来源与前置（机制边，不是风格选择）：本条的读数要「对共享词汇表里的每个 code」成立，而今天的 `AsrErrorCode` 是**类型 union、运行期被擦除**（`shared/asr/asrRegistry.ts:132`），运行期不可枚举 —— 十二语言文案的完备性因此只能在**一个运行期词表**上成立。那份运行期词表是 `gap-voice-error-classification-and-status-table`（AC-149）的交付面（它把 union 改成 13 码并导出运行期常量，判据不许另抄数组）。所以本条 `depends_on` 那条任务，判据必须 import 出货的那个运行期常量。若那份词表在实现时还不存在，本条**不得**自建第二份词表，也不得把它抄进前端 —— 如实报告阻塞。若那条任务此后被重立为另一个 id 取代，本条的前置应重新指向取代它的那一条（真正的前置是「运行期词表只有一处」这个机制，不是某个 id）。

**这条判据要的是什么（AC-151 原文拆开）**

1. 对共享词表里的每个 code，十二个语言的 chat 文案里都有 `voice.errors.<code>`，且非空。
2. 另有 `voice.errors.unknown` 作兜底。
3. 非英文语言的文案不与英文文案逐字相同（未翻译的占位视为缺失）。
4. 没有任何文案形如「transcribe 加状态码」的拼接句。
5. 前端把 code 映射成文案的函数对词表内每个 code 返回对应文案；对未知 code 与没有 code 的失败返回兜底文案，并保留状态码。
6. 取假形态：(1) 词表新增一个 code 而不加文案 ⇒ 必须红；(2) 任一语言缺键 ⇒ 必须红；(3) 未知 code 直接显示为拼接句 ⇒ 必须红。

**现状（立案时实测，可复验）**

| 项 | 实测 |
|---|---|
| 判据文件 | `src/modules/chat/tests/voiceErrorMessages.test.tsx` → `No such file or directory` |
| 十二语言的 voice 文案 | `src/modules/i18n/locales/*/chat.json` 的 `voice` 块（en 的 `:106-117`）只有 input / stopRecording / transcribing / speak / stopSpeaking / loading / replayOriginal / replayTrimmed / stopReplayOriginal / stopTrimmedPlayback 十个键，**没有 `errors` 子对象** |
| 语言集合 | `src/modules/i18n/languages.ts` 出货 12 项（en fr es ko zh-CN zh-TW ja ru de tr it id），与 `src/modules/i18n/locales/` 的 12 个目录一一对应，每个目录都有 `chat.json` |
| 前端今天的失败文案 | `useVoiceInput.ts:548` 在拿到失败响应后抛出拼接句 `transcribe ${res.status}` 或 `transcribe ${res.status} (${code})`，`:582` 再包成 `Transcription failed: …` |
| 今天读 code 的唯一位置 | `useVoiceInput.ts:65-73` 的 `refusalCode(response)` 读响应体的 `code`（只为拼那句，读完就丢）—— code 已经在线路上，前端只是没有把它映射成文案 |
| 失败通道的形状 | `onError` 只收一个 `string`；code 与 status 在拼句那一刻就被压平，composer 再也拿不回来（这正是「保留状态码」要改的那一格） |
| 本地失败（与词表无关） | 另有 6 处 `onError`：`:507` `Recording too short` / `Audio file too small`、`:579` `No speech detected`、`:582` `Transcription failed: …`、`:647` `Mic error: …`、`:727` `Playback failed: …` |
| 展示 | `ChatComposer.tsx:253-262` 把错误当 `string` 存进 `voiceError`，4 秒计时器清掉；`handleVoiceError`（`:291`）传给 hook；`VoiceInputButton.tsx` 的 `Props.errorMsg?: string \| null` 只把字符串渲染进气泡 |
| 前端已有的 shared 值边先例 | `useVoiceInput.ts:18` 值导入 `@shared/asr/transcriptionWire`；`src/shared/tests/voiceTrimShippedRecogniser.test.ts:36` 值导入 `@shared/asr/asrRegistry` —— 前端 vitest 里值导入 shared/asr 有先例 |
| 驱动出货 composer 的配方已存在 | `src/modules/chat/tests/voiceTranscriptRepair.test.tsx` 文件头部：`vi.hoisted` + `vi.mock('@/shared/api')` 只切 `transcribeVoice`（其余走真货），然后渲染真 `ChatComposer` 并用真 mic 按钮驱动 —— 本条的判据沿用这个配方，不绑端口、不联网、不起子进程 |
| 前端测试入口 | `vitest.config.ts` 的 include 只收 `src/**/*.test.ts(x)`，jsdom，`@shared` 别名已注册；`npm run test:client` = `vitest run` |

**要交付的事**

1. **十二语言文案**（12 个 `src/modules/i18n/locales/<lang>/chat.json`）：在 `voice` 块下新增 `errors` 对象，键 = 出货运行期词表里的每个 code 逐字（AC-149 落地后是 13 个），另加 `unknown`。每条是「发生了什么 + 怎么办」的一句话，非空；非英文语言的每一条必须与英文那条不同（不许把英文抄过去顶格，也不许留 `TODO` / 空串）。措辞质量是人读范畴，判据只读存在、非空、非英文 ≠ 英文、不是拼接句。
2. **code→文案只有一份实现**（新文件 `src/modules/chat/utils/voiceErrorMessages.ts`）：入参是「失败」（至少含 `code?: string` 与 `status?: number`，上游码串可选），出参是文案键或文案。要求：
   - 词表内每个 code → `voice.errors.<code>`；
   - 词表外的 code（未知 code）与**没有 code** 的失败 → `voice.errors.unknown`；
   - 状态码与上游码串**保留**在失败里，并由同一模块的一个「技术详情」访问器按需渲染成含状态码数字（有上游码串时也含它）的字符串 —— 判据断言数字是它的子串，**不钉周围格式**；
   - 词表来源：`import { <运行期词表常量> } from '@shared/asr/asrRegistry'`（**值**导入，名字取 AC-149 实际出货的那个；`import type` 取不到运行期数组）。**不得在本条里另抄一份 code 字符串数组**，判据文件里也不许；
   - 若 `shared/asr/asrRegistry.ts` 里还没有那个运行期常量，本条不得自建词表，如实报告阻塞。
3. **失败通道改成结构化的**（`useVoiceInput.ts`）：把服务端失败的 `{ code?, status, upstreamCode? }` 原样传给 `onError`（具体形状由实现定），由 composer 侧经第 2 步的映射取文案。**本地失败**（录音太短 / 文件太小 / `No speech detected` / `Mic error` / `Playback failed`）保持它们今天各自的专门文案，不得被兜底文案顶掉；空答案那支的 code 归 AC-149/AC-150，本条只让它走同一条映射。
4. **composer 侧**（`ChatComposer.tsx`）：把收到的失败经 `useTranslation('chat')` 的 `t` 换成文案再进 `voiceError`；**显示行为一个都不动** —— 4 秒计时器、单行气泡、无关闭按钮、无折叠详情都保持今天的样子（那是 AC-153 的交付面）。`VoiceInputButton` 的 `errorMsg` 形状不变（composer 解析完再传下去），因此本条的 Touches 不含它。
5. **判据文件**（`src/modules/chat/tests/voiceErrorMessages.test.tsx`，AC-151 的 `criterion:` 文件，只有它能认领该判据）：vitest + jsdom，按 `voiceTranscriptRepair.test.tsx` 的配方；十二语言的 `chat.json` 静态导入，词表从 `@shared/asr/asrRegistry` **值**导入。i18next 初始化时**必须关掉 `fallbackLng`**（或直接读资源对象）—— 否则某语言缺键会静默回落到英文，这条判据就成了空读数。
6. **取假形态在同一次运行内可执行**（判据里的独立 test，三段）：都通过**出货的那一份**词表/映射代码驱动，逐例打印 `base=green mutant=red which=<读的是哪条>` 与族外仍绿；变异是内存里的克隆，不写临时文件、不留残留、不起子进程。

**边界（不做）**

- 不做持续显示、关闭按钮、折叠技术详情、去掉 4 秒计时器、草稿保留（AC-153）。
- 不扩词表、不做分类函数、不改 `PROVIDER_ERROR_STATUS`（AC-149）；不改路由信封与 `upstreamCode` 的提取与合规（AC-150）；不把分类搬到前端复用（AC-152 的读数）。
- 不做 ADR-004 修订；不改 `voice.transcribe` 行形状（AC-143）；不改识别行为、提示词、模型；不联网、不跑真实上游、不跑真实浏览器。
- 不改本地失败（录音太短 / 文件太小 / `Mic error` / `Playback failed`）的既有文案，也不给它们编 code。

**已知不等价点**

- 判据读的是**文案的存在性与非同一性**，不是措辞质量：「非英文 ≠ 英文」是机器可读的替代读数，一个把英文抄成占位符的实现在这里红，但一句机器翻得别扭的中文不会红。
- 前端跑在 jsdom 上、`transcribeVoice` 是替身：不代表真实服务端信封（AC-150）与真实浏览器（AC-153）。
- `voice.errors.unknown` 是**兜底**，不代表未知 code 的语义被正确解释；语义归属是 AC-149 分类器的事。
- 「十二个语言」是 `languages.ts` 今天的出货集合：新增语言会让 AC2 的集合相等读数红，需要在同一次改动里补文案，这是有意的耦合。

## AC

- [ ] AC1 判据入口与预算：`npx vitest run src/modules/chat/tests/voiceErrorMessages.test.tsx` 退出 0；判据自身零子进程、零真实监听端口、零网络（`transcribeVoice` 是替身）；末尾打印 `elapsed-ms=<n>` 且实测 < 30000（目标侧判据门是 60 秒硬上限、不可调）。打印 `subprocess-imports=<n>`。
- [ ] AC2 十二语言 × 词表逐格覆盖：code 集合从 `@shared/asr/asrRegistry` 的出货运行期常量读（判据里不另抄数组）；语言集合从 `src/modules/i18n/languages.ts` 的出货 `languages` 读，并断言判据导入的 `chat.json` 数据集与它逐字相等（防「只挑几个语言」）。对词表里每个 code 断言十二个语言的 `voice.errors.<code>` 存在、是 `string`、`trim()` 后非空；`voice.errors.unknown` 同样断言一遍。逐语言打印 `lang=<值> keys=<n> missing=<…>`，末尾打印 `langs=<n> vocab=<n> cells=<n> missing=<n>`，断言 missing 为 0。**取假形态 (1) 的正式读数**：词表新增一个 code 而文案不动 ⇒ 这条必红（判据迭代的是出货词表本身）。
- [ ] AC3 非英文不与英文逐字相同（未翻译占位视为缺失）：对 11 个非英文语言、每个键断言 `非英文文案 !== 英文文案`，且不等于键名、不含 `TODO` / `translation missing` 一类占位串、`trim()` 后非空。逐语言打印 `lang=<值> identical-to-en=<n>`，末尾打印 `identical=<n>`，断言为 0。**取假形态 (2) 的正式读数**：任一语言缺键或抄英文 ⇒ 这条必红。
- [ ] AC4 不是拼接句（含出货路径的读数）：(a) 十二语言的全部 `voice.errors.*` 字符串里没有一条匹配 `/transcribe\s*\(?\d+/i`，也没有一条以 `transcribe` 开头；(b) 驱动**出货的 `ChatComposer`**（`transcribeVoice` 替身返回 **502 且响应体不带 `code`** 的失败），读气泡里实际显示的那句话，断言它等于当前语言的 `voice.errors.unknown` 文案（这条等式本身就是取假形态 (3)：显示拼接句则不等）；(c) 同一次失败里状态码仍被前端保留：断言失败载荷的 `status` 是 502，且出货的「技术详情」访问器对该载荷的输出**包含子串 `502`**（不钉格式）。打印 `concat-hits=<n> composer-text=<…> equals-unknown=<b> status-preserved=<b>`。
- [ ] AC5 映射对所有词表 code 成立、有兜底、且有正对照：对词表里每个 code 断言映射（en 与 zh-CN 各一遍）返回的文案 === 该语言 `voice.errors.<code>` 字符串；对词表外的 code（如 `Some.Future.Code`）与**没有 code**（`undefined`）的失败断言返回该语言的 `voice.errors.unknown` 字符串。**正对照**（防「一律返回兜底」的空过）：(i) 词表内至少两个 code 的文案互不相同；(ii) 每个 code 的文案 !== 兜底文案。打印 `vocab=<n> mapped=<n> distinct-messages=<n> fallback-distinct=<b> unknown-code=<b> no-code=<b>`。
- [ ] AC6 取假形态可执行（同一次运行内，三段各自 base 绿 → 变异红并指名 → 族外绿）：(i) `vocab-gains-a-code`：把出货词表克隆后追加一个合成 code ⇒ AC2 的覆盖读数必须报它十二个语言全缺，未克隆那一份同时报 0 缺（同一段代码两个方向都读得出）；(ii) `locale-missing-a-key`：把某一语言克隆后删掉一个 `voice.errors.<code>` ⇒ 覆盖读数必须恰好报出（该语言, 该 code），未克隆那份报 0；(iii) `concat-fallback`：断言拼接句形状 `transcribe 502` 确实被 AC4 的读数判红（`/transcribe\s*\(?\d+/i` 命中，且 **不等于** 当前语言的 `voice.errors.unknown`），同时出货路径的读数判绿 —— 三条一起证明「等式 + 正则」这对读数真的能分辨，而不是恒真。逐例打印 `mutation=<名> base-green=<b> mutant-red=<b> which=<…> outside-family-green=<b>`。三段都是内存克隆：不写文件、不留残留、不起子进程；跑完 `git status --porcelain` 与本任务开工时逐字相同。
- [ ] AC7 既有面不退化（逐条打印 `exit=<n> name=<…>`，不是空过）：`npx vitest run src/modules/chat/tests/voiceTranscriptRepair.test.tsx src/modules/chat/tests/voiceClipPlayback.test.tsx src/modules/chat/tests/voiceInputButtonName.test.tsx src/modules/chat/tests/composerDraftScoping.test.tsx src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx` 退出 0（这五个都驱动真 `ChatComposer` / 真 hook，是本条最可能顶到的既有面）；`npm run test:client`、`npm run typecheck`、`npm run lint` 各退出 0。
- [ ] AC8 如实登记：判据输出与本任务完成记录里写明「本条只做十二语言 `voice.errors.*` 文案、code→文案映射与技术详情访问器、失败通道结构化、composer 的文案解析；未做持续显示 / 关闭 / 折叠详情 / 4 秒计时器移除（AC-153）、词表与分类（AC-149）、路由信封与 `upstreamCode`（AC-150）、直连路径同码（AC-152）、ADR-004 修订；未改 `voice.transcribe` 行形状；未联网、未跑真实上游与真实浏览器；本地失败（录音太短 / 文件太小 / `Mic error` / `Playback failed`）的既有文案保持原样、未给它们编 code」，并把所用运行期词表常量的**实际名字**与它当时含的 code 数记下来。

## DoD

真实落地判据：不是「加了 12 × N 个键」，而是**出货的 composer** 在一批失败上真的显示出按 code 选中的本地化文案、在没有 code 时显示出兜底文案，且那句话不是 `transcribe <状态码>` 的拼接句 —— 由执行读数证明，不由段落文字声明。承重性由四件读数证明：

(a) **词表是判据的输入，不是判据的副本**（AC2 + 取假形态 (1)）：code 集合来自 `@shared/asr/asrRegistry` 的出货运行期常量，语言集合来自 `languages.ts`；克隆后追加一个 code，同一段覆盖读数立刻报它全缺。「判据里另抄了一份词表」会让这条读数恒绿，所以 AC6 (i) 必须红在新增 code 上。

(b) **非英文是翻译，不是英文的拷贝**（AC3 + 取假形态 (2)）：11 × N 条逐字比较，删一个键立刻被指名。

(c) **显示的不是拼接句**（AC4 + 取假形态 (3)）：出货 composer 在无 code 的 502 上显示的那句话 **等于** 当前语言的 `voice.errors.unknown`；同时 `transcribe 502` 这个形状被同一对读数判红；状态码仍被保留（技术详情访问器输出含 `502`）。

(d) **有兜底不是一律兜底**（AC5 正对照）：词表内每个 code 都返回各自的文案、至少两条互不相同、没有一条等于兜底文案；只有未知 code 与无 code 才落兜底。

**跨判据的连带改动必须如实登记**：本条把 `useVoiceInput.ts` 的失败通道从 `string` 改成结构化载荷，顶到 `ChatComposer.tsx` 的 `handleVoiceError` 与它传给 `VoiceInputButton` 的 `errorMsg`；完成记录里逐条写「原来传什么、现在传什么、显示行为为什么一个都没动（那是 AC-153 的交付面）」。

**已知不等价点**：判据读存在性与非同一性，不读措辞质量；前端跑在 jsdom 与 `transcribeVoice` 替身上，不代表真实服务端信封（AC-150）与真实浏览器（AC-153）；`voice.errors.unknown` 是兜底文案，不代表未知 code 的语义被正确解释（那是 AC-149 分类器的事）；「十二个语言」是 `languages.ts` 今天的出货集合，新增语言会让 AC2 的集合相等读数红，需在同一次改动里补文案。

L_D 该轴仍暗，理由：本条读数全是字符串的存在性、相等/不等与集合大小，没有可比的数值量。
L_G 该轴仍暗，理由：目标层的读数是真实浏览器里页面上的文案与提示持续显示（AC-153），本条只到 jsdom 里的气泡文本。

## Touches

- src/modules/chat/utils/voiceErrorMessages.ts (new)
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/voiceErrorMessages.test.tsx (new)
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/id/chat.json
- tasks/gap-voice-error-messages-i18n-fallback.md
