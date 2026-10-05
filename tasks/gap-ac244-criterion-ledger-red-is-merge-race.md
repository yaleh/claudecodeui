---
id: gap-ac244-criterion-ledger-red-is-merge-race
title: AC-244 判据台账尾部红是 merge race：审计实现 10c053c0/ba9eb2c5 只提交在 task 分支，fan-in
  dc1d71ea 于 05:59:16Z 才带进 develop/主检出，而红拍（…05:56:47Z）早于落地 —— verification-only
  归因入档（净树直跑 exit 0 ×4，5/5/0），不重新实现既有修复
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-244
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（不是台账尾巴）。GOAL-020 的 AC-244（`goals/AC-244-每次工具调用留一条审计-成功-拒绝-出错各有结果-参数只记摘要-超过保留期的记录被清理.md`，`status: active`）被判 CURRENTLY FALSE 交办：`.quay/gate-events.jsonl` 里 `item_id=AC-244`、`gate=goal`、`actor=goal-cli` 从 `02:02:31.316Z` 到 `05:56:47.270Z` **连续 30 拍 fail**，理由逐字皆为 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-audit.test.ts`，`evaluationRoot=/data/home/yale/work/claudecodeui`（主检出，branch `author`）。但认领 AC-244 的唯一任务 `gap-ac244-mcp-audit-log-outcomes-and-retention` 已是 `done`（fan-in `dc1d71ea`）。故本轮先做**直接现测 + ancestry 复核**，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
for f in server/modules/mcp-gateway/tests/mcp-audit.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-audit.test.ts
```

