---
id: gap-session-hosts-binding-multiplexing
title: AC-158 宿主与会话 1:N：multiplexedHost 伪造 driver 下同一宿主承载两条绑定、解绑一条不关宿主、最后一条恰好一次
  closeHost、同一 appSessionId 二次绑定被拒且点名冲突宿主、per-run 顶替先以 superseded 关旧宿主再起新宿主
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
goal_ac: AC-158
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rn "^goal_ac: *AC-158" tasks/*.md | wc -l` → **0**；`grep -rn "AC-158" tasks/*.md` → 4 命中，全部落在邻居任务的**非目标**段里（`gap-session-hosts-default-wrap-four-providers:48`、`gap-session-hosts-lease-driven-lifecycle:45,60`、`gap-session-hosts-rest-list-endpoint:57`、`gap-session-hosts-per-run-frame-parity:60`），没有一条认领它。宿主层符号在代码里零命中：`grep -rn "IProviderHostDriver\|hostDriver\|closeHost\|HostLease\|SessionBinding\|multiplexedHost\|supersedeOnNewTurn" server/ src/ shared/ | wc -l` → **0**。⇒ AC-158 无认领者；本条要建的机制（宿主主键与**绑定基数**、解绑不误关、单写者拒绝、per-run 顶替的**可观测次序**）与四条邻居的机制都不同，本条不是重复。

本条的前置是两条已立案的邻居，它们各自认领了本条要驱动的那个对象：`gap-session-hosts-default-wrap-four-providers`（AC-154）落 `SessionHostManager`、`ProcessHost.bindings`、`hostId → ProcessHost` 与 `appSessionId → hostId` 两个索引、以及 `IProviderHostDriver` facet；`gap-session-hosts-lease-driven-lifecycle`（AC-157）落 lease 驱动的状态机、`LifecyclePolicy.supersedeOnNewTurn`、`lingering` 与 `superseded` 的产生入口。两条都在各自的**非目标**里把「1:N 解绑与单写者不变量」「(顶替的)真实产品路径」让给本条。故本条顶层 `depends_on` 指向这两条：判据直接驱动它们建出来的 manager，先有它们的 module 与共享契约才能落地。

**来源与判据物。** 判据逐字取自 `goals/AC-158-宿主与会话-1-n-解绑一个会话不关闭仍有其他绑定的宿主-同一会话不能有第二个绑定.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-bindings.test.ts`（命令逐字含文件路径，不用 glob）。红态基线（本轮**直跑**，读数不是推断）：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/session-hosts/tests/session-host-bindings.test.ts'`；`ls server/modules/session-hosts/` → `No such file or directory`（exit 2；`server/modules/` 现有 23 个模块，无 `session-hosts`）。

**命令形状是好的，红只因缺文件**（这条是本条红态归因的承重件，单独测过）：同一命令形状跑一个已存在的后端测试 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-runtime.service.test.ts` → 退出 **0**，读数 `tests 3 / pass 3 / fail 0 / duration_ms 689.5`，墙钟 1.0s ⇒ 判据今天退 1 的唯一原因是判据文件不存在。

**现状（本轮实测的读数）**

- 宿主层在代码里零命中（见上，7 个符号合计 0）。承载本条的 manager 与共享契约（`ProcessHost.bindings`、`SessionBinding`、`HostLease`、`appSessionId → hostId` 索引、`IProviderHostDriver.unbind/closeHost`）**今天都不存在**，由 AC-154/AC-157 先落。
- `multiplexedHost` 今天在任何地方都不存在：`grep -rn "multiplexedHost\|lifecycleModes" server/ src/` → **0 命中**（proposal §5 `:229-250` 把它排在能力矩阵里，`:235` 是字段声明；`server/modules/providers/services/provider-capabilities.service.ts` 今天每个 provider 12 个字段里全无这两个）。
- 判据表的三个锚点都在 proposal `docs/proposals/claude-resident-sessions.md`（唯一提交 `e88175cf`）：§2 宿主模型 `:115-144` —— `bindings: Map<string, SessionBinding>`（`:126`，key = appSessionId）、两个索引 `:141`（`hostId → ProcessHost` 与 `appSessionId → hostId`，后者是单写者不变量的落点）、「宿主在所有绑定都解除后关闭」`:143`；§13.1 单写者不变量 `:362-364`（同一 provider session 在任何时刻最多只有一个绑定，由 `appSessionId → hostId` 索引强制）；§阶段 1 测试项 `:544`（「1:N 下，解除一个绑定时，仍有其他绑定的宿主不关闭；最后一个绑定解除时宿主关闭」）。
- driver facet 的解除面在 §4 `:193-217`：`unbind(host, appSessionId, reason)` 与 `closeHost(host, reason)`（`:209`、`:210`）；facet 本身是 `IProvider` 上的**可选** `hostDriver?`（`:217`），与既有 `fork?`/`rename?` 同形。本条要的 `multiplexedHost` 声明落在**这个 facet** 上 —— 判据逐字要求「一个声明 `multiplexedHost` 的伪造 driver」，只有 driver 自己声明得出来。
- 既有测试的形状样板（判据文件照抄这一族）：`server/modules/debug-agent/tests/*.test.ts` 与 `server/modules/providers/tests/provider-runtime.service.test.ts` —— `node:test` + `node:assert/strict`，import 用 `@/modules/…js` / `@/shared/…js`。

**要建的东西（范围是 AC-158 的最小充分集）**

1. **共享契约**（`server/shared/types.ts`；AC-154 已在此落 `ProcessHost`/`SessionBinding`/`HostLease`/`HostCloseReason`，本条只在其上补，**不重复造已有字段**）：
   - `HostBindErrorCode`：至少含 `'session-already-bound'`（同一 `appSessionId` 已有绑定时拒绝）与 `'host-not-multiplexed'`（非多路复用的宿主不接受第二个绑定）。以值数组常量导出（照 AC-157 的 `HOST_CLOSE_REASONS` 写法），使「错误可辨」可机械断言而不是靠人肉认字面量。
   - `HostBindResult`：判别联合 —— `{ ok: true; hostId: string }` | `{ ok: false; code: HostBindErrorCode; existingHostId: string | null }`。`existingHostId` 是「可辨」的承重件：同一会话已有绑定时必须点名**冲突的那个宿主**（哪怕请求指向另一个宿主）。
2. **driver facet 上的多路复用声明**（`server/shared/interfaces.ts`）：给 AC-154 落的 `IProviderHostDriver` 加 `readonly multiplexedHost?: boolean`（缺省视为 `false`）。**只落 facet**：能力矩阵（`provider-capabilities.service.ts`）里的同名镜像是 GOAL-012 范围里的能力矩阵项、**无任何 AC 判据覆盖它**，本条不落，避免把无判据的字段塞进 Touches。
3. **manager 的绑定面**（`server/modules/session-hosts/session-host-manager.service.ts`，按 AC-154/AC-157 落地后的实际形状命名，**不新起第二份状态表**；下面是行为要求，不是要求新造名字 —— 若已存在同形入口，按实际名字用，并在完成记录写明实际入口名）：
   - **绑定基数**：`bindSession({ provider, appSessionId })` 返回 `HostBindResult`。driver 声明 `multiplexedHost: true` 时，同一 provider 上已有、且仍接受绑定的宿主被**复用** ⇒ 一个宿主上出现**两条**绑定；`false`/缺省时**绝不**出现一个宿主两条绑定（拒绝并给 `host-not-multiplexed`，或另起一个宿主 —— 二者都接受，完成记录写明实际选了哪种）。
   - **解绑不误关**：`unbindSession(appSessionId, reason)` 调 driver 的 `unbind(host, appSessionId, reason)` 并摘掉该绑定；宿主上**仍有**其他绑定时宿主不关闭、**不**调 `closeHost`，且其他绑定的 `state` 与 `leases` 逐字不变。
   - **最后一条绑定**：解除后宿主没有任何绑定 ⇒ 调 `driver.closeHost(host, reason)` **恰好一次**，`closeReason = reason`，宿主进 `closed`；对同一会话重复解绑**不得**再调一次（幂等）。
   - **单写者**：`bindSession` 对已有绑定的 `appSessionId` 一律拒绝（无论请求指向同一宿主还是另一宿主），返回 `{ ok: false, code: 'session-already-bound', existingHostId: <冲突宿主> }`，且**不发生部分写入**（被拒的那次不得在目标宿主上留下绑定）。
   - **per-run 顶替次序**：`supersedeOnNewTurn` 为真时，同一 `appSessionId` 的新一轮到来且旧宿主处于 `lingering` ⇒ **先** `await driver.closeHost(旧宿主, 'superseded')`，**再** `startHost`/`bind` 新宿主 —— manager 必须**等**旧的 `closeHost` 结算完才开新宿主。这条与上面的「单写者拒绝」不矛盾，而正是后者的推论：先关旧宿主使旧绑定消失，随后的新绑定才不会撞上单写者不变量；反过来（先绑新宿主）会被自己的单写者不变量拒绝。
4. **判据测例** `server/modules/session-hosts/tests/session-host-bindings.test.ts`：测试内自带的**假 driver**（实现 AC-154 的 facet、声明 `multiplexedHost`、把每次调用追加进一份共享调用日志、`closeHost` 可被测试用 gate 悬住不结算）+ 直接驱动 manager。与既有后端测试同形（`node:test` + `node:assert/strict`，`@/modules/…js` / `@/shared/…js`）。

**判据测例怎么搭**（每个子例打印逐行读数；除了测试自己持有的 closeHost gate，没有任何时序依赖，故不需要真实等待）

- 共享脚手架：假 driver 的调用日志形如 `[['startHost', hostId], ['bind', hostId, appSessionId], ['unbind', hostId, appSessionId, reason], ['closeHost', hostId, reason], …]`，测试按序断言；`closeHost` 有一枚测试持有的 gate（默认已放行，需要时改成悬住）。
- **(1)** 一个声明 `multiplexedHost: true` 的假 driver：`bindSession(A)` 得宿主 h1，`bindSession(B)` 再绑同一 provider ⇒ 快照里 `hosts=1`、`h1.bindings.size=2`、两个 key 恰为 `{A,B}`；打印 `hosts=1 hostId=h1 bindings=2 appSessionIds=[A,B]`。
- **(1b) 正/负控制**（让声明承重）：同一形状但假 driver 不声明 `multiplexedHost`（或显式 `false`）⇒ 断言**不存在**一个宿主带两条绑定，并打印实际形态（`hosts=2 maxBindingsPerHost=1` 或 `rejected code=host-not-multiplexed`）。没有这条，`multiplexedHost` 就只是个装饰字段。
- **(2)** 回到 (1) 的两个绑定，先给 B 记下 `state` 与 `leases` 的逐字快照；`unbindSession(A, 'user')` ⇒ 宿主仍在（`state !== 'closed'`）、`h1.bindings.size` 由 2 变 **1**（**正控制**：解绑真的发生了，不是无操作）、只剩 `{B}`、B 的 `state` 与 `leases` 与快照逐字相等、`closeHost` 调用数 **0**；打印 `unbind=user bindingsBefore=2 bindingsAfter=1 remaining=[B] bindingUnchanged=true closeHostCalls=0`。**另一子例**用 `unbindSession(A, 'idle')` 重跑同一条（判据的「idle 或 user」两形都覆盖），打印 `unbind=idle …`。
- **(3)** 在 (2) 之后继续 `unbindSession(B, 'idle')` ⇒ `unbind` 调用数 **2**、`closeHost` 调用数**恰好 1**、宿主 `state=closed` 且 `closeReason=idle`；再对同一会话重复解绑一次 ⇒ `closeHost` 调用数仍为 **1**（幂等；**正控制**：「恰好一次」不是恒真）。打印 `unbindCalls=2 closeHostCalls=1 closeReason=idle hostState=closed idempotentCloseHostCalls=1`。
- **(4)** 建宿主 h1 并绑 A；再 `bindSession(A)` 指回 h1 ⇒ `{ok:false, code:'session-already-bound', existingHostId:h1}`；另起宿主 h2 并 `bindSession(A)` 指向 h2 ⇒ 同样被拒且 `existingHostId` 仍是 **h1**（错误点名的是冲突宿主，不是请求宿主）；**负控制**：`bindSession(C)`（全新会话）⇒ `ok:true`，且被拒的那次在 h2 上**没留下**绑定。打印 `rebindSameHost=rejected code=session-already-bound existingHostId=h1`、`rebindOtherHost=rejected code=session-already-bound existingHostId=h1 targetBindingsBefore=[] targetBindingsAfter=[]`、`bindFreshSession=ok hostId=h2`。
- **(5)** per-run 策略（`supersedeOnNewTurn: true`）：绑 A 到 h1，给 h1 一条 `turn` lease 再摘掉、留有 `background-task` ⇒ h1 `state=lingering`；把假 driver 的 `closeHost` gate **悬住**；对 A 开新一轮 ⇒ 断言到此刻为止调用日志里**有** `closeHost(h1,'superseded')` 且**没有**任何 `startHost`/`bind`（打印 `gated:startedNewHostBeforeOldClosed=false`）；放行 gate ⇒ 有序日志里 `closeHost(h1,superseded)` 在 `startHost(h2)`/`bind(h2,A)` **之前**（打印有序日志），且 h1 `closeReason=superseded`、h2 `state=busy`、全表里 A 的绑定数**恰好 1**。**正控制**：h1 的原因读成 `superseded` 而不是 `turn-complete`/`released`。
- 末尾打印 `elapsed=<n>ms`。

**假形态（判据的分辨力证明，必须实测）**

判据逐字指定的那一形：**以 `appSessionId` 作宿主主键**（`hostId := appSessionId`，即 1:1）⇒ 判据命令必须退出 **1**，红文案落在 (1) 的 `bindings=2` 读数与 (2) 的 `bindingsAfter=1`/「宿主仍在」读数上。只改实现、判据文件一字不动；实测完 `git checkout --` 还原到 `git status --short` 只剩 Touches 里的文件 + 任务文件。**如实登记**：若该假形态下 (1) 是以「新建了第二个宿主」而不是「断言的 bindings 读数不符」的方式红的，把实际红文案逐字抄进完成记录 —— 红必须落在 `bindings` 读数上，否则这条假形态没有承重。

**非目标**：默认包装与四个 provider 的真实分派入口登记（AC-154）、逐帧不变（AC-155）、`GET /api/session-hosts` 与另两条 REST（AC-156）、lease 驱动的状态机/关闭原因穷举/停机（AC-157）、真实 Claude driver 的顶替与 30 分钟持有（AC-159）、调试 agent 的 `hostDriver` 与场景 op（AC-160）、能力矩阵的 `lifecycleModes`/`multiplexedHost` 镜像（无 AC 判据覆盖）、`process-containment.service.ts`、数据库 `lifecycle_mode` 列、`chat-run-registry`/`scheduled-message-dispatcher` 的 run-source 字段、前端。**不改 `server/modules/providers/list/**`（四个 runtime 一字节不动）、不改 `server/modules/websocket/**`**。

## Plan

1. 读 AC-154 与 AC-157 的落地提交：manager 的实际形状（工厂名、`snapshot()`、`bindings` 的实际类型与 key、driver facet 的方法名与 sink 事件、`LifecyclePolicy` 的字段、`lingering`/`superseded` 的实际产生入口）。按实际形状改第 1/2/3 条与判据测例的调用名，**不重复造**已有字段/入口。若发现 AC-154/AC-157 尚未落地，**不得**自行补它们的范围（那是它们的前置），如实登记并停在这一步。
2. 落共享契约：`HostBindErrorCode` + `HostBindResult`（`server/shared/types.ts`），`IProviderHostDriver.multiplexedHost?`（`server/shared/interfaces.ts`）；`npm run typecheck` 绿。
3. manager：绑定基数（多路复用复用宿主；非多路复用不共享）、`unbindSession` 的解绑不误关、最后一条绑定恰好一次 `closeHost` 且幂等、`bindSession` 的单写者拒绝与 `existingHostId`、per-run 顶替的**先关后起**次序（`await` 旧 `closeHost` 后才开新宿主）。
4. 写判据测例（五个子例 + (1b) 负控制 + (2)(3)(4)(5) 的正/负控制），假 driver + 调用日志 + closeHost gate，读数逐行打印。
5. 实测假形态（`hostId := appSessionId`），抄退出码与红态文案，`git checkout --` 还原。
6. `npm run typecheck`、`npm run lint`；四条邻居判据文件（`session-host-default-wrap.test.ts`、`session-host-lifecycle.test.ts`、`session-hosts-routes.test.ts`、`session-host-per-run-parity.test.ts`）全绿；写完成记录（含每条读数、两次运行一致性、假形态实测）。

## AC

- [ ] AC1 判据入口为绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-bindings.test.ts` 在落地后的树上退出 **0** 且输出 `fail 0`（命令逐字含文件路径，不用 glob）。红态基线已测：同命令当前退出 1、stdout 逐字 `Could not find 'server/modules/session-hosts/tests/session-host-bindings.test.ts'`；同一命令形状跑既有 `server/modules/providers/tests/provider-runtime.service.test.ts` 退出 0（`tests 3 / pass 3 / fail 0`，墙钟 1.0s）⇒ 红只因缺文件。
- [ ] AC2 (1)+(1b) 绑定基数：`multiplexedHost: true` 的假 driver 上 `hosts=1 hostId=<h1> bindings=2 appSessionIds=[A,B]`；同一形状但 driver 不声明（或显式 `false`）时**不存在**一个宿主带两条绑定（打印实际形态 `hosts=2 maxBindingsPerHost=1` 或 `rejected code=host-not-multiplexed`）。两条读数都打印。
- [ ] AC3 (2) 解绑不误关：`unbindSession(A,'user')` 与 `unbindSession(A,'idle')` 两形都覆盖；每形断言宿主仍在、`bindings` 2→1（正控制）、仅剩 `{B}`、B 的 `state` 与 `leases` 与解绑前逐字相等、`closeHostCalls=0`。打印 `unbind=<reason> bindingsBefore=2 bindingsAfter=1 remaining=[B] bindingUnchanged=true closeHostCalls=0`。
- [ ] AC4 (3) 最后一条绑定：解除最后一条后 `unbindCalls=2 closeHostCalls=1`、宿主 `state=closed`、`closeReason` 等于该次解绑 reason；对同一会话重复解绑 ⇒ `closeHostCalls` 仍为 1（正控制：「恰好一次」不是恒真）。打印 `unbindCalls=2 closeHostCalls=1 closeReason=<r> hostState=closed idempotentCloseHostCalls=1`。
- [ ] AC5 (4) 单写者拒绝且错误可辨：同一 `appSessionId` 再绑定被拒（同一宿主与另一宿主各一次），两次都是 `code=session-already-bound` 且 `existingHostId` 都指向**冲突宿主 h1**；**负控制**：全新会话 `bindSession(C)` 得 `ok:true`；被拒的那次在目标宿主上没留下绑定（打印目标宿主绑定集合前后）。三行读数都打印。
- [ ] AC6 (5) per-run 顶替次序可观测：把假 driver 的 `closeHost` gate 悬住后对同一会话开新一轮 ⇒ gate 释放前日志里**没有** `startHost`/`bind`（打印 `gated:startedNewHostBeforeOldClosed=false`）；释放后有序日志里 `closeHost(h1,superseded)` 在 `startHost(h2)`/`bind(h2,A)` **之前**；h1 `closeReason=superseded`（正控制：不是 `turn-complete`/`released`）、h2 `state=busy`、全表里 A 的绑定数恰为 1（单写者仍成立）。
- [ ] AC7 假形态承重：把宿主主键改成 `appSessionId`（`hostId := appSessionId`，即 1:1）⇒ 判据命令退出 **1**，红文案落在 (1) 的 `bindings` 读数与 (2) 的 `bindingsAfter=1`/「宿主仍在」读数上。实测退出码与红态文案逐字抄进完成记录，用后 `git checkout --` 还原。
- [ ] AC8 确定性与可重复：判据文件里没有真实等待（`grep -c "setTimeout\|await sleep\|node:timers" server/modules/session-hosts/tests/session-host-bindings.test.ts` → 0，打印该读数；唯一的时序控制是测试持有的 closeHost gate 与 manager 的 promise 结算），连续两次运行的关键读数行逐字相同（两行都打印），墙钟 `elapsed=<n>ms` 且 `< 60_000`。
- [ ] AC9 契约面与邻居不被改窄：`npm run typecheck`、`npm run lint` 退出 0；四条邻居判据文件仍退出 0（`session-host-default-wrap.test.ts` = AC-154、`session-host-lifecycle.test.ts` = AC-157、`session-hosts-routes.test.ts` = AC-156、`session-host-per-run-parity.test.ts` = AC-155；AC-155/AC-156 尚未落地时如实登记而不是谎报绿）；`git diff --name-only` 里没有 `server/modules/providers/list/**`、没有 `server/modules/websocket/**`。
- [ ] AC10 声明落在 facet 且承重：`grep -n "multiplexedHost" server/shared/interfaces.ts` 有输出；`grep -n "HostBindErrorCode\|HostBindResult" server/shared/types.ts` 有输出；`ls server/modules/session-hosts/{types,interfaces,utils}.ts` 全不存在（模块内不建这三类文件）；`grep -n "multiplexedHost" server/modules/providers/services/provider-capabilities.service.ts` **无**输出（能力矩阵镜像不在本条）。
- [ ] AC11 如实登记：完成记录写明（a）AC-154/AC-157 落地后 manager 与 driver facet 的实际形状、本条实际用的入口名（若与 Proposal 拟名不同）；（b）(1b) 里非多路复用 driver 的实际行为（拒绝 vs 另起宿主）；（c）假形态的实测退出码与红态文案；（d）两个解绑子例的 reason 实际取值与写新宿主的入口；（e）未实现：AC-154…AC-157、AC-159、AC-160、能力矩阵镜像、前端。

## DoD

判据在**落地后的树**上按原命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-bindings.test.ts`）重跑：退出码 0 且 `fail 0`。AC2 的 `hosts=1 bindings=2` 与 (1b) 的负控制读数、AC3 两个 reason 的 `bindingsBefore=2 bindingsAfter=1 bindingUnchanged=true closeHostCalls=0`、AC4 的 `unbindCalls=2 closeHostCalls=1 idempotentCloseHostCalls=1`、AC5 的三行拒绝/负控制读数、AC6 的 gate 读数与有序日志与 `superseded` 正控制、AC7 假形态的实测退出码与红态文案、AC8 的两次运行一致性与 `elapsed`，一并写进完成记录。`npm run typecheck` 与 `npm run lint` 退出 0。改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐；四个 runtime 与 `server/modules/websocket/**` 不在其中）。完成后 AC-158 在驱动器下一轮经 `goal_ac: AC-158` 独立复跑时由红翻绿 —— 且这次翻绿有分辨力：AC7「以 appSessionId 作宿主主键」的假形态必红（`bindings` 读数那条），AC4 的幂等控制保证「恰好一次」不是恒真，AC1 的 `multiplexedHost: false` 负控制保证多路复用声明不是装饰字段。

## Touches

- server/modules/session-hosts/session-host-manager.service.ts
- server/modules/session-hosts/index.ts
- server/modules/session-hosts/tests/session-host-bindings.test.ts (new)
- server/shared/types.ts
- server/shared/interfaces.ts
- tasks/gap-session-hosts-binding-multiplexing.md
