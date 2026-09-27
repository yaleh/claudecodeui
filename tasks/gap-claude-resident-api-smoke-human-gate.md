---
id: gap-claude-resident-api-smoke-human-gate
title: AC-170 人工关卡：API 面真模型冒烟（只走 HTTP/WS 脚本，不加 cloudcli 子命令）—— 创建常驻会话 → 连续 3 轮 →
  一个无人轮 → 关闭 → 重启后读到已随重启关闭 → 再次发送重新拉起；读数写进
  docs/proposals/claude-resident-sessions-smoke.md；「冒烟验收：通过」行只由人 yale 写，执行者不得代写
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
  - gap-claude-resident-server-restart
  - gap-lifecycle-mode-matrix-and-host-api
goal_ac: AC-170
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-170" tasks/*.md | wc -l` → **0**；`grep -rln "AC-170" tasks/*.md | wc -l` → **0** —— 全库零命中：连邻居任务的**非目标**段里都没点过 AC-170。物证侧：`ls scripts/resident-smoke*` → 无匹配；`docs/proposals/claude-resident-sessions-smoke.md` 不存在（`grep` 报 `No such file or directory`）；`grep -rn "resident-smoke" scripts/ tasks/ docs/ | wc -l` → **0**。⇒ AC-170 无认领者，本条不是重复。

**来源与判据物。** AC 逐字（`goals/AC-170-人工关卡-api-面真模型冒烟由人确认通过-之后才开始-ui.md` 的 `criterion:`）：`grep -q '^冒烟验收：通过' docs/proposals/claude-resident-sessions-smoke.md || { echo 'smoke record docs/proposals/claude-resident-sessions-smoke.md missing or not accepted by a human (need a line starting with 冒烟验收：通过)' >&2; exit 1; }`。红态基线（本轮**直跑**，读数不是推断）：该命令退出 **1**，stderr 逐字两行 —— `grep: docs/proposals/claude-resident-sessions-smoke.md: No such file or directory` 与 `smoke record docs/proposals/claude-resident-sessions-smoke.md missing or not accepted by a human (need a line starting with 冒烟验收：通过)`。

**这条是什么、不是什么。** 它是 GOAL-013 的**人工关卡**：在 UI 之前，用**真实模型**把 API 面（HTTP + WS，**不加 cloudcli 子命令**）的常驻会话从头走到尾，把**原始读数**写进一份记录文件，交人 yale 判定；人写下 `冒烟验收：通过` 之后，AC-171–175 的 UI 派工任务才允许开工（AC 逐字：「UI 相关 AC（AC-171 至 AC-175）的派工任务以本条对应的任务为前置」）。因此本条**不写产品代码**（常驻 driver 与 start/close API 由 AC-161/162/166/169 落地），只建一条**取数与取证的通道**：一个真模型冒烟脚本 + 它的护栏判据 + 记录文件。

**六段必须真的走完（AC 逐字的分段）：** 创建常驻会话 → 连续 3 轮 → 触发一个无人轮 → 关闭 → 重启服务后读到已随重启关闭 → 再次发送重新拉起。每段一条原始读数（宿主快照的 `lifecycle_mode`、同一 pid 与 `result` 计数、无人轮的 `source`/`seq`/触发类型、关闭原因、重启后的服务 pid 与原因、再次发送后的新 pid），写进记录文件对应小节。

**为什么必须真模型。** mock 端点那一半已由 AC-161/162/166/169 各自的判据覆盖；人工关卡要回答的是「**真模型**经过**真 HTTP/WS 面**、跨轮、跨无人轮、跨服务重启仍然成立」。所以脚本必须打真实 `/v1/messages`（用应用里已配置且可达的模型条目），并把本次费用/用量写进记录 —— proposal §「阶段 0」已声明实验与冒烟会真实调用模型、产生费用。

**机器能验的部分 vs 人证那一关。** 脚本与 `--check-record` 能机械验：六节齐全、每节有 `读数：` 与 `结论：`、读数非占位。但「通过」二字只有人能写：记录文件里以 `冒烟验收：通过` 开头的那一行**只能由人 yale 写入，执行者不得代写**（AC 逐字）。前若干条 AC 全绿而人证那条未勾时，本任务的正确终态是 **needs-human，不是 done** —— 与 `gap-claude-resident-phase0-experiments` 同一形态（它的人工关卡是 `E2/E3 基准确认：`，已由人写在 `docs/proposals/claude-resident-sessions-experiments.md:49`）。

