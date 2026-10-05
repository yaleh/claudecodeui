---
id: gap-ac276-mcp-resident-smoke-record
title: AC-276 常驻专有能力冒烟记录齐全：scripts/mcp-smoke.mjs 追加 --check-resident-record +
  docs/proposals/cloudcli-mcp-resident-smoke.md 八节逐节非空；缺节必红、撤回节 pid 前后不同必红；不点亮
  AC-277
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac249-session-send-immediate-runid
  - gap-ac250-session-create-interrupt-lifecycle
  - gap-ac256-mcp-nested-smoke-record
  - gap-ac271-mcp-session-cancel-queued
  - gap-ac272-mcp-session-reconfigure
  - gap-ac273-mcp-session-background
  - gap-ac274-mcp-approvals
goal_ac: AC-276
---
## Proposal

**来源与判据物。** AC-276（`goals/AC-276-常驻专有能力冒烟的记录齐全-独立实例上经-mcp-对真实常驻会话做排队-撤回-重配置-后台任务与审批-每节有原始读数.md` 的 `criterion:`）逐字：

```
for f in scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-resident-smoke.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md
```

`expect` 逐字要点：做法照 GOAL-020 的嵌套冒烟（AC-256）——独立实例、真实 Claude CLI、终端 Claude Code 经 PAT 连接。记录逐节齐全，每节有「读数：」与「结论：」，八节为：环境与版本；常驻会话启动与 pid；忙时发送得到 `queuedMessageUuid`；撤回得到 `cancelled` 且 pid 不变；`session_reconfigure` 下一轮生效；`session_background` 列出与停止；审批（在非 bypass 权限模式下由一个需要权限的工具触发，经 `approvals_list` 看到、`approval_answer` 解除）；收尾残留与生产 3001 监听 pid 不变。`--check-resident-record` 逐节检查并点名缺哪节。本判据只证明读数齐全，验收结论由 AC-277 人工关卡给出。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 删掉任一节 ⇒ 必须红并点名；(ii) 撤回一节里 pid 前后不同 ⇒ 必须红。

**红态基线（本轮实测，读数不是推断）。** `ls scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-resident-smoke.md` 两个都不存在；判据的存在性闸以退出码 **1** 逐字输出 `缺判据文件：scripts/mcp-smoke.mjs`（存在性闸按 `for` 顺序，第一个缺失即停）。⇒ 本条当前必红，且红只因缺文件。

**这条是什么、不是什么。** 它是 GOAL-022 常驻专有能力的嵌套冒烟**取数与取证通道**：不写产品代码（MCP 工具由 AC-271–AC-274 落地），只在 AC-256 已交付的 `scripts/mcp-smoke.mjs` 上**追加** `--check-resident-record` 模式 + 一个把八段真跑一遍、把**原始读数**落盘的真记录，交人 yale 判定（判定行由 AC-277 收）。它**不**重复 AC-256 的 `--check-record`（那是 GOAL-020 八节的机械检查，节集合不同、记录文件不同）。

**八节与机械检查（本任务定义）。** `RESIDENT_SECTION_TITLES` 八节逐字：`环境与版本` / `常驻会话启动与 pid` / `忙时发送` / `撤回与 pid 不变` / `重配置下一轮生效` / `后台任务列出与停止` / `审批` / `收尾残留与生产监听 pid`。

`--check-resident-record` 的三件机械检查（本任务自己定义、并被自己的单测覆盖）：(a) 八节逐节要求非空 `读数：` 与 `结论：` 两行，缺整节点名该节、缺行点名该节缺哪行；(b) 第 4 节 `撤回与 pid 不变` 的 `读数：` 行必须含 `pid-before=<n>` 与 `pid-after=<n>` 且二者相等，解析不到或不等即红并点名（这正是假形态 (ii)）；(c) 文件不存在时把八节点名全缺。

**取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令；恢复后重跑回绿）：** (i) 删掉记录里任一节（例如 `审批`）⇒ `--check-resident-record` 必须红并点名该节；(ii) 把第 4 节的 `pid-after=` 改成与 `pid-before=` 不同的值 ⇒ 必须红并点名 pid 不等。

**两个必须钉住的边界。** 其一，**不得点亮下一条判据**：AC-277 的判据是 `grep -q '^常驻专有能力验收：通过' docs/proposals/cloudcli-mcp-resident-smoke.md`，因此记录文件表头、八节正文与脚本输出里都不得出现以 `常驻专有能力验收：通过` 开头的一行——本任务的记录只写「读数：」与「结论：」，人证行由人 yale 在 AC-277 写。其二，**不重写 `--check-record`**：`--check-resident-record` 与 `--check-record` 并存，两个节集合常量分开，不改 AC-256 的 `--check-record` 行为与它的记录文件 `docs/proposals/cloudcli-mcp-smoke.md`。

