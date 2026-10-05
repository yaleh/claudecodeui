---
id: gap-ac249-criterion-ledger-red-is-merge-race
title: AC-249 判据台账尾部红是 merge race：session_send 实现
  224e8646（16:37:08）/1c4a85e2（17:06:35）只提交在 task 分支，fan-in 5a261845 于 17:54:02Z
  才带进 develop、主检出 ff 于 17:54:25，86 拍红（末拍 09:54:01.618Z@tree
  e0fc09d30619=5600d210，判据文件 ABSENT）早于落地 —— verification-only 归因入档（净树直跑 7/7/0
  exit 0 ×3），不重新实现既有修复
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-249
---
## Proposal

来源：本轮 gap-filing 的**直接现测**（不是台账尾巴）。GOAL-020 的 AC-249（`goals/AC-249-session-send-立即返回-runid-运行与-ui-发起的运行是同一种-来源为-mcp-出现在运行中列表-忙时.md`，`status: active`）被判 CURRENTLY FALSE 交办：`.quay/gate-events.jsonl` 里 `item_id=AC-249`、`gate=goal`、`actor=goal-cli` 从 `2026-10-05T02:02:34.284Z` 到 `2026-10-05T09:54:01.618Z` **连续 86 拍 fail**，理由逐字皆为 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts`，`evaluationRoot=/data/home/yale/work/claudecodeui`（主检出，branch `author`）。但认领 AC-249 的唯一任务 `gap-ac249-session-send-immediate-runid` 已是 `done`（fan-in `5a261845`）。故本轮先做**直接现测 + ancestry 复核**，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
for f in server/modules/mcp-gateway/tests/mcp-session-send.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts
```

**本轮直接现测：判据在检出上退出 0（工作树满足 AC-249）。** 在 `/data/home/yale/work/claudecodeui`（branch `author`，`git rev-parse HEAD`=`6a97fa4f`，`git status --porcelain -- server shared src package.json package-lock.json` 空）直跑三次，每次读数逐字一致、退出码 0：

```
run1: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
run2: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
run3: ℹ tests 7 / ℹ pass 7 / ℹ fail 0 / exit 0
```

七条用例逐字通过：`(a)/(b) session_send returns while running, with source mcp and the token owner as caller`、`(c) a busy resident session queues and hands over the driver queue-tail uuid`、`(d) a busy per-run session is refused with the in-flight runId and a run_get hint`、`(e) waitSeconds returns early with the closing assistant message`、`(f) a token lacking the write scope is denied, audits one denied row, and never calls the control service`、`(g) the WebSocket chat.send and the MCP session_send reach the same control service`、`the stage-4 write table is exactly the five SPEC tools`。

**机制：merge race（修复落地晚于判据测量），不是修复失效。** 这是内存 `goal-gate-red-can-race-the-fixs-own-landing` 的又一实例（同族先例：`gap-ac135/178/244/245/246/247-criterion-ledger-red-is-merge-race`）：

- 修复提交 `224e8646`「feat(mcp-gateway): session_send returns a runId at once (AC-249)」（`2026-10-05 16:37:08 +0800` = `08:37:08Z`）与 `1c4a85e2`「fix(mcp-gateway): spell the debug-agent gate vars through constants (AC-249)」（`17:06:35 +0800` = `09:06:35Z`）最初只提交在 task 分支 `task/gap-ac249-session-send-immediate-runid` 上。
- 判据红拍时主检出 `author` 的 HEAD 是 `5600d210`（`17:46:33`），其 tree 为 `e0fc09d30619` —— 正是末拍红 gate event 的 `treeSha`。`git merge-base --is-ancestor 224e8646 5600d210` = 非 0、`… 1c4a85e2 5600d210` = 非 0 ⇒ 被测树**不含**修复；`git cat-file -e 5600d210:server/modules/mcp-gateway/tests/mcp-session-send.test.ts` = `fatal: path '…mcp-session-send.test.ts' exists on disk, but not in '5600d210'`（exit 128）⇒ 判据文件在测量树上不存在，正是台账理由来源。
- fan-in 落地提交 `5a261845`「tasks: 翻 gap-ac249-session-send-immediate-runid done（driver 机械 fan-in）」的父 `ff0fdc49` 已含判据文件；`git reflog show develop` 里 `5a261845` 的 push 时刻为 `17:54:02 +0800` = `09:54:02Z`，`git reflog show author` 里同名 ff 为 `17:54:25 +0800` = `09:54:25Z`。现 `git merge-base --is-ancestor 1c4a85e2 HEAD` = 0；`git ls-tree HEAD -- server/modules/mcp-gateway/tests/mcp-session-send.test.ts` 命中 blob `707cd6c5`。
- 即：**末拍红 `09:54:01.618Z` 落在 develop 带入修复（`09:54:02Z`）前约 0.4s、落在主检出 fast-forward（`09:54:25Z`）前约 23s**。此后尚无新的 goal 评估（`.quay/goal-round.jsonl` 最新 record 为 round 91 @ `2026-10-05T09:52:33.125Z`，AC-249 goal-ring fact 逐字 `active/fail: acceptance failed (exit 1) — 缺判据文件：…`）。

