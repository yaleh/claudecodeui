---
id: gap-claude-resident-addressable
title: AC-164 常驻进程有稳定的 SendMessage 地址 — 两个常驻会话（真实 claude 二进制 + mock 端点）宿主快照
  peerName 等于按 proposal §12 规则（标题 slug-会话 ID 前 6 位）生成的名字、与 CLI 转录 agent-name
  及实际送达地址逐字一致、进程存活期间改名不变；mock 让会话甲以该地址 SendMessage ⇒ 会话乙产出
  source=unattended、触发类型=跨会话消息可回放的 run；假形态（不传 extraArgs.name）必须红
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-process-survival
  - gap-claude-resident-unattended-turn
goal_ac: AC-164
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn '^goal_ac: *AC-164' tasks/*.md | wc -l` → **0**；`grep -rln 'AC-164' tasks/*.md | wc -l` → **0** —— 不是「未认领」，是**全库零命中**（连任何邻居任务的非目标段都没点过 AC-164）。代码侧：`grep -rn 'peerName' server/ src/ --include=*.ts --include=*.tsx --include=*.js | wc -l` → **0**；`grep -rn 'extraArgs' server/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -c 'identity(' server/shared/interfaces.ts` → **0**（`IProviderHostDriverSink` 今天没有上报身份的动词）；`grep -rn 'sessionId/close' server/ --include=*.ts | wc -l` → **0**；`grep -rn 'lifecycle_mode' server/ --include=*.ts --include=*.js | wc -l` → **0**；`ls server/modules/providers/list/claude/ | grep host-driver` → 只有 `claude-per-run-host-driver.provider.ts`，**无** resident driver。⇒ AC-164 无认领者，本条不是重复。

**本条认证的机制是「稳定的进程地址」**：`extraArgs.name` 落进 CLI、CLI 本地转录里的 `agent-name`、宿主快照的 `peerName`、另一个会话**实际送达**的地址，四者必须是**同一个字符串**，且在进程存活期间**改名不变**；再由**另一个**常驻会话真的用这个（从 `GET /api/session-hosts` 投影里取的、与界面「复制 SendMessage 地址」同源的）地址 `SendMessage`，让对方产出一条 `source=unattended`、触发类型为**跨会话消息**、可完整回放的 run。E6 已实测这条链的判定通道：`-n, --name <name>` 是合法旗标、中文与空格原样接受，但**这个名字不进 `/v1/messages` 请求体**，判定必须读本地转录（`<configDir>/projects/<slug>/<session>.jsonl` 里的 `agent-name`），读请求体是看不出来的（`docs/proposals/claude-resident-sessions-experiments.md:241-253`）。

**与 §12 的原始条款逐字对齐**（`docs/proposals/claude-resident-sessions.md:397-401`）：通过 `extraArgs: { name: '<标题 slug>-<会话 ID 前 6 位>' }` 给常驻进程一个稳定的 peer 名，driver 以 `identity` 事件把它上报到绑定的 `peerName`；标题变化时**不改名**，名字在进程生命周期内固定。会话详情显示 pid / peer 名 / 启动时间 / 内存 / 状态 / 保活理由，数据来自统一宿主接口。

<!-- dedup-ref --> 邻居让位是**逐字写在案的**：`gap-claude-resident-process-survival`（AC-161，`ready`）落 resident driver（一个不结束的输入队列、`result` 切轮、`interrupt` 只停当前轮、close 走 stdin EOF）、`lifecycle_mode` 列与 `POST /:sessionId/close`；`gap-claude-resident-unattended-turn`（AC-162，`todo`）落「CLI 自己开的一轮 ⇒ 宿主开 run」的形状、`source='unattended'`、完整回放，并在**第 4 条**里逐字定下触发类型词表「后台任务回报 / 定时任务触发 / **跨会话消息**」；`gap-claude-resident-busy-input`（AC-163，`todo`）落忙时输入进 CLI 自己的命令队列与撤回。三条与本条**机制都不同**（一个跨轮存活、一个无人轮触发与 run 落地、一个忙时队列），本条认证的是**地址本身**：名字怎么生成、落到哪里、怎么读回、改名不变、以及**另一个会话**用复制的地址真的送达。与之并列的宿主层七条邻居**全部 `status: done`**（`gap-session-hosts-default-wrap-four-providers` AC-154 落 `SessionHostManager`/`ProcessHost`/`SessionBinding`/`HostLease`/`IProvider.hostDriver`；`gap-session-hosts-lease-driven-lifecycle` AC-157；`gap-session-hosts-binding-multiplexing` AC-158；`gap-session-hosts-claude-per-run-driver` AC-159；`gap-session-hosts-rest-list-endpoint` AC-156 落 `GET /api/session-hosts` 投影；`gap-debug-agent-host-driver` AC-160 落**第一个**声明 `resident` 的 driver；`gap-session-hosts-per-run-frame-parity`）—— 它们是本条要扩的那两个类型（`SessionBinding`、`IProviderHostDriverSink`）的作者，但不是本条的前置。

**两条真前置（已写成关系边，非仅散文）**：`gap-claude-resident-process-survival`（AC-161，`ready`）—— 没有 resident driver 就没有「跨轮存活的常驻进程」可寻址，也没有 `lifecycle_mode` 分派把 `chat.send` 送进那个进程；`gap-claude-resident-unattended-turn`（AC-162，`todo`）—— 本条第二腿（会话乙产出 `source=unattended` 的 run）骑在 AC-162 落的「CLI 自己开的一轮 ⇒ 宿主开 run + 触发类型词表」上；AC-162 未落地时本条**不得**自行补它的范围（无人轮识别 / 开 run 的注入点 / 通知触发类型），只登记并停在那一步。两条都是**真前置**，故 `depends_on` 逐字列出（关系边存在，散文点名安全）。proposal 的阶段划分同属**阶段 3**（`docs/proposals/claude-resident-sessions.md:699`）。

**来源与判据物。** 判据逐字取自 `goals/AC-164-常驻进程有稳定的-sendmessage-地址-另一个会话用复制的地址能送达并产生一轮.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-addressable.test.ts`（命令逐字含文件路径，不用 glob）。**红态基线（本轮直跑，读数不是推断）**：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-addressable.test.ts'`。**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑已存在的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-background-work.test.ts` → 退出 **0**，读数 `tests 10 / pass 10 / fail 0 / duration_ms 484.8671` ⇒ 判据今天退 1 的唯一原因是判据文件不存在。

**现状（本轮实测的读数）—— 地址这一格在类型层就还没有落脚点**

- **绑定上没有名字**：`SessionBinding`（`server/shared/types.ts:1855-1866`）逐字只有 `appSessionId` / `providerSessionId` / `state` / `leases` / `lastActivityAt` / `detachReason`，**没有 `peerName`**；proposal §2 `:154` 的 `peerName: string | null; // 可寻址时的 SendMessage 地址` 尚未落。
- **sink 没有上报身份的动词**：`IProviderHostDriverSink`（`server/shared/interfaces.ts:161-181`）逐字只有 `leaseAdded` / `leaseRemoved` / `activity` / `exited`，**没有 `identity`**；proposal §12 的「driver 以 `identity` 事件把它上报到绑定的 `peerName`」两端都缺。
- **REST 投影里没有 peer 名**：`session-hosts.routes.ts` 的 `GET /` 投影（AC-156 落）逐字含 pid / mode / closeReason 等，**不含 peerName** —— 而「复制 SendMessage 地址」的数据源就是它（proposal `:400`：仅当绑定存活且 `addressable` 时可用）。
- **driver 侧不存在**：`claude-per-run-host-driver.provider.ts` 是 per-run 的；resident driver 是 AC-161 的范围（`claude-host-driver.provider.ts`，proposal §7 `:287` 钦定路径）。
- **触发类型词表由 AC-162 落**：`notifyBackgroundWorkCompleted({ userId, provider, sessionId, sessionName })`（`notification-orchestrator.service.js:272`）今天签名里没有触发类型；`ChatRunSource`（`server/shared/types.ts:1997`）只有 `'user' | 'scheduled' | 'unattended'`，run 上没有触发类型字段。AC-162 的第 4 条负责扩它；本条负责让「跨会话消息」这一档**真的产生**并对上。
- **`SendMessage` 在 CLI 工具表里**：E9 实测常驻 stream-json 暴露的 21 个工具里**有** `SendMessage`、**没有** `Monitor`（`docs/proposals/claude-resident-sessions-experiments.md:448`）⇒ 判据用 `SendMessage` 触发是落在本 build 真实存在的工具上。
- 真实二进制在位（判据需要）：`which claude` → `/data/home/yale/.nvm/versions/node/v24.21.0/bin/claude`，`claude --version` → `2.1.283 (Claude Code)`；SDK `@anthropic-ai/claude-agent-sdk ^0.3.165`。

**要建的东西（范围是 AC-164 的最小充分集）**

1. **绑定的 `peerName` 与 sink 的 `identity`**：`SessionBinding` 加 `peerName: string | null`（proposal §2 `:154` 逐字）；`IProviderHostDriverSink` 加 `identity(appSessionId, peerName)`（或等价动词，按 proposal §4 的动词规格命名）；manager 记到绑定上；`GET /api/session-hosts` 投影里带上它（界面「复制 SendMessage 地址」的数据源）。
2. **按 §12 规则生成并真的传进 CLI**：resident driver 起进程时以 `extraArgs: { name: '<标题 slug>-<会话 ID 前 6 位>' }`（proposal §12 `:399` 逐字规则）传给 CLI —— ⚠️ **名字不能只算不传**（这正是假形态要红的那个面）；随后 driver **读回**本地转录里的 `agent-name`（`<CLAUDE_CONFIG_DIR>/projects/<slug>/<session>.jsonl`，E6 实测的判定通道）并以 `identity` 上报 —— 上报的是**CLI 真的注册的那个名字**，不是 driver 自己算出来的那个字符串；两者不一致时按 `exited`/错误处理，不得静默覆盖。
3. **名字在进程生命周期内固定**：会话标题改名（走既有 rename 路径）**不**改 peer 名（proposal §12：标题变化时不改名）；进程重启（新 pid）才允许按当时标题重算。
4. **跨会话送达产生一轮**：两个常驻会话甲/乙；mock 端点按脚本让**甲**的模型发一条 `SendMessage` 的 `tool_use`（`to` = 从 `GET /api/session-hosts` 读到的乙的 `peerName`）；工具在甲的 CLI 里真实执行 ⇒ `<cross-session-message>` 进乙的上下文 ⇒ 乙的 CLI 自开一轮 ⇒ 乙的宿主层开一条 `source='unattended'`、触发类型为**跨会话消息**、可完整回放的 run（机制骑在 AC-162 的 run 开路上）。
5. **判据文件** `server/modules/providers/tests/claude-resident-addressable.test.ts`：做法照 AC-025 的 `model-gateway-end-to-end.test.ts`（真实 `claude` 二进制 + mock Anthropic 兼容端点，**按请求体体量识别真轮**——E9 补充细节 1：一轮开始有 ~2KB 预检 + ~77KB 真轮两条请求，按序号或「有没有用户文本」识别都会错；临时 `DATABASE_PATH` + 临时 `CLAUDE_CONFIG_DIR`；经真 `handleChatConnection` 的 `chat.send` 驱动）。先取红态（判据文件不存在 ⇒ 退 1）与假形态红态都实测一遍。

**约束（不要碰的红线）**

- `claude-runtime.provider.js` 的 `passthrough-parity.test.ts` 断言 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 必须仍在 `sdkOptions.env` 里（AC-159 已钉），且 `claude-background-work.test.ts` 以该**路径与 `.js` 扩展名** import `startsBackgroundWork` ⇒ 该文件**保持 `.js` 且保持该路径**。resident driver 里需要的 SDK 选项（含 `extraArgs.name`）在**自己文件里**构建；若要共用 `claude-runtime.provider.js` 的选项构建，只做**纯抽取、零行为变化**并以既有三条测试族不改断言仍绿为准。
- 跨模块只经 `index.ts` barrel（`AGENTS.md` 的后端标准 + 本仓 boundaries lint）；新测试文件的 import 走 `@/modules/…/index.js` / `@/shared/…js`。
- 开 run 的注入点不得让 providers 反向 import websocket 形成闭环（照 `provider.registry.ts:101-103` 的禁环说明选边 —— 该边由 AC-162 落，本条只用不建）。

## Plan

1. **类型与投影**：`SessionBinding.peerName` + `IProviderHostDriverSink.identity` + manager 记录 + `GET /api/session-hosts` 投影带出。可独立验证：投影读数为 `null`（未上报）与上报后逐字相等；既有 `session-hosts-routes.test.ts` / `session-host-bindings.test.ts` 不改断言仍绿。
2. **driver 侧（依赖 AC-161 的 resident driver 已落地；未落地则登记并停）**：按 §12 规则算名 → 真的写进 `extraArgs.name` → 读回转录 `agent-name` → `identity` 上报。先用**伪造 SDK 流 + 伪造转录文件**把两端钉住：不传 `extraArgs.name` 时 `identity` 上报的名字与转录里的名字不一致 ⇒ 假形态在伪造层先红。
3. **改名不变**：改名走既有 rename 路径后，`pid` 与 `peerName` 两个读数都不变（只有标题变）；用伪造流验证，再在真实二进制判据里复验一次。
4. **送达链路**：mock 端点按脚本给甲发 `SendMessage` 的 `tool_use`；乙侧断言 `source='unattended'` + 触发类型 = 跨会话消息 + 完整回放。触发类型的读数口径（CLI 对跨会话到达给出的事件形态）若在真实二进制上读不到可分辨的标记，**不得自行编造**：把原始事件序列写回 `docs/proposals/claude-resident-sessions-experiments.md`（E9 一节旁）并停在 `needs-human` 由人改判据。
5. **判据文件**：两个常驻会话 + 真 `chat.send` + mock 脚本化 `SendMessage` + 改名 + 送达 + 回放 + 两臂假形态 + 60 秒预算守卫；最后跑三条既有 per-run 判据确认不改断言。
6. **收尾**：`npm run typecheck`、`npm run lint` 退出 0；写完成记录（含每条读数与假形态实测）。

## AC

- [ ] 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-addressable.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`，并打印整体墙钟 `elapsed=<n>ms` 且 `< 60_000`。红态基线本轮实测：同命令退出 **1**、文案逐字 `Could not find 'server/modules/providers/tests/claude-resident-addressable.test.ts'`。命令逐字含文件路径，不用 glob。
- [ ] §12 规则逐字：判据对**两个**常驻会话各打印一行 `session=<A|B> sid6=<6位> slug=<标题 slug> ruleName=<slug>-<sid6> snapshotPeerName=<v> equal=true`，断言 `snapshotPeerName === '<slug>-<sid6>'`。
- [ ] 快照名 == CLI 真的注册的地址：判据打印 `transcriptAgentName=<v> equalToSnapshot=true`（从 `<CLAUDE_CONFIG_DIR>/projects/<slug>/<session>.jsonl` 的 `agent-name` 记录读出，E6 的判定通道），**并**打印 `nameInRequestBody=false`（证明该读数不是从 `/v1/messages` 请求体来的 —— 它本就不进请求体）。
- [ ] 地址取自「复制」的那条路：判据打印 `addressSource=GET /api/session-hosts peerName=<v>` —— 断言用来发送的地址**逐字来自 REST 投影的 `peerName`**，不是判据内部的另一个变量（与界面「复制 SendMessage 地址」同源，proposal §12 `:400`）。
- [ ] 进程存活期间不变：进程存活时改会话标题（走既有 rename 路径）⇒ 判据打印 `pidBefore=<p> pidAfter=<p> peerNameBefore=<n> peerNameAfter=<n> pidUnchanged=true nameUnchanged=true`。
- [ ] 送达并产生一轮：判据打印 `sentFrom=<A peerName> sentTo=<B peerName> delivered=true`，以及乙侧 `run.source=unattended run.trigger=cross-session-message runsBefore=<n> runsAfter=<n+1>`（run 计数确实增加）；回放：新连接 `chat.subscribe(lastSeq=0)` 的 `replayed=<n>` 与本次产出的帧数相等。
- [ ] 三条读数的**正控制**（保证不是恒真）：(a) 名字 —— 假形态臂打印 `transcriptAgentName=<CLI 自动名> equalToSnapshot=false`，证明上面的等值断言不是恒真；(b) 触发类型 —— 同一次运行里另有一条用户轮，打印其 `run.source=user run.trigger=<非跨会话>`，证明触发类型不是常量；(c) 回放 —— 乙在送达前 `replayEvents(B,0)` 为空（打印 `replayed-before=0`）。
- [ ] 假形态承重：driver 照 §12 规则**算**出名字但**不传** `extraArgs.name`（判据文件一字不动）⇒ 判据命令退出 **1**，且红**落在**「快照名 == 转录 `agent-name`」那条读数上（不是别的腿先红）。实测退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原。
- [ ] 60 秒预算：判据打印整体墙钟 `elapsed=<n>ms` 并断言 `< 60_000`（goal 的判据闸门对单条判据是 60 秒硬超时，不可上调）；真实二进制那段的等待只能是有界轮询（等事件/等文件），不引入固定时长的 `sleep`；两个常驻进程 + 送达 + 回放都要算进这个窗口。
- [ ] 触发面落在真实存在的工具上：判据打印 `sendMessageInToolTable=true monitorInToolTable=false`（E9 9.3 实测 21 个工具里有 `SendMessage`、没有 `Monitor`），保证触发只用 `SendMessage`。
- [ ] 不使既有判据变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts`、`…/claude-background-work.test.ts`、`…/passthrough-parity.test.ts` 三条各自退出 **0**（逐条打印命令与退出码），这三条文件**一字不改**（`git diff --name-only` 里没有它们）；`server/modules/session-hosts/tests/` 下的既有判据也仍绿（逐条打印退出码）。
- [ ] 契约面：`npm run typecheck`、`npm run lint` 退出 0。
- [ ] 触发类型读数缺口如实处理：若真实二进制上读不到可分辨的「跨会话到达」标记，判据**不得**声称绿；把原始事件序列写回 `docs/proposals/claude-resident-sessions-experiments.md`（E9 一节旁）并停在 `needs-human` 由人改判据（AC 逐字要求「触发类型为跨会话消息」，放宽只能由人做）。

## DoD

判据在**落地后的树**上按原命令重跑：退出码 0、`fail 0`、`elapsed < 60_000`。**真实落地**（不是「测试存在」）：判据里真的起**两个** `claude` 常驻进程（真二进制 + mock 端点 + 临时 `DATABASE_PATH` + 临时 `CLAUDE_CONFIG_DIR`），真的读出宿主快照的 `peerName` 与 CLI 本地转录里的 `agent-name` 是**同一个字符串**（且等于 §12 规则算出的 `<标题 slug>-<会话 ID 前 6 位>`），真的改一次会话标题而 **pid 与 peerName 都不变**，真的让甲的模型经 mock 脚本发一条指向乙 `peerName` 的 `SendMessage`、真的送达、真的让乙产出一条 `source=unattended`、触发类型为**跨会话消息**、可经 `chat.subscribe(lastSeq=0)` 完整回放的 run。假形态（算名不传 `extraArgs.name`）把「快照名 == 转录 agent-name」读数打红（绿 = 判据有洞，必须先补判据再继续）。三条读数各带正控制，保证不是恒真。既有 per-run 判据与宿主层判据逐字不变且仍绿。完成后 AC-164 在驱动器下一轮经 `goal_ac: AC-164` 独立复跑时由红翻绿——且这次翻绿有分辨力：假形态必红，名字/触发类型/回放三条读数各有正控制。

## Touches

- `server/shared/types.ts`（`SessionBinding.peerName`）
- `server/shared/interfaces.ts`（`IProviderHostDriverSink.identity`）
- `server/modules/session-hosts/session-host-manager.service.ts`（把 `identity` 记到绑定上）
- `server/modules/session-hosts/session-hosts.routes.ts`（`GET /api/session-hosts` 投影带出 `peerName`）
- `server/modules/session-hosts/index.ts`（barrel 收口；签名不变则不动）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（AC-161 落地的 resident driver；本条在其上按 §12 规则建 `extraArgs.name`、读回转录 `agent-name`、`identity` 上报；若其实际文件名不同，按实际文件登记并在完成记录里写明）
- `server/modules/providers/list/claude/claude.provider.ts`（若需要透传 peer 名/触发类型）
- `server/modules/providers/tests/claude-resident-addressable.test.ts`（新：判据）
- `docs/proposals/claude-resident-sessions-experiments.md`（写回跨会话到达的事件形态读数——仅当判据需要该口径时）
- `tasks/gap-claude-resident-addressable.md`（自触）