机械前置：本条要在**已落地的 MCP 网关与常驻工具**上取读数——先要 AC-256 交付 `scripts/mcp-smoke.mjs` 骨架与「临时实例 + PAT 播种 + `claude mcp add`」驱动面；「常驻会话启动」要 AC-250 的 `session_create`；「忙时发送」要 AC-249 的 `session_send`；「撤回」要 AC-271 的 `session_cancel_queued`；「重配置」要 AC-272 的 `session_reconfigure`；「后台任务」要 AC-273 的 `session_background`；「审批」要 AC-274 的 `approvals_list` / `approval_answer`。任一未落地时脚本必须**点名拒绝**（缺哪件说哪件），不写假的读数行。

<!-- dedup-ref --> 机制上去重已核对：`grep -rl "goal_ac: AC-276" tasks/` 为空——本仓库无任何任务带 `goal_ac: AC-276`；`grep -rln "AC-276" tasks/` 也为空（无人认领、无人越界声明）。相关但不同：AC-256（`gap-ac256-mcp-nested-smoke-record`，GOAL-020）交付 `scripts/mcp-smoke.mjs` 与 `--check-record`，记录 `docs/proposals/cloudcli-mcp-smoke.md`；本条在**同一脚本**上追加 `--check-resident-record`，记录到**不同文件** `docs/proposals/cloudcli-mcp-resident-smoke.md`，节集合是常驻专有能力（启动/忙发/撤回/重配置/后台/审批/收尾），与 AC-256 的「列出会话/发消息/查进度/中止」不同。AC-277（人工关卡，判据是记录文件里的人证行）是不同机制。先例 `scripts/resident-smoke.mjs`（AC-170）是被照抄的**骨架**而非认领者：它驱动的是常驻会话的 HTTP/WS 面，判据文件与记录都不同。相关但非本任务前置（仅溯源）：AC-241（PAT 认证）与 AC-245（只读工具）由 AC-256 传递依赖；AC-275（真实 claude 二进制经控制服务撤回）是本条「真实常驻会话撤回」的驱动层对照，不是本条要交付或复用的产物。

**非目标**：AC-256 的 `--check-record` 与其记录；AC-271–AC-275 的产品代码（网关/工具/审批）；AC-277 的**人证行**（只能由人 yale 写，执行者不得代写）；把冒烟挂进 CI 常驻（真模型有费用，只作一次性人证读数）；对生产 3001 做任何事（不连接、不启用、不重启）。

## Plan

1. 读 AC-256 落地后的 `scripts/mcp-smoke.mjs` **实际形状**：`SECTION_TITLES` / `extractSection` / `upsertSection` / `checkRecordText` / `parsePort` / `main(argv)` / realpath 守卫，以及 `main` 里按 `argv` 分派 `--check-record` 的位置；护栏（临时 `DATABASE_PATH`、`listen(0)` 端口、`detached` 整组杀）与「真服务实例 + PAT 播种 + `claude mcp add` + 自然语言驱动 + 记录写入」的复用点。把 `--check-resident-record` 的接缝钉在真面上，不按 AC-256 的规划文字猜；缺面时**点名拒绝**。
2. 读 AC-271–AC-275 落地后的**实际工具形状**：`session_cancel_queued` 返回 `queuedMessageUuid` 的来源与 `cancelled`/`already-started`/`unknown` 的说法；`session_reconfigure` 的模型/强度/权限模式「下一轮生效」读数面；`session_background` 的 `stopTaskId` 列出与停止读数面；`approvals_list` / `approval_answer` 的待审批读法与回答语义；常驻会话 pid 的读取面（宿主快照 `pid`/`running`）。缺面时**点名拒绝**。
3. 在 `scripts/mcp-smoke.mjs` 追加：`RESIDENT_SECTION_TITLES`（八节逐字）；`parseResidentSection` / `parseCancelPids` / `checkResidentRecordText` / `checkResidentRecordFile`；`main` 增加 `--check-resident-record <file>` 分派（纯读，不起实例）。机械检查三件照 Proposal 的 (a)(b)(c)。保持 `--check-record` 行为不变。
4. 追加真跑：在 AC-256 的临时实例/`claude mcp add` 驱动面上，用真 `claude` CLI + 自然语言驱动走完八段——常驻会话启动（记 `pid=`）、忙时发送（记 `queuedMessageUuid=`）、撤回（记 `pid-before=` 与 `pid-after=`，两者相等）、重配置（记下一轮生效读数）、后台任务（列出与停止）、审批（非 bypass 模式 + 需权限工具触发，`approvals_list` 看到、`approval_answer` 解除）、收尾残留（进程/目录/scope 命中数 0，`:3001` 起终点监听 pid 逐字相同）。八段各自 `upsertResidentSection()` 落盘 `读数：` / `结论：`；**不写**任何以 `常驻专有能力验收：通过` 开头的行。
5. 写单测 `scripts/mcp-smoke-resident.test.mjs`（新）：对 `checkResidentRecordText` 覆盖（a）缺整节点名该节、（b）缺 `读数：`/`结论：` 行点名、（c）读数为空点红、（d）撤回节 `pid-after` ≠ `pid-before` 点红（假形态 (ii) 的机械版）、（e）解析不到 pid 点红、（f）八节齐全 exit 0、（g）文件不存在八节全缺。承重腿是「缺一节就红」与「撤回节 pid 不等就红」——先写红测再补实现。子进程断言 stderr 时直接读 `spawnSync` 返回的 `result.stderr`（内存 `node-test-stderr-does-not-reach-the-caller`）。
6. `node --test scripts/mcp-smoke-resident.test.mjs` 与 `--check-resident-record` 绿；对新/改文件跑 `npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke-resident.test.mjs` 退出 0；**不**要求 `npm run typecheck` 退出 0（`scripts/tsconfig.json` 的 `allowJs + checkJs` 在 `scripts/*.mjs` 上的红是 develop 侧既有）；写完成记录（含每条读数与两次假形态的红）。

