---
id: gap-resetmodules-cold-compile-timeout
title: vi.resetModules()+用例内动态 import 让整张模块图的冷编译挤进 vitest 默认 5s
  用例预算：并发下被拖红，AC-103 约 7 次红 1 次
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-103
---
## Proposal

**现象**：AC-103 的判据（`scripts/suite-concurrency-check.sh`）在 15 次实测里红 1–2 次，红的是它自己的条件①「2 份套件退出码均为 0」。红**不是**签名崩溃（每次红时 `STACK_TRACE_ERROR=0`、`Timeout calling "fetch"=0`，比值读数也远低于 K=4），而是一条**真实的负载敏感**：

```
FAIL src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts
  × a refresh that renames the selected project updates the selected copy          5005ms → Test timed out in 5000ms.
  × a refresh that changes nothing workspace-visible keeps the selected object identity  5008ms → Test timed out in 5000ms.
Test Files  1 failed | 72 passed (73)
```

同一文件在**安静机上**的逐用例读数（`npx vitest run <file> --reporter=verbose`）：

```
✓ a refresh that renames the selected project updates the selected copy   3637ms
✓ 其余 5 个用例                                                            80–150ms
Test Files 1 passed (1) | Tests 6 passed (6) | Duration 4.76s
```

**机制**（两个因素相乘，缺一不成）：

1. `src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts:83` 的 `afterEach(() => { vi.resetModules(); })` 让模块注册表**每个用例失效**，而 `:58` 的 `renderProjectsState()` 在**用例体内**用 `await import('@/modules/project-workspace/hooks/useProjectsState')` 重新求值整张 hook 依赖图（React + testing-library + 该 hook 的全部依赖）。于是**第一个用例**付掉整张图的**冷编译**代价 = 3637ms；此后各用例只付热求值 ≈150ms。这正是「同一文件里第一个用例 3637ms、其余 150ms」的唯一解释。
2. `vitest.config.ts` **没有声明 `testTimeout`** ⇒ 吃 vitest 默认 **5000ms**。3637 / 5000 ⇒ 余量只剩 **27%**。任何 CPU 争抢（另一个套件、另一个 worker、别的重活）都足以把这次冷编译推过线。并发实测里连安静时只要 150ms 的用例也被拖到 5008ms（整个 vitest worker 被饿死），说明红的不止那一条慢用例。

**这不是孤例，是一族**：`vi.resetModules()` + 用例内动态 import 的组合出现在 **11 个测试文件**（`grep -rl resetModules src/ --include='*.test.ts*'` 共 13 个，其中 2 个无动态 import 故不计入本机制）。其中 `src/shared/tests/busySessionIds.test.tsx:43` 正是 AC-103 origin 记录里**另一个被点名**的并发失败文件 —— 两个失败文件同一机制，而 AC-103 的判据只看到「套件 rc≠0」，看不到背后是「一族文件各自在 5s 预算内付冷编译」这一件事。

**⇒ 待办**：把「冷编译挤在某个用例的 5s 预算里」从源头去掉，而不是放宽判据。按下列顺序做（实现者按实测选路，但**不得跳过第 1 步**）：

1. **先做确定性读出（本任务主要产出）**。负载敏感不可复现就无法验收：既有判据只有在负载下才红，且只红 1/7，改完也无法证明改对了。正确形态是**余量**而非红绿 —— 对族内每个文件单独跑，解析最慢用例耗时 `T_max`，与该文件适用的 `testTimeout` 预算 `B` 相比，要求 `T_max ≤ B / K`。该读数是**确定性**的（不依赖机器负载）、且**可红**（当前树上 `3637 / 5000 = 0.73 > 1/K`）。
2. **把冷编译移出用例预算**：族内文件在 `beforeAll` 里预热一次模块图，使冷编译不再计入任何**用例**的 `testTimeout`（`hookTimeout` 是独立预算）。这是首选路径。
3. **只有第 2 步做不到时才动 `testTimeout`**：显式写进 `vitest.config.ts`（不再依赖隐式默认），且必须附实测余量。**单纯抬 `testTimeout` 会削弱套件的挂死探测**（AC-105 正为此而设），故不是首选；若确实要抬，DoD 必须给出「抬后仍能在预算内探到挂死」的读数。

