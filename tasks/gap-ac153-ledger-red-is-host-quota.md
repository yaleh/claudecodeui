---
id: gap-ac153-ledger-red-is-host-quota
title: AC-153 的台账读数被宿主配额耗尽（EDQUOT）在判据启动前冒名成红：重跑判据与反假控制并重建读数，钉住「宿主启动死 ≠ 判据假」
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-153
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，宿主本地 2026-09-28 05:1x CST = UTC 2026-09-27 21:1xZ，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `01afb8cbb98cf1ee55c46f9997a5718a2b593927`）：`grep -rn "^goal_ac: *AC-153" tasks/*.md` → 2 命中，两条都是 `done`（`gap-voice-error-notice-browser-e2e`、`gap-ac142-refusal-leg-copy-repoint`），全量 227 条 `tasks/*.md` 里没有第三条，也没有任何 todo/ready/needs-human 的认领者。按本轮规则的默认读法是「更早的修复没守住 ⇒ 立新条」，**本条的直接测量推翻了这个默认读法**，所以本条不是「再修一次」。

**本轮的直接测量（我在同一 checkout 上重跑判据本体，不是台账尾巴）**

```
$ npx playwright test e2e/voice-error-messages.spec.ts
legs=4 coded=4 distinct=3 chinese=4
empty-200="录音里没有检测到人声——请靠近麦克风重新录制。" server-422="录音里没有检测到人声——请靠近麦克风重新录制。" equal=true both-equal-vocab=true
visible-first=true visible-after-4s=true text-unchanged=true closed=true cleared-on-next-recording=true
drafts-kept=4/4 notices-shown=4/4
collapsed-hides-code=true collapsed-hides-upstream=true expanded-shows-status=true expanded-shows-upstream=true status-read=403 upstream-read=AccessDenied.Unpurchased concat-hits=0
legs=4 passed=4 criterion-wall-ms=24796 watchdog-line=false
  1 passed (24.8s)
EXIT=0
```

AC-153 的 expect 点名的每一条读数都在场：四条腿各自的 code 文案（`coded=4`）、中文界面读到中文文案（`chinese=4`）、4 秒之后仍可见（`visible-after-4s=true`）且逐字未变（`text-unchanged=true`）、点关闭后消失（`closed=true`）、下次录音时被清除（`cleared-on-next-recording=true`）、草稿逐字保留（`drafts-kept=4/4`，`notices-shown=4/4` 是它的正对照）、折叠详情行展开前读不到 code 与 upstreamCode 而展开后读得到、无拼接句（`concat-hits=0`）、空 200 与服务端 422 同一条文案（`equal=true both-equal-vocab=true`）。

同一棵树上，判据所依赖的**承重反假控制**也全绿（`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx`，exit 0，3 passed / 1.33s）：

```
mutation=four-second-timer lever=the pre-change timer restored in the failure handler … base-green=true mutant-red=true which=AC4 visible-after-4s outside-family-green=true (AC4 closed-on-close-control)
mutation=concat-message … base-green=true mutant-red=true which=AC2 sentence-equals-code-copy + AC6 concat-hits outside-family-green=true (AC4 visible-after-4s)
mutation=clear-draft-on-failure … base-green=true mutant-red=true which=AC5 draft-kept outside-family-green=true (AC4 visible-after-4s)
```

⇒ 这是**可证伪的绿**：三条取假形态各自被指名打红，且读的是同一棵出货组件。

**为什么台账尾巴读 fail：宿主配额耗尽（errno −122 = EDQUOT）在判据启动前把它打死**

`.quay/gate-events.jsonl` 里 AC-153 的 `gate=goal` 读数共 1771 条，**尾巴是 14 连 `pass` 之后接 2 条 `fail`**：

```
2026-09-27T19:24:07.670Z  goal-sweep  pass
2026-09-27T21:04:41.412Z  goal-sweep  fail  Error: Unknown system error -122: Unknown system error -122, mkdtemp '/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-XXXXXX' at mkdtempSync (node:fs:3134:18) at makeTempDir (file:///…/scripts/e2e-data-dir-selection.mjs:268:59) at resolveE2eDataDir (…:294:19) at file:///…/playwright.config.ts
2026-09-27T21:05:56.704Z  goal-cli    fail  （同上，逐字相同）
```

两条 `fail` 的判词都是 **errno −122（Linux 的 `EDQUOT`，用户配额耗尽）**，失败点是 **`mkdtemp`**：判据本体**一次都没开始跑**，谈不上「AC-153 的行为退化了」。同一窗口（`21:04:31.986Z`–`21:05:56.704Z` = 本地 `05:04:31`–`05:05:56` CST）里，**同一原因的 `fail` 共 12 条、跨 7 条 AC**（AC-151×2、AC-153×2、AC-171、AC-172、AC-173×2、AC-174×2、AC-175×2）—— 这 7 条判据连文件都不共享，`12 条独立回归` 不成立；这是宿主故障的指纹。

