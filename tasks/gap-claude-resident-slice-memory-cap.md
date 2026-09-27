---
id: gap-claude-resident-slice-memory-cap
title: AC-167 常驻进程超出内存上限时只有它被杀 — 把 claude-session-scope 包装推广为 provider 中立并加共享
  slice（systemd-run --user --scope --slice=cloudcli-resident.slice -p
  MemoryMax=配置值 -p MemorySwapMax=0）：单进程上限与 slice 总上限都来自配置且可注入；注入小上限后命令行读到
  MemoryMax=注入值、MemorySwapMax=0、slice 名逐字；同 slice 下两子进程其一超限被 OOM（宿主快照
  closeReason=exited、closeDetail=oom），另一个与测试进程存活；结束后无残留 scope 且缺席读数带正对照；无
  systemd user manager 时打印原因并 exit 3；假形态（退化为直接 spawn、上限写死常量）必须红
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-session-cgroup-scope
goal_ac: AC-167
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-167" tasks/*.md | wc -l` → **0**；`grep -rln "AC-167" tasks/*.md | wc -l` → **0** —— 全库零命中，连邻居任务的「非目标」段都没有点名过 AC-167。机制侧同为零：`grep -rn -- "--slice" server/ --include=*.ts --include=*.js | wc -l` → **0**（今天全仓没有任何 `--slice`，现有包装只发 `MemoryMax` 与 `MemorySwapMax=0`）；`grep -rln "cloudcli-resident" tasks/*.md | wc -l` → **0**；`systemctl --user list-units 'cloudcli-resident*' --no-legend --plain | wc -l` → **0**（本机没有这个 slice）。⇒ 本条要建的机制（一个共享 slice + 来自配置的 slice 总上限 + OOM 只收超限者）在库内与机器上都不存在，不是重复。

**来源与判据物。** 判据逐字取自 `goals/AC-167-常驻进程超出内存上限时只有它被杀-服务与同-slice-的其他常驻进程不受影响.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/process-containment.test.ts`（命令逐字含文件路径，**不用 glob**）。红态基线（本轮**直跑**，不是推断）：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/session-hosts/tests/process-containment.test.ts'`。