<!-- dedup-ref --> 与在飞邻居的边界（关系边已写进顶层 `depends_on`，本段只作溯源）：本条**不重做**它们的工作面，只在它们落地后的树上取一条端到端读数。`gap-claude-resident-process-survival`（AC-161：同 pid 跨轮、关闭即 stdin EOF）、`gap-claude-resident-unattended-turn`（AC-162：无人轮建 run、可回放）、`gap-claude-resident-server-restart`（AC-166：重启后无残留、读到「已随重启关闭」、再发重新拉起）、`gap-lifecycle-mode-matrix-and-host-api`（AC-169：`lifecycle_mode` 列与 `POST /api/session-hosts/:sessionId/start|close`）。四条任一未 done，冒烟脚本就没有可打的 API 面 —— 脚本必须**点名拒绝**而不是谎报绿。

**非目标**：AC-161/162/166/169 的产品代码（driver、分派接线、`lifecycle_mode`、start/close 路由）；AC-163/164/165/167/168 的忙时输入 / 可寻址 / 空闲关闭 / 内存上限 / 权限拦截（各在自己的判据里取读数，不进这条冒烟的分段）；AC-171–175 的前端与 e2e；`cloudcli` 子命令；把冒烟挂进 CI 常驻（真模型有费用，只作一次性人证读数）。

## Plan

1. 读 AC-161/162/166/169 落地后的**实际形状**（宿主接口路径与字段、`chat.send` 的 WS 报文形状、无人轮的触发手段、`lifecycle_mode` 的读写面、`scripts/mint-token.mjs` 的用法），把冒烟脚本的接缝钉在真面上，不按 proposal 的规划文字猜。
2. 写 `scripts/resident-smoke.mjs`（新）：`--check-record <file>` 逐节校验记录（六节齐全、每节有 `读数：` 与 `结论：`，缺哪节点名哪节，exit 1/0）；主流程只用 **HTTP + WS** 打一个**真服务进程**（显式临时 `DATABASE_PATH` 并经 `/proc/<pid>/environ` 证明、`HOST=127.0.0.1`、端口用 `listen(0)` 探得且断言 `!= 3001`、日志走文件 fd、`detached:true` + 负 pid 杀进程组），**不重启 :3001**；六段各自把原始读数 `upsertSection()` 进记录文件；`main()` 按 realpath 守卫，被 `import` 时不执行（判据要 import 它的纯函数）。
3. 写护栏判据 `scripts/resident-smoke.test.mjs`（新）：未显式给临时 `DATABASE_PATH`（缺省 / 等于 shell 导出的真实库 / 不在临时根下）三条各自拒绝并 exit 1；受保护端口 3001 被拒；`--check-record` 对缺节与缺 `结论：` 的记录 exit 1 并点名、对六节齐全的记录 exit 0；`grep -c cloudcli scripts/resident-smoke.mjs` → 0。
4. 真跑一次冒烟（真模型），把六段读数、`claude --version`（本机现为 `2.1.283`，实施时以当时为准）与 SDK 版本、费用/用量写进 `docs/proposals/claude-resident-sessions-smoke.md`；**不写** `冒烟验收：通过` 那一行。
5. `--check-record` 绿、护栏判据绿、`npm run lint` 绿；写完成记录并置终态（人证未勾 ⇒ needs-human）。

## AC

