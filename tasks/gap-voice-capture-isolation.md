---
id: gap-voice-capture-isolation
title: 捕获失败的隔离：text 档打印捕获行时抛错、audio 档音频目录不可写两种情形下转写仍返回成功且返回文本逐字不变，恰好一行不含内容的
  voice.capture failed（AC-147）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-capture-mode-gate-off-fail-closed
  - gap-voice-capture-audio-file
goal_ac: AC-147
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on` 上）：立案时 `grep -rho '^goal_ac: *AC-147' tasks/*.md` 零命中；`grep -rln 'AC-147' tasks/` 只命中三份同族任务的**范围让渡**文字（`gap-voice-capture-text-payload`、`gap-voice-capture-audio-file`、`gap-voice-capture-secrets-three-modes`），其中前两份的边界原文写着「不做捕获异常的隔离判据（AC-147）」；`grep -rln 'voice-capture-isolation\|voice\.capture failed' tasks/ server/ src/ scripts/` 零命中。GOAL-010 的六条判据各有一份互不重叠的判据文件，本条只认领 AC-147 的那一份（`-isolation`）：AC-143 是 `voice-capture-off.test.ts`（闸门与接缝），AC-144 是 `voice-capture-text.test.ts`（text 档载荷），AC-145 是 `voice-capture-audio.test.ts`（audio 档写文件），AC-146 是 `voice-capture-secrets.test.ts`（三档脱敏），AC-148 是 `scripts/voice-capture-process-check.mjs`（真实进程）。

**现状（立案时实测，可复验）**

| 缺什么 | 实测 |
|---|---|
| 判据文件 | `ls server/modules/voice/tests/voice-capture-isolation.test.ts` → `No such file or directory` |
| 捕获通道本体 | `grep -rln 'voice-capture\|VOICE_CAPTURE' server/ src/ scripts/` → 0 个文件（接缝由 AC-143 出货，本条只消费） |
| 失败行 | `grep -rn 'voice\.capture failed' server/ src/ scripts/` → 零命中；`grep -rn 'voice-capture-isolation' tasks/` → 零命中 |
| 唯一的尝试日志出口 | `voice.service.ts:717` 的 `logAttempt`，8 处调用（735/757/767/794/800/844/852/867），把行交给注入端口 `voice.service.ts:652` 的 `const log: VoiceLogPort = dependencies.logger ?? console` |
| **捕获抛错今天会变成转写失败** | 成功分支的 `logAttempt('ok', 200, …)` 在 `voice.service.ts:852`，**位于** `voice.service.ts:804` 的 `try {` 之内；其 `catch (error)` 在 `voice.service.ts:861` 把任意抛出折成 `unreachableBackendFailure(error, dependencies.timeoutMs)` 并 `return refusal`（另打一行 `logAttempt('fail', …)`）。捕获若挂在这个出口上而不自带 catch，一次日志端口抛错就把成功的转写**变成失败** —— 这正是 AC-147 要堵的洞，也是取假形态 (i) 的靶子 |
| 两个注入面都真实存在 | 日志端口可注入（`dependencies.logger ?? console`）；音频写端口由 AC-145 在组装处注入（`writeAudio`，收到上传字节与 `captureId`）。所以「打印捕获行时抛错」与「写文件时抛错」两条路都可用真出货件驱动，不需要改契约 |
| 失败行今天无处可生 | 提案要求「捕获全部包在 try/catch 里：失败只打一行 `voice.capture failed`（不含任何内容）」；今天没有任何一行以该字面量开头 |

**要交付的五件事**

1. **隔离与失败行只有一份**（扩 `server/modules/voice/voice-capture.ts`，AC-143 出货的那个模块；不新开第二份）：一个纯函数（名字自定）承担「尝试记录 → 行」的全部工作并把自身包在 try/catch 里；成功时交出那一行，抛出时交出**恰好字面量** `voice.capture failed`（不带任何参数：不拼 error 消息、不拼 error code、不拼捕获记录的任何字段）。
2. **捕获调用点自带 catch，且必须比 `voice.service.ts:804` 的那层更内层**：在捕获的调用点外面包一层**局部** try/catch，使捕获端口与日志端口的抛出**到达不了** `voice.service.ts:861` 的 `catch (error)`；失败时只打那一行，然后**继续走原有的返回路径**（成功分支仍返回 `{ ok: true, value: { text: result.text } }`，失败分支仍返回它自己那一支）。
3. **失败行自己也抛时仍不传播**：失败行的打印必须在同一个保护之内（可以是嵌套 guard）—— 一个对任何以 `voice.capture` 开头的行都抛的端口（`voice.capture failed` 在内）也不得让转写失败，此时那一行当然打不出来（见 AC7）。
4. **`voice.transcribe` 行不被牵连**：捕获抛错不影响该行照常打出，也不改变它的字段（除 AC-143 在非 `off` 档加的 `captureId`）。
5. **判据与取假形态**：`server/modules/voice/tests/voice-capture-isolation.test.ts`（AC-147 的 `criterion:` 文件，只有这一个文件能认领该判据）＋ `server/modules/voice/tests/voice-capture-isolation.false-forms.test.ts`（两条取假形态的可执行旁证，沿用本仓 `voice-dashscope-settings.false-forms.test.ts` 的形状：出货源文件的副本写到同树临时路径使相对 import 仍可解析、单锚点文本变异、动态 import 变异体、重跑同一份读数表、跑完即删；未变异副本必须先退出 0）。

**边界（不做）**：不做闸门与模式解析（AC-143）；不做 text 档载荷细化（AC-144）；不做 audio 档写文件与目录/文件权限（AC-145）；不做三档脱敏判据（AC-146）；不做真实进程判据（AC-148）；不改 `voice.transcribe` 行在 `off` 档的逐字节形状；不改 `voice.module.ts`；不改适配器与 registry 契约；`VOICE_CAPTURE` 不进设置页、不进健康负载、不进客户端；不改 TTS 通路；不联网、不重跑实验、不改 `experiments/` 与 `docs/experiments/` 下任何文件。

## AC

- [ ] AC1 判据入口与预算：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-isolation.test.ts` 退出 0；判据自身零子进程、零网络、零真实监听端口；末尾打印 `elapsed-ms=<n>`，实测 < 15000（目标侧判据门 60 秒硬上限且不可调）。读数表导出为对**任意**模块路径可重跑的 `collectReadings(modulePath)`（取假形态据此驱动变异体），读数名格式 `AC<n> <label>`（保持既有可归因形态）。
- [ ] AC2 text 档 · 打印捕获记录行时抛错 ⇒ 结果与文本逐字不变：`VOICE_CAPTURE=text`（把 `process.env.VOICE_CAPTURE` 的**原文**交给出货的模式解析函数，不写字面量，端口也用出货的构造函数建），注入的日志端口在收到以 `voice.capture {` 开头的行时抛一个哨兵错误、其余行原样记录。对同一份录音跑一次成功的转写，与「同一次运行内以不注入 capture 端口构造的基线服务」在同一份输入上的结果比对：`ok` 相同、`status` 相同、`value.text` **逐字相同**。正例（抛过的读数才算数）：打印 `text.captureThrew=<n>`（必须 ≥ 1）、`text.thrownOnCaptureLine=<b>`、`text.resultIdentical=<b>`、`text.textByteIdentical=<b>`。
- [ ] AC3 text 档 · 转写行不变且恰好只多一行：同一 arm 里，`voice.transcribe` 行去掉 `captureId=<…>` 记号后与基线的那一行**逐字节相同**；以 `voice.capture` 开头的行恰好 **1** 行，其去掉首尾空白后**逐字等于** `voice.capture failed`。打印 `transcribeLineEqual=<b>`、`failedLines=<n>`、`failedLineVerbatim=<b>`。
- [ ] AC4 失败行不含内容（带正例）：同一 arm 里造三个本次运行唯一的针：`TRANSCRIPT_SENTINEL`（替身上游信封里作为返回正文的那一段）、`AUDIO_BYTES`（上传字节，≥ 192 字节）、`KEY_SENTINEL`（`settings.dashscopeApiKey`）。断言并打印：(a) **正例** —— `serviceHadText=<b>`（返回的 `value.text` 含 `TRANSCRIPT_SENTINEL`）、`wireCarriedKey=<b>`（替身 fetch 收到的 `Authorization` 逐字等于 `Bearer <KEY_SENTINEL>`）；(b) **负例** —— `voice.capture failed` 那一行的原始文本里**不含** `TRANSCRIPT_SENTINEL`、`AUDIO_BYTES` 的 base64、`AUDIO_BYTES` 的原始字节子串、`KEY_SENTINEL`、`Bearer `、`Authorization`、`Content-Type` ⇒ `failedLineContentFree=<b>`。音频这一族针的**正例在 AC5**（text 档不写文件，AC-145），本条如实登记这个跨 arm 的控制，不假装它在本 arm 里被读。
- [ ] AC5 audio 档 · 音频目录不可写 ⇒ 结果与文本逐字不变，且失败行照出：`VOICE_CAPTURE=audio`，`VOICE_CAPTURE_DIR` 指到本次运行新建的临时目录下**正好落在一个普通文件之下**的路径（`<tmp>/blocker` 用 `writeFileSync` 造成普通文件，路径为 `<tmp>/blocker/voice-capture`），于是出货的 `writeAudio` 默认实现在 `mkdirSync` 上抛 `ENOTDIR`。对同一份录音跑一次成功转写：与 capture-off 基线比对 `ok`/`status`/`value.text` 逐字相同；以 `voice.capture` 开头的行恰好 1 行且去掉首尾空白后逐字等于 `voice.capture failed`；`fs.existsSync(<tmp>/blocker/voice-capture) === false`。正例：`audio.writeAttempts=<n>`（≥ 1）、`audio.writeRefused=<b>`（计数包装确实看到抛出）、`audio.bytesInHand=<b>`（包装把它收到的字节数与 `AUDIO_BYTES.length` 比，逐字节相同）—— 这就是 AC4 里音频那一族针的正面控制。打印 `audio.resultIdentical=<b>`、`audio.textByteIdentical=<b>`、`audio.dirCreated=<b>`、`audio.failedLineVerbatim=<b>`。
- [ ] AC6 上游失败的转写其错误状态不因捕获失败而改变：同一运行里再驱动一次上游失败（替身 fetch 对 dashscope 那条请求回 404 + 判据自造的 JSON 错误体），用同一份抛错日志端口：与「捕获关闭时同一次 404」的结果比对，`ok === false` 相同、`status` 相同、`error`（消息）**逐字相同**；其 `voice.capture failed` 行同样逐字出现。打印 `fail.ok=<b>`、`fail.status=<n>`、`fail.errorEqual=<b>`、`fail.failedLines=<n>`。
- [ ] AC7 失败行自己也被抛时仍不传播（同一不变量的更硬读法）：同一 arm 换一个「对**任何**以 `voice.capture` 开头的行都抛」的日志端口（`voice.capture failed` 也在内）⇒ 转写仍返回 `ok`、`value.text` 仍与基线逐字相同（此时那一行打不出来，本读数**不**要求它出现）。打印 `hardPort.threw=<n>`（≥ 1）、`hardPortSurvives=<b>`、`hardPort.textByteIdentical=<b>`。
- [ ] AC8 既有面不退化：`server/modules/voice/tests/voice-capture-off.test.ts`（AC-143）、`voice-capture-text.test.ts`（AC-144）、`voice-capture-audio.test.ts`（AC-145）、`voice.service.test.ts`、`voiceHealth.test.ts`、`voice-config.routes.test.ts`、`voiceTranscribeGaps.test.ts` 各退出 0；`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json`）与 `npm run lint` 退出 0；逐条打印退出码（不是空过）。
- [ ] AC9 两个取假形态是**可执行**的旁证：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-isolation.false-forms.test.ts` 退出 0，其中每条**先要求未变异副本退出 0**（恒红的工装不能证明任何事），再各自指名打红哪一条读数：(`i`) `capture-throw-reaches-the-outer-catch`：去掉捕获调用点的局部 try/catch（让抛出落进 `voice.service.ts:861` 的 `catch (error)`）⇒ 必须让 AC2 的 `text.resultIdentical` 判红（结果由 `ok` 变 `ok:false`）；(`ii`) `failed-line-carries-the-transcript`：让失败行拼上返回正文（例如 `voice.capture failed ` + 返回文本）⇒ 必须让 AC4 的 `failedLineContentFree` 判红（针命中）。变异体复制到同树临时路径（与 `voice-capture-isolation.test.ts` 同目录，使相对导入仍可解析）、跑完即删，`git status --porcelain` 在跑完后为空；每条打印 `mutation=<name> baseExit=0 mutantRed=<b> whichReading=<AC2|AC4>`。
- [ ] AC10 如实登记：判据输出与本任务的完成记录里写明「本条只做捕获失败的隔离与失败行本身：抛出被局部 catch 吃掉、失败行逐字为 `voice.capture failed` 且不带内容、`ok`/`status`/`text` 与不开启捕获时逐字相同；判据全程用替身 fetch、注入的日志端口与注入的写音频端口（audio 档那一次走的是出货的默认写实现加一个不可写的路径），未接触真实上游、未起真实服务进程」。

## DoD

真实落地判据：不是「多了一个 try/catch」，而是**同一份出货 service 在 `VOICE_CAPTURE=text` / `audio` 下、捕获那一环抛错时，返回给调用方的 `ok`/`status`/`text` 与不开启捕获时逐字相同**，并且账上只多一行字面量 `voice.capture failed` —— 由执行读数证明，不由段落文字声明。承重性由三件读数证明：

(a) **抛出是「真发生过」的**（AC2 的 `captureThrew≥1`、AC5 的 `writeRefused`、AC7 的 `hardPort.threw≥1`）：三条 arm 各有一个「注入面确实抛了」的计数读数；一个从不抛的端口证明不了隔离，所以该计数为 0 时同 arm 的 `*=Identical=<b>` 不算读数（本仓的老坑：**「零」的读数必须配一个正面控制**）。

(b) **抛出真的会伤到转写，所以隔离不是装饰**（AC9 的取假形态 (i)）：`voice.service.ts:852` 的那次 `logAttempt('ok', 200, …)` 就在 `voice.service.ts:804` 的 `try` 之内，其 `catch (error)`（`voice.service.ts:861`）会把任何抛出折成 `unreachableBackendFailure(...)` 的失败 —— 所以「去掉局部 catch」这个变异体必然把 AC2 的 `resultIdentical` 打成 `ok:false`。这把「捕获异常向上传播使转写失败 ⇒ 必须红」从一句担心变成一条可执行读数。

(c) **失败行的「不含内容」是搜出来的**（AC4 + AC5 的跨 arm 正例 + 取假形态 (ii)）：三个针族各有一处正面控制证明它们物理上到过捕获面（返回文本里有正文、线上带着 key、写端口收到的字节数与上传逐字节相同），负例在同一行上搜不到它们；变异体 (ii) 让这一条指名变红 —— 所以「没写正文」与「什么都没写」不是同一句话，而是两条读数。

**必须如实登记**：本条**不**做闸门与模式解析、**不**做 text 档载荷、**不**做 audio 档的写文件与权限、**不**做三档脱敏、**不**做真实进程；判据跑在替身 fetch、注入的日志端口与注入的写音频端口上（audio 档那一次走出货的默认写实现加一个不可写路径），未接触真实上游、未起真实服务进程；`VOICE_CAPTURE` 只在服务端环境变量上，不进设置页与健康负载。

**已知不等价点**：`voice.capture failed` 的**逐字相等**是对提案「失败只打一行、不含任何内容」的直接编码，比 AC 的 `expect` 字面（只说「不含转写正文、音频与 key」）更严 —— 若实现时确有必要在行上带错误类别，登记为发现并改读法，不静默放宽；AC7 读的是同一不变量的更硬形态（连失败行也打不出来时仍不传播），不是第二个命题；替身上游 404 的体是判据自造的，不等于真实 DashScope 的错误体；「不含」是「判据放的针在行里找不到」，不是对全部可能内容的穷举。

L_D 该轴仍暗，理由：本条读数全是布尔、计数与逐字比对，没有可比的数值量；捕获失败是判据注入的常量而不是测量。

L_G 该轴仍暗，理由：目标层的读数是真实服务进程标准输出上「捕获失败不影响转写」的现场（那条判据要求真实进程与本地替身上游），本条只到 service 面与组装面。

## Touches

- server/modules/voice/voice-capture.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-capture-isolation.test.ts (new)
- server/modules/voice/tests/voice-capture-isolation.false-forms.test.ts (new)
- tasks/gap-voice-capture-isolation.md