## AC

- [ ] AC1 红态基线逐字记录：改动前运行 AC-276 判据命令，存在性闸退出码 **1** 并逐字输出 `缺判据文件：scripts/mcp-smoke.mjs`（写下完整命令与完整输出）。
- [ ] AC2 判据绿：逐字命令 `for f in scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-resident-smoke.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md` 退出 **0**；写下 stdout 逐字。
- [ ] AC3 记录八节齐全：`node scripts/mcp-smoke.mjs --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md` 退出 **0**。八节逐字为 `环境与版本` / `常驻会话启动与 pid` / `忙时发送` / `撤回与 pid 不变` / `重配置下一轮生效` / `后台任务列出与停止` / `审批` / `收尾残留与生产监听 pid`，每节都要有非空 `读数：` 与 `结论：`。红态基线本轮实测：两个判据文件都不存在，判据命令应退出 1 并逐字输出 `缺判据文件：scripts/mcp-smoke.mjs`。
- [ ] AC4 取假形态 (i) 缺一节必红并点名：删掉记录里任一节（例如 `审批`）后 `--check-resident-record` 退出 **非 0**，stderr 逐字点名该节缺。登记变异 diff、逐字失败行、恢复命令；恢复后重跑回绿。
- [ ] AC5 取假形态 (ii) 撤回节 pid 前后不同必红：把 `撤回与 pid 不变` 一节的 `pid-after=` 改成与 `pid-before=` 不同的值后 `--check-resident-record` 退出 **非 0** 并点名 pid 不等。登记变异 diff、逐字失败行、恢复命令；恢复后重跑回绿。
- [ ] AC6 单测覆盖「缺一节就红」与「撤回节 pid 不等就红」：`node --test scripts/mcp-smoke-resident.test.mjs` 退出 **0**；至少覆盖（a）缺整节点名该节、（b）缺 `读数：`/`结论：` 行点名、（c）读数为空点红、（d）撤回节 `pid-after` ≠ `pid-before` 点红、（e）解析不到 pid 点红、（f）八节齐全 exit 0、（g）文件不存在八节全缺。逐条写出测试名。
- [ ] AC7 常驻冒烟**真跑过**、八段读数是原始读数：真服务实例（临时 `DATABASE_PATH` 经 `/proc/<pid>/environ` 命中行证明、`HOST=127.0.0.1`、端口 `listen(0)` 探得且 ≠ 3001、`detached` 整组杀）+ 真 `claude` CLI（`claude mcp add --transport http` 命令逐字 + 自然语言驱动）+ 临时项目。逐段打印证据行：常驻会话 pid；忙时发送返回 `queuedMessageUuid`（非空、逐字）；撤回答复逐字含 `cancelled` 且 `pid-before == pid-after`；`session_reconfigure` 后**下一轮**运行取到新值（同一 pid，逐字打印新旧值）；`session_background` 列出当前后台任务、带 `stopTaskId` 停止并读回停止结果；审批在**非 bypass** 权限模式下由需权限工具触发，`approvals_list` 逐字看到该待审批、`approval_answer` 解除（读回消失/已答）。
- [ ] AC8 收尾残留读数为 0 且不碰生产：跑完打印临时根上 `pgrep -af` / `/proc` environ / `systemctl --user list-units --type=scope` 三条命中数均为 **0**；`:3001` 的监听 pid 与 systemd MainPID 的**终点读数与起点读数逐字相同**（打印两行）；全程未连接 / 未启用 / 未重启 3001。
- [ ] AC9 不点亮 AC-277：`grep -c '^常驻专有能力验收：通过' docs/proposals/cloudcli-mcp-resident-smoke.md` → **0** 且 `grep -c '常驻专有能力验收：通过' scripts/mcp-smoke.mjs` → **0**（记录模板与脚本输出都不得出现以该字样开头的行）。
- [ ] AC10 契约面与边界：`npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke-resident.test.mjs` 退出 **0**；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；证明产品代码一行未改（网关 / 工具 / 审批 / AC-256 的 `--check-record` 与它的记录均不在本 diff）。

