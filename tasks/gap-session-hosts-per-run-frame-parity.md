---
id: gap-session-hosts-per-run-frame-parity
title: AC-155 per-run 客户端可见帧逐帧不变：四个 provider 经真实 chat websocket（send / abort /
  忙时重复发送 / subscribe 重放）与接入宿主层之前录下的基线 fixture 深比较
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-session-hosts-default-wrap-four-providers
goal_ac: AC-155
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rln 'goal_ac: *AC-155' tasks/*.md` → 0 个文件；`grep -rln 'per-run-parity' tasks/*.md` → 0 个文件；`ls tasks/ | grep session-hosts` → 只有 `gap-session-hosts-default-wrap-four-providers.md` 一个。同区两条相邻任务都不重复：`gap-session-hosts-default-wrap-four-providers`（AC-154）只认领「宿主登记与关闭原因」，它的 AC9 只做一次「绕过 manager 直跑 runtime」对「经 providerRuntimeService 跑」的帧深比较，并明确把「客户端可见行为的逐帧不变」让给本条；`gap-claude-runtime-frame-forwarding-coverage`（done）只补归一化器→writer 之间那一环的转发覆盖。本条的判据必须跑在**含宿主层包装**的树上（否则「接入前后逐帧相同」在这棵树上没有后半句），故顶层 `depends_on` 指向 AC-154 的落地任务：先 AC-154 把包装接进 `provider-runtime.service.ts`，再本条落下基线 fixture 与比较判据。

**来源与判据物。** 判据逐字取自 `goals/AC-155-per-run-的客户端可见行为在接入宿主层前后逐帧相同.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts`。红态基线（本轮**直跑**，不是推断）：该命令在当前树上退出 **1**，文案逐字 `Could not find 'server/modules/session-hosts/tests/session-host-per-run-parity.test.ts'`；`ls server/modules/session-hosts/` 无此目录。

**现状（本轮实测的读数，逐条都有出处）**

- **真实 ws 分派面**：`server/modules/websocket/services/chat-websocket.service.ts` 里 `handleChatConnection` 在 `:620`，`case 'chat.send'` `:644`、`'chat.abort'` `:647`、`'chat.subscribe'` `:650`；`handleChatSend` `:154` → `dispatchRun` `:216`。忙时重复发送的拒绝在 `:235-247`：`chatRunRegistry.startRun` 返回 null ⇒ `sendProtocolError(ws, 'RUN_IN_PROGRESS', …)`；`sendProtocolError` 在 `:126`，走 `sendJson` `:116` **直发、不带 seq**（所以它在投影里只能用 `kind + code` 认）。中止：`handleChatAbort` `:432` → `:449` `dependencies.runtime.abort(run.provider, sessionId)` → `:453` `chatRunRegistry.completeRun(sessionId, { exitCode: success ? 0 : 1, aborted: true })`（被中止那一轮的 terminal complete 由 ws 层**代发**）。订阅/重放：`handleChatSubscribe` `:465`，ack 帧 `kind: 'chat_subscribed'` `:503`，`attachConnection` `:495`，重放 `:516` `chatRunRegistry.replayEvents(sessionId, lastSeq)`；`lastSeq` 缺省 0（`:484-487`），且**只对 RUNNING 的 run 重放**（`:512-518`）。
- **seq 与帧装饰**：`server/modules/websocket/services/chat-run-registry.service.ts` 的 `decorateAndRecordEvent` `:84`，每帧 `run.lastSeq += 1` 并写回 `seq`（`:93-98`）；`startRun` `:167`（`lastSeq: 0`）；`replayEvents` `:265`；`clearAll` `:307`；`MAX_BUFFERED_EVENTS_PER_RUN = 5000` `:51`。**exactly-one-complete 去重在 `:88-92`**：`kind === 'complete'` 且 run 已 `completed` ⇒ 直接 `return null` 丢弃（假形态 (a) 的第一个陷阱）。
- **complete 帧**：构造器 `createCompleteMessage` 在 `server/shared/utils.ts:376`（`kind: 'complete'`、`exitCode` 默认 1、`aborted`）。
- **可复用的驱动面（既有测试的写法，不是发明）**：`server/modules/websocket/tests/chat-edit-send.test.ts` 的 `createFakeSocket()` `:17-26`（EventEmitter + `readyState = 1` + `frames` 收 `JSON.parse`）、`withGateway()` `:84-135`（存/恢复 `DATABASE_PATH`、临时库、`sessionsDb.createSession`、`handleChatConnection(socket, { user: { id: 1 } }, { runtime })`，finally 里 `connectedClients.clear()` + `chatRunRegistry.clearAll()` + `closeConnection()`）、`holdTheNextRun()` `:70-78`（把一轮按住不结算——`:265` 那条 RUN_IN_PROGRESS 断言就是这么造的）、`settle()` `:138`（30ms 定时器）。
- **生产分派入口**：`server/modules/providers/services/provider-runtime.service.ts` 的 `createProviderRuntimeService` `:42`、真正调 `provider.runtime.run(...)` `:72`、`abort` `:90-91`、生产单例 `:108`；`isProviderInstalled` 探测失败时返回 true（`:59-66`），所以不需要伪造 auth。四个 provider 的 runtime 都有 abort（claude `server/modules/providers/list/claude/claude-runtime.provider.js:1268`、codex `server/modules/providers/list/codex/codex-runtime.provider.ts:509`、cursor `server/modules/providers/list/cursor/cursor-runtime.provider.js:386`、opencode `server/modules/providers/list/opencode/opencode-runtime.provider.js:429`）。
- **仓库里没有已提交的 JSON fixture 先例**（`find server -path '*test*' -name '*.json'` → 0），本条是第一个：fixture 必须**随测试提交**，不是运行时生成。

**要建的东西**（全部落在 `server/modules/session-hosts/tests/` 下）

1. `per-run-frame-scenarios.ts` —— 场景驱动 + 每个 provider 的假进程 + 帧投影。**不 import `server/modules/session-hosts/index.ts`**：它要在基线录制树（AC-154 之前那棵树）里也能跑，而那个树上宿主模块还不存在。驱动必须用**真实**的 `handleChatConnection`、真实的 `chatRunRegistry`、真实的 `providerRuntimeService`（`provider-runtime.service.ts:108` 的生产单例）当 `dependencies.runtime`，只把 provider 的**进程**换成假，伪造在进程/原型层（不替换 provider 对象、不另造 `ProviderRuntimeContext`，否则「经真实分派入口」就不成立）：
   - **codex**：`t.mock.method(Codex.prototype, 'startThread' | 'resumeThread')` 返回假 `Thread`，其 `runStreamed()` 返回 `{ events: (async function* () {…})() }`（机制出处 `server/modules/providers/tests/codex-runtime.test.ts:27-41`）。
   - **opencode**：临时目录里写 `#!/bin/sh` + `node` 的 shim、`chmod 0o755`、PATH 前插（机制出处 `server/modules/providers/list/opencode/opencode-runtime.provider.test.js:25-58` 的 `createFakeOpenCodeExecutable`）。
   - **cursor**：同一形态的假 `cursor-agent`（`cursor-runtime.provider.js:159` `spawnFunction('cursor-agent', args, …)`）。
   - **claude**：`CLAUDE_CLI_PATH` 指向临时目录里的假 CLI（`claude-runtime.provider.js:238` 读 `resolveClaudeCodeExecutablePath`，`server/shared/claude-cli-path.ts:143`），按 SDK stream-json 协议输出 `system/init` → `assistant` → `result`，且提供闸门。
   **这四个假必须在 driver 里自带一份，不能 import AC-154 的测试文件**：录制基线的那棵树在 AC-154 之前，`tests/session-host-default-wrap.test.ts` 在那棵树上不存在。假进程必须 emit **确定性**的 session id 与文本，并提供一个测试可放的**闸门**（不结算即可制造「run 仍在进行」）。
2. **四个场景 × 四个 provider = 16 条录制**：① 正常一轮（`chat.send` 到 terminal `complete`）；② 中途中止（run 在飞行中 `chat.abort`）；③ 忙时重复发送（第一轮按住不结算，同 socket 再 `chat.send` ⇒ 基线里必须有 `RUN_IN_PROGRESS` 的 `protocol_error` 帧）；④ 断线后按 lastSeq 重放（第一轮跑到**被观测到的第 N 帧**后，新 socket `chat.subscribe` 带一个中途 `lastSeq`，收 ack + 重放帧）。推进一律**按观测到的帧**轮询（带上限超时），**不许用固定 sleep 当同步手段**——录制被截断会读成更短的序列，是假红/假绿的来源。
3. `session-host-per-run-parity.test.ts`（判据）—— 读 fixture，按上面的驱动逐条重放，与基线逐帧深比较；另加「活的这棵树真的接进了宿主层」的断言（见不变式 2）。fixture 用 `fileURLToPath(new URL('./fixtures/per-run-frame-baseline.json', import.meta.url))` + fs 读，**不要** `import … with { type: 'json' }`。
4. `record-per-run-frame-baseline.test.ts`（录制器）—— 默认 skip（`{ skip: !process.env.PER_RUN_PARITY_RECORD_COMMIT }`），并在**写文件前硬拒绝**：除非 `git cat-file -e <PER_RUN_PARITY_RECORD_COMMIT>:server/modules/session-hosts/index.ts` **失败**（那棵树确实还没有宿主模块）而当前 HEAD 的同一路径存在，否则 throw 且不写。这个拒绝闸就是「fixture 不是事后补录」的机械保证。
5. `fixtures/per-run-frame-baseline.json` —— 头部 `{ recordedAtCommit, recordedAt, providers, scenarios }`，主体是 16 条投影后的帧序列。

**基线怎么录（顺序本身是判据的一部分）**：宿主层落地提交 `HOST_COMMIT=$(git log --diff-filter=A --format=%H -1 -- server/modules/session-hosts/index.ts)`，锚点 `PRE=$(git rev-parse ${HOST_COMMIT}^)`。在**仓库根目录内**开临时 worktree（`git worktree add .worktrees/parity-record $PRE`；放仓内是为了让 Node 的模块解析沿父目录找到仓库根的 `node_modules`——worktree 自己不装依赖），把 `per-run-frame-scenarios.ts` 与 `record-per-run-frame-baseline.test.ts` 按同样相对路径拷进去，在那棵树里跑 `PER_RUN_PARITY_RECORD_COMMIT=$PRE npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/record-per-run-frame-baseline.test.ts` 产出 fixture，把 fixture 拷回主 checkout 提交，`git worktree remove` 清掉，保证 `git status --short` 干净。

**两个假形态（判据的分辨力证明，必须实测）**

- **(a) 宿主关闭时补发一个合成 complete** ⇒ 多出一帧，必须红。**已知陷阱（必须先用读数确认，再登记）**：`chat-run-registry.service.ts:88-92` 的 exactly-one-complete 去重会把「run 已 completed 之后再来的 complete」直接丢掉，所以最朴素的写法（经由 `run.writer`）**很可能到不了 socket**、变成 no-op（那会儿判据照绿，而你会以为它在承重）。实现者必须先证明这条变体真的往 socket 多送了一帧（直写连接那一支是可达形态），并把「朴素版本是 no-op」的读数也抄进完成记录。
- **(b) 忙时直写逻辑泄漏到 per-run** ⇒ 场景③不再返回 `RUN_IN_PROGRESS`，必须红。做法是让 per-run 宿主在 busy 时也走「直接写入进程、不返回 RUN_IN_PROGRESS」的忙时输入分支（即 proposal §8 / AC-157 的常驻规则漏给 per-run），于是场景③的 `protocol_error` 帧消失。**如实登记**：常驻侧的真实现今天还不存在（AC-157 / AC-159 未落地），所以这条变体是**构造出来的**，不是真回归；完成记录要写「构造的」，并给出它红在哪一条读数上。
- 两个形态都**只改实现、判据文件一字不动**；实测完 `git checkout --` 还原到 `git status --short` 只剩 Touches 里的文件 + 任务文件。

**不变式与正控制（不许让「相同」变成恒真）**

1. 比较是**零差**声明，所以每条录制必须自证非空、非平凡：投影后每条序列帧数 > 0；正常一轮那条含且仅含一个 terminal `complete`（并读它的 `exitCode` 与 `aborted`）；场景③那条含 `RUN_IN_PROGRESS` 的 `protocol_error`；场景④那条含 ack `chat_subscribed` 且至少有 1 条 `seq > lastSeq` 的重放帧。这些读数逐条打印。
2. 判据自己也要证明「这棵树上确实有宿主层」：正常一轮进行中，`sessionHostManager.snapshot()` 里该会话恰有一个 `mode=per-run` 的宿主（读数打印）。否则 AC-154 被回退时判据会**假绿**（帧没变，因为什么都没接进来）——这条把「接入后」那半句钉住。
3. **比较器自测（反红可达性）**：喂给它 `(基线, 基线去掉最后一帧)` 必须报「缺帧」并点名那条帧；`(基线, 基线追加一条合成 complete)` 必须报「多帧」。这直接证明假形态 (a) 的检出路径存在，而不是一条永不触发的断言。
4. **录制确定性自测**：同一 provider 的同一场景连跑两次，投影必须逐字节相同；不同则判据红（否则基线与活体的比较是噪声）。
5. **投影不许悄悄放宽**：默认丢弃的只有 `timestamp`；`kind` 与 `seq` 永不丢；`complete` 带 `exitCode`/`aborted`，`protocol_error` 带 `code`。若某字段在假进程下无法稳定（例如运行时生成的 provider 侧 id），可以把它也丢进投影，但**必须逐个登记字段名 + 不稳定原因 + 实测读数**；帧数与顺序严格相等，任何一帧都不许被丢。

**非目标**：AC-154（宿主登记与关闭原因）、AC-156 的两条 REST、AC-157 的状态机/停机/关闭原因穷举、AC-158 的 1:N 解绑与顶替、AC-159 的 Claude 常驻 driver、AC-160 的调试 agent 场景 op。本条**不改任何生产代码**：不改四个 runtime（`server/modules/providers/list/**`）、不改 ws 分派语义、不改 `chat-run-registry.service.ts`；只加测试与 fixture，录制与重放共用同一份 `per-run-frame-scenarios.ts`（不新起第二份实现）。若假 CLI 在预算内无法满足 SDK 协议（已知风险：`result`/`init` 的字段形状随 SDK 版本收紧），**不得**换 provider 顶替、也不得把 claude 那一格降级成 manager 单测；改用真 CLI + mock 端点（`server/modules/providers/tests/model-gateway-end-to-end.test.ts` 的 `startMockAnthropic()` `:60` / `createFakeSocket()` `:89` / `runChatSend()` `:102`）覆盖，并如实登记；若连它也超预算，把读数与阻塞点写进完成记录并另立一条只覆盖缺口的任务，不得把判据改成「跳过 claude」。

## Plan

1. 先读 AC-154 的落地提交，取 `HOST_COMMIT` 与 `PRE`，确认 `git cat-file -e ${PRE}:server/modules/session-hosts/index.ts` 失败、HEAD 上同路径存在。
2. 写 `per-run-frame-scenarios.ts`：四个假进程（codex Thread mock / cursor+opencode 假可执行文件 / claude 假 CLI）、闸门、四个场景、帧投影。先逐 provider 单跑一条场景、把帧打印出来看覆盖，不比较。
3. 写 `record-per-run-frame-baseline.test.ts`（默认 skip + 拒绝闸），按上面的 worktree 流程在 `$PRE` 上录出 16 条基线，拷回主 checkout。
4. 写 `session-host-per-run-parity.test.ts`：fixture 深比较 + 不变式 2 的宿主快照读数 + 不变式 3 的比较器自测 + 不变式 4 的确定性自测。
5. 实测两个假形态 (a)(b)（先确认 (a) 的朴素版本是否 no-op），抄退出码与红态文案，还原。
6. 跑判据命令（目标退出 0）、`npm run typecheck`、`npm run lint`、既有 `server/modules/websocket/tests/chat-run-registry.test.ts` 与 `chat-edit-send.test.ts`；确认 `git status --short` 只剩 Touches。

## AC

- [ ] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`。红态基线已测：同命令当前退出 1、文案逐字 `Could not find 'server/modules/session-hosts/tests/session-host-per-run-parity.test.ts'`。
- [ ] AC2 四条场景 × 四个 provider = 16 条录制，全部经真实 `handleChatConnection`（`chat-websocket.service.ts:620`）分派、`chatRunRegistry` 与 `providerRuntimeService`（`:108` 单例）为真、只换进程；逐行打印 `provider=… scenario=… frames=… kinds=…`，16 行都在。
- [ ] AC3 非平凡正控制：投影后每条序列帧数 > 0；正常一轮那条含且仅含 1 个 `kind: 'complete'` 且打印其 `exitCode`/`aborted`；忙时重复发送那条含 1 个 `kind: 'protocol_error'` 且 `code == 'RUN_IN_PROGRESS'`；重放那条含 1 个 `kind: 'chat_subscribed'` 且重放帧数 ≥ 1（打印 `replayed=…`）。
- [ ] AC4 宿主层确实在路径上（防「AC-154 被回退 ⇒ 假绿」）：正常一轮进行中 `sessionHostManager.snapshot()` 里该会话恰有一个 `mode=per-run` 宿主，逐 provider 打印 `provider=… hosts=… mode=per-run`；同时 16 条帧序列与基线相同。
- [ ] AC5 基线确实是接入之前录的：fixture 头部有 `recordedAtCommit`；判据断言 `git cat-file -e <recordedAtCommit>:server/modules/session-hosts/index.ts` 失败、而当前 HEAD 的同一路径存在；两条腿分别打印，失败时点名是哪条腿。
- [ ] AC6 比较器自测（反红可达性）：`(基线, 基线去掉最后一帧)` 报缺帧并点名该帧；`(基线, 基线 + 一条合成 complete)` 报多帧；两种输入各打印一次判定。
- [ ] AC7 录制确定性：同一 provider 同一场景连跑两次的投影逐字节相同（至少 4 例，打印 `run1=… run2=… equal=…`）。
- [ ] AC8 假形态 (a) 承重：宿主关闭路径补发合成 complete ⇒ 判据退出 **1**，红文案点名多出的那条帧；并登记「朴素版本是否被 `chat-run-registry.service.ts:88-92` 去重吞掉（no-op）」的实测读数。实测退出码与红态文案抄进完成记录，用后还原。
- [ ] AC9 假形态 (b) 承重：忙时直写泄漏到 per-run ⇒ 判据退出 **1**，红文案点名场景③少了 `RUN_IN_PROGRESS` 帧；登记该变体是「构造的」（常驻侧真实现尚未落地）。实测退出码与红态文案抄进完成记录，用后还原。
- [ ] AC10 生产面零改动：`git diff --name-only` 里没有 `server/modules/providers/list/**`、没有 `server/modules/websocket/services/**`、没有 `server/modules/providers/services/provider-runtime.service.ts`；落地的只有 Touches 列出的文件（`git diff --stat` 逐条对齐）。
- [ ] AC11 契约面不被改窄：`npm run typecheck`、`npm run lint` 退出 0；既有 `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts` 与 `…/chat-edit-send.test.ts` 退出 0。
- [ ] AC12 如实登记：完成记录写明（a）四个 provider 各自的假进程形态与出处（codex 的 mock 面、cursor/opencode 的假可执行文件、claude 假 CLI 的协议与「`result` 之后不退出」如何做到）；（b）`$PRE` 的实际 sha 与「它确实不含宿主模块」的读数；（c）两个假形态的实测退出码与红态文案，含 (a) 的 no-op 读数；（d）投影里除 `timestamp` 外还丢了哪些字段、为什么；（e）未实现：AC-156…AC-160 与常驻侧的一切。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-per-run-parity.test.ts`）重跑：退出码 0 且 `fail 0`。16 条 `provider=… scenario=… frames=…` 读数、AC3 的四类非平凡读数、AC4 的宿主快照读数、AC5 的两条腿读数、AC6 的比较器自测判定、AC8/AC9 两个假形态的实测退出码与红态文案（含 (a) 的 no-op 读数）、fixture 的 `recordedAtCommit` 与「该 sha 不含宿主模块」的读数，一并写进完成记录。fixture 已随测试提交（`git log --oneline -1 -- server/modules/session-hosts/tests/fixtures/per-run-frame-baseline.json` 有输出）。`npm run typecheck` 与 `npm run lint` 退出 0。改动只落在 Touches 列出的文件上，生产面零改动。完成后 AC-155 在驱动器下一轮经 `goal_ac: AC-155` 独立复跑时由红翻绿 —— 且这次翻绿有分辨力：AC8「合成 complete」的变体必红、AC9「忙时直写泄漏」的变体必红、把 AC-154 的包装摘掉（宿主快照为空）必红。

## Touches

- server/modules/session-hosts/tests/session-host-per-run-parity.test.ts (new)
- server/modules/session-hosts/tests/per-run-frame-scenarios.ts (new)
- server/modules/session-hosts/tests/record-per-run-frame-baseline.test.ts (new)
- server/modules/session-hosts/tests/fixtures/per-run-frame-baseline.json (new)
- tasks/gap-session-hosts-per-run-frame-parity.md
