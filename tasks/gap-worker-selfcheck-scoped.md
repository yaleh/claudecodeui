---
id: gap-worker-selfcheck-scoped
title: worker 自测改跑 scoped：任务 AC 从全量套件改为 --for-task &lt;自身 id&gt;，并在 test.sh 前置加机械守卫
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

**要解决的问题**：本项目并发套件的**乘法来自一条约定**，不是来自某个开关。`.quay/config.yml` 的 `loop:` 段没有任何并发键，派发并发来自插件的 `scripts/drivers.yml` 默认 `kinds.worker.cap: 5`；而**每一个任务 worker 的自测 AC 都写着 `bash scripts/test.sh`（全量）**。于是 `cap: 5` 的真实含义变成「最多 5 个全量套件同时抢一台机器」——**前者管派发，后者才是成本，而两者互不知情**。

**为什么这是错配**：全量套件本该是 **fan-in 的合并闸**（它在合并前对被测树跑一次），worker 自己只需要证明**它改的那部分**没坏。quay 的 `integration-batch-merge.sh:948` 逐字建议 worker 这么做：

> 先在自己 worktree 自测绿：`node --test <文件>` 或 **scoped test.sh（`bash scripts/test.sh --for-task <task-id> --allow-thin`）**，得到 `scope=worktree+state=green` 记录后再 fan-in

而 `runner-static-gate.ts:1157` 明说 scoped 路径**刻意跳过**全量静态闸——它就是为「便宜」设计的。

**机制已经现成**：`scripts/test.sh:29-39` 已实现 `--for-task <id>`（从该任务 `## Touches` 里抽 `*.test.*` 文件）；本项目**已有 7 条任务在用**。所以这一刀不需要新机件，只需要**把约定倒过来**并且**让它可机械检查**。

要做的事：
1. 新增 `scripts/suite-scope-check.sh`：扫描 `tasks/*.md`，凡 `status` 不属于 `{done, superseded}` 且 `## AC` 段里出现全量 `bash scripts/test.sh`（即未用 `--for-task`）的，逐个列出并以非零退出；失败时**把违规任务 id 写在判词里**（本仓库 AC 硬校验：criterion 的失败退出必须同行输出原因），不得用裸 `grep -q` 链。允许 `done`/`superseded` 的历史任务保留原文（不改历史账）。
2. 在 `scripts/test.sh` 的**前置**加一次该守卫（对照 quay 的 `check_group_declarations` 前置位置，`scripts/test.sh:1035`），使「没人主动跑」不可能发生。⛔ 不得破坏既有的 flag 消费契约（`--buckets|--root|--state-dir|--runner|--log-file|--run-id) shift 2`）与 `__PERFILE__` 输出格式。
3. ⛔ 非目标：**不在本任务里逐条改既有任务的 AC 文本**——那是 task-store 写入，归属各自的撰写流程；本条只交付**守卫**，让它们此后无法再出现。

## AC

- [ ] `bash scripts/suite-scope-check.sh` 退出码 0：`tasks/` 下所有非 `done`/`superseded` 任务都不再用全量 `bash scripts/test.sh` 作为 AC。
- [ ] 取假（确定性）：临时把某个活跃任务的 AC 改回全量 `bash scripts/test.sh`，同一守卫必须以非零退出**并打印出该任务 id**；改回后转绿。
- [ ] `bash scripts/test.sh` 退出码 0，且该守卫已在其前置被调用（可从输出或代码位置核对），既有 `__PERFILE__` 行格式未变。
- [ ] `bash scripts/test.sh --for-task gap-model-env-kind-explanations` 能跑通并退出 0（证明 scoped 路径在本项目可用，而不是只存在于文档里）。

## DoD

真实落地判据：不是「守卫脚本存在」。要求**真的把一个任务的 AC 从全量改成 scoped 并跑通它**（`--for-task <id>` 实跑退出 0），且守卫被 `scripts/test.sh` 前置调用（改动后的 test.sh 实跑一次、退出 0），两段输出记入完成记录。⛔ 仅新增守卫脚本而 `test.sh` 未调用它、或未实跑 scoped 路径，不算完成。

## Touches

- scripts/test.sh
- scripts/suite-scope-check.sh
- tasks/gap-worker-selfcheck-scoped.md
