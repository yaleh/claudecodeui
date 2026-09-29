---
id: gap-claude-resident-remote-control-isolation-arm-outside-harness
title: AC-176 判据的假形态臂 (3)/(4) 在环境 DB 未迁移时恒红：arm (3) 不走 withRemoteControlHarness
  ⇒ createSdkResidentProcess 的 launch-spec 解析读 provider_models 抛 no such table ⇒
  宿主未注册、20s 超时；让判据自带它需要的 DB 事实
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Finding

<!-- dedup-ref --> 本条是机械 fan-in suite 的一个**确定性**红的修复项，不是任何在飞任务的 delta：判据
`server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts`（AC-176，拥有者
`gap-claude-resident-remote-control-isolation`，`status: done`）在当前 develop 上恒红，红在它自己的两条假形态臂上，
真断言 (1)/(2a)/(2b)/(5)/(6)/(7) 全绿。相关的独立机制（另一个 in-flight 任务的 delta 都不是这条红）见 `gap-resident-enter-send-bypasses-intent-and-consent-gate` 的 Evidence。

**逐字读数（本轮实测；本仓 main checkout 与任务 worktree 各跑一遍，两处同红）。**

```
✖ (3) 假形态 (a)：检测到开启仍照常启动 ⇒ 门的读数必须红 (20028.841054ms)
  Error: Timed out after 20000ms waiting for the mutated build to open a resident host despite the enabled user settings
✖ (4) 假形态 (b)：启动时不传那两项 flag settings ⇒ 读回的读数必须红 (2.667049ms)
  { code: 'SQLITE_ERROR' }
ℹ pass 6 / fail 2
```

**真因（本轮插桩读到的未捕获 runError，逐字）。** 假形态臂 (3) 直接构造 driver
（`createFakeClock` + `createSessionHostManager({ now, scheduler: clock })` +
`new ClaudeResidentHostDriver({ host, ... createProcess: createScriptedProcess(), userSettingsPath: elsewherePath })`），
**不走 `withRemoteControlHarness`**，因此 `DATABASE_PATH` 仍是环境里的默认值。它的 `createProcess` 调
`createSdkResidentProcess` ⇒ `buildResidentSdkOptions` ⇒ `mapCliOptionsToSDK`
（`server/modules/providers/list/claude/claude-runtime.provider.js:310`）⇒ `resolveModelLaunchSpec`
（`server/modules/providers/services/model-launch-spec.service.ts:35`）⇒ `findCustomProviderModelByModelId` 读 `provider_models` 表：

```
SqliteError: no such table: provider_models
  at Object.findCustomProviderModelByModelId (server/modules/database/repositories/provider-models.ts:74)
  at resolveModelLaunchSpec (server/modules/providers/services/model-launch-spec.service.ts:35)
  at mapCliOptionsToSDK (server/modules/providers/list/claude/claude-runtime.provider.js:310)
  at buildResidentSdkOptions (server/modules/providers/list/claude/claude-host-driver.provider.ts:1396)
  at createSdkResidentProcess (server/modules/providers/list/claude/claude-host-driver.provider.ts:1463)
```

该异常在 `startResidentHost` 里先于 `this.host.openHost(...)` 抛出，所以宿主从未注册进 manager，`waitFor`
（`claude-resident-remote-control-isolation.test.ts:903`）20s 超时；臂 (4) 随后因脏 setup 报 `SQLITE_ERROR`。

**为什么 `provider_models` 不在。** 环境里的默认 `database/auth.db`（被 `.gitignore`（`*.db`）挡住，每个 checkout 各一份）
只有 `app_config` 一张表——本轮实测：worktree 的 `database/auth.db` 与 main checkout 的 `database/auth.db` 都是
`count=1, has provider_models=false`。真断言臂没这个问题，是因为它们跑在 harness 里
（`DATABASE_PATH = <temp>/auth.db`，第 543 行），那份库被迁移过。

**归属证据。** (a) 判据文件在 develop 上逐字未变（拥有者任务已 done），本条的修复面只在判据/其 DB 夹具；
(b) 本轮 suite 日志里 `gap-resident-enter-send-bypasses-intent-and-consent-gate` delta 覆盖的前端测试全 `passed=true`，
三个 `passed=false` 全在 `server/`（另外两个是 model-gateway 的 /tmp teardown 竞态与 voice-dashscope-settings 的 AC8 并发探针竞态，两者单独重跑都退 0）；
(c) main checkout（非 worktree）单独跑同一条命令同样退 1 且同一句。

⇒ 这是 done 任务的判据对**环境默认 DB** 的隐含依赖，被后来的共享依赖（`buildResidentSdkOptions` 走 DB 的 launch-spec 解析）打穿。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` 在**环境 `database/auth.db` 只有 `app_config` 一张表**的 checkout 里退出 **0**（该条件下的红态基线：退出 1，`fail 2`，红在 (3)/(4)，`runError` 逐字含 `no such table: provider_models`）。
- [ ] 假形态臂 (3) 的承重读数恢复：`waitFor` 不再超时，`manager.snapshot()` 里出现 `mode === 'resident' && state !== 'closed'` 的宿主，且随后 `assert.strictEqual(runError, null, 'the mutated gate must let the launch through, not refuse it')` 通过（逐字登记该臂的 `假形态 (a)：……仍起了常驻宿主 <hostId>` 读数行）。
- [ ] 假形态臂 (4) 不再报 `SQLITE_ERROR`（若其依赖 (3) 的 setup，随 (3) 一起恢复）。
- [ ] 修复**不改**真断言臂 (1)/(2a)/(2b) 的读数语义：修复后该文件 `pass 8 / fail 0`，真断言仍逐字读回拒绝码、两项 flag settings、请求值/检测值两个字段。
- [ ] 独立负控制：在**环境 DB 已迁移**（`database/auth.db` 含 `provider_models`）的 checkout 里，修复前该文件也退 0——即修复针对的是「环境 DB 未迁移」这一条件，不是把断言放宽或跳过。
- [ ] `npm run typecheck` 与 `npm run lint` 退出 0（判据 import 仍只经 barrel）。

## DoD

真落地：在交付树上**真的**在「环境 `database/auth.db` 只有 `app_config`」的条件下跑一次判据命令，读到 `tests 8 / pass 8 / fail 0`、退出 0；把修复前后的两段读数（`fail 2` 的 (3)/(4) 与 `pass 8`）逐字写进 Evidence。修复须让判据**自带**它需要的 DB 事实——例如把 (3)/(4) 也放进 `withRemoteControlHarness`，或显式把 `DATABASE_PATH` 指向一份迁移过的临时库，或注入 launch-spec 缝——不得靠「跑之前手工迁移仓库里的 `database/auth.db`」，那正是它在别的 checkout 上恒红的原因。若最终选择改产品侧（让 launch-spec 解析在缺表时回退），在完成记录里写明理由与该回退的负控制读数。

## Touches

- `server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts`
- `tasks/gap-claude-resident-remote-control-isolation-arm-outside-harness.md`