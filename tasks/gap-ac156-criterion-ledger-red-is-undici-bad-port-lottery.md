---
id: gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery
title: AC-156 判据台账红是 undici bad-port 抽签：判据命令 npx tsx --test 直跑绕开了只接在测试通道的
  scripts/undici-blocked-ports-preload.mjs，净检出三跑 7/7/0 — verification-only
  归因入档，不重新实现
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-156
---
## Proposal

来源：本轮 gap-filing 的**直接测量 + 机制归因**（不是台账尾巴本身）。GOAL-012（`status: achieved`，非 `long-term`）的 AC-156（`goals/AC-156-get-api-session-hosts-列出所有-provider-的宿主-含状态-绑定-保活理由与关闭原因-需鉴权.md`，`status: achieved`）被判 CURRENTLY FALSE 交办。认领 AC-156 的唯一任务 `gap-session-hosts-rest-list-endpoint`（`goal_ac: AC-156`）已是 `done`。故本轮先直跑判据 + 归因，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts
```

**本轮直接现测：判据在当前检出（`/data/home/yale/work/claudecodeui`，branch `author`）上退出 0，`tests 7 / pass 7 / fail 0`（三跑一致）。** AC-156 的保证——需鉴权的 `GET /api/session-hosts` 用宿主层快照列出全部 provider 的宿主（含 state/pid/bindings/closeReason）、lingering 可见、关闭原因有注入时钟的保留窗口——逐条通过。

**机制：undici bad-port 抽签，不是 AC-156 回归。** 判据本体用 `app.listen(0, '127.0.0.1')`（`server/modules/session-hosts/tests/session-hosts-routes.test.ts:393`）再用全局 `fetch`（`:430` 的 `getListing`）打回自己。内置 undici 对 18 个端口直接拒绝（`[TypeError: fetch failed] { [cause]: Error: bad port }`，发生在打开 socket 之前）；本机 `ip_local_port_range = 1024 65535`，内核给 `listen(0)` 分配端口时有概率落在其中，于是该文件随机红、单独重跑就绿——即内存 `undici-bad-port-lottery-in-listen0-route-tests` 的同一机制。

**为什么「早先的修复」没覆盖这一格：不是失效，是没接进判据通道。** repo 已有任务 `gap-undici-blocked-ports-held-in-server-test-lane`（`status: done`）落地了 `scripts/undici-blocked-ports-preload.mjs`，让测试通道的进程提前占住这 18 个端口。但它只把预加载接在**测试通道**两处：`package.json:55` 的 `test:server`、`scripts/test.sh:894` 与 `:896` 的 server 阶段（`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test "$f"`）。AC-156 的判据命令是**直接** `npx tsx --tsconfig server/tsconfig.json --test <file>`（不带 `--import`），由 goal 驱动器逐字执行 ⇒ 预加载不生效，抽签仍在。AC-156 的实现本身是对的（净树 7/7）。

**台账证据（`.quay/gate-events.jsonl`，`item_id=AC-156`、`gate=goal`）。** 判据落地后长期连绿；10-06 只有两个孤立红点：`2026-10-06T02:16:47.932Z` fail@tree `b694336b8e6c93b557d108471f844598e40ec845`、`2026-10-06T02:38:25.589Z` fail@tree `daa9c8958655c6c1cfef04a5432eed60d8ee0af6`；同一窗口另有 6 拍 pass（`02:17:48Z`…`02:35:32Z`）。红拍理由被存储截断（`… [truncated, 4324 chars of stdout omitted]`），保留的尾部是判据文件自身的 fetch 栈：`…/session-hosts-routes.test.ts:430:26) at <anonymous> (…:507:27) at withServer (…:397:11) at process.processTicksAndRejections`，**无任何断言文案**。同款指纹的同文件红也在别的任务（路径不相交）的 scoped gate 里出现过（`/tmp/fan-in-step-gap-occupied-session-read-only-mode-wk-prod-anchor-scoped-gate.log`：`__PERFILE__ … passed=false`、`__PERFILE_KIND__ … kind=assert`、文件级 `not ok - server/modules/session-hosts/tests/session-hosts-routes.test.ts:   [TypeError: fetch failed] {`）。`.quay/goal-round.jsonl` 连续 round 154–159 的 `frozenRecheck` 里 AC-156 全部 `verdict=pass` / `outcome=cleared` / `cause=now-true`。

⇒ **判法：AC-156 的保证成立；台账红尾是 undici bad-port 抽签（判据命令 `npx tsx --test` 直跑绕开了只接在测试通道上的 `scripts/undici-blocked-ports-preload.mjs`）。** 本条**不重新实现**，也不改判据/实现/goals/测试文件。

<!-- dedup-ref --> 机制去重读数（立案时实测）：`grep -rn "^goal_ac: *AC-156" tasks/*.md` 命中**仅 1 条** —— `tasks/gap-session-hosts-rest-list-endpoint.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-156`）**0 命中** ⇒ 无在飞认领者，本条不是重复。相邻任务 `gap-undici-blocked-ports-held-in-server-test-lane`（done）修的是**测试通道**（`test:server`/`scripts/test.sh`），未覆盖判据直跑通道，其边界逐字写着「不改任何 `server/**/*.test.*`」；本条只归因、也不改该测试文件，两条的机制与交付物都不同。

## Plan

1. 建本条隔离 worktree（起点 = 开工时 `develop`），打印路径与 `git rev-parse HEAD`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据**三次**（出货命令逐字不改），抄 `ℹ tests`/`ℹ pass`/`ℹ fail`、三次退出码与七条用例名。
3. 机械复核「判据命令绕开预加载」：`grep -n -- '--import' package.json scripts/test.sh`；`grep -n "listen(0" server/modules/session-hosts/tests/session-hosts-routes.test.ts`；`grep -n "await fetch" server/modules/session-hosts/tests/session-hosts-routes.test.ts`；`ls -l scripts/undici-blocked-ports-preload.mjs`。
4. 抄台账：AC-156 的 goal gate 判决序列（含 10-06 两红点与 6 拍 pass、`treeSha`）、红拍理由的截断形态与尾部 fetch 栈；抄 `.quay/goal-round.jsonl` 最近 round 的 `frozenRecheck` AC-156 条目。
5. 交付只落 `tasks/<本条 id>.md`。

## AC

- [ ] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑三次：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts` 均退出 **0**，`ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0` 与七条用例名逐字入档（稳定绿：三跑读数一致）。红态基线（立案读数）：当前检出直跑 exit 0；台账末拍红 `2026-10-06T02:38:25.589Z`@tree `daa9c895` 退出 1。
- [ ] AC2 机制归因的机械证据入档：(a) `grep -n -- '--import' package.json scripts/test.sh` 逐字显示 `scripts/undici-blocked-ports-preload.mjs` 只接在 `package.json:55` 的 `test:server` 与 `scripts/test.sh:894`/`:896` 的 server 阶段，**不**在判据命令里；(b) `grep -n "listen(0" server/modules/session-hosts/tests/session-hosts-routes.test.ts` → `:393`；(c) `grep -n "await fetch" server/modules/session-hosts/tests/session-hosts-routes.test.ts` → `:430`；(d) `ls -l scripts/undici-blocked-ports-preload.mjs` 存在。命令与逐字输出入档。
- [ ] AC3 台账证据逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-156`、`gate=goal` 的判决序列（明确含 `2026-10-06T02:16:47.932Z` fail@`b694336b`、`2026-10-06T02:38:25.589Z` fail@`daa9c895`，与同窗 6 拍 pass），红拍理由的被截断形态与尾部 fetch 栈（`:430:26` ← `:507:27` ← `withServer :397:11`，无断言文案）；`.quay/goal-round.jsonl` 最近 round 的 `frozenRecheck` 里 AC-156 全部 `verdict=pass` / `cause=now-true`。
- [ ] AC4 判法写明：**「AC-156 的保证成立；台账红尾是 undici bad-port 抽签（判据命令 `npx tsx --test` 直跑绕开了只接在测试通道上的 `scripts/undici-blocked-ports-preload.mjs`）」**，并给出残留未钉死假设（抽签不可复现；红拍 stdout 的 `cause` 未被存储保留，机制由站点指纹与同族先例认定）。
- [ ] AC5 承重面未触碰：`git diff --name-only develop...HEAD -- server src goals scripts package.json` 为空；`git status --porcelain` 与开工快照逐字相同；唯一交付物是 `tasks/<本条 id>.md`。

## DoD

- 出货判据（逐字不改；⛔ 不改断言、不改判据、不改实现）在净检出上真的跑过、退出 0，`7/7/0` 与七条用例名逐字入档——不是复述 AC 文字、不是读台账。
- 机制归因可由任何人在同一 checkout 上复现：判据命令无 `--import`、`test:server`/`scripts/test.sh` 有、`listen(0)`+`fetch` 的站点行号、预加载文件存在；命令与逐字输出写进完成记录。
- 台账序列与 `goal-round` recheck 读数逐字入档，含红拍理由的截断说明。
- 完成记录明确写出判法（见 AC4）与残留未钉死假设。
- 若净树直跑为**红**（红与抽签无关、判据真的坏了），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，归因不成立，应按缺陷任务重立」——⛔ 不得把环境红写成产品绿。
- 交付物只动 `tasks/<本条 id>.md`。

## Touches

- `tasks/gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery.md`（自触）
- `server/modules/session-hosts/tests/session-hosts-routes.test.ts`（本条只跑不改：判据本体）
- `scripts/undici-blocked-ports-preload.mjs`（本条只读不改：测试通道的抽签缓解本体）
- `goals/AC-156-get-api-session-hosts-列出所有-provider-的宿主-含状态-绑定-保活理由与关闭原因-需鉴权.md`（本条只读不改：criterion/expect 逐字来源）