## DoD

- 判据命令在**网关照常工作**的树上退出 0：`node scripts/mcp-smoke.mjs --check-resident-record docs/proposals/cloudcli-mcp-resident-smoke.md`。
- 记录文件八节**逐节**有非空 `读数：` 与 `结论：`；读数来自**真跑**（真服务进程 + 真 Claude CLI + 临时项目 + 终端 Claude Code 经 PAT），不是转述或模板。
- 常驻专有能力是**真的被操作过**：忙时发送真的拿到 `queuedMessageUuid`；撤回真的报 `cancelled` 且 `pid-before == pid-after`；`session_reconfigure` 真的在**下一轮**生效；`session_background` 真的列出并停止；审批真的在非 bypass 模式下被 `approvals_list` 看到并被 `approval_answer` 解除。
- 隔离是机械读数：临时 `DATABASE_PATH` 经 `/proc/<pid>/environ` 证明、`HOST=127.0.0.1`、端口 ≠ 3001；收尾后进程 / 目录 / scope 命中均为 0；`:3001` 起点与终点监听 pid 相同。
- 两次取假形态都先红后恢复；变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- AC-277 的人证行**没被点亮**：记录与脚本里都没有以 `常驻专有能力验收：通过` 开头的行；本任务的正确终态是 `done`（读数齐全），GOAL-022 的验收结论由人 yale 在 AC-277 给出。
- 只动 `## Touches` 列出的文件；产品代码一行不改（含不改 AC-256 的 `--check-record` 与其记录）。

## Touches

- scripts/mcp-smoke.mjs（在 AC-256 交付的脚本上追加 `--check-resident-record` 与 `RESIDENT_SECTION_TITLES`）
- scripts/mcp-smoke-resident.test.mjs (new)（resident 记录检查的护栏单测，含「缺一节就红」与「撤回节 pid 不等就红」）
- docs/proposals/cloudcli-mcp-resident-smoke.md (new)（八段读数记录；人证行由人 yale 在 AC-277 写）
- tasks/gap-ac276-mcp-resident-smoke-record.md（自触）

## Notes

- `--check-resident-record` 的节标题按整行相等比对（不用 `\b`——中文没有词边界），沿用 `resident-smoke.mjs` 的 `extractSection` 写法；本任务八节无前缀互撞。
- **绝不碰生产 3001**：不连接、不启用 `MCP_ENABLED`、不重启。生产启用 MCP 是人在会话外执行的单独步骤（SPEC §456），不属于任何判据。
- 撤回节的判据物是「`pid-before` 与 `pid-after` 相等」——这正是假形态 (ii)。记录里必须**显式**写出这两个字段（`pid-before=<n> pid-after=<n>`），否则解析不到也要红（假形态 (ii) 的负控制）。
- 记录文件是 AC-277 的判据物但**不是**本任务写的验收行：`--check-resident-record` 只读它，脚本输出里也**不得**出现以 `常驻专有能力验收：通过` 开头的行。
- 新增 `scripts/*.mjs` 会让 `scripts/tsconfig.json`（`allowJs + checkJs`）多报类型错——这是 develop 侧既有的红（`resident-smoke.mjs` 63 个），本条不修它，也不把 `npm run typecheck` 退出 0 写进 AC；只要求新/改文件的 `oxlint` 绿。
- `node --test` 的 stderr 不回传给调用方（内存 `node-test-stderr-does-not-reach-the-caller`）：单测里若 spawn 子进程跑 CLI 并断言 stderr，直接读 `spawnSync` 返回的 `result.stderr` 字段，不靠透传。
- 新增测试文件已在 `## Touches` 列出（内存 `quay-boundaries-lint-blocks-new-test-files`）；`.mjs` 测试可能不被 scoped 门正则覆盖（内存 `scoped-gate-regex-excludes-mjs-tests`），故 AC6 的真跑靠自己 `node --test` 证明，不假设门会跑它。
