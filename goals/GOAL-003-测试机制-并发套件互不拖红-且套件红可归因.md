---
id: GOAL-003
title: 测试机制：并发套件互不拖红，且套件红可归因
status: draft
kind: goal
origin: 落地复核 2026-09-20：两条任务的 worker 均 exit 0 跑满 5-7 分钟，却连续在 fan-in 的 suite
  步判红，而判红用的是每次都不相同的失败文件集合——任务级 AC 与 DoD 全绿，属性却仍然是假的。与 GOAL-002
  同形：目标级判据才能抓住这类缺口（人 yale 授权立此目标）。
---
背景：loop 里每个任务的 worker 自己就要跑一次全量套件（它的 AC 判据之一），fan-in 阶段再跑一次；而 client 侧的 worker 池没有上限——vitest 的默认值取 os.availableParallelism()，本机是 128。于是两个 worker 并发时就有两个约 128 路的池 + 两组各 4 个 server 测试进程同时抢机器。实测（同一份代码）：安静时服务端逐文件中位耗时 0.7s、Σ 153.6s；两个 worker 并发时中位升到 22.6s 与 41.3s、Σ 升到 3991.8s（26 倍）。由此产生 STACK_TRACE_ERROR、[vitest-worker]: Timeout calling fetch、以及 spawnSync ETIMEDOUT，而它们与真实断言失败在套件报告层同形，且每次失败的文件集合都不同——fan-in 因此判红，任务不翻 done。

范围：一是并发治理（client 池上限、全量套件单飞、负载准入）；二是失败归因（基建性红与真失败分开、无法归因的条目单独成段）。判据以两条 AC 的 checker 读数表达，不以配置里出现了哪些行为标志。

非目标：不改任何业务测试的断言；不放宽任何既有闸——不删测试、不缩 canonical glob（把测试删掉不叫变快）；不引入跨项目「一次只跑一个重测试」令牌（quay 已由人裁定整体删除该机制）；不设早杀 kill-on-red（quay 实测它把杀死时刻的在飞集合混进失败集，会伪造出「每轮浮出不同名单」的假象）。

退出条件：AC-103（并发 checker）与 AC-104（归因 checker）均 achieved，即两条判据由红转绿；或由人裁定放宽 / 取消其中任一条。