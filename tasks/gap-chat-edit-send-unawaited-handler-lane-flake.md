---
id: gap-chat-edit-send-unawaited-handler-lane-flake
title: chat-edit-send.test.ts 在 fan-in lane 下偶发红：服务端在 providerRewindsForEdit
  里读不到夹具刚同步创建的会话行（SESSION_NOT_FOUND），夹具唯一的同步手段是固定 30ms 的 settle()；单独跑 8/8 绿
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Finding

**现场（唯一一次观测）。** `.quay/fan-in-suite-gap-session-hosts-default-wrap-four-providers~wk-prod-anchor~1790342649056-665fe6.log`（2026-09-25 21:26–21:29 +0800）：

- `:243` `not ok - server/modules/websocket/tests/chat-edit-send.test.ts: [ERROR] Chat WebSocket error: Session "edit-session" was not found.`
- `__PERFILE__ duration_ms=5977 server/modules/websocket/tests/chat-edit-send.test.ts passed=false`
- 整轮 `# tests 236 / # pass 235 / # fail 1` —— 该文件是这次 fan-in 唯一的红。

**这行不是「通过时的日志被误引」。** 本仓 `scripts/test.sh` 的 `first_error()` 会把测试自己的 stdout 行拼到 `not ok` 后面，所以引用行本身不能当原因。判别方式是直接读：单独跑该文件（`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-edit-send.test.ts`）**两次都是 `tests 8 / pass 8 / fail 0`、exit 0、duration_ms 2889**，且两次的输出里 `grep -c 'was not found'` 都是 **0** —— 健康跑动不打印这行，所以它是失败路径独有的服务端日志，不是恒在的噪声。

**抛出点。** 该文案（`Session "${sessionId}" was not found.`，**不带**尾部那句 `Create it via POST /api/providers/sessions first.`）在全仓非测试代码里有三处，都在 `server/modules/providers/services/sessions.service.ts`：`resolveEditAnchor:440`、`providerRewindsForEdit:466`、`rewindSessionForEdit:483`。其中 `resolveEditAnchor` 的抛出被 `handleChatEditSend` 的 try/catch 接住、转成 `ANCHOR_LOOKUP_FAILED` 协议错误；而 `providerRewindsForEdit` 在同一条路径上是**裸调用**（`const rewinds = sessionsService.providerRewindsForEdit(sessionId);`），抛出会一路冒到 `chat-websocket.service.ts:662` 的 `console.error('[ERROR] Chat WebSocket error:', …)` —— 与日志里那行的形态完全一致。三处内部都是 `sessionsDb.getSessionById(sessionId)` 返回空。

**夹具的同步方式。** `chat-edit-send.test.ts` 的 `withGateway()`（`:84` 起）在同一个同步块里先 `await initializeDatabase()`、再 `sessionsDb.createSession(SESSION_ID, provider, …)`、再 `handleChatConnection(socket, …)`，然后交给用例；用例推帧后**唯一的等待**是 `settle()`（`:133`）—— `setTimeout(resolve, 30)`，注释自陈「The handler is async and the socket listener does not await it」。也就是说：服务端在 30ms 内没把该会话读出来（或读的是另一个库句柄），用例的断言就落在空结果上。

**本地未能复现（如实登记）。** 两次并发加压都没红：一次 6 路兄弟文件（含 `claude-runtime-frame-forwarding` / `claude-sessions` / `shell-websocket.service` / `chat-run-registry` / `codex-runtime` / `session-upsert-broadcast`），一次 8 路更重的（含 `voice-capture-text.false-forms`（会 spawn 子进程）、`debug-agent-external-write`、`claude-session-title-corpus`、`claude-background-work`、`chat-permission-mode`、`claude-compaction`、`claude-session-scope`、`websocket-heartbeat.service`）。两次目标都 exit 0、`was not found` 计数 0。盘上 11 份 `fan-in-suite-*.log` 里该文件红过 **1** 次，所以这是个低频通道，不是每次必现 —— **本任务的第一步就是把复现变成确定性的**（见 AC1），没有确定性复现就不许改夹具。

