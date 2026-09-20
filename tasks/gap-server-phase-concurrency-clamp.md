---
id: gap-server-phase-concurrency-clamp
title: 服务端阶段并发照单全收：fan-in 塞入远大于 4 的并发 ⇒ 一批 50s+ 重 e2e 互踩、每次红在不同文件，任务反复被 park
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**人（yale）2026-09-21 裁定：直接补。** GOAL-003 决定记录里的「补锁 / 补闸的触发条件（**不得提前**）……AC-103 的 checker 在真实并发下测出脏读数时才补」这条禁令，就其**触发源**（AC-103 的 checker 而非 fan-in 的 lane-wide 读数）而言未被字面满足；人已裁定 **fan-in 侧的读数即已足够算数**，本任务据此立案。裁定记录在案，供审计。

**现象：一个任务被同一机制连环误杀三次，每次红在【不同的文件】。**

`gap-model-env-kind-explanations`（4/4 AC 已勾、实现完整）的三次 fan-in 判红：

| ts | 失败文件 | 耗时 |
|---|---|---|
| 13:52:37 | `src/shared/tests/busySessionIds.test.tsx` | 7.3s |
| 14:29:45 | `server/modules/cli/tests/cli-environment-bootstrap.test.ts` | 44.4s |
| 16:23:45 | `server/modules/launch-profiles/tests/gateway-end-to-end.test.ts` | 56.3s |

**「每次失败的文件都不同」本身就是机制指纹**，不是三个各自独立的坏测试。

**机制**（`scripts/test.sh` 照单全收并发数）：

- `scripts/test.sh:27` ⇒ `CONCURRENCY=4`（默认）；`:36-38` ⇒ `--test-concurrency=*` **逐字**写入 `CONCURRENCY`，只挡空值/非数字/0；`:481` ⇒ 服务端阶段用 `while [ "$(jobs -rp | wc -l)" -ge "$CONCURRENCY" ]; do wait -n; done` 节流。
- 于是调用方给多大就并发多大。fan-in 的 runner 会塞入一个远大于 4 的值（本仓实测 `end_ms` 有 **10–12 个文件在 0.5s 内同时结束**，并发度下界 10–12），**而本仓服务端有一批 50s+ 的重 e2e/服务测试**。

16:23 那一次的原始判词（`.quay/fan-in-suite-gap-model-env-kind-explanations~wk-prod-anchor~1789921327335-cb8e49.log`）：

```
__PERFILE__ duration_ms=56337 server/modules/launch-profiles/tests/gateway-end-to-end.test.ts passed=false end_ms=1789921413723
not ok - server/modules/launch-profiles/tests/gateway-end-to-end.test.ts: Error aborting session gateway-e2e-session: Error: Query closed before response received
```

同一次运行里的对照读数（**关键反证：不是这些测试自己有缺陷**）：

```
58193ms passed=true  server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts
56337ms passed=false server/modules/launch-profiles/tests/gateway-end-to-end.test.ts
52400ms passed=true  server/modules/projects/tests/session-filter-realdata.test.ts
50471ms passed=true  server/modules/providers/tests/provider-runtime.service.test.ts
49954ms passed=true  server/modules/browser-use/tests/browser-use.service.test.ts
```

即：**同批的孪生文件 58.2s 通过、失败的那个 56.3s**，且失败走的是它**自己的中止路径**（`Error aborting session …`）—— 是内部截止时间被踩，不是断言失败。

**⛔ 已排除的一条错路（勿再走）**：不是固定端口冲突。两个 gateway e2e 都用 `http.createServer` + `AddressInfo`（绑定临时端口），且 `server/**/*.test.ts` 里搜不到硬编码测试端口。往端口方向查会浪费一轮。

**要做的事**：给服务端阶段的并发加**上限**，使调用方给多大都不会过订阅，同时**不夺走调用方的调低能力**。