⇒ **早先的修复是兜住的**（`gap-ac249-session-send-immediate-runid`，done，净树 3 跑全绿 7/7/0）；台账 86 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态，不是 AC-249 回归。本条**不重新实现**任何修复。

<!-- dedup-ref --> 机制去重读数（本轮立案实测，`git rev-parse HEAD`=`6a97fa4f`）：`grep -rn "^goal_ac: *AC-249" tasks/*.md` 命中**仅 1 条** —— `tasks/gap-ac249-session-send-immediate-runid.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-249`）**0 命中** ⇒ 无在飞认领者，本条不是重复。`tasks/` 里已有的同类归因任务 `gap-ac135/178/244/245/246/247-criterion-ledger-red-is-merge-race` 各为**另一条 AC**（`goal_ac: AC-135/178/244/245/246/247`），机制相同但 AC 不同，非重复。`grep -rln "AC-249" tasks/*.md` 另命中 `gap-ac240/244/245/246/247/248/250/251/252/256/274…` 的边界段，各自声明「写工具（AC-249–AC-251）」的边界，是相关但不同机制的记录。

**残留的未钉死假设（如实登记）**：本条只复核 AC-249 的判据本体（`mcp-session-send.test.ts` 直跑绿）；AC-249 的 (a)–(g) 读数由该判据自证，本条不额外复算；判据用真实 express 4 + MCP SDK 客户端 + 调试 agent 的常驻/按次进程会话，绿读数已覆盖 (a)–(g)。

## Plan

1. 复核主检出状态与判据承重面干净：`git rev-parse HEAD`、`git status --porcelain -- server shared src package.json package-lock.json` 空。
2. 在检出上直跑判据三次（`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts`），逐字抄 `ℹ tests` / `ℹ pass` / `ℹ fail` 与三次退出码。
3. 机械复核 merge race 的 ancestry 证据：`git log -1 --format='%h %cI %s' 224e8646 / 1c4a85e2 / 5a261845 / 5600d210`；`git merge-base --is-ancestor 224e8646 5600d210; echo $?`、`… 1c4a85e2 5600d210`、`… 1c4a85e2 HEAD`；`git rev-parse '5600d210^{tree}'`；`git cat-file -e 5600d210:server/modules/mcp-gateway/tests/mcp-session-send.test.ts`；`git ls-tree HEAD -- server/modules/mcp-gateway/tests/mcp-session-send.test.ts`；`git reflog show develop --date=iso` 与 `git reflog show author --date=iso`（定位 `5a261845` 的 develop push 与 author ff 时刻）；复算末拍红 `09:54:01.618Z` 与落地的差。
4. 从 `.quay/gate-events.jsonl` 抄出 AC-249 `gate=goal` 的 fail 尾部（首拍 `02:02:34.284Z`、末拍 `09:54:01.618Z`、逐字理由与 `evaluationRoot`、`treeSha`）；从 `.quay/goal-round.jsonl` 抄出 round 91（`09:52:33.125Z`）的 AC-249 goal-ring fact 逐字。
5. 交付只落 `tasks/<本条 id>.md`。

## AC