**两条边界（不要把本任务当成别的东西来修）。**

<!-- dedup-ref -->
- 这不是 voice `__criterion-falsify-*` 共写目录那条串扰（`gap-voice-false-forms-siblings-pid-attribution`，已由 `d5f7904b` 修掉）：同一份日志里 voice 判据 0 命中红。
- 也不是 `gap-session-hosts-default-wrap-four-providers` 自己的 delta：该任务只改 `server/modules/session-hosts/`、`provider-runtime.service.ts`、两个 `server/shared/` 文件，`git diff --name-only develop...HEAD` 里没有任何 websocket 文件。本任务与该任务是不同机制，不重复申领它。

## AC

- [ ] AC1 先拿到**确定性**复现，再动夹具：给出一个命令，在改动前的树上重复运行 ≥5 次，至少 1 次复现出同样的签名（`passed=false` 且服务端日志出现 `Session "edit-session" was not found.`），逐次记录 `run=N exit=… fail=… reading=…`。做不到确定性复现时，改用等价的证伪替代（`quay-unreproducible-before-reading-falsification-substitute` 的允许形状）：在工作树里把 `sessionsDb.getSessionById` 对 `edit-session` 一次性打桩返回空，证明该抛出点**可达**且红态签名与现场一致（退出码、文案原文抄进完成记录），随后还原。两种读数都要有，且必须在同一份完成记录里写明用的是哪一条。
- [ ] AC2 夹具不再靠固定睡眠等待：`withGateway()` 或其调用方改为等待一个**真实信号**（例如等那一轮的运行被登记 / 等帧序列里出现该轮的 complete，或对薄注入的 handler 返回的 promise 做 await），`grep -n 'setTimeout(resolve, 30)' server/modules/websocket/tests/chat-edit-send.test.ts` 在改动后不再命中 `settle` 的定义行；改动只允许改夹具与等待方式，**不得删除或放宽该文件任何一条 `assert`**（`git diff develop -- server/modules/websocket/tests/chat-edit-send.test.ts | grep -c '^-.*assert'` 为 0）。
- [ ] AC3 负控制——改了等待之后，被强制的失败仍必须红：AC1 用的那条注入（或确定性复现的触发条件）在改动后的树上再跑一次，仍须退出码非 0 且签名相同。这证明新的等待等的是真信号，而不是把错误吞掉。读数与还原一并登记。
- [ ] AC4 回归：该文件连续 5 次单独运行全部 `exit 0` 且 `fail 0`；`npm run typecheck` 与 `npm run lint` 退出 0；`server/modules/websocket/tests/` 下其余文件在该次改动后不变（`git diff --stat develop...HEAD` 逐条对齐 `## Touches`）。
- [ ] AC5 范围纪律：若 AC1 的诊断证明根因在产品代码（例如 `initializeDatabase()` / DB 单例与逐用例 `DATABASE_PATH` 切换不同步、或 `getSessionById` 的读路径有缺陷），**停止改夹具并如实把证据写进完成记录**，按机制另立 gap 任务处理产品侧；本任务不把改动伸到 `## Touches` 之外的文件。

## DoD

真实落地判据不是「调大了等待时间」，而是**那条通道不再由夹具自己的时序产生**：AC1 的复现（或证伪替代）在改动前读到过红，AC3 证明同一触发条件在改动后**仍然红**（新等待必须有分辨力，不能是掩盖），AC4 的 5 连绿与两条门读数证明夹具本身没被改松。完成记录必须写明：这份红在盘上只观测到 1/11，本地 6 路与 8 路加压都未复现，所以「修好」的读数强度取决于 AC1 走的是确定性复现还是证伪替代 —— 后者只能说「该抛出点可达且已被有界等待替代」，不能声称「已复现 driver 那次红」。若 AC5 判定根因在产品侧，则本任务的真实落地物是那份证据与新建的 gap 任务，不谎报为已修复。

## Touches

- server/modules/websocket/tests/chat-edit-send.test.ts
- tasks/gap-chat-edit-send-unawaited-handler-lane-flake.md
