---
id: gap-debug-agent-fixture-home-isolation
title: 调试 Agent 的 fixture HOME 隔离：根来自门控变量而非 os.homedir()，正面断言真实 home 未被写入
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-debug-agent-engine-and-scenario-ops
  - gap-debug-agent-gate-structural-off
goal_ac: AC-127
---
## Proposal

**交付物：fixture HOME 的隔离、清理，以及「真实 home 未被写入」的正面断言。** 据 `adr/ADR-003-可控制的调试-agent-不跑真-cli-也能产生输出.md` 的「fixture HOME 隔离与清理」一节与决策 3 实现。

**为什么这不是洁癖，是一条已发生过的故障的修复面。** `session-synchronizer.service.ts` 的注释里记着：一次**指向了真实 `~/.claude`** 的测试运行留下的 transcript，因为观察者只对 `add`/`change` 反应而**不对 `unlink` 反应**，在侧栏留下了一个永久条目——点开是空的 "Untitled" 会话。调试 Agent 会写文件，所以它必须有一个自己的 home，规则如下。

1. **根来自门控变量，不来自 `os.homedir()`。** 这是承重的：claude 会话同步的 home 是 `path.join(os.homedir(), '.claude')` 这样的**类字段**，它读的是进程的 `HOME`。若调试 Agent 复用它，fixture 就会落到真实 home 里。
2. **fixture 根建在测试自己的临时目录下**，清理是**显式的、在 teardown 里执行的整目录删除**。
3. **必须正面断言真实 home 未被写入**——不只看 fixture 根被清理了，还要断言真实 home 在这次运行中**没有新增**（不存在性断言或修改时间断言）。
4. **清理顺序要尊重 `pruneOrphanedSessions` 的边界语义**：该函数只在**所在目录仍然存在**时才删除索引行。因此「**先删 fixture 根、再断言索引被清理**」是**错的顺序**——目录一没，索引行就永远不会被回收，正是上面那次故障的形状。正确顺序是**先让索引收敛、再删根**。

**第 3 条是这条判据与「清理干净了」的分界。** 「fixture 根被删掉了」对「产物写到了真实 home 里」完全失明——后者恰恰是那次真实故障。所以必须正面断言真实 home 的读数。

**本任务不做**：不实现引擎；不实现门控模块本身（只消费它给的根）；不改 `pruneOrphanedSessions` 的实现。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务——按「fixture 隔离 / HOME / 临时根 / 清理顺序」检索无命中。相邻但机制不同的是 `gap-e2e-onboarding-anchor-seeded-transcripts`（播种时序），它管的是"什么时候写"，本任务管的是"写到哪、怎么收"。

## Plan

1. 测试起进程时把 `HOME` 指向一个 **decoy** 目录、把门控根指向另一个目录——两者不同，才能证明产物落在门控根而非 `HOME`。
2. 运行一次完整产出后，对**两个**目录分别取读数：门控根下有产物；decoy 的对应子目录为空。
3. teardown 里**先**让索引收敛（删产物后触发一次同步/剪枝），**再**删 fixture 根——顺序在实现里写死并用断言固定。
4. 「真实 home 未被写入」用**修改时间 + 条目数**双读数：只用一个容易被同秒写入骗过。
5. 取假变体：把 fixture 指向 `HOME`（即真实 home）时，第 3 条必须红。

## AC

- [ ] AC1 fixture 隔离判据——`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-fixture-isolation.test.ts` 退出码 0。该用例即 `goals/AC-127`：断言 (1) 产物只出现在门控根下、**不在** decoy HOME 下；(2) **正面断言**真实 home 在这次运行中没有新增（修改时间 + 条目数双读数）；(3) teardown 后 fixture 根被整目录删除；(4) 清理顺序是**先索引收敛、再删根**。打印四处实际读数。
- [ ] AC2 抗假变体（**真跑并留输出**）：把 fixture 根指向真实 home ⇒ `AC1` 的命令必须**退出码非 0**，且红因是第 (2) 条（真实 home 出现新增），**不是**第 (1) 或第 (3) 条。这一点是承重的：若红在第 (3) 条，说明判据抓的是"没清理"而不是"写错地方"。跑完还原，`git status` 干净，并贴两次输出。
- [ ] AC3 清理顺序可判真伪：把顺序颠倒（先删根、再收敛索引）⇒ `AC1` 的命令必须**退出码非 0**，且红因指明残留的索引行。取假形态：若顺序颠倒后仍绿，说明第 (4) 条没有真的被断言——它是那次真实故障的形状，不能只写在 Proposal 里。
- [ ] AC4 判据不得只断言"目录被删"：命令在输出里同时给出**真实 home 的条目数与最新修改时间**，且这两项是断言的一部分而非附注。取假形态：把第 (2) 条换成"fixture 根已删除"时，`AC2` 必须红——本 AC 用这条对照证明两条不是同一件事。
- [ ] AC5 本任务未触及 Touches 之外的文件。命令：`git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都必须能对应到 Touches 内的一条；命中之外时逐行打印并以非 0 退出。

## DoD

真实落地判据（不是「临时目录被清理了」）：**调试 Agent 写下的东西，永远不会落在真实 home 里；而且这一点是被正面断言的，不是从"清理干净"推断出来的。** 承重性由三件事正面证明：

(a) **真实 home 的读数是指标本身**（AC1 的 (2)、AC4），而不是附注——「清理干净」对「写错地方」完全失明；
(b) **取假变体真跑过，且红在正确的半条上**（AC2：红在第 (2) 条而非第 (3) 条）；
(c) **清理顺序被正面断言**（AC3）——颠倒顺序必须红，因为那正是 `session-synchronizer.service.ts` 注释里那次真实故障的形状。

另需如实登记：本任务**未**覆盖观察者对 `unlink` 不反应的修复本身（那是同步器/观察者的行为，本任务只是不触发它）；也**未**在真实的多用户机器上验证（隔离靠 `HOME` 与门控根，二者都是进程级的）。

L_D 该轴仍暗，理由：本任务交付的是调试/测试机制的 fixture 隔离，不改变产品领域能力，没有可读出的产品领域读数；判定面由 AC1 的四项读数与 AC2/AC3 两次变体承担。
L_G 本目标的判据是 `goals/AC-127`（fixture 根来自门控变量而非 `os.homedir()`，且正面断言真实 home 未被写入），本任务的 AC1 即该判据的命令；AC2 是它的抗假变体。

## Touches

- server/modules/debug-agent/tests/debug-agent-fixture-isolation.test.ts (new)
- server/modules/debug-agent/debug-agent.gate.ts
- server/modules/debug-agent/debug-agent.engine.ts
- server/modules/providers/services/session-synchronizer.service.ts
- tasks/gap-debug-agent-fixture-home-isolation.md