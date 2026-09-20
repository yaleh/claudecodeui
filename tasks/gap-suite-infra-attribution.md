---
id: gap-suite-infra-attribution
title: 套件输出分不清基建失败与真失败：给 scripts/test.sh 的失败行加机器可读分类，并附可复跑检查器
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-104
---
## Proposal

AC-104 现在是一条**纯红**判据：`criterion: bash scripts/suite-infra-attribution-check.sh`，gate exit 127「No such file or directory」。

**要解决的问题（实测）**：`scripts/test.sh` 用 `first_error()`（第 71-75 行）给每个失败文件抓**第一条**匹配 `Error|error|not ok|✗|FAIL|failed` 的行，于是

- `Error: STACK_TRACE_ERROR`（vitest worker 异常死亡时的通用兜底文本）
- `Error: spawnSync ... ETIMEDOUT`（子进程被负载拖爆时限）

与**真实断言失败**被印成**同一个形状**（`not ok - <file>: <第一行>`）。2026-09-20 两次 fan-in 判红都属此类：失败集合每次不同、两次都红的文件单独跑却是过的，而下游只能看到 `state: red / reason: failed`——驱动因此在日志里找不到任何「worker 能修的东西」，只能停派。

**本任务只做项目侧那一半**：让 `scripts/test.sh` **自己**把「基建形状的失败」与「真失败」在输出上分开，并提供一个可复跑的检查器来断言这一点。

要做的事：
1. `scripts/test.sh`：为失败文件增加一个**机器可读的分类**（例如 `__PERFILE__ ... passed=false kind=infra|assert`，或同一行输出 `kind=`），判定依据**只看结构性事实**、⛔ 不做日志关键词匹配——至少覆盖：子进程 spawn 超时、worker 异常死亡（无断言输出的 `STACK_TRACE_ERROR`）、退出码落在信号段（129..192）。保留既有 `not ok - <file>: <原因>` 行不变（下游解析器依赖它），分类是**增量字段**。
2. ⛔ 不得把真断言失败改判成 infra：`kind=infra` 只在**没有任何断言失败输出**时给出；有断言输出的一律 `kind=assert`。这条是防止「把真缺陷误记为基建」——quay 的 `ci-red-attribute.ts` 逐字记着该方向的代价不对等（误记 infra 会**豁免**一条红，方向不可逆，故默认取 real-defect）。
3. 新增 `scripts/suite-infra-attribution-check.sh`：**确定性地**制造一次基建形状的失败（例如让某个测试文件的子进程 spawn 超时，或在套件运行中 SIGKILL 掉一个 vitest worker），跑一次 `scripts/test.sh`，断言该文件的失败行带 `kind=infra`；再跑一次只有断言失败的场景（例如临时把一个预期值改错），断言带 `kind=assert`。失败时把**成因写进判词**（本仓库 AC 硬校验：criterion 的失败退出必须同行输出原因），不得用裸 `grep -q` 链。

**⚠️ 边界**：轮记录的 `reason` 词汇（`infra-error|aborted|crashed|...`）属于 **plugin 的 full-suite-runner**，不在本项目能改的面内。所以本任务**不**去改轮记录，只让本项目自己的输出可分类；AC-104 的判据读的是**本项目输出**的分类字段与检查器的退出码。

## AC

- [ ] `bash scripts/suite-infra-attribution-check.sh` 退出码 0：基建形状失败被标 `kind=infra`，且仅断言失败的场景被标 `kind=assert`。
- [ ] 取假（确定性）：把分类逻辑退化为「一律 `kind=assert`」（即当前行为）时，同一检查器必须以非零退出并打印出它实际观察到的分类值。
- [ ] `bash scripts/test.sh` 退出码 0；且既有 `__PERFILE__` / `not ok - <file>` 行格式未变（下游解析器不回归）。
- [ ] `bash scripts/test.sh` 的失败行在**分类字段缺失时**不得静默通过——即该字段是显式存在的，不是可选装饰。

## DoD

真实落地判据：不是「多了一个字段」。要求在**同一台机器上真的造出**一次基建形状失败与一次真断言失败，并把两次 `scripts/test.sh` 输出中相应文件的分类字段原文记入完成记录；随后 AC-104 的 gate 由 `exit 127`（文件不存在）变为 `exit 0`。⛔ 仅新增检查器、或用合成字符串喂给它而不实跑 `scripts/test.sh` 不算完成。

## Touches

- scripts/test.sh
- scripts/suite-infra-attribution-check.sh
- tasks/gap-suite-infra-attribution.md
