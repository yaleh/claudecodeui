---
id: gap-voice-capture-secrets-three-modes
title: 三档脱敏判据：off/text/audio 各一次成功与一次失败下，DashScope key、共享 backend key、Bearer
  形式与录音 base64 都不出现在任何日志行与任何捕获文件里，且它们确实过了线（正例）（AC-146）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-capture-mode-gate-off-fail-closed
  - gap-voice-capture-text-payload
  - gap-voice-capture-audio-file
goal_ac: AC-146
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on`）：立案时 `grep -rho '^goal_ac: *AC-146' tasks/*.md` 零命中；`grep -rln 'AC-146' tasks/` 只命中 `gap-voice-capture-text-payload` 与 `gap-voice-capture-audio-file` 的**范围让渡**文字；`grep -rln 'voice-capture-secrets' tasks/` 零命中且 `ls server/modules/voice/tests/voice-capture-secrets.test.ts` → `No such file or directory`。GOAL-010 的六条判据各有一份互不重叠的判据文件，本条只认领 AC-146 的那一份（`-secrets`）：同族三条在飞任务各自白纸黑字把脱敏让了出来 —— `gap-voice-capture-mode-gate-off-fail-closed`（`goal_ac: AC-143`，闸门与接缝）边界原文「不做三档脱敏判据」，`gap-voice-capture-text-payload`（`goal_ac: AC-144`，text 档载荷）边界原文「不做三档脱敏判据（AC-146）」，`gap-voice-capture-audio-file`（`goal_ac: AC-145`，audio 档写文件）只读字节、sha256 与权限。本条是它们让出的那一半，不是它们的重述；判据文件互不重叠（AC-143 是 `voice-capture-off.test.ts`，AC-144 是 `voice-capture-text.test.ts`，AC-145 是 `voice-capture-audio.test.ts`，本条是 `voice-capture-secrets.test.ts`）。

**现状（立案时实测，可复验）**

| 缺什么 | 实测 |
|---|---|
| 判据文件 | `ls server/modules/voice/tests/voice-capture-secrets.test.ts` → `No such file or directory` |
| 捕获通道本体 | `grep -rln 'voice-capture\|VOICE_CAPTURE' server/ src/ scripts/` → 0 个文件；`grep -rn 'voice\.capture\|captureId' server/ src/ scripts/` → 0 处（接缝由 AC-143 出货，本条只消费） |
| 既有的脱敏读数 | `server/modules/voice/tests/voice-dashscope-settings.test.ts:848` 的 needles 是 `[DASHSCOPE_KEY, 'Bearer ' + DASHSCOPE_KEY, AUDIO_BASE64, SUCCESS_TRANSCRIPT, SUCCESS_INSTRUCTION]`，`:849` 在**日志行**上读命中数，`:867` 读 `wire.plaintext-key-sent` 作正例；它覆盖的是**一次成功与一次失败的转写**、**一个 provider**，没有捕获通道、没有三档、没有「捕获文件」这个面；它的 `BROWSER_API_KEY`（`:115`）只出现在 TTS 的 `:789` 与设置读写回读上，**从不**作为「共享 backend 的 key 出现在转写的捕获面上」被读 |
| 共享 backend 的线形态 | `shared/asr/transcriptionWire.ts:64` `return apiKey ? { Authorization: \`Bearer ${apiKey}\` } : {}`；`:86` `body.append('file', upload.audio, upload.fileName)` ⇒ **multipart 原始字节，不是 base64**；provider id 是 `openai-compatible`（`shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts:39`），凭证位是 `baseUrl`/`apiKey` |
| DashScope 的线形态 | `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts:361` `data:${baseMimeType(mimeType)};base64,${encoded}` → `:623` 进 JSON 请求体；`:635` `...(invocation.apiKey ? { Authorization: \`Bearer ${invocation.apiKey}\` } : {})` ⇒ **base64 只在这一条线上过** |
| provider 名录 | `shared/asr/asrRegistry.ts` 三条：`dashscope-omni` / `multimodal` / `openai-compatible` |
| 已有的取假形态工装 | `server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts`：单锚点文本变异（`anchorCount === 1` 断言在 `:145`）、变异体复制到**同树**临时路径（相对 import 仍解析、ESM 按 URL 缓存所以不复用 base 副本路径，`REPO_ROOT` 见 `:46`）、三段读数（`measureArm` 在 `:110`）、跑完删并以 `git status --porcelain` 收尾 |

**要交付的 N 件事**

1. **判据入口与可重跑的读数列表**：新文件 `server/modules/voice/tests/voice-capture-secrets.test.ts`（AC-146 的 `criterion:` 文件，只有这一个文件能认领该判据）。导出与 `voice-dashscope-settings.test.ts` 同形的 `collectReadings(modulePath)`：读数列表对**任意**模块路径可重跑（取假形态文件据此驱动变异体），读数名格式为 `AC<n> <label>`（保持既有可归因形态，取假形态按 `^AC4 ` 这类前缀断言红在哪一族）。`node --test` 下 self-drive 全部读数，末尾打印 `elapsed-ms=<n>`。
2. **三档 × 两个 provider × 成功/失败 = 12 次尝试**：`VOICE_CAPTURE` 取 `off`/`text`/`audio`，每次把它的**原文**交给出货的模式解析函数（AC-143 的唯一解析器，不写字面量），并用同模块出货的捕获端口与写音频端口构造函数注入 `createVoiceService`。每次尝试用**本次运行唯一**的四个针族：`DASHSCOPE_KEY`（`settings.dashscopeApiKey`）、`SHARED_KEY`（同一个哨兵串**同时**放进 `defaults.apiKey` 与 `settings.apiKey`，使 `resolveVoiceConfig` 的任一优先级选中它都读到同一个值；两处都打印其掩码形态）、`Bearer ` + 两个 key（两种形式）、`AUDIO_BASE64`（上传字节的 base64，取 `AUDIO_BYTES.length ≥ 192` 所以 base64 ≥ 256 字符，不可能偶然命中）。每次尝试前清空日志收集器与捕获目录。provider 选 `openai-compatible`（共享 backend）与 `dashscope-omni` 两条线；失败重放「404 + 错误体」形状。
3. **正例（这些值确实过了线 —— 缺正例的「零」不算读数）**：替身 `fetchBackend` 记录它收到的 `(url, init)`。断言并打印：(a) 两个 provider 的 `init.headers.authorization` **逐字等于** `Bearer ` + 对应 key（`wire.<provider>.<case>.keySent=<b>`）；(b) `dashscope-omni` 的 `init.body` 含 `AUDIO_BASE64` **逐字子串**（`base64Sent=<b>`）；(c) `openai-compatible` 的 multipart 体含**原始音频字节**（不是 base64）—— 以 `Buffer` 逐字节搜索原始 `AUDIO_BYTES` 判定（`rawBytesSent=<b>`）。⇒ (c) 这条读数说的是「音频确实上过线，只是共享这条线上以原始字节形式」，所以「捕获面里没有 base64」在共享这条线上同样是**区分**而不是从未存在。
4. **负例面一 —— 任何日志行**：不只读注入的日志端口，还装一个覆盖 `console.info/warn/error/log/debug` 的探针（与 `voice-dashscope-settings.test.ts:878` 的 `log.port-or-console` 同形，探针只在本次读数期间安装并立即还原）。三档 12 次尝试期间**两者收到的每一行**都进同一个 needle 扫描；打印 `log.lines=<n>`、`console.lines=<n>`、`sinkHits=<n>`。两个面的行数都是**读数本身**（见 AC7 的非空性），不是「零就够」。
5. **负例面二 —— 任何捕获文件**：`audio` 档把捕获目录显式交给出货的目录解析函数（该函数按 AC-145 的设计**不读** `process.env`；判据传 `process.env.VOICE_CAPTURE_DIR` 的原文）并指到本次运行新建的临时目录。扫描该目录下**每一个文件的字节**（utf8 解码后逐针族搜索）**与每一个文件名**；`text`/`off` 档断言零文件零目录。打印 `mode=<m> files=<n> byteHits=<n> nameHits=<n>`。
6. **扫描器自身的灵敏性**：把四个针族各塞进一个**合成的**接收面（一行日志字符串、一个临时文件的**名**、一个临时文件的**内容**），用**同一个扫描函数**读出 `hits > 0`；打印 `probe.<needle>=<n>`。⇒ 这是「负例为零」不是「扫描器恒零」的旁证（`zero-claim-criterion-needs-positive-controls`）。
7. **两个取假形态（可执行，且变异必须真的泄漏）**：新文件 `server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts`，沿用 `voice-dashscope-settings.false-forms.test.ts` 的三段形状（未变异副本先清空整张读数表 → 变异体必须在**预测族内**红一条并打印红的是哪一条 → **族外**至少还有一条是绿的）：
   - (i) `headers-into-capture`：把本次请求的 `init.headers` 并入要记录的捕获载荷（记请求头）⇒ 必须让 needle 读数族（`^AC4 `）判红；
   - (ii) `base64-into-capture-row`：把上传字节的 base64 并入捕获行 ⇒ 必须让同一族判红。
   单锚点要求沿用既有文件：anchor 在出货文件里**恰好出现一次**（`anchorCount === 1`）且替换后文本改变；变异体复制到 `server/modules/voice/` 同树临时路径、跑完即删、`git status --porcelain` 里不残留 `__criterion-falsify-` 前缀。
   **reachability 是读数**：每条变异额外打印 `mutant.rawSinkHits=<n>`（变异体原始接收面上的命中数）并要求 `> 0` —— 否则「变异体读绿」会被误读成判据有分辨力，而实际是变异没生效（`anti-fake-trap-must-be-reachable-by-the-impls-own-lookup`：泄漏点是行由 `voice-capture.ts` 的纯函数从**收窄后的入参**构造时，service 侧加字段会被构造点丢掉，变异体必然全绿）。此时**唯一允许的补法**是把该收窄点接上它在 scope 里已经持有的 `init.headers` / `audio.bytes`，并让出货实现继续**不把**它们写进行里；这一处接缝改动必须在完成记录里如实登记。不得为了让取假形态成立而削弱判据。
8. **不重复 AC-144 的载荷条款**：本条只读「针族命中数」与「档位/文件数的非空性」；不断言字段集、不断言截断、不断言模型名、不断言分支闭集。
9. **边界（不做）**：不做 audio 档的字节逐字节相等、sha256、目录/文件权限（AC-145）；不做 text 档字段表与截断（AC-144）；不做 `off` 档的逐字节基线（AC-143）；不做捕获异常隔离（AC-147）；不做真实进程 stdout（AC-148）；不改适配器与 registry 契约、不改 `transcriptionWire.ts`、不改 TTS 通路；`VOICE_CAPTURE` 不进设置页、不进健康负载、不进客户端；不联网、不重放真实 DashScope、不改 `experiments/` 与 `docs/experiments/` 下任何文件。

## AC

- [ ] AC1 判据入口与预算：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-secrets.test.ts` 退出 0；判据自身零子进程、零网络、零真实监听端口；末尾打印 `elapsed-ms=<n>`，实测 < 15000（目标侧判据门 60 秒硬上限且不可调）。
- [ ] AC2 三档 × 两 provider × 两结果的编排来自出货路径：每一次尝试把 `process.env.VOICE_CAPTURE` 的**原文**交给出货的唯一模式解析函数（打印 `resolverInput=<off|text|audio> mode=<off|text|audio>`），捕获端口与写音频端口都由出货模块的构造函数建出；`off` 档的捕获端口调用次数 === 0。另断言判据文件里没有任何手写的 `voice.capture` 行构造（行的构造点只有出货模块一个）⇒ 打印 `handRolledRow=<b>`。
- [ ] AC3 正例：四个针族确实过了线。12 次尝试的替身 `fetchBackend` 读数逐次打印：两个 provider 各 6 次的 `init.headers.authorization` **逐字等于** `Bearer ` + 对应 key（`keySent=<b>`）；`dashscope-omni` 的 6 次 `init.body` 含 `AUDIO_BASE64` 逐字子串（`base64Sent=<b>`）；`openai-compatible` 的 6 次 multipart 体含原始 `AUDIO_BYTES` 逐字节（`rawBytesSent=<b>`）。逐条打印 `wire.<provider>.<case>.keySent/base64Sent/rawBytesSent=<b> authorizationLength=<n>`（**不**逐字打印授权头的值）。三条正例各打印总命中数，且都必须 > 0。
- [ ] AC4 负例（日志面）：三档下注入端口与 `console` 探针收到的**全部**行对四个针族的命中数为 0；逐档打印 `mode=<m> log.lines=<n> console.lines=<n> logHits=<n> consoleHits=<n>`，并打印 `sinkHits=<n>`（两者之和）。读数名以 `AC4 ` 开头（取假形态按这一族断言）。
- [ ] AC5 负例（捕获文件面）：`audio` 档逐个文件读字节与文件名对四个针族的命中数为 0；`text`/`off` 档 `fs.existsSync(捕获目录) === false`（目录不预建）且 `files === 0`。逐档打印 `mode=<m> files=<n> byteHits=<n> nameHits=<n> dirExists=<b>`；读数名以 `AC5 ` 开头。
- [ ] AC6 12 行读数表：每一次尝试打印一行 `mode=<m> provider=<p> outcome=<ok|fail> captureLines=<n> files=<n> sinkHits=<n> keySent=<b>`（12 行，`sinkHits` 恒为 0）。⇒ 失败尝试与成功尝试**各有**一行读数，且两种 provider 都被走到（「只测成功」「只测一个 provider」在表上就可辨）。
- [ ] AC7 零不是空实现（非空性）：`text`/`audio` 档每次尝试恰好 1 行 `voice.capture`（每档 4 条），`audio` 档每个成功尝试恰好落 1 个文件；`off` 档捕获行数 === 0 而 `voice.transcribe` 行数 === 尝试数（4）、`console.lines > 0`（`off` 档不注入捕获端口时日志端口照样收行）。逐档打印 `mode=<m> captureLines=<n> transcribeLines=<n> files=<n> console.lines=<n>`。
- [ ] AC8 扫描器灵敏性（读出「扫描器不会漏」）：四个针族各塞进合成的日志行、临时文件名、临时文件内容，用**同一个**扫描函数读出 `hits > 0`；打印 `probe.<needle>=<n>`（四个值都 > 0）。⇒ 「负例为零」有正例支撑。
- [ ] AC9 两个取假形态是**可执行**的旁证：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts` 退出 0，每条**先要求未变异副本退出 0**（恒红的工装不能证明任何事），再：(`i`) `headers-into-capture` 必须让 AC4 族红；(`ii`) `base64-into-capture-row` 必须让 AC4 族红。每条打印 `mutation=<name> baseExit=0 anchorCount=1 mutantRed=<b> inTarget=[<…>] red-reason=<…> outsiderGreen=<…> mutant.rawSinkHits=<n>`，并要求 `mutant.rawSinkHits > 0`（变异真的泄漏，不是不生效）。跑完 `git status --porcelain` 里不残留 `__criterion-falsify-`。
- [ ] AC10 既有面不退化：`server/modules/voice/tests/voice-dashscope-settings.test.ts`（AC-141 的判据，同一族 needles 的既有读数）、`voice-capture-off.test.ts`、`voice-capture-text.test.ts`、`voice-capture-audio.test.ts`、`voice.service.test.ts`、`voiceHealth.test.ts`、`voice-config.routes.test.ts`、`voiceTranscribeGaps.test.ts` 八条各退出 0；`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json`）与 `npm run lint` 退出 0；逐条打印退出码（不是空过）。
- [ ] AC11 如实登记：判据输出与本任务的完成记录里写明「本条只做三档脱敏判据（日志面与捕获文件面）；判据全程用替身 fetch、注入的日志端口与临时捕获目录，未接触真实上游、未起真实进程、未读真实 `server.log`」；并写明本条对出货代码的改动面：判据在出货实现上判绿时 `shippingDelta=0`（本条只是判据），判红时唯一允许的修法是 AC9 的 reachability 条款所说的收窄点接缝改动并如实登记。

## DoD

真实落地判据：不是「多了一个测试文件」，而是**同一份出货捕获通道**在一个把 key 与录音都真的送上线的替身环境里，三档之下都不把 DashScope key、共享 backend key、`Bearer` 形式与录音 base64 留在任何日志行或任何捕获文件里 —— 而「不留下」是被**证明为一次区分**的：这些值在同一个进程、同一次尝试里确实过了传输层。承重性由三件读数证明：

(a) **不出现是区分而不是从未存在**（AC3 + AC4/AC5）：四个针族各有正例读数（`keySent`/`base64Sent`/`rawBytesSent` 都 > 0）与负例读数（`logHits`/`consoleHits`/`byteHits`/`nameHits` 都为 0）。只打印「没有命中」的实现在这里缺半边，读者能从同一次运行的同一张表里看到值确实在手上过。

(b) **「零」有非空性支撑**（AC7）：`text`/`audio` 档有捕获行、`audio` 档有文件、`off` 档有 `voice.transcribe` 行与 `console` 行 —— 「捕获通道根本没接上」「日志根本没有行」在 AC7 立刻红，不靠散文声明。

(c) **扫描器与变异都有分辨力**（AC8 + AC9）：四个针族在合成接收面上被同一个扫描函数读到（扫描器不是恒零），两条变异各自指名打红 AC4 族、并要求 `mutant.rawSinkHits > 0`（变异真的泄漏）与族外至少一条绿（不是整台工装倒了）。⇒ 「判据有分辨力」与「变异没生效」不会同形。

**必须如实登记**：本条**不**做 audio 档字节/sha256/权限、**不**做 text 档字段表与截断、**不**做 `off` 档逐字节基线、**不**做捕获异常隔离、**不**做真实进程判据；判据跑在替身 fetch、注入的日志端口与临时捕获目录上，**未**接触真实上游、**未**起真实进程、**未**读真实 `server.log`（真实进程 stdout 上的那两条读数归 AC-148）。

**已知不等价点**：替身上游收到的体是判据自己的音频与响应，不等于真实 DashScope 的信封；「共享 backend 这条线上没有 base64」是**线协议本身**的性质（multipart 原始字节）而不是判据的假设，所以那条线上的正例读的是原始字节；`console` 探针只覆盖 `info/warn/error/log/debug` 五个方法，不是对进程 stderr/子进程输出的穷举；12 次尝试都是 `dashscope-omni` 与 `openai-compatible` 两个 provider，`multimodal` 未被走到；「任何日志行」在本条里等于「注入端口 + console 探针收到的行」，真实进程的 stdout 不在读数里。

L_D 该轴仍暗，理由：本条读数全是布尔、计数、存在性与逐字比对，没有可比的数值量；四处「零」都由同一次运行的正例托住，不产生规模或成本上可比的量。

L_G 该轴仍暗，理由：目标层的读数是真实服务进程按环境变量启动后标准输出上的启动行与捕获行（那条判据要求真实进程与本地替身上游），本条只到 service 面、文件系统面与注入端口。

## Touches

- server/modules/voice/tests/voice-capture-secrets.test.ts (new)
- server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts (new)
- server/modules/voice/voice-capture.ts
- server/modules/voice/voice.service.ts
- tasks/gap-voice-capture-secrets-three-modes.md