**本轮直接现测：判据在检出上退出 0（工作树满足 AC-244）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`，`git rev-parse HEAD`=`e3a08557`，`git status --porcelain` 对本条承重面为空）直跑四次（立案 1 次 + 连续 3 次），每次读数逐字一致、退出码 0：

```
ℹ tests 5
ℹ pass 5
ℹ fail 0
run1=0 run2=0 run3=0
```

五条用例逐字通过：`(a) every tool call writes exactly one row, for ok, denied and error`、`(b) the digest keeps ids verbatim and reduces free text to length + 40 chars`、`(c) unauthenticated calls answer 401, write no row, and leave the server alive`、`(d) retention deletes only rows past 90 days, runs at start, and schedules daily`、`(e) re-running initializeDatabase over a populated database changes nothing`。判据逐字读数（(b)/(d) 关键行）：`(b) args_digest={"session":"sess-id-123","project":"proj-id-456","message":{"length":500,"preview":"AAAA…(40)…"}}`、`(d) before=2 afterStartup=1 remaining=fresh scheduledMs=86400000 prune()=1`、`(e) rows 2->2; columns=[id,at,token_id,client_id,tool,args_digest,outcome,duration_ms]`。

而台账那批 fail 的逐字理由只到**存在性闸**：`缺判据文件：server/modules/mcp-gateway/tests/mcp-audit.test.ts`（判据文件在那棵树里根本不存在，测试未被执行）。

**机制：merge race（修复落地晚于判据测量），不是修复失效。** 这是内存 `goal-gate-red-can-race-the-fixs-own-landing` 的又一实例（同族先例：`gap-ac135-criterion-ledger-red-is-merge-race`、`gap-ac178-criterion-ledger-red-is-merge-race`）：

- 修复提交 `10c053c0`「feat(mcp-gateway): audit every tool call to mcp_audit_log with 90-day retention (AC-244)」（`2026-10-05 13:02:23 +0800` = `05:02:23Z`）与随后的 boot-order 修复 `ba9eb2c5`「fix(mcp-gateway): run audit retention sweep after the database is initialized」（`13:48:16 +0800` = `05:48:16Z`）**最初只提交在 task 分支 `task/gap-ac244-mcp-audit-log-outcomes-and-retention` 上**。
- 判据红拍时主检出 `author` 的 HEAD 是 `d7586d2f`（`13:52:16 +0800`；reflog `author@{2026-10-05 13:52:16} … d7586d2f`，其后的下一笔 author 移动是 `13:59:21` 的 fan-in Fast-forward）。`git merge-base --is-ancestor 10c053c0 d7586d2f` = **非 0（exit 1）** ⇒ 被判据测的那棵树**不含审计修复**；`git merge-base --is-ancestor ba9eb2c5 d7586d2f` = **1**；`git cat-file -e d7586d2f:server/modules/mcp-gateway/tests/mcp-audit.test.ts` = `fatal: path '…mcp-audit.test.ts' exists on disk, but not in 'd7586d2f'`（exit 128）⇒ 判据文件在测量树上不存在，正是台账理由的来源。
- fan-in 落地提交 `dc1d71ea`「tasks: 翻 gap-ac244-mcp-audit-log-outcomes-and-retention done（driver 机械 fan-in）」与合并 `364b0b7c`「Merge branch 'develop' into task/gap-ac244-…」同在 `2026-10-05 13:59:16 +0800`（= `05:59:16Z`；`develop` reflog push `13:59:16`，`author` Fast-forward `13:59:21`），才把 `10c053c0`/`ba9eb2c5` 带进 `develop`/主检出。现 `git merge-base --is-ancestor 10c053c0 develop` = **0**、`= HEAD` = **0**；`git show develop:server/modules/mcp-gateway/tests/mcp-audit.test.ts | head -3` 命中文件头 `/** … mcp_audit_log criterion (AC-244).`。
- 即：**最后一拍红 `05:56:47.270Z` 比修复落进 develop/主检出 `05:59:16Z` 早约 149 秒**（`05:59:16 − 05:56:47 = 2m29s`）。此后尚无新的一拍 goal 评估（`.quay/goal-round.jsonl` 最新一 record 为 round 35 @ `05:56:02.038Z`，AC-244 fact 逐字 `active/fail: acceptance failed (exit 1) — 缺判据文件：…`）。

⇒ **早先的修复是兜住的**（`gap-ac244-mcp-audit-log-outcomes-and-retention`，done，净树 4 绿）；台账 30 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态，不是 AC-244 回归。本条**不重新实现**任何修复。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，`git rev-parse HEAD`=`e3a08557`）：`grep -rn "^goal_ac: *AC-244" tasks/*.md` 命中**仅 1 条** —— `tasks/gap-ac244-mcp-audit-log-outcomes-and-retention.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-244`）**0 命中** ⇒ 无在飞认领者，本条不是重复。`grep -rln "AC-244" tasks/*.md` 另命中 `gap-ac240/241/242/243/251/252/274…` 的边界段（它们各自声明「不做审计（AC-244）」或「审计属 AC-244」），是相关但不同的机制（传输/认证/回环/词汇/工具），非重复。同族先例仅归因机制相同：`gap-ac135-criterion-ledger-red-is-merge-race`（`goal_ac: AC-135`）、`gap-ac178-criterion-ledger-red-is-merge-race`（`goal_ac: AC-178`），均为**另一条 AC**。

**残留的未钉死假设（如实登记）**：判据用 `withMcpAudit` 注册**三个假工具**（`echo_ok` 无 scope / `needs_send` 需 `cloudcli:session:send` / `boom` 抛错）经注入的 `registerTools` 缝执行，故「判据绿」只证明**审计包装器**对假工具成立；真实的只读/写工具（AC-245–AC-251）本任务未落地，判据**不**证明真实的 `session_send`（AC 举例的 500 字 `message`）真的落进摘要——那属 AC-249/AC-250 的判据。且 `summarizeToolArgs` 的 id 白名单目前只覆盖 `session`/`sessionId`/`project`/`projectId`，真实工具引入别的 id 键时需扩表。保留期（默认 90 天、启动一次 + 每日一次）与调度缝由注入的假时钟/假 `setInterval` 测；生产接线只有 `server/index.ts` 里 `initializeDatabase()` 之后的一次调用（`ba9eb2c5` 正是修这个 boot-order，避免 `no such table` 崩启动）。

本任务是 **verification-only 归因入档**：不改实现、判据、goals、宿主配置一个字节，也不动任何在飞 WIP。

## Plan

1. 建本条隔离 worktree（起点 = 开工时的 `develop`），打印 worktree 路径与 `git rev-parse HEAD`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据三次（`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-audit.test.ts`），逐字抄 `ℹ tests` / `ℹ pass` / `ℹ fail` 与三次退出码。
3. 机械复核 merge race 的 ancestry 证据：`git log -1 --format='%H %ci %s' 10c053c0` / `ba9eb2c5` / `dc1d71ea` / `d7586d2f`；`git merge-base --is-ancestor 10c053c0 d7586d2f; echo $?`、`… ba9eb2c5 d7586d2f; echo $?`、`… 10c053c0 develop; echo $?`、`… 10c053c0 HEAD; echo $?`；`git show develop:server/modules/mcp-gateway/tests/mcp-audit.test.ts | head -3`；`git cat-file -e d7586d2f:server/modules/mcp-gateway/tests/mcp-audit.test.ts`；复算「最后一拍红 05:56:47.270Z < fan-in 落地 05:59:16Z」= 149s。
4. 从 `.quay/gate-events.jsonl` 抄出 AC-244 `gate=goal` 的 fail 尾部（至少 `05:56:47.270Z`，含逐字理由与 `evaluationRoot`）；从 `.quay/goal-round.jsonl` 抄出 round 35（`05:56:02.038Z`）的 AC-244 goal-ring fact 逐字。
5. 交付只落 `tasks/<本条 id>.md`。

## AC

- [ ] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑三次：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-audit.test.ts` 均退出 **0**，`ℹ tests 5` / `ℹ pass 5` / `ℹ fail 0` 与五条用例名逐字入档。红态基线（本轮立案读数）：主检出 `05:56:47.270Z` 那拍退出 1，红在存在性闸 `缺判据文件：server/modules/mcp-gateway/tests/mcp-audit.test.ts`。
- [ ] AC2 承重的 ancestry 证据机械入档：`git log -1 --format='%H %ci %s' 10c053c0` → 修复提交 `2026-10-05 13:02:23 +0800`；`… ba9eb2c5` → boot-order 修复 `13:48:16 +0800`；`… dc1d71ea` → fan-in `13:59:16 +0800`；`… d7586d2f` → 最后一拍红时主检出 HEAD `13:52:16 +0800`；`git merge-base --is-ancestor 10c053c0 d7586d2f; echo $?` → **非 0**；`… ba9eb2c5 d7586d2f; echo $?` → 非 0；`… 10c053c0 develop; echo $?` → 0；`… 10c053c0 HEAD; echo $?` → 0；`git cat-file -e d7586d2f:server/modules/mcp-gateway/tests/mcp-audit.test.ts` → 报 `exists on disk, but not in 'd7586d2f'`；`git show develop:server/modules/mcp-gateway/tests/mcp-audit.test.ts | head -3` 命中文件头。命令与逐字输出入档。
- [ ] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-244`、`gate=goal`、`actor=goal-cli` 的 fail 尾部（至少 `2026-10-05T05:56:47.270Z`，含逐字理由 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-audit.test.ts` 与 `evaluationRoot=/data/home/yale/work/claudecodeui`），并抄出 `.quay/goal-round.jsonl` round 35（`2026-10-05T05:56:02.038Z`）的 AC-244 goal-ring fact；写明「最后一拍红（05:56:47.270Z）早于 fan-in 落地（05:59:16Z）约 149s」。
- [ ] AC4 机制去重复核：`grep -rn "^goal_ac: *AC-244" tasks/*.md` 的命中集合与其 `status:` 逐字入档（仅 `gap-ac244-mcp-audit-log-outcomes-and-retention`，done）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-244`）若命中的是本条自身，须注明；并写明同族先例 `gap-ac135-criterion-ledger-red-is-merge-race`、`gap-ac178-criterion-ledger-red-is-merge-race`（各为另一条 AC）。
- [ ] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- server src goals scripts` **为空**；`server/modules/mcp-gateway/tests/mcp-audit.test.ts`、`server/modules/mcp-gateway/mcp-gateway.audit.ts`、`server/modules/database/repositories/mcp-audit-log.db.ts` 的 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空）；`git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `server/**`、`goals/**`）。
- [ ] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-244**（净树三跑 exit 0、5/5/0）」与「台账 30 拍 fail 尾部由修复 `10c053c0`/`ba9eb2c5` 最初只提交在 task 分支、fan-in `dc1d71ea` 于 `05:59:16Z` 才把它带进 develop/主检出、而判据红拍发生在落地之前造成」，并给出残留未钉死假设（判据只跑假工具缝；真实 `session_send` 属 AC-249/AC-250；id 白名单待扩）；⛔ 不得用单元层读数替代判据本体。

## DoD

- 出货命令（`for f in …; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-audit.test.ts`，逐字不改；⛔ 不改断言、不改判据）在净检出上真的跑过、退出 0，五条用例名与 `5/5/0` 逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（修复提交时刻、boot-order 修复时刻、fan-in 时刻、被测量树 HEAD、`merge-base --is-ancestor` 退出码、`git show develop:…` 命中、红拍/落地时刻差）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `10c053c0`（+ boot-order 修复 `ba9eb2c5`）有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据、实现、goals 文件、工作树一个字节未动。
- 若净树直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— ⛔ 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- `tasks/gap-ac244-criterion-ledger-red-is-merge-race.md`（自触）
- `server/modules/mcp-gateway/tests/mcp-audit.test.ts`（本条只跑不改：判据本体）
- `server/modules/mcp-gateway/mcp-gateway.audit.ts`（本条只读不改：审计服务实现 / `withMcpAudit` / `summarizeToolArgs` / `startMcpAuditRetention`）
- `server/modules/database/repositories/mcp-audit-log.db.ts`（本条只读不改：`mcp_audit_log` 仓库）
- `goals/AC-244-每次工具调用留一条审计-成功-拒绝-出错各有结果-参数只记摘要-超过保留期的记录被清理.md`（本条只读不改：criterion/expect 逐字来源）