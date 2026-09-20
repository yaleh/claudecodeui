---
id: gap-worker-selfcheck-scoped
title: worker 自测改跑 scoped：任务 AC 从全量套件改为 --for-task &lt;自身 id&gt;，并在 test.sh 前置加机械守卫
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-103
---
## Proposal

**要解决的问题**：本项目并发套件的**乘法来自一条约定**，不是来自某个开关。`.quay/config.yml` 的 `loop:` 段没有任何并发键，派发并发来自插件的 `scripts/drivers.yml` 默认 `kinds.worker.cap: 5`；而**每一个任务 worker 的自测 AC 都写着 `bash scripts/test.sh`（全量）**。于是 `cap: 5` 的真实含义变成「最多 5 个全量套件同时抢一台机器」——**前者管派发，后者才是成本，而两者互不知情**。

**为什么这是错配**：全量套件本该是 **fan-in 的合并闸**（它在合并前对被测树跑一次），worker 自己只需要证明**它改的那部分**没坏。quay 的 `integration-batch-merge.sh:948` 逐字建议 worker 这么做：

> 先在自己 worktree 自测绿：`node --test <文件>` 或 **scoped test.sh（`bash scripts/test.sh --for-task <task-id> --allow-thin`）**，得到 `scope=worktree+state=green` 记录后再 fan-in

而 `runner-static-gate.ts:1157` 明说 scoped 路径**刻意跳过**全量静态闸——它就是为「便宜」设计的。

**机制已经现成**：`scripts/test.sh:29-39` 已实现 `--for-task <id>`（从该任务 `## Touches` 里抽 `*.test.*` 文件）；本项目**已有 7 条任务在用**。

**⚠️ 关键约束（本任务的第一条设计约束，别踩）**：`--for-task` **只抽 `*.test.*`**。若一个任务的 Touches 里**没有**测试文件（例如交付物是 `scripts/*.sh` 检查器），`--for-task` 会抽到 0 个文件、走 `scripts/test.sh:36-38` 打印 `no scoped test files for <id> (thin)` 并 **exit 0** —— **那是一个取不了假的绿，比全量更糟**（quay 的 init 契约文档对同形有逐字告警：「a green that cannot go red is not a measurement」）。所以守卫**不得**无条件要求改成 `--for-task`。

要做的事：
1. 新增 `scripts/suite-scope-check.sh`，规则**两条并列**：
   - (a) 对每一个非 `done`/`superseded` 的任务：若它的 `## AC` 里出现**全量** `bash scripts/test.sh`（未带 `--for-task`），**且它的 `## Touches` 含 `*.test.*` 文件**（scoped 在该任务上语义成立），判违规并列出任务 id——改法是改用 `--for-task <自身 id>`；
   - (b) 对**不**含测试文件的任务：`--for-task` 豁免（避免假绿），但其 AC **不得**以全量套件充当自测——改为直接跑它自己交付的检查器（`scripts/*.sh`）。
   - 两类都要**把任务 id 写进判词**（本仓库 AC 硬校验：criterion 的失败退出必须同行输出原因），不得用裸 `grep -q` 链。`done`/`superseded` 的历史任务**原样保留**（不改历史账）。
2. 在 `scripts/test.sh` 的**前置**加一次该守卫（对照 quay 的 `check_group_declarations` 前置位置，`scripts/test.sh:1035`），使「没人主动跑」不可能发生。⛔ 不得破坏既有的 flag 消费契约（`--buckets|--root|--state-dir|--runner|--log-file|--run-id) shift 2`）与 `__PERFILE__` 输出格式。
3. **必须把当前非 done 的违规任务改到位**——否则守卫生来即红、AC1 不可能满足。范围仅限于此：`done`/`superseded` 的历史一律不动，不扩散到无关任务。当前已知的活跃违规者只有 3 条，且都是本轮新立/新改的（其中一条含测试文件、属 (a) 类；两条交付物是 `scripts/*.sh`、属 (b) 类）。

## AC

- [ ] `bash scripts/suite-scope-check.sh` 退出码 0：非 `done`/`superseded` 任务中，凡 Touches 含 `*.test.*` 者都不用全量 `bash scripts/test.sh` 作自测；不含测试文件者不以全量套件充当自测。
- [ ] 取假（确定性，**两个方向都要**）：①临时把一个**含测试文件**的活跃任务 AC 改回全量 → 守卫非零退出并打印其 id；②临时让一个**不含测试文件**的任务 AC 改回全量 → 同样被列出。两次改回后均转绿。
- [ ] ⛔ 守卫**不得**把「不含测试文件的任务」判成「应该改用 `--for-task`」——必须区分「scoped 语义成立」与「scoped 会掏空成假绿」两种情况（用一个不含测试文件的样本断言它给出 (b) 类判词而非 (a) 类）。
- [ ] `bash scripts/test.sh` 退出码 0，且该守卫已在其前置被调用，既有 `__PERFILE__` 行格式未变。

## DoD

真实落地判据：不是「守卫脚本存在」。要求：①守卫被 `scripts/test.sh` 前置调用（改动后的 test.sh 实跑一次、退出 0）；②**真的把一个含测试文件的活跃任务改成 scoped 并跑通**（`bash scripts/test.sh --for-task <id>` 实跑退出 0，且**不是 thin 空跑**——输出须显示它确实执行了至少一个测试文件）；③两个取假方向各有一次实跑输出。三段输出记入完成记录。⛔ 仅新增守卫脚本、或交付一个只会四处 `--for-task` 的实现，不算完成。

## Touches

- scripts/test.sh
- scripts/suite-scope-check.sh
- tasks/gap-worker-selfcheck-scoped.md
