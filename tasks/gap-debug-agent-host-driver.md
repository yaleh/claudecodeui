---
id: gap-debug-agent-host-driver
title: AC-160 调试 agent 以宿主驱动接入：一个 multiplexedHost 宿主承载两个 resident 绑定，无人轮由
  manager 开 run（来源 unattended、seq 由 registry 分配且递增、transcript 落盘、可完整回放），lease
  增减与 exit(oom) 反映到宿主快照，门控关闭时宿主层无任何调试宿主
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-session-hosts-default-wrap-four-providers
  - gap-session-hosts-lease-driven-lifecycle
  - gap-session-hosts-binding-multiplexing
goal_ac: AC-160
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rn "^goal_ac: *AC-160" tasks/*.md | wc -l` → **0**；`grep -rn "AC-160" tasks/*.md | wc -l` → 13，全部落在五条邻居任务的**非目标**段里（`gap-session-hosts-default-wrap-four-providers:48`、`gap-session-hosts-lease-driven-lifecycle:60`、`gap-session-hosts-claude-per-run-driver:64`、`gap-session-hosts-rest-list-endpoint:57`、`gap-session-hosts-per-run-frame-parity:60`），没有一条认领它；宿主层与驱动面在代码里零命中：`grep -rn "hostDriver\|IProviderHostDriver\|multiplexedHost\|lifecycleModes" server/ src/ shared/ --include=*.ts --include=*.tsx | wc -l` → **0**；`ls server/modules/session-hosts` → `No such file or directory`（AC-154 的落地在 `task/gap-session-hosts-default-wrap-four-providers` 分支的 `d9116247`/`c7a49886`，尚未进本条所在的树）。⇒ AC-160 无认领者，本条不是重复。

本条认领的是五条邻居都明确让出的那一格：**非 Claude 的 provider 以一次声明（`multiplexedHost`）就换来宿主层的多路复用，并且无人轮在没有浏览器连接时仍经真实链路（manager → chatRunRegistry → 真实归一化 → 客户端 writer）产出一轮可完整回放的内容**。调试 agent 是这一格的替身：它没有 CLI、没有 SDK，所以「一个宿主承载多个常驻会话」「无人轮的来源是 `unattended`」「保活理由增减与进程退出进入宿主快照」这几件事可以在它身上逐条读出读数，而不必先有 Claude 常驻的一切（那属 GOAL-013）。

与五条邻居的机制区别在于各自认证的对象：AC-154 认证「四个 provider 的每一轮都有 per-run 宿主」；AC-157 用**伪造 driver** 认证 lease 驱动的状态机；AC-158 用**伪造 driver** 认证 1:N 绑定；AC-159 认证 Claude per-run 的顶替与持有；本条认证的是**驱动面本身**——`IProviderHostDriver` 的第一个真实实现、`HostEventSink` 的第一个真实上报者、以及 `chatRunRegistry` 里 `unattended` 这个 run 来源的第一个产生者。这条链路上的读数（run 来源、seq 归属、回放完整性）只能由「谁开的 run」决定，因此它对「引擎自己构造帧推给 writer、绕过 manager 直接开 run」这个假形态有分辨力——那正是本 AC 点名要求必红的假形态。

**非目标**：真实 Claude 常驻 driver、输入队列、忙时直写、SendMessage 地址、空闲自动关闭，以及常驻的 UI 与 e2e（GOAL-013 的 AC-162…AC-175）；`lifecycle_mode` 数据库列与 `POST /api/session-hosts/:sessionId/start|close`（AC-169）；四个 runtime（`server/modules/providers/list/**`）一字节不动；不改任何 per-run 的客户端可见行为（AC-155 的逐帧基线承载这一点）。

## Plan

1. 读 AC-154/AC-157/AC-158 的落地提交，取 manager 与共享契约的**实际形状**：导出/工厂名、`snapshot()` 的字段、`SessionBinding`/`HostLease`/`HostCloseReason` 的实际取值与 key、`IProviderHostDriver` 的**实际方法签名**、`HostEventSink` 的实际事件名、`resident` 策略的入口与 `superseded`/`exited` 的产生点。按实际形状改本任务第 3–7 步里的调用名，**不重复造**已有字段。若三条尚未落地，**不得**自行补它们的范围——如实登记并停在这一步（`depends_on` 已把它们声明为本条的前置）。
2. 共享契约按需补齐本条驱动要用到的成员（`server/shared/interfaces.ts`、`server/shared/types.ts`）；`npm run typecheck` 绿。**不得**拓宽 `LLMProvider` 联合：`server/shared/types.ts` 里那一行被 `server/modules/debug-agent/tests/debug-agent-frames.test.ts` 的 `PROVIDER_UNION_LINE` 逐字钉住。
3. 调试 agent 的 `hostDriver` facet：新文件 `server/modules/debug-agent/debug-agent.host-driver.ts` 实现 `IProviderHostDriver`（`startHost`/`bind`/`submit`/`interrupt`/`unbind`/`closeHost`），声明 `multiplexedHost`，`startHost` 在已有多路复用宿主上复用同一个句柄（一个宿主承载多条 resident 绑定），保活理由增减与进程退出经 `sink` 上报；`createDebugAgentProvider` 把它挂到 `IProvider.hostDriver` 上（`debug-agent.provider.ts`），注入面按需扩（`provider.registry.ts` 的构造点）。**该文件及其碰到的调试模块源码不得出现任何帧字段名或事件名字面量**——AC-126 的静态守卫扫的正是调试模块的源码范围。
4. 场景 op：把 `unattended-turn`、保活理由增/减、`exit(oom)` 加进 `debug-agent.scenario.ts` 的 op 闭集与 step 类型（闭集里每个值都是本 build 会执行的值，不认识的值仍旧拒绝并印出闭集），在 `debug-agent.engine.ts` 里执行：`unattended-turn` 必须经宿主层开 run，而不是由引擎自己构造帧推给 writer；保活理由与 `exit(oom)` 经 sink 上报。闭集本身也不许出现帧/事件名。
5. run 来源：`server/modules/websocket/services/chat-run-registry.service.ts` 的 run 记录加 `source`（`user` | `scheduled` | `unattended`），`startRun` 入参带上它，既有调用点各归其位（`chat.send` → `user`，`runDetachedChatTurn` → `scheduled`），并让该字段可读；无人轮的 `unattended` 由 manager 开 run 时写入。
6. 能力矩阵：`server/modules/providers/services/provider-capabilities.service.ts` 的 `ProviderCapabilities` 加 `lifecycleModes` 与 `multiplexedHost`，四个既有 provider 填 `['per-run']`/`false`，调试 agent 填 `['per-run','resident']`/`true`；调试条目的落法（`debug` 不在 `LLMProvider` 联合里）用一处显式 seam，而不是拓宽联合。
7. 判据文件 `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`：沿用 `debug-agent-frames.test.ts` 的子进程取数法（门控按进程求值并缓存，开/关两态各需一个独立子进程），读数逐行打印；跨模块引用**只走 barrel**（`@/modules/session-hosts/index.js`、`@/modules/providers/index.js`、`@/modules/websocket/index.js`），不深引邻居模块内部文件（`boundaries/dependencies`）。
8. 实测假形态（引擎里直接构造帧推 writer + 绕过 manager 开 run），抄下退出码与红态文案，`git checkout --` 还原到 `git status --short` 只剩 Touches 里的文件 + 任务文件。
9. `npm run typecheck`、`npm run lint`、AC-123/AC-126/AC-136 三条判据与既有 debug-agent 判据全绿；写完成记录（含每条读数与假形态实测）。

## AC

- [ ] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-host-driver.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`，并打印整体墙钟 `elapsed=<n>ms` 且 `< 60_000`（goal 的判据闸门对单条判据是 60 秒硬超时，不可上调）。红态基线本轮实测：同命令退出 **1**、文案逐字 `Could not find 'server/modules/debug-agent/tests/debug-agent-host-driver.test.ts'`。命令逐字含文件路径，不用 glob。
- [ ] AC2 (1) 能力矩阵：`getProviderCapabilities('debug')` 返回 `lifecycleModes` 含 `per-run` 与 `resident`、`multiplexedHost === true`，打印 `provider=debug lifecycleModes=per-run,resident multiplexedHost=true`。**负控制**：四个既有 provider 的 `multiplexedHost` 全为 `false`（打印四行 `provider=… multiplexedHost=false`）——证明该字段不是恒真。
- [ ] AC3 (2) 一个宿主两条 resident 绑定：启动一个 `mode=resident` 的调试宿主并绑两个调试会话，宿主快照读到 `hosts=1 hostId=<h1> mode=resident bindings=2 appSessionIds=[A,B]`，两条绑定的 leases 含 `resident-policy`；逐字打印该行。**负控制**：同一 driver 以 per-run 起两轮 ⇒ 全表里不存在一个宿主带两条绑定（打印实际形态 `maxBindingsPerHost=1` 或该形态下的宿主数）。
- [ ] AC4 (3) 无人轮经真实链路：在**没有任何浏览器连接**时（打印 `browserConnections=0`）跑 `unattended-turn`，读数逐条打印：`run.source=unattended`、`run.appSessionId=<A>`；本次产出的每一帧都来自真实归一化（对照 `sessions.normalizeMessage` 对刚落盘那一行的输出），打印 `frames=<n> rowsDelta=<n> framesFromNormalizer=<n>` 且三者相等；帧上的 `seq` 由 run registry 分配且严格递增（打印 `seqs=[1..n] lastSeq=<n>`，断言 `lastSeq === n`）；transcript 真实落盘（行数与 `mustContain` 内容从磁盘读回）；随后 `chat.subscribe(lastSeq=0)` 的完整重放帧数与本次产出的帧数相等（打印 `replayed=<n>`）。**正控制**：同一 session 在没有 run 时 `replayEvents(A,0)` 为空（打印 `replayed-before=0`），保证 `replayed=<n>` 不是恒真。
- [ ] AC5 (4) 保活理由与 exited/oom 进快照：打印 `leasesBefore=` / `leasesAfterAdd=` / `leasesAfterRemove=` 三行，逐行断言增删确实反映在宿主快照的 `leases` 上（且宿主在理由清空后按策略收尾，不误关）；`exit(oom)` 后读 `closeReason=exited`、`closeDetail=oom`（打印该行）。**正控制**：并列的 `interrupt` 那条读 `aborted`，两条 `closeReason` 不同——保证 `exited` 不是 `aborted` 的别名。
- [ ] AC6 (5) 解除一条不影响另一条：`unbind(A)` 后宿主仍在、`bindings` 2→1、仅剩 `{B}`、B 的 `state` 与 `leases` 与解绑前逐字相等、`closeHost` 未被调用，打印 `unbind=A bindingsBefore=2 bindingsAfter=1 remaining=[B] bUnchanged=true closeHostCalls=0`。**正控制**：再解除 B ⇒ `closeHostCalls=1 closeReason=<该次 reason> hostState=closed`（「恰好一次」与「不误关」都不是恒真）。
- [ ] AC7 门控关闭：门控关闭（未设或取值不认识）的**独立子进程**里，宿主层快照不含任何 `provider=debug` 的宿主，`resolveProvider('debug')` 失败，打印 `gate=off debugHosts=0`。**正控制**：门控开启的独立子进程里同一读数 ≥ 1，打印 `gate=on debugHosts=<n>`（开/关各取一次读数，因为门控按进程求值并缓存）。
- [ ] AC8 假形态承重：让调试引擎在引擎里直接构造帧推给 writer、并绕过 manager 直接开 run（判据文件一字不动）⇒ 判据命令退出 **1**，红文案落在 (3) 的 `run.source` 与 `seq`/`lastSeq` 读数上（不是别的腿先红）。实测退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原。
- [ ] AC9 不使 AC-123、AC-126、AC-136 变红：三条判据命令各自退出 **0**，逐条打印命令与退出码——`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-gate.test.ts`（AC-123）、`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`（AC-126）、`npx vitest run src/shared/tests/debug-agent-display-identity.test.ts`（AC-136）。这三条判据文件**一字不改**（`git diff --name-only` 里没有它们）。
- [ ] AC10 契约面不被改窄：`npm run typecheck`、`npm run lint` 退出 0；既有调试判据文件仍绿：`debug-agent-frames.test.ts`、`debug-agent-gate.test.ts`、`debug-agent-control-plane.test.ts`、`debug-agent-fixture-isolation.test.ts`、`debug-agent-vocabulary-guard.test.ts`、`debug-agent-external-write.test.ts`（逐条打印退出码）；`grep -n "export type LLMProvider" server/shared/types.ts` 逐字打印，联合未被拓宽；`git diff --name-only` 里没有 `server/modules/providers/list/**`。
- [ ] AC11 确定性与零真实等待：判据文件自身零真实等待（`grep -c "setTimeout\|await sleep\|node:timers" <判据文件>` → 0，打印该读数），时序只由测试持有的 gate 与注入的钟/step 时钟控制；场景里不出现 `at > 0` 的 `wait` 步（打印 scenario 的 `at` 集合）；连续两次运行的关键读数行逐字相同（两行都打印）。
- [ ] AC12 如实登记：完成记录写明（a）AC-154/157/158 落地后 manager 与 driver facet 的实际形状、本条实际用的入口名、本条改了它们什么；（b）`source` 字段的实际位置与取值集合，以及 `user`/`scheduled` 两个既有来源是怎么保持不变的；（c）能力矩阵里调试条目怎么落进 `Record<LLMProvider, …>`（用的哪处 seam，以及为何不拓宽联合）；（d）假形态的实测退出码与红态文案；（e）场景 op 在无浏览器连接时被驱动的实际入口（哪个函数、从哪来）；（f）未实现：GOAL-013 的 resident driver/UI/真实 Claude 路径（AC-162…AC-175）、`lifecycle_mode` 列、`POST /api/session-hosts/:sessionId/start|close`（AC-169）。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`）重跑：退出码 0、`fail 0`、`elapsed < 60_000`。AC2 的 `lifecycleModes`/`multiplexedHost` 读数与四个 `false` 负控制、AC3 的 `hosts=1 bindings=2` 与 per-run 负控制、AC4 的 `run.source=unattended` 与 `seqs`/`lastSeq`/`replayed` 三组读数（含 `replayed-before=0` 正控制）、AC5 的三行 leases 与 `exited`/`oom` 及 `aborted` 正控制、AC6 的解绑读数与「恰好一次」正控制、AC7 的 `gate=off debugHosts=0` 与 `gate=on` 正控制、AC8 假形态的实测退出码与红态文案、AC9 三条邻居判据的退出码、AC11 的两次运行一致性，一并写进完成记录。`npm run typecheck` 与 `npm run lint` 退出 0。改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐；`server/modules/providers/list/**` 与三条邻居判据文件不在其中）。完成后 AC-160 在驱动器下一轮经 `goal_ac: AC-160` 独立复跑时由红翻绿——且这次翻绿有分辨力：AC8「引擎自造帧 + 绕过 manager 开 run」的假形态必红（`run.source` 与 `seq` 两条读数），AC2/AC3/AC5/AC6 各自的负控制或正控制保证每一条读数都不是恒真。

## Touches

- server/modules/debug-agent/debug-agent.host-driver.ts (new)
- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/debug-agent/debug-agent.scenario.ts
- server/modules/debug-agent/debug-agent.engine.ts
- server/modules/debug-agent/debug-agent.routes.ts
- server/modules/debug-agent/index.ts
- server/modules/debug-agent/tests/debug-agent-host-driver.test.ts (new)
- server/modules/providers/services/provider-capabilities.service.ts
- server/modules/providers/provider.registry.ts
- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/session-hosts/session-host-manager.service.ts
- server/modules/session-hosts/index.ts
- server/shared/interfaces.ts
- server/shared/types.ts
- tasks/gap-debug-agent-host-driver.md
