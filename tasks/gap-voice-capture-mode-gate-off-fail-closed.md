---
id: gap-voice-capture-mode-gate-off-fail-closed
title: 语音捕获的模式闸门与失败关闭：VOICE_CAPTURE 未设置/off/非法值三情形下日志逐字节等于基线、不建目录不写文件、非法值一行告警并按
  off、启动行读出生效模式（AC-143）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-143
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rln 'AC-143' tasks/`、`grep -rln 'VOICE_CAPTURE' tasks/`、`grep -rln 'voice\.capture' tasks/`、`grep -rln 'GOAL-010' tasks/` 四者**零命中**；本条的判据文件 `server/modules/voice/tests/voice-capture-off.test.ts` 在 `server/` 下也零命中。GOAL-010 的六条判据各有一份互不重叠的判据文件，本条只认领 AC-143 的那一份（`-off`）：载荷细化（实际模型、上游原始返回逐字、结果分支、64KB 截断）在 `-text` 那份，audio 档在 `-audio` 那份，脱敏在 `-secrets` 那份，捕获失败隔离在 `-isolation` 那份，真实进程在 `scripts/voice-capture-process-check.mjs`。本条只负责**闸门与接缝**：模式从哪来、`off` 怎么做到真的零、非法值怎么失败关闭，以及为了让「这里的零不是空实现的零」可证而必须存在的那一条最小捕获行。

**现状（立案时实测，可复验）**

| 缺什么 | 实测 |
|---|---|
| 判据文件 | `ls server/modules/voice/tests/voice-capture-off.test.ts` → `No such file or directory` |
| 环境变量 | `grep -rn 'VOICE_CAPTURE' server/ src/ scripts/` → 零命中 |
| 捕获位 | `grep -rn 'voice\.capture\|captureId' server/ src/` → 零命中 |
| 启动行 | `grep -rn 'mode=' server/modules/voice/` → 零命中（今天没有「启动行」这种东西） |
| 环境变量的读点 | `grep -rn 'process\.env\.VOICE' server/` 只有 7 处，全在 `server/modules/voice/voice.module.ts`（`VOICE_TIMEOUT_MS` / `VOICE_API_BASE_URL` / `VOICE_API_KEY` / `VOICE_STT_MODEL` / `VOICE_TTS_MODEL` / `VOICE_TTS_VOICE` / `VOICE_PROVIDER_ID`），没有 `VOICE_CAPTURE` |
| 唯一的尝试日志出口 | `server/modules/voice/voice.service.ts:717` 的 `logAttempt`，只写模块自己算出的形状字段（`providerId/outcome/status/latencyMs[/promptVersion][/writtenFallback]`）；日志端口 `VoiceLogPort` 是注入的（`voice.service.ts:57`，缺省 `console` 在 `voice.service.ts:652` 解析） |
| 服务不读全局 | `createVoiceService` 的形状与注释要求依赖注入（`dependencies.logger ?? console`），所以「模式」必须在组装处读进来、注入进去，不能在 service 里读 `process.env` |

**要交付的五件事**

1. **模式解析只有一份**（新模块 `server/modules/voice/voice-capture.ts`）：`resolveVoiceCaptureMode(raw)`（入参是 `string | undefined`，**不是** `process.env`）→ `{ mode: 'off' | 'text' | 'audio', warning: string | null }`；未设置 → `off`，`off` → `off`，`text`/`audio` → 自身，其余一律 → `off` **且** `warning` 非空（含非法原文）。启动行文本与告警文本由同一模块的两个纯函数产出，这样「启动时读一次、打一行、非法值只多一行告警」是可判的，而不是靠散文声明。
2. **组装处是唯一读该环境变量、唯一打启动行的地方**：`voice.module.ts` 里 `process.env.VOICE_CAPTURE` 恰好出现一次，并调用那个唯一函数打启动行（`log.info`），非法值再打一行告警。⛔ service 内部不得读 `process.env`。
3. **闸门与接缝**：`VoiceServiceDependencies` 增一个可选 `capture` 端口（与 `logger`/`fetchBackend` 并列，缺省 = 不捕获）。`off` 档（含未设置与非法值）：`logAttempt` 的输出**逐字节不变** —— 不加 `captureId`、不构造记录、不触碰文件系统；`text` 档：每次尝试多一行单行 JSON `voice.capture {…}`（同一个 `log.info`），同一次尝试的 `voice.transcribe` 行多一个 `captureId=<id>`，两处 id 逐字相同。本条的最小记录集：`captureId`、`providerId`、`outcome`、`status`；载荷细化不在本条（见边界）。
4. **失败关闭的物理形态**：目录**不预建**。`off` 档下即使 `VOICE_CAPTURE_DIR` 指到一个不存在的路径，那个目录也不得被创建，写音频端口一次都不被调用。
5. **判据与取假形态**：`server/modules/voice/tests/voice-capture-off.test.ts`（AC-143 的 `criterion:` 文件）＋ `server/modules/voice/tests/voice-capture-off.false-forms.test.ts`（两条取假形态的可执行旁证，沿用本仓 `voice-dashscope-settings.false-forms.test.ts` 的形状：把出货源文件复制到同树临时路径、做一次文本变异、动态 import 变异体、重跑同一份读数；未变异副本必须先退出 0）。

**边界（不做）**：不做 text 档载荷细化（实际模型、上游原始返回逐字、结果分支、64KB 截断与 `truncated` 标记）；不做 audio 档写文件与目录/文件权限；不做三档脱敏判据；不做捕获异常的隔离判据；不做真实进程判据；`VOICE_CAPTURE` 不进设置页、不进健康负载、不进客户端；不改 TTS 通路；不联网、不重跑实验、不改 `experiments/` 与 `docs/experiments/` 下任何文件。

## AC

- [ ] AC1 判据入口与预算：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.test.ts` 退出 0；判据自身零子进程、零网络、零真实监听端口；末尾打印 `elapsed-ms=<n>`，实测 < 15000（目标侧判据门 60 秒硬上限且不可调）。
- [ ] AC2 三种情形各自逐字节等于基线：未设置 / `VOICE_CAPTURE=off` / `VOICE_CAPTURE=verbose`（非法）三种情形，各对同一份录音做**一次成功**与**一次上游失败**（替身 fetch，失败重放「404 + 错误体」形状）的 `transcribe`；收集型日志端口抓到的行（时间字段用固定时钟冻结，实现方式自定）与「同一份输入、同一次运行内以**不注入 capture 端口**构造的基线服务」的输出**逐行逐字节相同**；三条情形各打印 `case=<unset|off|invalid> lines=<n> baseline=<n> equal=<b>`。另断言三条情形下**都没有** `voice.capture` 行、`voice.transcribe` 行**都不含** `captureId`，打印 `captureLines=<n>`、`carries-captureId=<b>`。
- [ ] AC3 零文件与零目录：三条情形下把 `VOICE_CAPTURE_DIR` 指到本次运行新建的临时父目录下的**不存在**路径，转写跑完后 `fs.existsSync(该路径) === false`；注入的写音频端口调用次数 `=== 0`；打印 `dir-created=<b>`、`writeAudio-calls=<n>`。另断言 `off` 档下默认音频目录的解析函数零调用（用一个计数包装读出），打印 `defaultDir-resolves=<n>`。
- [ ] AC4 启动行读出生效模式，非法值恰好一行告警：由组装处调用的那个唯一函数产出 —— 未设置 → 恰好 `['voice.capture mode=off']`（无告警行）；`off` → 恰好同上；`verbose` → 恰好两行：一行 `voice.capture mode=off`，一行告警，告警含非法原文 `verbose` 且恰好一行；正例 `text` → `voice.capture mode=text`（「一律读 off」的空实现必红）。并在判据内读 `server/modules/voice/voice.module.ts` 源码断言：`process.env.VOICE_CAPTURE` 在其中**恰好出现一次**（「启动时读一次」的机械形态），且启动行函数的符号名在该文件里被调用；打印 `startup-lines=<…>`、`envReads=<n>`、`announce-called=<b>`、`warnLines=<n>`。
- [ ] AC5 正例 —— 这里的零不是空实现的零：同一次运行里 `VOICE_CAPTURE=text` 对同一份输入（成功 + 失败各一次）必须出现**恰好 2 行** `voice.capture`，每行是合法单行 JSON（`JSON.parse` 成功且 `split('\n').length === 1`），其 `captureId` 与同一行 `voice.transcribe` 里的 `captureId` 逐字相同；打印 `text.captureLines=<n>`、`text.parseable=<b>`、`text.idMatch=<b>`。
- [ ] AC6 接缝不改既有字段面：`off` 档下 `voice.transcribe` 行的字段集合与基线**只减不增**（本条只允许在非 `off` 档追加 `captureId`）；`voice.service.test.ts`、`voiceHealth.test.ts`、`voice-config.routes.test.ts`、`voiceTranscribeGaps.test.ts` 四条既有判据各退出 0；`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json`）与 `npm run lint` 退出 0；逐条打印退出码（不是空过）。
- [ ] AC7 两个取假形态是**可执行**的旁证：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.false-forms.test.ts` 退出 0，其中每条**先要求未变异副本退出 0**（恒红的工装不能证明任何事），再：(`i`) `gate-permanently-open`：把闸门短路成「一律记录」⇒ 必须让 AC2 的那一行（`equal=<b>` / `captureLines=<n>`）判红；(`ii`) `invalid-treated-as-text`：把非法值分支改成 `mode='text'` ⇒ 必须让 AC4 的启动行读数（读到 `text` 而非 `off`）判红。变异体复制到同树临时路径、跑完即删，`git status --porcelain` 在跑完后为空；每条打印 `mutation=<name> baseExit=0 mutantRed=<b> whichLine=<AC2|AC4>`。
- [ ] AC8 如实登记：判据输出与本任务的完成记录里写明「本条只做模式解析、组装处的启动行与告警、闸门与最小捕获行、失败关闭的物理形态；判据全程用替身 fetch 与冻结时钟，未接触真实上游」。

## DoD

真实落地判据：不是「多了一个 if 和一个新文件」，而是**同一份出货组装**（`voice.module.ts` 读一次环境、打启动行、把模式注入 service）在 `off` 档下产出与今天**逐字节相同**的日志、不建目录、不写文件、`voice.transcribe` 行不变，而在 `text` 档下确实多出带 `captureId` 的捕获行 —— 由执行读数证明，不由段落文字声明。承重性由三件读数证明：

(a) **「零」有正例**（AC5）：同一份输入、同一次运行，`text` 档两行捕获行、`off` 档零行 —— 「什么都没实现」在 `text` 档立刻红，「不看模式一律记录」在 `off` 档立刻红；两条取假形态（AC7）各自指名打红的是哪一行读数。

(b) **「逐字节」是比对出来的**（AC2）：三情形与基线服务逐行比对，而不是断言「没有某个字符串」—— 后者对「多打了一行别的」是盲的。

(c) **启动行与告警来自组装处**（AC4）：环境变量在 `voice.module.ts` 里恰好读一次、启动行函数的符号确实被该文件调用 —— 「启动行只存在于测试里」过不了这一条；真实进程 stdout 上的那条读数不在本条。

**必须如实登记**：本条**不**做 text 档载荷细化、**不**做 audio 档、**不**做脱敏判据、**不**做捕获失败隔离、**不**做真实进程判据；判据跑在替身 fetch 与冻结时钟上，未接触真实上游（真实冒烟归人工）；`VOICE_CAPTURE` 只在服务端环境变量上，不进设置页与健康负载。

**已知不等价点**：本条给 `text` 档的捕获行只有最小字段集（`captureId`/`providerId`/`outcome`/`status`），因此「`text` 档能看见上游原始返回」这件事在本条**不被证明**，那是 `-text` 那份判据的命题；两个取假形态是在**副本**上做的文本变异，证明的是判据的分辨力，不是变异体本身会出货。

L_D 该轴仍暗，理由：本条读数全是布尔、存在性与逐字节比对，没有可比的数值量；`off` 档不新增文件、不改变出站字节，本条不产出任何可比的量。

L_G 该轴仍暗，理由：目标层的读数是真实服务进程 stdout 上的启动行与捕获行（那条判据要求真实进程与本地替身上游），本条只到组装面与单元面。

## Touches

- server/modules/voice/voice-capture.ts (new)
- server/modules/voice/voice.module.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-capture-off.test.ts (new)
- server/modules/voice/tests/voice-capture-off.false-forms.test.ts (new)
- tasks/gap-voice-capture-mode-gate-off-fail-closed.md