**非目标**：不改任何业务断言；不删 `vi.resetModules()`（它是为用例间模块状态隔离而设，删掉会改测试语义）；不放宽 AC-103 的任一条件（本任务是把条件①变绿，不是在判据上让步）；不引入跨项目重操作令牌。

## AC

- [ ] AC1：`bash scripts/test-timeout-margin-check.sh` 存在，且在**当前树上以非零退出**，并在**同一行**打印族内最差文件的 `T_max`、预算 `B`、比值与阈值 `1/K`（红先行：先观测到红，再动手修）。
- [ ] AC2：修复后 `bash scripts/test-timeout-margin-check.sh` 退出 0，且读数里族内**每一个**文件的 `T_max ≤ B / K`。
- [ ] AC3：`vitest.config.ts` 显式声明 `testTimeout`（`grep -E 'testTimeout' vitest.config.ts` 命中 ≥1 行），且判据脚本把从该显式值读到的 `B` 打进自己的判词（不再隐式假定 5000ms）。
- [ ] AC4：`bash scripts/suite-concurrency-check.sh` 连续 5 次退出 0（`for i in $(seq 5); do bash scripts/suite-concurrency-check.sh || echo "run $i red"; done`）。⚠️ 这条只是**旁证**：修复前它本就是 13/15 绿，5 连绿不构成证明；真正的判据是 AC2 的确定性余量读数。

## DoD

真实落地，不是「脚本存在」：

- 族内 11 个文件在安静机上逐个跑出的 `T_max` 表（文件名 / 最慢用例 / 耗时 / 预算 / 比值）作为完成记录写进本任务 —— 这是「余量」这条判据与 K 取值的原始数据。K 的默认值只是首版待钉值，须由该分布数据支撑（本仓既有纪律：分布数据出来之前不设阈值）。
- 至少一次**真实并发**实测：修复后的树上跑完 `scripts/suite-concurrency-check.sh`，其 `concurrent-suite-*.out` 里 `projectsStateSelectionSync.test.ts` 的逐用例耗时**不再出现 5000ms 上限截断**（不再是 `5005ms → Test timed out`），该文件 6/6 通过。
- AC1 的红先行证据保留：修复前的非零退出与读数字样粘贴在本任务下。
- 若最终走第 3 条路径（抬 `testTimeout`），必须另附「故意挂死的用例仍能在预算内被探到」的读数 —— 否则等于用放宽超时掩盖了挂死探测。

## Touches

- `scripts/test-timeout-margin-check.sh`（新增：本任务的确定性判据）
- `vitest.config.ts`（显式 `testTimeout`；走第 3 条路径时必改）
- `src/modules/project-workspace/tests/projectsStateSelectionSync.test.ts`（已验证的失败文件，冷编译须移出用例预算）
- `src/shared/tests/busySessionIds.test.tsx`（同族，AC-103 origin 点名的另一个并发失败文件）
- `src/modules/project-workspace/tests/projectsStateSessionAlias.test.ts`
- `src/modules/project-workspace/tests/projectsInitialFetch.test.tsx`
- `src/modules/chat/tests/markdownSyntaxThemeInjection.test.tsx`
- `src/modules/chat/tests/chatProviderModels.test.ts`
- `src/modules/chat/tests/sessionStoreTruncate.test.tsx`
- `src/modules/chat/tests/transcriptScrollOwnership.test.tsx`
- `src/modules/chat/tests/tokenUsageFreshness.test.tsx`
- `src/modules/settings/tests/settingsControllerCodeEditor.test.ts`
- `src/shared/tests/authenticatedFetch.test.ts`
- `tasks/gap-resetmodules-cold-compile-timeout.md`（本任务自身）