- [x] AC1 记录文件六节齐全且机械可验：`node scripts/resident-smoke.mjs --check-record docs/proposals/claude-resident-sessions-smoke.md` 退出 **0**。六节逐字为 `创建常驻会话` / `连续三轮` / `无人轮` / `关闭` / `重启后已关闭` / `再次发送重新拉起`，每节都要有 `读数：` 与 `结论：`。红态基线本轮实测：`docs/proposals/claude-resident-sessions-smoke.md` 不存在（`grep` 报 `No such file or directory`），`--check-record` 应退出 1 并点名全部六节。
- [x] AC2 护栏判据绿：`node --test scripts/resident-smoke.test.mjs` 退出 **0**，至少覆盖 —— 未显式给临时 `DATABASE_PATH` / 它等于 shell 导出的真实库 / 它不在临时根下，三条各自拒绝且 CLI exit 1；端口 3001 被拒；`--check-record` 对缺节记录 exit 1 并点名缺的节、对缺 `结论：` 的节点名该节、对六节齐全记录 exit 0。
- [x] AC3 「只走 HTTP/WS、不加 cloudcli 子命令」是机械事实：`grep -c 'cloudcli' scripts/resident-smoke.mjs` → **0**，且驱动面只出现 `fetch(` / `new WebSocket`（打印 `grep -c -E "fetch\(|new WebSocket" scripts/resident-smoke.mjs` 与脚本实际发出的请求/帧清单）。**正控制**：同一 `cloudcli` grep 在 `scripts/resident-experiment.mjs` 上**非零** —— 该脚本确实 spawn 真 `claude` 二进制，证这条 grep 有分辨力、不是恒真。
- [x] AC4 六段的原始读数逐段落盘（不是转述），每段打印其证据行：`创建常驻会话` → 宿主快照出现且 `lifecycle_mode` 逐字为 `resident`；`连续三轮` → **同一 pid**、恰好 3 条 `result`（打印 `pid=<a> results=3`）；`无人轮` → 一条 `source=unattended` 的 run（打印 `seq` 与触发类型，并证明它可回放）；`关闭` → 进程退出、关闭原因逐字（打印 `closeReason=<…>`，`/proc/<a>` 消失）；`重启后已关闭` → **新**服务进程上读到该会话未运行且原因**非空**（打印 `server-old-pid` / `server-new-pid` 与原因值）；`再次发送重新拉起` → 新 pid 且 `!= <a>`（打印 `old-pid=<a> new-pid=<c>`）。**正控制**：`重启后已关闭` 的原因字段在同一读里对一个 per-run 会话为 `null`（保证该字段不是恒真）。
- [x] AC5 版本与成本写进记录（proposal §「风险与注意事项」：每份实验与冒烟记录写明 CLI 与 SDK 两者版本）：`docs/proposals/claude-resident-sessions-smoke.md` 里有 `claude --version` 行、SDK 版本行，以及本次真实模型的费用/用量行（逐字打印这三行的内容）。
- [x] AC6 不碰生产：每次起服务都打印 `tr '\0' '\n' </proc/<pid>/environ` 里临时 `DATABASE_PATH` 与 `HOST=127.0.0.1` 的**命中行**，端口 `!= 3001`；跑完 `pgrep -f` 与 `systemctl --user list-units` 无本冒烟残留（打印读数）；**:3001 全程未重启**（打印 :3001 的 pid 前后一致）。
- [ ] AC7 **人工关卡**——冒烟验收已由人确认：`grep -q '^冒烟验收：通过' docs/proposals/claude-resident-sessions-smoke.md` 退出 **0**。该行**只能由人 yale 写入，执行者不得代写**；执行者只写 `读数：` 与 `结论：` 行。**执行者不得勾这一条。**
- [x] AC8 契约面与边界：`npm run lint` 退出 0；改动只落在 Touches 列出的文件上（`git diff --stat` 与 Touches 逐条对齐）；脚本跨文件 import 只取 `.mjs` 同级相对路径，不引入新的构建面。

## DoD

- 冒烟**真实跑过**：**真服务进程**（临时 `DATABASE_PATH` 经 `/proc/<pid>/environ` 证明、`HOST=127.0.0.1`、端口 ≠ 3001、杀整个进程组）+ **真实模型**（不是 mock 端点），六段读数是脚本的原始输出（`lifecycle_mode`、pid、`result` 计数、`seq`、关闭原因、新 pid），不是转述；记录文件写明取数时间与 `claude --version` / SDK 版本。
- 六段每一段都**真的发生**（不是走捷径）：连续三轮是**同一** pid 且恰好 3 条 `result`；无人轮是 `source=unattended` 且可回放；关闭真的让进程退出并给出原因；重启真的换了**另一个**服务进程且读回「已随重启关闭」；再次发送真的拉起**新** pid。
- 走的是 **HTTP + WS 脚本**，全程没有 `cloudcli` 子命令参与（AC3 的机械读数），也没有前端/e2e 参与。
- 脚本对缺面拒绝而不谎报绿：AC-161/162/166/169 任一未落地时，脚本在处理到那一段时点名缺失并 exit 非 0，不写假的读数行。
- 临时实例的 `DATABASE_PATH` 经 `/proc/<pid>/environ` 核对并写进记录；:3001 未重启；结束后无残留进程与 scope（附 `systemctl --user list-units` 与 `pgrep` 读数）。
- **AC1–AC6 与 AC8 通过而 AC7（人工关卡）未勾时，本任务的正确终态是 `needs-human`，不是 `done`。** 记录文件里以 `冒烟验收：通过` 开头的那一行只由人 yale 写；执行者代写即为造假 —— 判据会因那一行翻绿，但它不是执行者的产物，且一旦代写，「冒烟」就失去了它作为人证的意义。

## Touches

- `scripts/resident-smoke.mjs` (new)（真模型 HTTP/WS 冒烟脚本 + `--check-record`）
- `scripts/resident-smoke.test.mjs` (new)（护栏判据）
- `docs/proposals/claude-resident-sessions-smoke.md` (new)（六段读数记录；`冒烟验收：通过` 行由人 yale 写）
- `tasks/gap-claude-resident-api-smoke-human-gate.md`（自触）