**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑已存在的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-host-lifecycle.test.ts` → 退出 **0**，读数 `tests 6 / pass 6 / fail 0 / duration_ms 317.296819`，墙钟约 0.3s ⇒ 判据今天退 1 的唯一原因是判据文件不存在。

**本机有可用的 systemd user manager，判据必须真跑。** 真实探测（不是 `is-system-running` 的读数）：`systemd-run --user --scope --quiet -p MemoryMax=64M -p MemorySwapMax=0 true` → 退出 **0**。⚠️ `systemctl --user is-system-running` 报 `degraded`，那**不是**本条要用的可用性判据 —— 要问的是「能不能真的在一个带上限的 scope 里跑起来」，「没有 systemd user manager 时 exit 3」对应的也必须是**真实执行**的探测（`probeSystemdUserScope()` 就是这么做的，见下）。

**现状（本轮读的码）—— 包装已有，缺的是 slice**

- `server/modules/providers/services/claude-session-scope.service.ts`（`gap-claude-session-cgroup-scope` 落地，status: done）已导出 `createClaudeSessionScopeSpawn`、`probeSystemdUserScope`、`listClaudeSessionScopeUnits`、`stopClaudeSessionScopes`、`sweepOrphanClaudeSessionScopes`、`buildClaudeSessionScopeUnitName`、`parseClaudeSessionScopeOwnerPid`、`resolveClaudeSessionMemoryMax`，全部经 `server/modules/providers/index.ts` barrel 导出（`:70-85`）。
- 它生成的 argv 只有 `--user --scope --quiet --unit=claudecodeui-session-<pid>-<suffix> -p MemoryMax=<cap> -p MemorySwapMax=0 -- <cmd> <args>`（`buildClaudeSessionScopeArgv`）：**没有 `--slice`**，也**没有 slice 级总上限**；单进程上限来自 `CLAUDE_SESSION_MEMORY_MAX`，默认 `8G`。
- OOM 归因已有骨架：`journalReportsOomKill` 读 `journalctl --user -u <unit>.scope` 找 `OOM killer`，`attributeSessionScopeOom` 命中后打一行点名上限的 `console.error`。**但它只打日志** —— 没有把它落成宿主的 `exited`/`oom` 读数。
- 宿主侧词汇已经就位：`server/shared/types.ts:1808` 的 `HostCloseDetail = 'oom' | 'signal' | 'error' | 'forced'`，`session-host-manager.service.ts:543 reportExited(hostId, detail)` 会 `closeHost(hostId, 'exited', detail)`。**今天没有任何调用方用 `'oom'`**（`claude-per-run-host-driver.provider.ts:455` 逐字写着「`oom`/`signal` are kernel facts this layer cannot see」）⇒ 「被内存上限杀死 ⇒ 宿主快照 closeReason=exited、closeDetail=oom」这条链缺最后一跳。

**要建的东西（范围是 AC-167 的最小充分集）**

1. **把 `claude-session-scope` 服务推广为 provider 中立，并加 slice 与 slice 总上限**（AC 逐字要求「复用 … 不另起一套」）：
   - 包装 argv 增 `--slice=cloudcli-resident.slice`（slice 名**逐字钉死**，取自 AC 与 proposal §11 `:385`），保留 `-p MemoryMax=<单进程上限> -p MemorySwapMax=0`；
   - **单进程上限与 slice 总上限都来自配置、并且可被测试注入**（今天的 `ClaudeSessionScopeSpawnDeps` 已有 `memoryMax` 注入面，本条把 slice 名与 slice 总上限做成同样的注入面；**生产默认数值不在本条** —— E7 的 24 小时浸泡未取到，AC 逐字说明「只钉机制」）；
   - slice 总上限要**真的落到 slice 上**（`--slice=` 起进程 + 对 slice 设 `MemoryMax`，例如 `systemctl --user set-property <slice> MemoryMax=<配置值>` 或等价机制，实施者择一并写明），使内核只在常驻进程之间选受害者；
   - 「provider 中立」＝命名与导出不再写死 claude（proposal §11 `:385` 建议 `cloudcli-host-<短ID>` 的 `--unit` 前缀），**但停/扫生命周期语义不变**（`stopClaudeSessionScopes` / `sweepOrphanClaudeSessionScopes` 仍然只动本 server 拥有的、以及属主已死的 scope），且 claude 侧接线要么随名改、要么以旧名 re-export，既有 `server/modules/providers/tests/claude-session-scope.test.ts` 的对外契约不得静默破坏。
2. **把 OOM 归因落成宿主读数**：被上限杀死的进程，其宿主快照必须是 `closeReason='exited'` 且 `closeDetail='oom'`（经 `reportExited(hostId,'oom')`），不再只是 `console.error`。⚠️ `'oom'` 只能由**内核事实**给出（journal 命中或 SIGKILL 信号），**不得**由「退出码非零」冒充 —— 判据要能区分「超限被杀」与「自己崩了」。
3. **判据文件** `server/modules/session-hosts/tests/process-containment.test.ts`（新，路径逐字来自 AC 的 `criterion:`）。做法照 `server/modules/providers/tests/claude-session-scope.test.ts` 的**真机**用例：真的 `systemd-run --user --scope`、真的吃内存子进程、`waitUntil` 轮询而不是固定 `sleep`；真机用例**先断言探测为真**，探测为假则该路径 `process.exit(3)`（未评估）而不是 skip。判据**不依赖真实 claude 二进制** —— AC 逐字说的是「子进程」，所以通用吃内存/睡眠子进程即可，这也正是它 provider 中立的读数。

**判据必须自带的四条读数（AC 逐字）**

- **(1) 包装命令行读数**：注入一个测试用小单进程上限并起包装 ⇒ 命令行（或对应 systemd 单元属性）读到的 `MemoryMax` **等于注入的配置值**、`MemorySwapMax=0`、slice 名是 `cloudcli-resident.slice`；**slice 总上限同样来自配置**（注入一个值并读回）。
- **(2) OOM 只收超限者**：同一 slice 下两个子进程，其一分配内存超过该上限 ⇒ **它**被 OOM 杀死，宿主快照 `closeReason='exited'`、`closeDetail='oom'`。
- **(3) 无关者存活**：另一个子进程与**测试进程本身**都存活（AC 逐字把「不殃及测试进程」写进来）。
- **(4) 无残留 + 正对照**：结束后无残留 scope；**缺席读数必须带正对照** —— 在 scope 存在的时刻探针/列读必须**读到它**，不允许以「固定 sleep 后读到空」当证据。

**未评估必须显式**：没有 systemd user manager 时打印原因并 **`process.exit(3)`**（未评估），**不得读绿**；本机探测退 0，所以本机必须**真跑**（既非 skip 也非 3）。

**两臂假形态（绿 = 判据有洞，必须先补判据再继续）**

- (a) 包装退化为**直接 `spawn`**（不套 `systemd-run`）⇒ 超限进程**不被杀**或**殃及测试进程** ⇒ 读数 **(2)(3) 必须红**。
- (b) 上限**写死为常量**而不读配置 ⇒ 读数 **(1) 必须红**。

**约束（不要碰的红线）**

- 现有 `server/modules/providers/tests/claude-session-scope.test.ts` 的真机用例与降级用例是上一代判据入口，**不得静默改断言**；推广命名以「旧名 re-export / 契约不变 + 该文件仍退 0」为准。
- 后端代码遵循 `AGENTS.md` 要求：`.agents/skills/backend-module-standards/SKILL.md` 的模块与 barrel 规范（本条的改动全在 `server/`）。
- 跨模块只经 barrel（本仓 boundaries lint）：判据在 `server/modules/session-hosts/tests/`，import 走 `@/modules/providers/index.js` / `@/modules/session-hosts/index.js` / `@/shared/…js`。
- AC 的「命令逐字含文件路径，不用 glob」约束的是**判据命令**：本条判据入口与 DoD 里的命令都写**字面路径**，不写 glob。

## Plan

1. **服务推广 + slice（先不落宿主读数）**：给包装注入面加 slice 名与 slice 总上限，argv 增 `--slice=cloudcli-resident.slice`，并把 slice 总上限真正设到 slice 上。可独立验证：注入值 ⇒ argv/属性读回注入值；slice 名逐字；既有 `claude-session-scope.test.ts` 仍退 0。
2. **判据骨架（(1)(3)(4) 先跑）**：真机起包装、读命令行读数、起两个子进程、在 scope 存在时用同一读法做**正对照**、收尾读无残留；无 systemd user manager 时 `process.exit(3)` + 一行原因。
3. **OOM 归因落宿主**：把 journal/信号的 `oom` 事实经 `reportExited(hostId,'oom')` 落成 `closeReason='exited'` + `closeDetail='oom'`；非 OOM 的异常退出仍走 `error`/`signal`。
4. **补 (2) 与两臂假形态**：吃内存臂读到「只有它被杀 + 宿主 exited/oom + 另一个和测试进程存活」；把假形态 (a) 直接 spawn、(b) 常量上限各自打红。
5. **收尾**：`npm run typecheck` / `npm run lint` 退 0；无残留 scope；补文档。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/process-containment.test.ts` 在交付树上退出 **0**；同一命令在 develop 上退出 **1**，stdout 逐字 `Could not find 'server/modules/session-hosts/tests/process-containment.test.ts'`。
- [ ] 判据注入一个测试用小单进程上限并起包装 ⇒ 包装命令行读到的 `MemoryMax` **等于注入的配置值**、`MemorySwapMax=0`、`--slice=cloudcli-resident.slice` 逐字出现；**slice 总上限同样来自配置**（注入并读回该值）。
- [ ] 同一 slice 下两个子进程，其一分配内存超过单进程上限 ⇒ **它**被 OOM 杀死，且其**宿主快照**为 `closeReason='exited'`、`closeDetail='oom'`。
- [ ] 另一个子进程与**测试进程本身**在 (2) 之后都**存活**（`/proc/<pid>` 仍在 / `process.kill(pid,0)` 不抛）。
- [ ] 结束后 `listClaudeSessionScopeUnits()` 为空（无残留）；**缺席读数带正对照**：在 scope 存在时该读法必须**读到它**（同一探针先非空后空，不以固定 sleep 后的空读数当证据）。
- [ ] 判据在**没有 usable systemd user manager** 的路径上打印原因并 **`process.exit(3)`**（未评估），**不得退 0**；本机探测退 0，故本机必须真跑（既非 skip 也非 3）。
- [ ] 假形态 (a)：包装退化为直接 `spawn` ⇒ 读数 (2)(3) **必须红**（超限进程不被杀，或殃及测试进程）。
- [ ] 假形态 (b)：上限写死为常量而不读配置 ⇒ 读数 (1) **必须红**。
- [ ] 既有 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-scope.test.ts` 退出 0 且断言不改（推广命名不得静默破坏既有契约）。
- [ ] `npm run typecheck` 与 `npm run lint` 退出码均为 0（含 boundaries：判据跨模块只经 barrel）。

## DoD

真实落地判据，不是「有一个钩子」：在交付的树上**真的**跑一次 `npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/process-containment.test.ts`，读到 (1) 注入值在命令行/slice 上逐字出现、(2) 真有一个吃内存子进程被内核在自己的 scope 里收走且宿主读数 `exited`/`oom`、(3) 兄弟子进程与测试进程都还在、(4) 收尾 `listClaudeSessionScopeUnits()` 为空而该读法在 scope 存在时读到过它；并把关键读数（注入值、读回的 `MemoryMax`、slice 名、被杀 unit、宿主 closeReason/closeDetail、兄弟 pid、收尾空读 + 正对照）写进 Evidence。两臂假形态各自把对应读数打红（绿 = 判据有洞，先补判据再继续）。**生产默认数值不在本条**（E7 的 24 小时浸泡未取到），本条只钉机制与配置可注入。真实落地后，`docs/operations/process-isolation-and-memory-caps.md` 增补常驻 slice 一节（含「上限来自配置」「OOM 只收受害者」「无 systemd 时退化」）。

## Touches

- `server/modules/providers/services/claude-session-scope.service.ts`（推广为 provider 中立 + `--slice=cloudcli-resident.slice` + slice 总上限，两者配置可注入）
- `server/modules/providers/index.ts`（barrel：新增/改名的导出收口）
- `server/modules/providers/list/claude/claude-runtime.provider.js`（接线随配置面/命名调整；纯接线，不堆逻辑）
- `server/modules/session-hosts/session-host-manager.service.ts`（OOM 事实经 `reportExited(hostId,'oom')` 落成 `exited`/`oom` 读数；若入口已足则只加调用点）
- `server/modules/session-hosts/tests/process-containment.test.ts`（新：判据）
- `server/modules/providers/tests/claude-session-scope.test.ts`（仅当推广命名触及旧契约时同步；断言语义不变）
- `docs/operations/process-isolation-and-memory-caps.md`（常驻 slice 一节）
- `tasks/gap-claude-resident-slice-memory-cap.md`（自触）