- [ ] AC1 判据在**检出**（`git status --porcelain -- server shared src package.json package-lock.json` 空；打印 `git rev-parse HEAD`）直跑三次：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts` 均退出 **0**，`ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0` 与七条用例名逐字入档。红态基线（本轮立案读数）：主检出 `09:54:01.618Z` 那拍退出 1，红在存在性闸 `缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts`。
- [ ] AC2 承重的 ancestry 证据机械入档：`git merge-base --is-ancestor 224e8646 5600d210; echo $?` → 非 0；`… 1c4a85e2 5600d210; echo $?` → 非 0；`… 1c4a85e2 HEAD; echo $?` → 0；`git rev-parse '5600d210^{tree}'` == `e0fc09d30619`（= 末拍红 `treeSha`）；`git cat-file -e 5600d210:server/modules/mcp-gateway/tests/mcp-session-send.test.ts` → `exists on disk, but not in '5600d210'`（exit 128）；`git ls-tree HEAD -- …/mcp-session-send.test.ts` → blob `707cd6c5`；`git reflog show develop` 的 `5a261845` push 时刻（`17:54:02 +0800`）与 `git reflog show author` 的 `5a261845` ff 时刻（`17:54:25 +0800`）。命令与逐字输出入档。
- [ ] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-249`、`gate=goal`、`actor=goal-cli` 的 fail 尾部（首 `2026-10-05T02:02:34.284Z`、末 `2026-10-05T09:54:01.618Z`、共 86 拍，含逐字理由 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-session-send.test.ts` 与 `evaluationRoot=/data/home/yale/work/claudecodeui`、末拍 `treeSha=e0fc09d30619`），并抄出 `.quay/goal-round.jsonl` round 91（`2026-10-05T09:52:33.125Z`）的 AC-249 goal-ring fact；写明「末拍红（09:54:01.618Z）早于 develop 落地（09:54:02Z）约 0.4s、早于主检出 ff（09:54:25Z）约 23s」。
- [ ] AC4 机制去重复核：`grep -rn "^goal_ac: *AC-249" tasks/*.md` 的命中集合与其 `status:` 逐字入档（仅 `gap-ac249-session-send-immediate-runid`，done）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-249`）0 命中；并写明同类归因先例 `gap-ac135/178/244/245/246/247-criterion-ledger-red-is-merge-race` 各为另一条 AC。
- [ ] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- server src goals scripts` **为空**；`server/modules/mcp-gateway/tests/mcp-session-send.test.ts`、`server/modules/mcp-gateway/mcp-session-send.ts`、`server/modules/mcp-gateway/mcp-gateway.write-tools.ts` 的 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空）；`git status --porcelain` 与本条开工快照一致（未 `stash`、未 `git checkout --`、未编辑任何 `server/**`、`goals/**`）。
- [ ] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-249**（净树三跑 exit 0、7/7/0）」与「台账 86 拍 fail 尾部由修复 `224e8646`/`1c4a85e2` 最初只提交在 task 分支、fan-in `5a261845` 于 `09:54:02Z` 才把它带进 develop、主检出 ff 于 `09:54:25Z`、而判据红拍发生在落地之前造成」，并给出残留未钉死假设；不得用单元层读数替代判据本体。

## DoD

- 出货命令（`for f in …; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts`，逐字不改；不改断言、不改判据）在检出上真的跑过、退出 0，七条用例名与 `7/7/0` 逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（修复提交时刻、fan-in 时刻、被测量树 HEAD 与 tree、`merge-base --is-ancestor` 退出码、`cat-file -e` 失败、`ls-tree HEAD` 命中、红拍/落地时刻差）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `224e8646`（+ `1c4a85e2`）有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据、实现、goals 文件、工作树一个字节未动。
- 若直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」——不得把环境红写成产品绿，也不得据此改断言。

## Touches

- tasks/gap-ac249-criterion-ledger-red-is-merge-race.md（自触）
- server/modules/mcp-gateway/tests/mcp-session-send.test.ts（本条只跑不改：判据本体）
- server/modules/mcp-gateway/mcp-session-send.ts（本条只读不改：session_send 适配层）
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts（本条只读不改：写工具注册集合）
- goals/AC-249-session-send-立即返回-runid-运行与-ui-发起的运行是同一种-来源为-mcp-出现在运行中列表-忙时.md（本条只读不改：criterion/expect 逐字来源）
