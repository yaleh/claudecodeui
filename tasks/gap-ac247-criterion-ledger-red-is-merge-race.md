---
id: gap-ac247-criterion-ledger-red-is-merge-race
title: AC-247 判据台账尾部红是 merge race：overview 实现 1220097a（15:38:34 +0800）只提交在 task
  分支，fan-in 23ff75a0（15:48:53 +0800 / 07:48:53Z）才带进 develop/主检出；末拍 goal 红
  07:47:58.629Z@tree 1cdd54fd8c64（mcp-overview.test.ts ABSENT）早于落地约 54s ——
  verification-only 归因入档（当前检出直跑 exit 0，5/5/0），不重新实现
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-247
---
## Proposal

来源：本轮 gap-filing 的**直接测量 + ancestry 复核**（不是台账尾巴本身）。GOAL-020 的 AC-247（`goals/AC-247-overview-一次给出全局状态-只读-quay-缓存-冷缓存时不触发任何-quay-cli-quay-snapsho.md`，`status: active`）被判 CURRENTLY FALSE 交办：`.quay/gate-events.jsonl` 里 `item_id=AC-247`、`gate=goal` 从 `2026-10-05T02:02:33.107Z` 到 `2026-10-05T07:47:58.629Z` **连续 57 拍 fail / 0 pass**，末几拍理由逐字皆为 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-overview.test.ts`。但认领 AC-247 的唯一任务 `gap-ac247-overview-quay-cache-readonly` 已是 `done`（fan-in `23ff75a0`）。故本轮先做直接现测 + ancestry 复核，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
for f in server/modules/mcp-gateway/tests/mcp-overview.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-overview.test.ts
```

**本轮直接现测：判据在当前检出 `/data/home/yale/work/claudecodeui`（branch `author`）上退出 0（工作树满足 AC-247）。** 读数逐字：

```
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
```

五条用例逐字通过：`(a) overview carries the running, awaiting-permission, aborted and resident readings`、`(b) overview reads quay from the cache only, marking misses unknown`、`(c) quay_snapshot reads cache by default and refreshes exactly one project when asked`、`(d) a project without quay config is explained in words, not thrown`、`(e) twenty projects cost zero runner calls`。而台账那批 fail 的逐字理由只到**存在性闸**：判据文件在被测量的那棵树里根本不存在，测试未被执行。

**机制：merge race（修复落地晚于判据测量），不是修复失效。** 内存 `goal-gate-red-can-race-the-fixs-own-landing` 的又一实例（同族先例：`gap-ac244-criterion-ledger-red-is-merge-race`、`gap-ac245-criterion-ledger-red-is-merge-race`、`gap-ac246-criterion-ledger-red-is-merge-race`、`gap-ac135-criterion-ledger-red-is-merge-race`、`gap-ac178-criterion-ledger-red-is-merge-race`）：

- 修复提交 `1220097a`「AC-247: overview reads the quay cache only; quay_snapshot refreshes one project」（`2026-10-05 15:38:34 +0800` = `07:38:34Z`）**最初只提交在 task 分支 `task/gap-ac247-overview-quay-cache-readonly` 上**。
- 任务分支把 `develop` 合并进来的 `614d55b9`（`15:40:45 +0800`）已含 `1220097a`，但该合并只落在 **task 分支**；主检出 `author` 当时尚未含它。
- 末拍 goal 红 `2026-10-05T07:47:58.629Z` 测量的树 `treeSha=1cdd54fd8c6429492811f8dd617e8c7079401594` **判据文件 ABSENT**（`git cat-file -e 1cdd54fd8c64:server/modules/mcp-gateway/tests/mcp-overview.test.ts` → exit 128）；本轮抽样的四棵红树 `70fae57c71db`/`971ebf17c163`/`1dcee81f14bb`/`1cdd54fd8c64` **全部 ABSENT**。`git merge-base --is-ancestor 1220097a 1cdd54fd8c64` → 非 0（修复不在被测量的树里）。
- fan-in 落地提交 `23ff75a0`「tasks: 翻 gap-ac247-overview-quay-cache-readonly done（driver 机械 fan-in）」在 `2026-10-05 15:48:53 +0800`（= `07:48:53Z`）才把 `1220097a` 带进 `develop`/主检出。现 `git merge-base --is-ancestor 1220097a develop` = 0、`… 1220097a HEAD` = 0；`git show develop:server/modules/mcp-gateway/tests/mcp-overview.test.ts | head -3` 命中文件头 `/** AC-247 criterion: \`overview\` answers the whole workspace from the quay CACHE`。
- 即：**末拍红 `07:47:58.629Z` 比修复落进 develop/主检出 `07:48:53Z` 早约 54 秒**（`07:48:53 − 07:47:58.629 = 54.371s`）。`.quay/goal-round.jsonl` 最新 round 62（`2026-10-05T07:46:41.257Z`）的 AC-247 goal-ring fact 仍读 fail —— 那是**上一拍 gate-event 判决的延续**（该 round 与红拍之间无新 gate-event），非修复未生效。

