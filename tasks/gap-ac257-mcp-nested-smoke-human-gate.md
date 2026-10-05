---
id: gap-ac257-mcp-nested-smoke-human-gate
title: AC-257 人工关卡：嵌套冒烟记录送人 yale 验收——复核 AC-256 八节齐全与反自点亮，worker 只写读数与结论，停在
  needs-human 等人写入「嵌套冒烟验收：通过」
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac256-mcp-nested-smoke-record
goal_ac: AC-257
---
## Proposal

**交付物：AC-257（GOAL-020 的人工关卡）的送审与机械前置复核。** 本任务不实现 MCP 网关/工具（由 AC-239–AC-253 落地），不修改记录 `docs/proposals/cloudcli-mcp-smoke.md`，也不写 AC-257 的验收行。它只做三件事：复核 AC-256 的记录已齐全；证明 AC-257 判据此刻为红只因缺人证行；把记录送人 yale 裁定。**验收行由人 yale 写入；worker 不代写这一行。**

**为什么需要这条任务（缺口）。** GOAL-020 的退出条件 11 由两条 AC 组成：AC-256 证明嵌套冒烟八段读数齐全，AC-257 是人工关卡——记录文件里必须出现一行以「嵌套冒烟验收：通过」开头、由人 yale 写入的验收行。判据逐字：`grep -q '^嵌套冒烟验收：通过' docs/proposals/cloudcli-mcp-smoke.md || { echo '缺人工验收行：…' >&2; exit 1; }`。驱动侧 `grep -rl "goal_ac: AC-257" tasks/` 为空——无任何任务（任何状态）认领 AC-257，故报为真缺口并立案本条。

**红态基线（本轮实测，读数不是推断）。** 记录文件 `docs/proposals/cloudcli-mcp-smoke.md` 尚不存在；运行 AC-257 判据得到退出码 **1**，stderr 逐字含 `缺人工验收行：`（并含 grep 对缺失文件的报错）。AC-256 落地后文件存在，判据仍红——因为人证行仍未写入。**这条红不能被执行者的任何动作消掉：它读的是人的写入。**

**这条是什么、不是什么。** 它是 AC-257 的送审任务：worker 复核前置（AC-256 判据绿）、复核记录八节齐全、做反自点亮负控制与正控制，然后把「人需要做的唯一一个动作」摆到人面前，停在 `needs-human`。它不是实现任务，也不是验收结论本身——GOAL-020 的达成结论只能由人 yale 的写入给出。

<!-- dedup-ref --> 机制上去重已核对：`grep -rl "goal_ac: AC-257" tasks/` 为空——本仓库无任何任务带 `goal_ac: AC-257`；`grep -rln "AC-257" tasks/` 只命中 AC-239–AC-256 各份的边界段（各自声明「验收结论由人工关卡 AC-257 给出」）。AC-256（记录齐全）是不同机制：它证明读数齐全，本条把记录送人裁定；两条缺一不可。先例 `gap-voice-asr-provider-seam-adr` 的 AC9（`grep -c '^status: accepted'`，不加 `（待外部）` 注解、由人裁定后才勾）是人类关卡在本仓库的既有形态，本条照抄其形状。机械前置（以顶层 `depends_on` 声明，本段只作溯源）：本条要在 AC-256 已落地的记录上取读数。

**非目标**：AC-239–AC-256 的产品代码；AC-254/255 的设置页与 i18n；AC-257 的人证行（由人 yale 写入）；把冒烟挂进 CI；对生产 3001 做任何事。

## Plan

1. 等 `gap-ac256-mcp-nested-smoke-record` 落地（顶层 `depends_on` 已声明）。复核 AC-256 判据绿：`for f in scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs docs/proposals/cloudcli-mcp-smoke.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node --test scripts/mcp-smoke.test.mjs && node scripts/mcp-smoke.mjs --check-record docs/proposals/cloudcli-mcp-smoke.md`，写下 tests/pass/fail 与 stdout 逐字。
2. 逐节复核记录八节（环境与版本 / 起独立实例 / Claude Code 握手与工具列表 / 列出会话 / 发消息 / 查进度 / 中止 / 收尾残留）：每节都要有非空 `读数：` 与 `结论：`（用 `--check-record` 的机械结论，并逐节打印标题与两行的存在性）。
3. 反自点亮：负控制——`grep -c '^嵌套冒烟验收：通过' docs/proposals/cloudcli-mcp-smoke.md` 为 0 且 `grep -c '嵌套冒烟验收：通过' scripts/mcp-smoke.mjs` 为 0；正控制——对一份临时拷贝在行首插入该字样后同一 grep 命中 1（证明负控制的 0 有分辨力、不是恒零）。
4. 把八节的承重读数（端口 ≠ 3001；发消息的 run 来源逐字 `mcp`，且同一读里非 MCP run 的来源不为 `mcp`；`run_get` 按 runId 命中；`session_interrupt` 前后常驻 pid 不变；收尾进程/目录/scope 命中均为 0；`:3001` 起终点监听 pid 逐字相同）摘录进本任务 `## Evidence`，并逐字写明请求人 yale 做的唯一动作：在 `docs/proposals/cloudcli-mcp-smoke.md` 写入一行以「嵌套冒烟验收：通过」开头的验收行。
5. 停在 `needs-human`：AC1–AC4 与 AC6 已满足而 AC5 未满足即停；不改 `status:` 字段（由 driver 机械落 needs-human）。人写入后重跑 AC5 判据 → 勾 AC5 → 正常推进，GOAL-020 方可判 achieved。