1. 在 `scripts/test.sh` 里为 `CONCURRENCY` 加一个**上限夹取**（形如 `CONCURRENCY=$(clamp "$CONCURRENCY" "$CEILING")`），上限**由本任务的实测推出**、不许凭感觉写；允许用环境变量覆盖上限以便调整。
2. ⛔ **不得把 `--test-concurrency=4` 变成别的值**：调用方调**低**必须原样生效（既有契约，且 `gap-suite-hang-watchdog` 的 AC 也在断言它）。夹取只在**超过上限**时发生。
3. 新增 `scripts/server-phase-concurrency-check.sh`：确定性判据（不依赖机器负载）—— 断言 ① 传入极大值时被夹到上限（可见于 dry-run 行）；② 传入 4 时仍是 4；③ 上限值有实测依据（读数打印在判词里）。任何失败都要在**同一行**带出成因（本仓库 AC 硬校验），不得用裸 `grep -q` 链。
4. ⛔ 不得删除/跳过任何测试，不得放宽 `__PERFILE_KIND__` 的「拒绝豁免」语义（`infra` 标签在 quay 策略下是**不可逆豁免**，不是本任务可用的出口），不得改 `__PERFILE__` 行格式。

**非目标**：不改任何业务测试的断言；不移植 quay 的 `@load-sensitive` 隔离重跑（人本次选了夹取上限这条更小的路径；若后续实测显示夹取仍不够，再另立任务）；不动 client 侧的 vitest 池上限（那是 `gap-vitest-worker-pool-unbounded`，已 done）。

## AC

- [ ] AC1（红先行，确定性）：`bash scripts/server-phase-concurrency-check.sh` 在**当前树上以非零退出**，且判词带出实测到的越界并发值（当前 `QUAY_TEST_DRY=1 bash scripts/test.sh --test-concurrency=100` 打印 `concurrency=100`，即未夹取）。
- [ ] AC2：修好后 `bash scripts/server-phase-concurrency-check.sh` 退出 0；其判词显示 `--test-concurrency=<极大值>` 被夹到上限、而 `--test-concurrency=4` 仍为 4。
- [ ] AC3：上限有实测依据 —— 完成记录里给出**并发坡度表**（N 取几档 × 墙钟 × 该档是否出现 `passed=false`），并据此说明上限取值与余量倍数；该表可复算。
- [ ] AC4：`QUAY_TEST_DRY=1 bash scripts/test.sh` 与 `QUAY_TEST_DRY=1 bash scripts/test.sh --test-concurrency=4` 的输出行格式未变（`dry run: args consumed (concurrency=<n>, files=<m>)`）；`bash scripts/test.sh` 全量退出 0，且 `__PERFILE__` 行格式未变。

## DoD

真实落地，不是「多了一个变量」：

- 在**同一台机器**上跑出一条**并发坡度表**（至少 4 档，含当前的越界档与拟取的上限档），每档记录：并发值、服务端阶段墙钟、失败文件集合（若空则记空）。这是 AC3 的原始数据，也是「上限」与余量倍数的唯一依据。
- **复现并记录一次真实越界**：在未夹取的状态下跑一次高并发，把一条 `passed=false` 的 `__PERFILE__` 行与其 `not ok` 判词贴进完成记录 —— 这是「修好了什么」的证据。
- 夹取落地后，至少一次**同规模**高并发实跑，服务端阶段不再出现 `passed=false`（或即使出现，其失败文件集合与未夹取档**不再呈现『每次不同』**这一指纹）。
- `gap-model-env-kind-explanations` 若能在本任务落地后成功 land（其 AC 已全勾、只卡在 suite 步），把该次 `completed` 的 `worker-outcome.jsonl` 行记入本任务 —— 这是端到端的因果闭合。
- ⛔ 仅改 `CONCURRENCY` 默认值而无坡度表，或未经复现越界就宣称修好，不算完成。

## Touches

- `scripts/test.sh`（`CONCURRENCY` 取值段与夹取）
- `scripts/server-phase-concurrency-check.sh`（新增：本任务的确定性判据）
- `tasks/gap-server-phase-concurrency-clamp.md`（本任务自身）
