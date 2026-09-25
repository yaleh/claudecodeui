---
id: gap-vitest-worker-heap-limit
title: vitest 工作进程堆上限：失控用例在配置层被秒级掐死，不再靠 24G 的 cgroup 兜底、也不因直接 npx vitest 绕过
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景（2026-09-25 实测，证据见 `docs/operations/process-isolation-and-memory-caps.md`）：一个失控的 vitest 用例（`chatComposerResponsive.test.tsx`，工作树里一行 `ChatComposer.tsx` 改动）14 秒内长到 12G，在没有上限时 scope 峰值 218.8G/252G，OOM killer 收走了整个 tmux scope，包括 :3001 server。用户 journal 里同一天另有 60G、217.8G、31.9G 三次同形态的 OOM，未逐一定根因。现有护栏 `scripts/with-memory-cap.sh`（默认 24G）只挂在 `npm run test:client` 与 `scripts/test.sh` 的 client 阶段；**直接 `npx vitest run` 不经过它**，9/25 08:58 那次正是这样发生的。且 24G 太宽：失控要吃到 24G 才死，宿主同时还有别人的进程。

方案：在 `vitest.config.ts` 里给 worker 固定 V8 堆上限（vitest 3.2.7 用 `test.poolOptions.forks.execArgv: ['--max-old-space-size=<MB>']`；先在本仓确认默认 pool 确为 forks，若不是则改对应 pool 的选项）。配置层的上限对任何入口（npx、npm run、scripts/test.sh、编辑器插件）一律生效，失控用例在秒级以清晰的 heap-limit 失败，而不是拖垮同 cgroup 的其他进程。

约束与取舍：
1. 上限值必须由实测推出，不许凭感觉：先用 `vitest run --logHeapUsage` 跑一遍完整 client 套件，记下单文件最大堆读数，上限取该读数的 3 倍以上并写明倍数；允许 `QUAY_VITEST_HEAP_MB` 环境变量覆盖（`off` 表示不加参数，供排障与本任务的对照用）。
2. V8 堆上限只约束 JS 堆，不约束 Buffer/external/原生内存；失控若走这些通道，仍由 `with-memory-cap.sh` 的 cgroup 上限兜底。两层是叠加关系，不替换：不得删除或放宽 `with-memory-cap.sh`。
3. 判据的正对照必须有：一个只占用上限 30% 左右的良性用例必须仍然绿，防止上限把正常用例误杀。

## AC

- [ ] `bash scripts/vitest-heap-limit-check.sh` 退出 0：脚本用一个临时的「不断保留对象」失控夹具，**直接** `npx vitest run`（不经过 `with-memory-cap.sh`，也不设 `QUAY_MEMORY_MAX`），断言 (a) vitest 退出码非 0，(b) 输出含堆耗尽或 worker 异常退出的证据，(c) 整个进程树的 RSS 峰值（采样 /proc）不超过上限的 1.5 倍，(d) 总墙钟不超过 30 秒。任何一项不满足，判词在同一行带出具体读数与成因。
- [ ] 同一脚本的正对照通过：占用约上限 30% 的良性夹具退出 0，判词写出其读到的堆用量与上限。
- [ ] 同一脚本的证伪模式 `bash scripts/vitest-heap-limit-check.sh --falsify` 退出非 0：把 `QUAY_VITEST_HEAP_MB=off` 后同一失控夹具越过上限 3 倍（由脚本自己的看门狗在该处杀掉并记为「未受限」），证明判据在没有配置上限时会红，而不是无论如何都绿。
- [ ] `node --test scripts/vitest-heap-limit-check.test.mjs` 退出 0：断言脚本的判词分支（受限/未受限/良性误杀/夹具残留）各有一条用例，且脚本结束后 `git status --porcelain` 不含夹具文件（夹具必须在 trap 里清除，包括失败与被信号打断的路径）。
- [ ] `npx tsc --noEmit -p scripts/tsconfig.json` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：不是配置里多了一行。要求 (1) 在完整 client 套件上实跑 `npm run test:client`，退出 0，并把 `--logHeapUsage` 的单文件最大堆读数、所选上限与倍数写进 Evidence；(2) 在一次性工作树里重放 9/25 的原始失控（`ChatComposer.tsx` 去掉 `!hasPendingPermissions` 一处条件后跑 `chatComposerResponsive.test.tsx`）。若能复现，记录它在新上限下多快失败、RSS 峰值多少；若该失控走的是非 JS 堆通道、上限拦不住，如实写出并说明仍由 24G cgroup 兜底，**不得**只用合成夹具就宣称原事故已堵。(3) 文档 `docs/operations/process-isolation-and-memory-caps.md` 增补两层护栏的分工与覆盖变量。实施前先读 AGENTS.md 指向的前端模块规范，本任务只改配置与脚本，不碰 `src/` 业务代码。

该轴仍暗，理由：纯测试基础设施，没有可独立度量的 L_D/L_G 读数；验收以上面的脚本判据与完整套件实跑读数为准。

## Touches

- vitest.config.ts
- scripts/vitest-heap-limit-check.sh (new)
- scripts/vitest-heap-limit-check.test.mjs (new)
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-vitest-worker-heap-limit.md