## AC

- [ ] AC1 前置齐全（AC-256 判据绿）：逐字命令 `for f in scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs docs/proposals/cloudcli-mcp-smoke.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node --test scripts/mcp-smoke.test.mjs && node scripts/mcp-smoke.mjs --check-record docs/proposals/cloudcli-mcp-smoke.md` 退出 **0**；写下 tests/pass/fail 与 `--check-record` 的 stdout 逐字。
- [ ] AC2 记录八节齐全且每节读数非空：`node scripts/mcp-smoke.mjs --check-record docs/proposals/cloudcli-mcp-smoke.md` 退出 **0**；打印八节标题（环境与版本 / 起独立实例 / Claude Code 握手与工具列表 / 列出会话 / 发消息 / 查进度 / 中止 / 收尾残留）与每节 `读数：`/`结论：` 两行的存在性。
- [ ] AC3 反自点亮负控制 + 正控制：`grep -c '^嵌套冒烟验收：通过' docs/proposals/cloudcli-mcp-smoke.md` → **0** 且 `grep -c '嵌套冒烟验收：通过' scripts/mcp-smoke.mjs` → **0**；正控制：对一份临时拷贝在行首插入该字样后同一 `grep -c` → **1**（证明负控制的零有分辨力、不是恒零）。
- [ ] AC4 红态基线逐字记录：运行 `grep -q '^嵌套冒烟验收：通过' docs/proposals/cloudcli-mcp-smoke.md || { echo '缺人工验收行：记录文件里没有以「嵌套冒烟验收：通过」开头的一行' >&2; exit 1; }`，退出码 **1**，stderr 逐字含 `缺人工验收行：`（完整判据文本见 goals/AC-257-*.md；本条复述其行为、不复述 echo 里的括注）。写下完整命令与完整输出。
- [ ] AC5 人证行已由人 yale 写入：`grep -q '^嵌套冒烟验收：通过' docs/proposals/cloudcli-mcp-smoke.md` 退出 **0**。**这条 AC 不得由 worker 自行勾选**；人尚未写入时它保持未勾，本任务停在 `needs-human` 等人裁定，不得置 done。
- [ ] AC6 只写本任务文件：`git diff --name-only "$(git merge-base develop HEAD)" -- . ':!tasks/gap-ac257-mcp-nested-smoke-human-gate.md'` 无输出（产品代码与记录文件一行未改；用 merge-base 而非裸 develop，避免把别人的 fan-in 读成本任务的改动）。

## DoD

**真实落地判据（不是「文件存在」）**：人 yale 必须能只读本任务的 `## Evidence` 与记录 `docs/proposals/cloudcli-mcp-smoke.md`，就一次真跑过的嵌套冒烟作出「通过 / 不通过」的判断，而**不需要重跑冒烟、也不需要回来补读数**。这要求记录八节逐节非空（AC2），且承重读数（端口 ≠ 3001、发消息 run 来源 `mcp` 与非 MCP run 的来源不同、`run_get` 命中、`session_interrupt` 前后常驻 pid 不变、收尾残留全 0、`:3001` 起终点 pid 相同）在 `## Evidence` 里逐字可见。

**停在 needs-human 而不是 done**：若 AC1–AC4 与 AC6 已满足而 AC5 未满足，正确终态是 `needs-human`（等人写入验收行），**不是** done。这是 AC-257 的 `expect` 与 GOAL-020 退出条件 11 的逐字要求（「记录齐全而人未确认时终止状态是 needs-human」）。worker 不自行改写 `status:` 字段，收尾由 driver 机械完成。

**不得自点亮**：记录文件与脚本里都没有以 `嵌套冒烟验收：通过` 开头的行（AC3 的负控制）；worker 不代写验收行。判据的红只能由人 yale 的写入消掉。

**只动本任务文件**：产品代码与记录文件一行未改（AC6）。

## Touches

- tasks/gap-ac257-mcp-nested-smoke-human-gate.md（自触）

## Notes

- **AC5 不得加 `（待外部）` 注解**：加注解会让 `flipAcGateVerdict` 判为 `pass-external`（`ok:true`），机械 fan-in 会把任务置 done 而 AC-257 仍红——那正是本任务要挡的旁路（内存 `quay-human-gate-must-be-an-ac-not-dod-prose`）。保持未注解，未勾的非外部项会让 fan-in 拒绝、driver 按重试上限落 `needs-human`，这才是设计终态。
- 也不要把人证门写成 DoD 散文里的一句话——门的机械判据只读 AC 勾选状态，散文会被静默绕过（同上内存）。故人证门必须是 AC5。
- AC4 是**一次性基线**（AC-256 落地后、人写入前登记），照 AC-256 任务的 AC1 先例；人写入后它不再成立，但已勾选状态保留。
- 记录文件是只读面：worker 不修改它，只读它并在本任务 `## Evidence` 里摘录读数。
- 绝不碰生产 3001：不连接、不启用、不重启。
- 冒烟的真跑成本（真模型、真 Claude CLI）已由 AC-256 承担一次；本条不重跑真冒烟，只重跑机械复核（`--check-record` 是纯读）与 AC-256 的单测。