**同一宿主上，红与绿的间距只有 8 分钟**：`21:02:40Z`–`21:04:31Z` 之间 `~/.cache/quay-e2e-tmp` 新出现 6 个 data dir，其中 **4 个内容为空**（`mkdtemp` 成功、写不进任何东西 ⇒ 启动即死，与那两条 `fail` 同形）；配额缓解之后，**同一条判据在 `21:13:07Z`（本地 `05:13:07` CST）直跑为绿**（上一节）。`/data` 上 `df` 全程显示 `14%` 不紧张 —— `EDQUOT` 是**配额**不是**容量**，`df` 对它无读数，这正是它容易被读成「AC 假」的原因。

**本条的交付面**

把上两节做成**可复核的入档读数**，并把「宿主启动死 ≠ 判据假」的区分钉成下次可机械复用的判法：判据直跑读数（AC1）、反假控制读数（AC2）、台账归因读数（AC3）、尾巴重建或如实登记（AC4）、空 delta 证明（AC5）、根因登记（AC6）。**本条不改任何实现、判据、宿主配置字节**：`~/.cache/quay-e2e-tmp` 无回收者是一个跨任务的共享资源问题（本条立案时实测 572 个目录 / 25G，且没有清理入口），属于另一条任务；本条只登记它，不在这里夹带修它。

## AC

- [ ] AC1 判据直跑：`npx playwright test e2e/voice-error-messages.spec.ts` 退出 0；把判据自己打印的读数行**逐字**抄进完成记录（`legs=4 passed=4`、`coded=4`、`chinese=4`、`visible-after-4s=true`、`text-unchanged=true`、`closed=true`、`cleared-on-next-recording=true`、`drafts-kept=4/4`、`notices-shown=4/4`、`collapsed-hides-code=true`、`expanded-shows-status=true`、`expanded-shows-upstream=true`、`concat-hits=0`、`equal=true`、`both-equal-vocab=true`，以及 `EXIT=0`），并同时给出跑动时刻（`date -u`）与 `git rev-parse HEAD`。
- [ ] AC2 反假控制承重：`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` 退出 0，且三例各自打印 `base-green=true mutant-red=true outside-family-green=true`；完成记录里按名字指出各自红的是哪条读数（`four-second-timer` → `AC4 visible-after-4s`；`concat-message` → `AC2 sentence-equals-code-copy + AC6 concat-hits`；`clear-draft-on-failure` → `AC5 draft-kept`）。
- [ ] AC3 台账归因读数（机械、可被任何人复现）：用 `python3`/`jq` 读 `.quay/gate-events.jsonl`，打印 AC-153 的 `gate=goal` 读数总条数、尾巴的 `verdict` 序列（应为 14×`pass` 后接 2×`fail`），逐字给出那两条 `fail` 的 `payload.reason` 并指出其中含 `Unknown system error -122`、失败点是 `mkdtemp`；再打印同窗（`2026-09-27T21:04:31.986Z`–`21:05:56.704Z`）内同因 `fail` 的 AC 名单与条数（应为 12 条 / 7 条 AC）。
- [ ] AC4 尾巴重建或如实登记：重跑之后若 AC-153 的 `gate=goal` 读数里出现新的 `verdict=pass`，逐字抄它；若 driver 的独立复核尚未发生，完成记录里必须逐字写明「台账尾巴仍是 fail」并附 AC1 的直跑读数，⛔ 不得把它写成已通过，⛔ 不得用组件层 jsdom 的绿替代浏览器层的绿。
- [ ] AC5 空 delta：`git diff --name-only develop..HEAD` 为空（本条只写 `tasks/gap-ac153-ledger-red-is-host-quota.md`），且收尾时 `git status --porcelain` 与本任务启动时逐字相同（无变异副本、无临时工装残留）。
- [ ] AC6 根因如实登记且**不在本条内修**：写明 `~/.cache/quay-e2e-tmp` 没有回收者导致配额耗尽，给出实测规模（目录数与占用）；同时声明本条**未**改 `scripts/e2e-data-dir-selection.mjs`、`playwright.config.ts`、`e2e/**`、`src/**`，并指明该根因的修复属于另一条任务。

## DoD

- 判据本体（真实浏览器 spec，出货命令 `npx playwright test e2e/voice-error-messages.spec.ts`）在干净宿主上被**真的跑过一次**，读数行逐字入档 —— 不是「台账里有 pass」，也不是复述 expect 的文字。
- 承重反假控制（三个变异体）在同一棵树上被真的跑过一次，每条打印「未变异副本先绿 → 变异体在预测族里红一条并写明是哪条 → 族外至少一条仍绿」；这个绿必须是可证伪的绿。
- 归因段落里的每一条读数（errno −122 = `EDQUOT`、失败点在 `mkdtemp`、同窗 12 条 / 7 条 AC）都能由任何人在同一 checkout 上用 `python3`/`jq` 读同一条 jsonl 复现，不依赖本条的转述。
- 交付物只动 `tasks/gap-ac153-ledger-red-is-host-quota.md`：判据文件、实现、宿主配置、宿主缓存一个字节未动。

## Touches

- tasks/gap-ac153-ledger-red-is-host-quota.md
- e2e/voice-error-messages.spec.ts （本条只跑不改：AC1 的判据本体）
- src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx （本条只跑不改：AC2 的承重反假控制）