⇒ **早先的修复是兜住的**（`gap-ac247-overview-quay-cache-readonly`，done，净树 5/5/0）；台账 57 拍 fail 尾部是 fan-in 落地与判据测量之间的竞态，不是 AC-247 回归。本条**不重新实现**任何修复。

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rn "^goal_ac: *AC-247" tasks/*.md` 命中**仅 1 条** —— `tasks/gap-ac247-overview-quay-cache-readonly.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-247`）**0 命中** ⇒ 无在飞认领者，本条不是重复。同族先例 `gap-ac244-criterion-ledger-red-is-merge-race`（`goal_ac: AC-244`，done）、`gap-ac245-criterion-ledger-red-is-merge-race`（`goal_ac: AC-245`，done）、`gap-ac246-criterion-ledger-red-is-merge-race`（`goal_ac: AC-246`）、`gap-ac135-criterion-ledger-red-is-merge-race`（`goal_ac: AC-135`）、`gap-ac178-criterion-ledger-red-is-merge-race`（`goal_ac: AC-178`）各为**另一条 AC**，仅归因机制相同。

**残留未钉死假设（如实登记）**：

1. **`.quay/goal-round.jsonl` 的 goal-ring fact 落后于 gate-event**：最新 round 62 的 AC-247 fact 仍读 fail，只是上一拍判决的延续；只有与该拍同时写入新 gate-event 的 round 才是新测量（内存 `goal-gate-red-can-race-the-fixs-own-landing` Sequel 2）。下一次 goal 评估（round 63）应在修复落地后读到 pass。
2. **本判据的 SDK 客户端用 `StreamableHTTPClientTransport` 并传基于 `node:http` 的 `fetch`**：`listen(0)` 在本机会抽到 undici 拒绝的端口（内存 `undici-bad-port-lottery-in-listen0-route-tests`），与 AC-240–AC-246 同款说明。
3. **判据夹具的常驻宿主走管理器机制而非调试 agent 驱动**：与 AC-245 判据的同款说明一致（`provider.registry` 在 import 时封死 DEBUG_AGENT 闸）。
4. **AC-248–AC-257 的读数不在本条**：本条只归因 AC-247 的台账尾部红。

本任务是 **verification-only 归因入档**：不改实现、判据、goals、宿主配置一个字节，也不动任何在飞 WIP。

## Plan

1. 建本条隔离 worktree（起点 = 开工时的 `develop`），打印 worktree 路径与 `git rev-parse HEAD`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据**三次**（`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-overview.test.ts`，出货命令逐字不改），逐字抄 `ℹ tests`/`ℹ pass`/`ℹ fail` 与三次退出码；五条用例名逐字入档（稳定绿：三跑读数一致）。
3. 机械复核 merge race 的 ancestry 证据：`git log -1 --format='%H %ci %s' 1220097a` / `614d55b9` / `23ff75a0`；`git merge-base --is-ancestor 1220097a 1cdd54fd8c64; echo $?`（非 0）、`… 1220097a 23ff75a0; echo $?`（0）、`… 1220097a develop; echo $?`（0）、`… 1220097a HEAD; echo $?`（0）；`git cat-file -e 1cdd54fd8c64:server/modules/mcp-gateway/tests/mcp-overview.test.ts`（exit 128）；`git show develop:server/modules/mcp-gateway/tests/mcp-overview.test.ts | head -3`（命中）；复算「末拍红 `07:47:58.629Z` < fan-in 落地 `07:48:53Z`」≈ 54s。
4. 从 `.quay/gate-events.jsonl` 抄出 AC-247 `gate=goal` 的 fail 首拍与尾部（含逐字理由、`evaluationRoot`、`treeSha`）；从 `.quay/goal-round.jsonl` 抄出最新 round（62，`07:46:41.257Z`）的 AC-247 goal-ring fact；用 per-tree 机械判据（`git cat-file -e <treeSha>:<criterion-file>`）把「红树 ABSENT / 现树 PRESENT」对上。
5. 交付只落 `tasks/<本条 id>.md`。

## AC

- [ ] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑三次：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-overview.test.ts` 均退出 **0**，`ℹ tests 5` / `ℹ pass 5` / `ℹ fail 0` 与五条用例名逐字入档（稳定绿：三跑读数一致）。红态基线（本轮立案读数）：当前检出直跑 exit 0；台账末拍红 `2026-10-05T07:47:58.629Z` 退出 1，红在存在性闸 `缺判据文件：server/modules/mcp-gateway/tests/mcp-overview.test.ts`。
- [ ] AC2 承重的 ancestry 证据机械入档：`git log -1 --format='%H %ci %s' 1220097a` → 修复提交 `2026-10-05 15:38:34 +0800`（task 分支）；`… 614d55b9` → task 分支合并 develop `15:40:45 +0800`；`… 23ff75a0` → fan-in `15:48:53 +0800`（=`07:48:53Z`）；`git merge-base --is-ancestor 1220097a 1cdd54fd8c64; echo $?` → **非 0**；`… 1220097a 23ff75a0; echo $?` → 0；`… 1220097a develop; echo $?` → 0；`… 1220097a HEAD; echo $?` → 0；`git cat-file -e 1cdd54fd8c64:server/modules/mcp-gateway/tests/mcp-overview.test.ts` → exit 128（ABSENT）；`git show develop:server/modules/mcp-gateway/tests/mcp-overview.test.ts | head -3` 命中文件头。命令与逐字输出入档；复算 `07:48:53 − 07:47:58.629 = 54.371s ≈ 54s`。
- [ ] AC3 台账尾巴逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-247`、`gate=goal` 的判决计数（**57 fail / 0 pass**）与首拍/尾部（首 `2026-10-05T02:02:33.107Z`、末 `2026-10-05T07:47:58.629Z`，含逐字理由 `acceptance failed (exit 1) — 缺判据文件：server/modules/mcp-gateway/tests/mcp-overview.test.ts`、`evaluationRoot=/data/home/yale/work/claudecodeui`、`treeSha`），并抄出 `.quay/goal-round.jsonl` 最新 round（62，`2026-10-05T07:46:41.257Z`）的 AC-247 goal-ring fact；写明「末拍红（`07:47:58.629Z`）早于 fan-in 落地（`07:48:53Z`）约 54s」；用 per-tree 判据把红树（`1cdd54fd8c64` 等）与现树（`develop`/`HEAD`）的判据文件存在性直接对上（ABSENT vs PRESENT）。
- [ ] AC4 机制去重复核：`grep -rn "^goal_ac: *AC-247" tasks/*.md` 的命中集合与其 `status:` 逐字入档（仅 `gap-ac247-overview-quay-cache-readonly`，done）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-247`）命中的只能是本条自身，须注明；并写明同族先例各为另一条 AC。
- [ ] AC5 承重面未被本条触碰：`git diff --name-only develop...HEAD -- server src goals scripts` **为空**；`server/modules/mcp-gateway/tests/mcp-overview.test.ts`、`server/modules/mcp-gateway/mcp-overview-tools.ts` 的 blob 与 `develop` 相等（`git diff --stat develop -- <file>` 空）；`git status --porcelain` 与本条开工快照逐字相同（⛔ 未 `stash` / 未 `git checkout --` / 未编辑任何 `server/**`、`goals/**`）。
- [ ] AC6 如实登记：完成记录逐字写明「**被提交的树满足 AC-247**（净树三跑 exit 0、5/5/0）」与「台账 57 拍 fail 尾部由修复 `1220097a` 最初只提交在 task 分支、fan-in `23ff75a0` 于 `07:48:53Z` 才把它带进 develop/主检出、而判据红拍发生在落地之前造成」，并给出残留未钉死假设（goal-round fact 落后；`StreamableHTTPClientTransport`+`node:http` fetch；夹具宿主走管理器机制）；⛔ 不得用单元层读数替代判据本体。

## DoD

- 出货命令（`for f in server/modules/mcp-gateway/tests/mcp-overview.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-overview.test.ts`，逐字不改；⛔ 不改断言、不改判据）在净检出上真的跑过、退出 0，五条用例名与 `5/5/0` 逐字入档 —— 不是复述 AC 文字，不是读台账尾巴。
- merge race 的每一条 ancestry 读数（修复提交时刻、task 分支合并时刻、fan-in 时刻、被测量红树的树 sha、`merge-base --is-ancestor` 退出码、`git show develop:…` 命中、红拍/落地时刻差）都能由任何人在同一 checkout 上复现；命令与逐字输出写进完成记录。
- 完成记录明确写出判法：**「修复 `1220097a` 有效；台账 fail 尾部是 fan-in 落地与判据测量之间的竞态」**，并给出残留未钉死假设。
- 交付物只动 `tasks/<本条 id>.md`：判据、实现、goals 文件、工作树一个字节未动。
- 若净树直跑为**红**（即该红与竞态无关），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，本条归因不成立，应按缺陷任务重立」—— ⛔ 不得把环境红写成产品绿，也不得据此改断言。

## Touches

- `tasks/gap-ac247-criterion-ledger-red-is-merge-race.md`（自触）
- `server/modules/mcp-gateway/tests/mcp-overview.test.ts`（本条只跑不改：判据本体）
- `server/modules/mcp-gateway/mcp-overview-tools.ts`（本条只读不改：overview / quay_snapshot 实现）
- `goals/AC-247-overview-一次给出全局状态-只读-quay-缓存-冷缓存时不触发任何-quay-cli-quay-snapsho.md`（本条只读不改：criterion/expect 逐字来源）