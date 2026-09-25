---
id: gap-session-hosts-default-wrap-four-providers
title: AC-154 默认包装：四个 provider 的每一轮经 provider-runtime.service 的真实分派入口登记为 per-run
  宿主，按实际收尾给出 turn-complete / aborted / released，Claude 的持有期读成 lingering
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-154
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rn "^goal_ac: *AC-154" tasks/*.md` → 0 命中；`grep -rln "session-hosts\|sessionHost\|hostDriver\|closeReason" tasks/*.md` → 0 命中；AC-150…AC-153 已被 voice 四条任务认领，GOAL-012 的 AC-154…AC-160 无认领者 —— 本条不是重复。同区不同机制的两条（本条不重复它们、不把它们当门槛）：`gap-claude-resident-phase0-experiments`（ready，只取 E1–E8 读数并写回 proposal，不写产品代码）与 `gap-claude-session-cgroup-scope`（needs-human，GOAL-013 的进程层 systemd scope）。本条认领的是它们都让出的那一格：**四个 provider 的每一轮都必须在宿主层里有一个 per-run 宿主，且关闭原因是按实际收尾算出来的**。

**来源与判据物。** 判据逐字取自 `goals/AC-154-默认包装-四个-provider-的每一轮都登记为-per-run-宿主-并按实际收尾给出关闭原因.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-default-wrap.test.ts`。红态基线（本轮直跑，读数不是推断）：该命令在树上退出 **1**，文案逐字 `Could not find 'server/modules/session-hosts/tests/session-host-default-wrap.test.ts'`；`server/modules/session-hosts/` 目录不存在（`ls` 无此目录）。

**现状（本轮实测的读数）**

- 真实分派入口是 `server/modules/providers/services/provider-runtime.service.ts`：`run()` 在 `:65-73`（`provider.runtime.run(command, options, writer, createRuntimeContext(provider))`），`abort()` 在 `:90-92`，单例在 `:108`。依赖可注入（`server/modules/providers/tests/provider-runtime.service.test.ts:47-69` 已在用 `createProviderRuntimeService({...})`）。WS 的 `chat.abort` 走的是同一条 abort：`server/modules/websocket/services/chat-websocket.service.ts:449` `const success = await dependencies.runtime.abort(run.provider, sessionId)`，而 `server/index.ts:117` 把 `providerRuntimeService` 作为 `chat.runtime` 注入。
- 四个 provider 的活跃表只有 Claude 有：`claude-runtime.provider.js:43` `const activeSessions = new Map()`（`addSession`/`getSession`/`activeSessions.keys()` 在 `:331-384`，`idleReleaseTimer` 持有期在 `:793-827`）。`grep -n "activeSessions" server/modules/providers/list/{codex,cursor,opencode}/*` → 0 命中。
- 每轮终结帧是 `{ kind: 'complete', … }`（构造器在 `server/shared/utils.ts:376` `createCompleteMessage`）；中止时那条 complete 带 `aborted: true`（claude `:44-48` + `:1100`，codex `:438`，cursor `:366-370`，opencode `:411-415` 四处同形）。
- 宿主层今天只有散文，代码里零命中：`grep` `ProcessHost|HostState|HostCloseReason|IProviderHostDriver|hostDriver|lingering` 于 `server/`、`src/`、`shared/` 全部命中都在 `docs/proposals/claude-resident-sessions.md` 里。

**要建的东西（范围是 AC-154 的最小充分集，其余交给兄弟 AC）**

判据表以 `docs/proposals/claude-resident-sessions.md` 为准（§2 模型 `:115-144`、§3 状态机与关闭原因 `:170-191`、§4 driver facet `:195-217`、§4 默认包装 `:219-227`）：

1. 共享契约落 `server/shared/types.ts`：`HostMode`（`'per-run' | 'resident'`）、`HostState`（`'starting' | 'idle' | 'busy' | 'lingering' | 'closing' | 'closed'`）、完整的 `HostCloseReason` 枚举（`turn-complete | released | superseded | aborted | user | idle | mode-change | rewind | exited | server-shutdown`，本条只断言前三个 + 不强求其余有调用方）、`ProcessHost`（`hostId`、`provider`、`mode`、`state`、`pid`、`startedAt`、`bindings: Map<appSessionId, SessionBinding>`、`closeReason`）、`SessionBinding`（`appSessionId`、`providerSessionId`、`state: 'idle' | 'busy'`、`leases: HostLease[]`、`lastActivityAt`、`detachReason`）、`HostLease`（`{kind:'turn', runId}` | `{kind:'background-task'|'monitor', id}` | `{kind:'cron', id, recurring, expiresAt}` | `{kind:'resident-policy'}`）。`server/shared/interfaces.ts`：加 `IProviderHostDriver`，`IProvider` 加**可选** `readonly hostDriver?: IProviderHostDriver`（照 `fork?`/`rename?` 的写法）。按后端规范这两个文件是共享定义的正位；模块内不许建 `types.ts`/`interfaces.ts`/`utils.ts`，`server/shared/index.ts` 那三行桶不动（消费方按 `@/shared/types.js` / `@/shared/interfaces.js` 直连，照 `provider-runtime.service.ts:4-12`）。
2. 新模块 `server/modules/session-hosts/`：`session-host-manager.service.ts` 里 `SessionHostManager` 维护两个索引（`hostId → ProcessHost`、`appSessionId → hostId`，后者是单写者不变量的落点）、一个只读快照口（`snapshot()`，返回全部宿主；判据只经它读），以及 **per-run 策略**：一轮开始 ⇒ 一个宿主 + 一个 `SessionBinding` + 一条 `turn` 保活理由（`state: busy`）；writer 上读到终结帧 ⇒ 摘掉 `turn` 理由；此后 `run()` 的 promise 仍未结算 ⇒ `state: lingering`，结算时按「promise 晚于 complete 结算 ⇒ `released`；不晚于 ⇒ `turn-complete`」；中途 abort ⇒ `aborted`。`index.ts` 桶只暴露 manager 实例/工厂与读口类型。
3. 接进真实入口：`provider-runtime.service.ts` 的 `run()` 经 manager 开 per-run 宿主并绑上本轮的 app 会话，包一层**只观察**的 writer（不新增、不重排、不吞帧）；`abort()` 把该会话跑动中的宿主标为中止。按 proposal §219-227，**默认包装不改任何 runtime 代码** —— 四个 runtime 文件一个字节不动。
4. 判据测例 `server/modules/session-hosts/tests/session-host-default-wrap.test.ts`。四个 provider 各跑一轮，**只经 `providerRuntimeService` 分派**，manager 只用于读快照。伪造面逐个 provider 登记（proposal §阶段 1a 说「沿用四个 provider 现有 runtime 测试的伪造流」，**本轮实测不成立**，照实修正）：
   - **codex**：沿用 `server/modules/providers/tests/codex-runtime.test.ts:27-41` 的机制 —— `t.mock.method(Codex.prototype, 'startThread' | 'resumeThread')` 返回一个假 `Thread`，其 `runStreamed()` 返回 `{ events: (async function*(){…})() }`。
   - **opencode**：沿用 `server/modules/providers/list/opencode/opencode-runtime.provider.test.js:25-58` 的 `createFakeOpenCodeExecutable(binDir)` —— 临时目录里写一个 `#!/bin/sh` + `node` shim，`chmod 0o755`，PATH 前插。
   - **cursor**：今天**没有任何** runtime 级测试（`grep -rn "cursorRuntime\|spawnCursor" server/` → 0 命中），须自建，形态取同一种「临时 PATH 上的假可执行文件」——假 `cursor-agent`（`cursor-runtime.provider.js:159` `spawnFunction('cursor-agent', args, …)`，`spawnFunction = crossSpawn`）。
   - **claude**：今天也没有 runtime 级伪造流（只有 helper 级用例，如 `claude-stream-event-unwrap.test.ts` 喂假 SDK 帧给 normalizer；以及真 CLI + mock 端点的 `model-gateway-end-to-end.test.ts`），须自建。首选**假 CLI**：`claude-runtime.provider.js:238` 读 `resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH)`（`server/shared/claude-cli-path.ts:143`，非 win32 直接返回该路径），把 `CLAUDE_CLI_PATH` 指向一个临时目录里的假 CLI（shebang + `chmod 0o755`），它按 SDK 的 stream-json 协议输出 `system/init` → `assistant` → `result`，并且**发出 `result` 之后不关 stdin、不退出**——这就是 (4) 的持有期：complete 已发、`run()` 的 promise 悬着；测试收尾时杀掉该进程 ⇒ 迭代器结束、promise 结算 ⇒ `released`。
   - 若假 CLI 在预算内无法满足 SDK 的协议（已知风险：`result`/`init` 的字段形状随 SDK 版本收紧），**不得**换成非 Claude 的 provider 顶替，也不得把 (4) 降级成「manager 单测」；如实登记该风险、改用真 CLI + mock 端点（照 `model-gateway-end-to-end.test.ts` 的 `startMockAnthropic()`/`createFakeSocket()`/`runChatSend()`）覆盖 (1)(2)(3)，并另立一条只针对 (4) 的判据任务。

**两个假形态（判据的分辨力证明，必须实测）**

- (a) 只给 Claude 登记宿主（即包装层只覆盖 `claude`，模拟「沿用其内部 `activeSessions`」的设计）⇒ (1) 在 codex/cursor/opencode 上必须红，红文案点名缺宿主的那一个 provider。
- (b) 把 complete 当作宿主关闭时刻（收到 complete 就 `closed`）⇒ (4) 的 `lingering` 读数必须红（读到 `closed`）。

**不变式**：包装层只观察、不介入 —— 写往客户端 writer 的帧序列在接入前后逐帧相同（这是 AC-155 要求的不变式，由 AC9 的逐帧深比较承载，不靠字节钉住测试文件）。

**非目标**：resident 策略与真实 Claude driver（AC-159）、`GET /api/session-hosts` 与另外两条 REST（AC-156）、保活理由驱动的完整状态机/停机/枚举穷举用例（AC-157）、1:N 解绑与顶替（AC-158）、调试 agent 的 hostDriver 与场景 op（AC-160）、能力矩阵的 `lifecycleModes`/`multiplexedHost`、`process-containment.service.ts` 与 `session-hosts.routes.ts`、数据库 `lifecycle_mode` 列、`chat-run-registry`/`scheduled-message-dispatcher` 的 run-source 字段。不改任何 per-run 的客户端可见行为。

## Plan

1. 落共享契约：`server/shared/types.ts` 加 `HostMode`/`HostState`/`HostCloseReason`/`ProcessHost`/`SessionBinding`/`HostLease`，`server/shared/interfaces.ts` 加 `IProviderHostDriver` 与 `IProvider.hostDriver?`；每个导出带说明与消费方注释（后端规范）。跑 `npm run typecheck` 确认共享面成立。
2. 建 `server/modules/session-hosts/session-host-manager.service.ts`：两个索引 + `snapshot()` + per-run 策略（开宿主/绑会话/`turn` 理由/摘理由/`lingering`/`released` vs `turn-complete`/`aborted`），导出 `sessionHostManager` 单例与 `createSessionHostManager()` 工厂；`index.ts` 桶只放这几样。
3. 接 `provider-runtime.service.ts`：`run()` 经 manager 开宿主并包只观察的 writer，`abort()` 标中止。包装层不得触碰帧内容。
4. 写判据测例：四个 provider 各一轮 + 中止一轮 + Claude 持有期 + 「绕过 providerRuntimeService 直跑」的负控制 + 「codex 无持有期不读成 lingering」的正控制；按各自的伪造面驱动，读数逐行打印（`provider=… hosts=… mode=… state=… appSessionId=…`、`frames=…`、`closeReason=…`）。
5. 实测两个假形态（改包装层、判据文件不动），抄下退出码与红态文案，然后 `git checkout --` 还原到 `git status --short` 只剩 Touches 里的文件 + 任务文件。
6. `npm run typecheck`、`npm run lint`、既有 `provider-runtime.service.test.ts` 全绿；写完成记录（含每条读数与两个假形态的实测）。

## AC

- [ ] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-default-wrap.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`。红态基线已测：同命令当前退出 1、文案逐字 `Could not find 'server/modules/session-hosts/tests/session-host-default-wrap.test.ts'`。
- [ ] AC2 登记只发生在真实分派入口里：每个 provider 的每一轮都由 `providerRuntimeService`（`server/modules/providers/services/provider-runtime.service.ts`）分派；**负控制**：同一个假 runtime 绕过它直接 `runtime.run(...)` 之后，manager 快照里宿主数为 0（读数 `direct-run-hosts=0`）。两个读数都打印。
- [ ] AC3 运行中读数（对应 (1)）：四个 provider 各跑一轮，运行中快照里**每个 provider 恰有一个宿主**，且该宿主 `mode=per-run`、`state=busy`、绑定集合恰有一个 `appSessionId` 等于本轮会话 id。逐行打印 `provider=… hosts=… mode=… state=… appSessionId=…`，四行都在。
- [ ] AC4 正常收尾（(2)）：codex/cursor/opencode 各跑完一轮后该宿主 `state=closed` 且 `closeReason=turn-complete`（三行读数都打印 `closeReason=turn-complete`）。
- [ ] AC5 中止收尾（(3)）：对其中一个 provider 的一轮中途经 `providerRuntimeService.abort(provider, sessionId)`（WS `chat.abort` 走的就是这条，`chat-websocket.service.ts:449`）中止，该宿主 `closeReason=aborted`；打印 `provider=… abort=… closeReason=aborted`。
- [ ] AC6 Claude 持有期（(4)）：假 CLI 发出 `result` 后保持存活时，complete 之后、`run()` 的 promise 结算之前宿主 `state=lingering`；promise 结算后 `closeReason=released`。两个读数都打印。**正控制**：同一形状下 codex（无持有期）**不**读成 `lingering`（直接 `closed`/`turn-complete`）——证明 `lingering` 读数不是恒真。
- [ ] AC7 假形态 (a) 承重：把包装收窄成只覆盖 `claude` ⇒ 判据命令退出 **1**，红文案点名 codex/cursor/opencode 中缺宿主的那一个 provider。实测退出码与文案抄进完成记录，用后还原。
- [ ] AC8 假形态 (b) 承重：把宿主关闭时刻改成收到 complete 的那一刻 ⇒ 判据命令退出 **1** 且 AC6 的 `lingering` 读数红（读到 `closed`）。实测退出码与文案抄进完成记录，用后还原。
- [ ] AC9 客户端可见帧逐帧不变：对同一轮伪造流做「绕过 manager 直跑 runtime」与「经 `providerRuntimeService` 跑」的帧序列**深比较**（条数与逐元素相等，含 `kind` 与顺序），两条序列的长度都打印（`frames-direct=… frames-via-service=…`）；包装层不得新增、重排、吞掉任何帧。
- [ ] AC10 共享契约已落位：`grep -n "HostCloseReason\|ProcessHost\|SessionBinding\|HostLease" server/shared/types.ts` 有输出；`grep -n "hostDriver" server/shared/interfaces.ts` 有输出；`ls server/modules/session-hosts/{types,interfaces,utils}.ts` 全不存在（模块内不建这三类文件）。
- [ ] AC11 契约面不被改窄：`npm run typecheck`、`npm run lint` 退出 0；既有 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-runtime.service.test.ts` 退出 0；`git diff --name-only` 里没有 `server/modules/providers/list/**` 的四个 runtime 文件（默认包装不碰 runtime，proposal §219-227）。
- [ ] AC12 如实登记：完成记录写明（a）四个 provider 各自的伪造面与出处（哪个现有测试的哪种机制；Claude 与 cursor 今天没有 runtime 级伪造面，须新建，登记实际用的形态与它如何做出持有期）；（b）两个假形态的实测退出码与红态文案；（c）宿主快照里 `pid` 在默认包装下可能为空（runtime 不对外暴露 pid），本条不谎报 pid；（d）本条只断言 `turn-complete`/`aborted`/`released` 三个关闭原因，其余枚举值、两种策略、停机与两条 REST 属兄弟 AC，未实现。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-default-wrap.test.ts`）重跑：退出码 0 且 `fail 0`。四个 provider 的运行中读数（`mode`/`state`/`appSessionId`）、三个正常收尾的 `turn-complete`、中止那一轮的 `aborted`、Claude 持有期的 `lingering → released`、AC2 的负控制读数（`direct-run-hosts=0`）、AC6 的正控制读数、AC9 的两条帧序列长度、AC7/AC8 两个假形态的实测退出码与红态文案，一并写进完成记录。`npm run typecheck` 与 `npm run lint` 退出 0。改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐；四个 runtime 文件不在其中）。`server/modules/session-hosts` 的公开面（manager 快照读口、`hostDriver` facet、关闭原因取值）以兄弟 AC 会扩展为前提保持稳定：`index.ts` 桶只暴露 manager 实例/工厂与读口类型。完成后 AC-154 在驱动器下一轮经 `goal_ac: AC-154` 独立复跑时由红翻绿 —— 且这次翻绿有分辨力：AC7「只覆盖 claude」的变体必红、AC8「以 complete 关闭」的变体必红。

## Touches

- server/modules/session-hosts/session-host-manager.service.ts (new)
- server/modules/session-hosts/index.ts (new)
- server/modules/session-hosts/tests/session-host-default-wrap.test.ts (new)
- server/modules/providers/services/provider-runtime.service.ts
- server/shared/types.ts
- server/shared/interfaces.ts
- tasks/gap-session-hosts-default-wrap-four-providers.md
