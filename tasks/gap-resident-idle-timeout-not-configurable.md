---
id: gap-resident-idle-timeout-not-configurable
title: AC-181 常驻空闲超时写死为 24 小时常量、无配置入口：加配置入口，默认不变，忙宿主不被关
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-181
---
## Proposal

**现状读数（2026-09-29）。** goal 正文写「空闲关闭（24 小时，可配置…）」。实际 `server/modules/session-hosts/session-host-manager.service.ts:60` 是 `export const RESIDENT_IDLE_TIMEOUT = 24 * 60 * 60 * 1000;`，`:90` 的 resident 策略 `quietCeilingMs: RESIDENT_IDLE_TIMEOUT` 直接引用它。全库 `grep -rn "RESIDENT_IDLE_TIMEOUT\|quietCeilingMs" server --include=*.ts` 排除测试后，没有任何环境变量或设置项读它。因此「可配置」没有实现；24 小时也没法在真机上等，空闲关闭无法被真实观察。AC-165 用固定 24 小时的注入时钟测，对这一点读绿。

**要做的事。** 给 resident 的空闲超时加一个配置入口（环境变量或现有设置存储，由 worker 读过 `server/modules/session-hosts/` 与现有配置面后择一，要求：默认仍是 24 小时；值非法时回落默认，不抛错；只影响 resident，不影响 per-run 的静默上限）。

## Plan

1. 读 `session-host-manager.service.ts` 的 `policyFor`、`:393`、`:434` 两处 `quietDeadlineAt` 计算，确定配置值在哪一处读取才对已存在的宿主与新宿主都成立。
2. 写 `server/modules/session-hosts/tests/resident-idle-timeout-config.test.ts`（放在 session-hosts 模块自己的 `tests/`）：注入时钟。红态先行。
3. 加配置入口，跑绿。
4. 取假形态：配置入口被忽略（仍用常量）、配置值把有 turn 租约的宿主也关掉，各必须红。
5. `npm run typecheck`（server 环）与 `npm run lint` 绿。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-idle-timeout-config.test.ts` 退出 0。红态基线：改代码前该文件不存在或红。
- [x] AC2 配置生效：把超时配成很短的值，注入时钟推进过该值，空闲的 resident 宿主关闭且 `closeReason` 为 `idle`。
- [x] AC3 忙不被关：同一时刻持有 turn 租约的宿主不关闭（正控制，证明不是无差别关）。
- [x] AC4 默认不变：不配置时读回 `86400000` 毫秒，`24 * 60 * 60 * 1000`。
- [x] AC5 非法值回落：配置为负数、0、非数字时回落到默认，不抛错。
- [x] AC6 取假形态必须红（承重）：配置入口被忽略 ⇒ AC2 红；配置值把忙宿主也关掉 ⇒ AC3 红。先提交再变异，用 `git checkout` 恢复，登记逐字失败行。
- [x] AC7 `npm run lint` 退出 0；`git diff --stat` 与 Touches 逐条对齐。**若实现需要动 Touches 之外的文件，先把该文件加进 `## Touches` 再写**，声明必须覆盖实际写入。

## DoD

- 默认值与既有 AC-165 的读数不变（`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-idle.test.ts` 仍退出 0）。
- 配置入口只有一个读取点，不在多处各读一遍。
- 后端改动遵守 `.agents/skills/backend-module-standards/SKILL.md`。
- 只动 Touches 列出的文件。

## 实现

配置入口取**环境变量** `SESSION_HOST_RESIDENT_IDLE_TIMEOUT_MS`（毫秒）。不取设置存储：`sessionHostManager` 在模块加载期构造，早于任何按用户、落库的设置可被读取；服务器其余进程级超时（`VOICE_TIMEOUT_MS`、`CLOUDCLI_BROWSER_USE_SESSION_TTL_MS`）同为此形。读取点只有一处——`createSessionHostManager` 构造 resident 策略时调用一次私有的 `readResidentIdleTimeoutMs()`，因此该 manager 打开的每个宿主（已在飞的与新开的）都量同一根尺；`DEFAULT_RESIDENT_POLICY` 常量本身仍是 24 小时的出厂默认，显式的 `residentPolicy` 覆盖仍优先于入口。非法值（空串、负数、0、非数字）回落默认且不抛。per-run 的 `PER_RUN_QUIET_CEILING_MS` 未动。

## Evidence

- 红态基线：实现前该测试文件不存在；写入后、加配置入口前，AC2/AC3 逐字红：`AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` / `86400000 !== 5000`。
- AC6 假形态 (a)「配置入口被忽略」（把构造处的 `quietCeilingMs: readResidentIdleTimeoutMs()` 改回 `RESIDENT_IDLE_TIMEOUT`；基于提交 `4a3cf0b9` 变异，`git checkout -- <file>` 恢复）：AC2 逐字失败行 `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 86400000 !== 5000` at `resident-idle-timeout-config.test.ts:240:10`（AC3 同因红，`:320:10`）。
- AC6 假形态 (b)「配置值把忙宿主也关掉」（`deriveState` 的 busy 分支去掉 `clearQuietClose(host)`，使开宿主时按配置值armed 的静默时钟继续跑；`git checkout` 恢复）：AC3 逐字失败行 `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` / `expected: null,`（`busy.quietDeadlineAt` 仍为 `1700000005000`）at `resident-idle-timeout-config.test.ts:294:10`；另以探针读数坐实该忙宿主在时钟推进 5000ms 后被关：`after advance 5000: state= closed closeReason= idle`。
- 判据读数：AC2 `idle-config-a configured=5000 armed-ceiling=5000 ... closed-at=1700000005000 closeReason=idle`；AC3 `idle-config-b busy state=busy leases=resident-policy+turn quietDeadlineAt=null`，同刻 idle 兄弟 `idle-sibling-state=closed idle-sibling-closeReason=idle`，turn 释放后按配置值 5000 重新 arm 并再关为 `idle`；AC4 `idle-config-default env=unset exported=86400000 armed-ceiling=86400000`；AC5 `raw="-1"/"0"/"not-a-number" armed-ceiling=86400000` 且 `doesNotThrow`。
- `npm run lint` 退出 0，触碰文件无 finding；`npx tsc --noEmit -p server/tsconfig.json` 退出 0；AC-165 `claude-resident-idle.test.ts` 与 `session-host-lifecycle.test.ts` 仍绿。
- `git diff develop --numstat`：`server/modules/session-hosts/session-host-manager.service.ts` +56/-2、`server/modules/session-hosts/tests/resident-idle-timeout-config.test.ts` +369/-0，与 Touches 一致（未新增 Touches 之外的文件）。

## Touches

- tasks/gap-resident-idle-timeout-not-configurable.md
- `server/modules/session-hosts/session-host-manager.service.ts`
- `server/modules/session-hosts/tests/resident-idle-timeout-config.test.ts` (new)
