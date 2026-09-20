---
id: gap-vitest-worker-pool-unbounded
title: vitest client worker 池无上限：loop 并发跑多个套件时 worker 成批死亡，致 fan-in 判红、任务
  exited-not-landed
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**判定机制（2026-09-20 实测 + 源码核对）**：vitest 的 client worker 池**没有上限**。选项解析链是 `opts.maxForks ?? config.maxWorkers ?? getDefaultThreadsCount()`，而 `getDefaultThreadsCount()` 取 `os.availableParallelism()` —— 本机 **128**。也就是说**单个** client 套件就能开出约 128 个 worker。

`scripts/test.sh:126` 调 `npx vitest run --reporter=json …` 不传任何池参数，`vitest.config.ts` 里也没有 `poolOptions` / `maxWorkers`；而 `scripts/test.sh:110` 的 `CONCURRENCY=4` **只管服务端 node:test**，管不到 client 侧的 vitest 池。

**为什么这是故障而不只是慢**：quay loop 会**同时**跑多个套件——每个任务 worker 自己就要跑一次 `bash scripts/test.sh`（它的 AC 判据之一），fan-in 阶段再跑一次。多个约 128 路的池并发 ⇒ Vite 模块服务被过订阅 ⇒ worker 在运行中成批死亡。其表现形态**与真实测试失败在套件报告层无法区分**：

```
not ok - src/shared/tests/busySessionIds.test.tsx: Error: STACK_TRACE_ERROR
not ok - …: [vitest-worker]: Timeout calling "fetch" with ["…/vitest.setup.ts","web"]
```

**实测证据（某任务的两次 fan-in）**：第一次 174 tests / fail 2，第二次 175 tests / fail 10（其中 5 条是 fetch 超时）。**两次失败的文件集合不同**；而两次都红的 `projectsStateSelectionSync.test.ts` 与 `busySessionIds.test.tsx` **单独跑是过的**（10/10），全量在干净树上也全绿 ⇒ 不是被测代码坏了。

**后果链**：fan-in 判红 ⇒ 任务不翻 done ⇒ `.quay/worker-outcome.jsonl` 记 `final_state: exited-not-landed`（`mechanical_fan_in.outcome: red`、`verdict.step: "suite"`）⇒ 驱动按设计用遗留 worktree 续做 ⇒ 撞同一个 flake ⇒ 重试耗尽 ⇒ 任务被 park 成 `needs-human`。本仓库当日累计 **81 条** `exited-not-landed` 记录。

**修法**：给 client 侧池加一个**自适应**上限（不是写死：小机器同样不该被要 8 个 worker，那等于从另一个方向重新引入过订阅）。本机实测代价：不封顶 4.97s、8 个 worker 7.53s、4 个 worker 13.43s ⇒ 取 8 几乎免费。

<!-- dedup-ref -->相关但不同：`gap-quay-tests-page-perfile-wrapper`（done）建的是 `scripts/test.sh` 这个入口本身（把 server node:test + client vitest + typecheck + lint 接进 quay tests 页）；本任务不改入口的职责，只给入口内部的 client 池加边界。

## AC

- [ ] `npx vitest run src/shared/tests/vitestWorkerPoolBound.test.ts` 退出码 0；该用例断言 `vitest.config.ts` 解析出的 `test.maxWorkers` 存在、`>= 1` 且 `<= 8`（即池被自适应封顶，不是 CPU 数）。
- [ ] 取假（确定性，必须真跑并留输出）：临时删掉 `vitest.config.ts` 里的 `maxWorkers` 一行后，上一条用例必须变红；恢复后转绿。
- [ ] 并发不变式：在项目根同时启动 3 个 `npx vitest run`，三个都退出码 0，且三份输出中 `STACK_TRACE_ERROR` 与 `Timeout calling "fetch"` 的计数**均为 0**。
- [ ] `bash scripts/test.sh` 退出码 0。

## DoD

真实落地判据：不是「配置里出现了这一行」。要求在真实 loop 里留下读数——**并发套件不再出现 worker 崩溃签名**：至少一次三进程并发的 `npx vitest run` 全绿且两串签名计数为 0，并把命令与输出记入完成记录；同时该上限在本机解析出的值落在 `[1, 8]`。⛔ 仅改配置、无并发实跑输出不算完成。

取假方向：把 `maxWorkers` 去掉后并发跑，应能观测到 `STACK_TRACE_ERROR` / fetch 超时。该方向受当时负载影响、**不保证每次复现**，故它是佐证而非判据；**判据是上面那条确定性取假（删行 ⇒ 断言用例变红）**。

## Touches

- vitest.config.ts
- src/shared/tests/vitestWorkerPoolBound.test.ts
- tasks/gap-vitest-worker-pool-unbounded.md
