---
id: gap-suite-concurrency-checker
title: 并发判据读数：新增 scripts/suite-concurrency-check.sh，让 AC-103 从「缺文件」变成可复跑的并发检查
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-103
---
## Proposal

AC-103 现在是一条**纯红**判据：`criterion: bash scripts/suite-concurrency-check.sh`，gate exit 127「No such file or directory」。**判据文件不存在**——这与 AC-102 当初的起法一致（先立一条必红的读数，再由任务把它变成可复跑的检查）。

本任务只做那一件事：**建立并发判据的读数**，使 AC-103 从「文件不存在」变成「跑得起来、且当前仍红/未来能绿」。

要做的事：
1. 新增 `scripts/suite-concurrency-check.sh`：在同一台机器上**并发**（不是串行）启动 2 个 client 套件（`npx vitest run`），等待两者结束，然后断言 ①两者退出码均为 0；②两份输出中 `STACK_TRACE_ERROR` 与 `[vitest-worker]: Timeout calling "fetch"` 的计数均为 0；③打印安静基线与并发两组的服务端逐文件中位耗时对比，并在并发组超过安静基线的 K 倍时以非零退出并**带出原因**（K 先由首次实测钉死，写回 AC-103 的 expect）。
2. 脚本必须在失败时把**成因写在判词里**（这是本仓库 AC 的硬校验：criterion 的任何失败退出都必须同行输出原因），不得用裸 `grep -q` 链。
3. 并发治理本身不在本任务范围：client 侧 worker 池上限由既有任务承担（其被本条判据观测）。

**⚠️ 本脚本刻意不进套件 glob**：`scripts/test.sh` 只收集 `server/**/*.test.*` 与 `src/**/*.test.*`，所以放在 `scripts/` 下的检查器不会被套件递归调用（否则它会在套件里再跑套件）。这也是它必须是 standalone 命令而非 `.test.ts` 的原因。

<!-- dedup-ref -->相关但不同：`gap-vitest-worker-pool-unbounded`（已立案）做的是**并发治理**（给 client 池加自适应上限）；本任务做的是**读数**（让 AC-103 可被判据机跑）。两者是「被观测」与「观测」的关系，不是同一件事，故不合并。

## AC

- [ ] `bash scripts/suite-concurrency-check.sh` 退出码 0：并发启动的 2 个 client 套件均 exit 0，且两份输出中 `STACK_TRACE_ERROR` 与 `Timeout calling "fetch"` 计数均为 0。
- [ ] 取假（确定性）：脚本内把并发数降到 1（或临时去掉池上限）时，同一脚本必须能以非零退出**并打印出它测到的那串签名计数**——即该判据能取假，而不是恒绿。
- [ ] `bash scripts/suite-concurrency-check.sh` 在**当前**代码上实测为红（或实测出并发劣化读数），并把这组读数写进完成记录（安静 vs 并发的中位耗时）。
- [ ] `bash scripts/test.sh` 退出码 0（新增文件不进套件 glob，既有套件不回归）。

## DoD

真实落地判据：不是「脚本文件存在」。要求在同一台机器上**真的并发跑出两个套件**并把两串签名的计数、以及安静/并发两组中位耗时记入完成记录；随后 AC-103 的 gate 由 `exit 127`（文件不存在）变为 `exit 0`（或在其治理前提未落地时仍红但**红在读数上、不再红在缺文件上**）。⛔ 仅新增脚本而从未实跑并发不算完成。

## Touches

- scripts/suite-concurrency-check.sh
- tasks/gap-suite-concurrency-checker.md
