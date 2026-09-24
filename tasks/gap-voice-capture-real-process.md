---
id: gap-voice-capture-real-process
title: 真实服务进程按 VOICE_CAPTURE 启动：stdout 出现启动行与捕获行、未设置时零捕获行，读数来自子进程 stdout 与一次真实
  HTTP（AC-148）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-capture-mode-gate-off-fail-closed
  - gap-voice-capture-text-payload
goal_ac: AC-148
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on` 上）：立案时 `grep -rho '^goal_ac: *AC-148' tasks/*.md` 零命中；`grep -rln 'AC-148' tasks/` 只命中四份同族任务的**范围让渡**文字（`gap-voice-capture-mode-gate-off-fail-closed`、`gap-voice-capture-text-payload`、`gap-voice-capture-isolation`、`gap-voice-capture-secrets-three-modes`），四份的边界原文都写着「不做真实进程判据（AC-148）」，其中三份把这条判据指名为 `scripts/voice-capture-process-check.mjs`；该文件 `ls` 不存在，`grep -rn 'VOICE_CAPTURE' server/ src/ scripts/ shared/` 与 `grep -rn 'voice\.capture' server/ src/ scripts/ shared/` 都是 0 命中。GOAL-010 的六条判据各有一份互不重叠的判据文件，本条只认领 AC-148 的那一份（真实进程）：AC-143 是 `voice-capture-off.test.ts`，AC-144 是 `voice-capture-text.test.ts`，AC-145 是 `voice-capture-audio.test.ts`，AC-146 是 `voice-capture-secrets.test.ts`，AC-147 是 `voice-capture-isolation.test.ts`。本条的判据不 import 任何 service 源码，读数全部来自真实子进程的 stdout 与一次真实 HTTP 请求 —— 这正是 AC-148 的取假形态要挡住的那种做法（在进程内注入端口构造读数）。

**现状（立案时实测，可复验）**

| 缺什么 | 实测 |
|---|---|
| 判据文件 | `ls scripts/voice-capture-process-check.mjs` → `No such file or directory` |
| 接缝本体 | `ls server/modules/voice/voice-capture.ts` → `No such file or directory`（AC-143 尚未出货） |
| 环境变量 | `grep -rn 'VOICE_CAPTURE' server/ src/ scripts/ shared/` → 0 个文件 |
| 捕获行 | `grep -rn 'voice\.capture' server/ src/ scripts/ shared/` → 0 个文件 |
| 真实进程今天能起 | `HOME=<tmp> SERVER_PORT=<free> HOST=127.0.0.1 DATABASE_PATH=<tmp>/auth.db VOICE_CAPTURE=text VOICE_API_BASE_URL=http://127.0.0.1:<double> npx tsx --tsconfig server/tsconfig.json server/index.ts` → 1.7 秒内打印 `CloudCLI Server - Ready`（两次实测 1517 ms 与 1790 ms） |
| 真实 HTTP 今天能通 | 同一进程上 `POST /api/voice/transcribe`，multipart 字段名 **`audio`**（字段名写 `file` 会得到 400 `Unexpected field`，实测），`Authorization: Bearer <token>`（`node scripts/mint-token.mjs mint --db <tmp>/auth.db --out <f>` 退出 0 且造出一次性 subject）→ **200** `{"text":"double-transcript-42"}`，替身记录到恰好一次 `POST /audio/transcriptions`（286 B） |
| 今天的 stdout | 同一次运行里 stdout 有 `voice.transcribe providerId=openai-compatible outcome=ok status=200 latencyMs=15`，而 `voice.capture` 行数 = **0**（即使 `VOICE_CAPTURE=text`）—— 这就是本条要闭合的差 |
| 硬链接副本可用 | `cp -al <repo>/. <tmp>/` 实测 1438 ms / 14.98 万个文件，副本里 `node_modules/.bin/tsx` 可用（取假形态的旁证靠它） |
| 继承环境里的两个陷阱 | 驱动锚点的 env 带着 `DATABASE_PATH=/data/home/yale/.cloudcli/auth.db`（操作员真实库）与 `FORCE_COLOR=2`（会把日志行包上 ANSI），子进程必须覆盖前者、关掉后者 |

（上面这套读数由本次立案时的一次性探针取得，探针跑在临时目录里，未改动仓库任何文件。）

**要交付的三件事**

1. **判据 `scripts/voice-capture-process-check.mjs`**（AC-148 的 `criterion:` 路径；裸 `node` 可跑）：自己起一个本地上游替身（`http://127.0.0.1:<随机端口>`，对 `POST /audio/transcriptions` 回一个固定 JSON `{"text": "<固定串>"}` 并记录收到的每一次请求），再按 `server:dev` 的那条命令从 `--root`（默认本仓根）起**真实服务进程** —— 本次运行的临时 `HOME`、`DATABASE_PATH`、`SERVER_PORT` 全部显式覆盖，`FORCE_COLOR=0`；用 `scripts/mint-token.mjs mint` 对**同一个临时库**造一次性 Bearer token；然后发**一次真实 HTTP** multipart（字段名 `audio`）。同一份流程跑两次：`VOICE_CAPTURE=text` 与 `VOICE_CAPTURE` 未设置（子进程 env 里显式删除该键；若仓库根 `.env` 里定义了它，判 `EMPTY_READING` 并非零退出）。读数全部来自子进程 stdout 与替身自己的请求记录。
2. **取假形态的可执行旁证 `scripts/voice-capture-process-check.false-forms.test.mjs`**：用 `cp -al` 把 `--root` 硬链接成一次性副本，在副本上各做一处文本变异跑同一条判据，要求「未变异副本先退出 0」再要求「变异必须红，且指名红的是哪一条读数」（两条变异各自只动 `server/modules/voice/voice.module.ts` 的一处，互相不遮挡）。
3. **不改任何出货源码**：本条只加判据与旁证。接缝（`voice-capture.ts`、`capture` 端口、`voice.module.ts` 的启动行与注入）由 AC-143 出货，载荷字段（含上游原始返回）由 AC-144 出货。若实现时发现真实进程 stdout 上缺的是**接缝没接进组装**，那是 AC-143 的读数而不是本条的 bug —— 登记为发现，不在本条顺手改 `voice.module.ts`。

**边界（不做）**：不改 `server/`、`src/`、`shared/` 下任何文件；不做闸门与模式解析（AC-143）；不做 text 档载荷细化（AC-144）；不做 audio 档写文件（AC-145）；不做三档脱敏（AC-146）；不做捕获失败隔离（AC-147）；不驱动浏览器；不读 `server.log`（判据读的是子进程 stdout；`server.log` 的重定向是部署方的事）；不联网、不碰真实 DashScope、不读 `.env` 与 `.env.test` 里的任何凭据；不改 `experiments/` 与 `docs/experiments/` 下任何文件。

## AC

- [ ] AC1 判据入口、预算与隔离：`node scripts/voice-capture-process-check.mjs` 退出 0；打印 `elapsed-ms=<n>`，实测 < 45000（目标侧判据门 60 秒硬上限且不可调）；两个子进程的 env 里 `HOME` 与 `DATABASE_PATH` 都指向本次运行的临时目录，判据打印 `child-home=<...>`、`child-db=<...>`；运行前后各读一次**继承 env 里**那个 `DATABASE_PATH`（存在时）的 `mtimeMs`，打印 `real-db-untouched=<b>` 且必须 `true`（沿继承值会让 `mint-token` 往操作员真实库里插一行，这是本条要挡的实害）。
- [ ] AC2 启动行在真实进程 stdout 上：`VOICE_CAPTURE=text` 那次真实进程的 stdout（去掉 ANSI 后按行比对）里恰好一行匹配 `^voice\.capture mode=text$`；打印 `startup.text.count=<n>`、`startup.text.line=<...>`；同一份判据的 `off`/未设置那一次不得出现这一行。
- [ ] AC3 捕获行与替身上游返回逐字一致：`text` 档那次 stdout 里恰好一行 `voice.capture`，其单行 JSON 可 `JSON.parse`，「上游原始返回正文」那一项与替身本次实际返回的正文**逐字相同**，返回给调用方的文本项也**逐字相同**；打印 `capture.lines=<n>`、`upstream.exact=<b>`、`text.exact=<b>`；另打印替身自己的请求记录 `double.requests=<n>`、`double.path=<...>`、`double.bytes=<n>`，并要求 `double.requests === 1` 且 `double.path === '/audio/transcriptions'`（正例：这次 HTTP 真的穿过了真实进程，不是判据自己编的读数）；该次 HTTP 必须 `status=200` 且正文里的 `text` 与替身文本逐字相同（打印 `http.status`、`http.text.exact`）。
- [ ] AC4 未设置时零捕获行，且「零」有正例托底：`VOICE_CAPTURE` 未设置的第二个真实进程上，同一条真实 HTTP 请求必须 `status=200` 且返回文本与替身文本逐字相同（否则「零捕获行」可能只是请求没跑通），而 stdout 里 `voice.capture` 行数 `=== 0`；打印 `unset.captureLines=0`、`unset.httpStatus=200`、`unset.text.exact=true`、`unset.startup.line=<...>`（未设置时启动行读出的是 `off`；那是 AC-143 的读数，本条只消费它）。
- [ ] AC5 取假形态是可执行的旁证，且每条指名红的是哪一条读数：`node --test scripts/voice-capture-process-check.false-forms.test.mjs` 退出 0；每条先跑「未变异的一次性硬链接副本」要求 `baseExit=0`，再在同一副本上变异并跑同一条判据：(i) `assembly-not-wired` —— 删掉 `server/modules/voice/voice.module.ts` 里把捕获端口交进 `createVoiceService` 的那一处 ⇒ **AC3 的 `capture.lines` 必须从 1 变 0**（红），而 AC2 的启动行仍在；(ii) `startup-line-missing` —— 删掉该文件里打启动行的那一次调用 ⇒ **AC2 的 `startup.text.count` 必须从 1 变 0**（红），而 AC3 的捕获行仍在。每条打印 `mutation=<name> baseExit=0 mutantRed=<b> whichReading=<capture.lines|startup.text.count>`；跑完副本已删除，且 `git status --porcelain` 在仓库里为空。
- [ ] AC6 判据只读进程与替身，不 import 出货源码：`grep -c 'createVoiceService\|voice\.module\|voice\.service' scripts/voice-capture-process-check.mjs` 为 0（打印 `service-source-imports=<n>`）；判据里出现的上游目标只有 `http://127.0.0.1:<替身端口>` 与 `http://127.0.0.1:<服务端口>`（打印 `hosts=<...>`），对任何非 `127.0.0.1` 的目标在出发前抛错（打印 `real-upstream-calls=0`）。
- [ ] AC7 如实登记：判据输出与本任务的完成记录写明「本条判的是真实服务进程与一次真实 HTTP；上游是本地替身而不是真实 DashScope；不驱动浏览器；读的是子进程 stdout 而不是 `server.log`；判据与旁证不改任何出货源码」。
- [ ] AC8 仓库门不回归：`npm run lint`、`npm run typecheck`、`npm run test:scripts` 各退出 0（逐条打印退出码；不是空过）。

## DoD

真实落地判据：不是「多了一个 .mjs」，而是**同一份出货组装**被**真实进程**启动后，stdout 上确实出现启动行与一行 `voice.capture`、其正文与替身上游返回逐字相同；而在同一份判据里，未设置时同一条真实请求照样成功却是零捕获行 —— 由执行读数证明，不由段落文字声明。承重性由三件读数证明：

(a) **「零」有正例**（AC3 对 AC4）：`text` 档 1 行、未设置 0 行，两次的 HTTP 都是 200 且文本逐字相同 —— 「没跑通」与「没捕获」被分开，`VOICE_CAPTURE` 被忽略的空实现在 AC3 立刻红。

(b) **「真实」有独立证人**（AC3 的 `double.requests`）：上游替身自己记到恰好一次 `POST /audio/transcriptions`，所以这次 HTTP 真的穿过了真实进程的路由、鉴权与 service，不是判据在进程内构造的读数。

(c) **接线**正是判据的分辨力所在（AC5）：删掉组装处的那一处注入，捕获行读数就从 1 变 0；删掉启动行那一次调用，启动行读数就从 1 变 0 —— 两条读数各自被一条变异指名，所以 AC-148 的取假形态「捕获只在单测的注入端口里成立而没有接进真实服务的组装」过不了这一条。

**必须如实登记**：上游是本地替身，不是真实 DashScope；读的是子进程 stdout，不是 `server.log`（重定向是部署方的事，目标是「标准输出」）；不驱动浏览器；判据与旁证不改任何出货源码；`VOICE_CAPTURE` 不进设置页、不进健康负载、不进客户端。

**已知不等价点**：真实进程的 stdout 与部署时写进 `server.log` 的内容未必同形（启动命令可能加时间戳或重定向）；判据用 `tsx` 直接跑 `server/index.ts`，不是编译产物 `dist-server/server/index.js`，因此「编译后仍成立」不被本条证明；替身只说 openai-compatible 的 multipart 线，不等于真实 DashScope；取假形态是在硬链接副本上做的文本变异，证明的是判据的分辨力，不是变异体本身会出货。

L_D 该轴仍暗，理由：本条读数全是布尔、计数、逐字比对与一个墙钟预算，没有可比的数值量；启动耗时是环境量而不是本条的命题。

L_G 读数：真实服务进程 stdout 上，捕获行条数 VOICE_CAPTURE 为 text 时 = 1、未设置时 = 0；启动行条数 = 1（未设置时读出 off）。

## Touches

- scripts/voice-capture-process-check.mjs (new)
- scripts/voice-capture-process-check.false-forms.test.mjs (new)
- tasks/gap-voice-capture-real-process.md