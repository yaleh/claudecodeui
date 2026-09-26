---
id: gap-voice-identifier-criterion-boot-dep-reopt-race
title: AC-115 判据在门自己那次运行里红、且从未跑到自己的断言：夹具的开户前导既无预热也无有界护栏，浏览器被拆时与「修复失效」同形（同族护栏已在
  AC-121/AC-108/AC-142 落地，本 spec 未回灌）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-115
---
## Proposal

本任务承接 AC-115（修复在真实浏览器里经语音按钮端到端生效）。判据命令是 `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"`。

### 一、本轮的直接测量（不是台账尾巴）

**判据对象为真。** 同一 checkout（`/data/home/yale/work/claudecodeui`，分支 `author`，HEAD `7db1d5b6`，`TMPDIR` 未设 = 与 driver 同环境）直跑判据一次，退出 `0`、命令墙钟 `15.4s`：

```
[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-YPSeW9 free-bytes=3802118189056 min-free-bytes=1073741824 (candidate /data/home/yale/.cache/quay-e2e-tmp)
[voice-identifier] upload: container=RIFF fixture=2.938s uploaded=2.870s
  ✓  1 e2e/voice-identifier-repair.spec.ts:273:3 › AC-115 the repair holds end to end through the voice button › AC-115 a recording made through the voice button lands the project's real file name in the composer (2.9s)
  1 passed (14.7s)
```

随后 **K=6 并发**同一命令（loadavg 12.1 → 15.4，128 核）：**6/6 退出 `0`**，每条腿 `1 passed (15.8s–16.1s)`、`[voice-identifier] upload:` 行同形。**本轮在安静宿主上复现不出红**，所以承重读数必须由 S1（AC2）的复现给出，不许先验写死。

### 二、台账两条红，以及它们落在哪里（**都不在判据的断言上**）

`.quay/gate-events.jsonl` 里 AC-115 今日两条 fail：`2026-09-26T11:52:53.617Z`（`goal-sweep`，运行目录 `quay-e2e-rCsLQk`）与 `2026-09-26T12:04:08.514Z`（`goal-cli`，`quay-e2e-ZyKMIe`）。两个目录**都还在盘上**，`test-results/voice-identifier-repair-AC-d54af-l-file-name-in-the-composer/error-context.md` 的 `# Error details` 原文：

- `ZyKMIe`：`Error: Channel closed` / `Error: locator.click: Target page, context or browser has been closed`，call log 停在 `- waiting for getByRole('button', { name: 'Stop recording' })`。
- `rCsLQk`：`Error: Channel closed` / `Error: locator.fill: Target page, context or browser has been closed`，call log 停在 `- waiting for locator('#username')`。

判据链一条都没有跑到：前提自查（`:282`/`:283`）、composer 逐字持有真名（`:324` 的 `toHaveValue(expected)`）、含真名（`:328`）、不含错拼形态（`:335`）、请求归属与凭据（其后）—— 这些断言在两次红里**一次都没有被执行**。台账 `reason` 里那串 `[WebServer] No .env file found …` / `[BABEL] … deoptimised the styling … vite-cache/deps/react-scan.js` 只是被截断的 stderr 尾巴，不是失败原因。

`rCsLQk` 的落点（`#username`）与本仓已记录的夹具前导死亡同形：`anchor.log:2781` 记着同一条腿另一次运行「hit the documented onboarding `#username` flake, green on repeat」。

### 三、两条候选机制（必须由复现点名，不许先验写死）

**M1 —— 夹具前导的依赖重优化，而且本 spec 没有护栏。** `beforeAll` 在 `:248` 裸调 `page.goto('/')`、`:249` 直接 `#username` fill，随后 `Create Account` → 项目行 → `:263` `page.reload()`。全程缺少本仓同族 spec 都有的三件东西（`grep -c warmClientStartup e2e/voice-identifier-repair.spec.ts` → `0`，在 HEAD 与 develop 上同为 `0`）：

- 预热 `warmClientStartup`：存在于 `e2e/transcript-follow.spec.ts:1826`、`e2e/voice-dashscope-written.spec.ts:330`、`e2e/session-filter.spec.ts:127` —— 本 spec 没有；
- 有界自报前导：`e2e/voice-trim.spec.ts:309` 的 `appears` + `:697` 起「8s 探针 → 至多 1 次 `page.reload()` → 仍不在就抛本 spec 自己的错（带页面文本 + console + `requestfailed`）」—— 本 spec 没有；
- `requestfailed` 采集：`e2e/voice-trim.spec.ts:650` —— 本 spec 没有。

这条形状与 memory `e2e-fresh-db-onboarding-hook-timeout` 记录的 2/5 红逐字同形（`Error: Channel closed` + `Frame.fill` 仍 `waiting for locator('#username')`）；那条 memory 自己写明「Bounded boot guard exists in voice-trim.spec.ts only」，并点名这是**同一族**：护栏本体由 AC-121 落地，transcript-follow（AC-108）与 voice-dashscope-written（AC-142）各自立过任务回灌。AC-115 是**剩下那个没回灌的**。

**M2 —— 浏览器进程被宿主内存压力杀掉。** 两次红的时刻，`journalctl --user` 里都有 `app.slice: A process of this unit has been killed by the OOM killer`（`19:54:22 +0800` 与 `20:02:56 +0800`，后者正压在 `ZyKMIe` 那次运行上），并伴随大量 `claudecodeui-session-*.scope: Failed with result 'oom-kill'`。这一族的共享资源已被兄弟任务点名并修掉：`os.tmpdir()` 读 `TMPDIR`、driver 环境不设 `TMPDIR` ⇒ 每份运行的 scratch（Chromium user-data、tsx/node/Playwright transform cache）全部落在舰队共用的 `/dev/vda2`（该结论与修复见 AC-122 那条任务，`092857e2`）。⚠️ 该修复已在 `develop`，但**判据是在主 checkout 上跑的**：`goal-store` 用 `runAcceptance({ command: criterion, cwd: resolveGitRoot(goalDir) })`，而 `author` 的 HEAD 尚未拿到这次合并。

**这一段是候选，不是结论。** S1 必须先证实其中一条或证伪两条；若复现点名的是别的资源，就修那一个，并在完成记录里写明本节哪一条被证伪。

### 四、修法（由 S1 点名的那一条决定，范围不预先扩大）

M1 被点名 ⇒ 用本仓既有且已被验证的形状（⛔ 不新造第二套实现）：把 `warmClientStartup` 的形状逐条照抄进本 spec 的 `beforeAll`，在 `browser.newContext()` **之前**跑完（形状取自 `e2e/transcript-follow.spec.ts:1826`；本仓既有做法是每 spec 自带一份，不抽共享模块）；并把 `:248` 起的开户前导改成有界的自报前导（`appears` + 有界 `page.reload()` 重试，预算耗尽时抛本 spec 自己的错，带页面文本、console 与 `requestfailed`）。

M2 被点名 ⇒ 把本运行自己的 scratch 移出宿主共享的 `/`：先确认判据所在树上 `develop` 的那次修复是否到位（`git show develop:playwright.config.ts | grep -c assembly`），未到位就写明本任务的修复面是让判据跑在已修复的树上；本 spec 里另有的共享点被点名时，点名它、移走它。

### 五、边界（不做）

不削弱判据：前提自查（`:282`/`:283`）与 composer 三条断言（`:324`/`:328`/`:335`）逐字保留。⛔ 不用 `retries` / `test.skip` / 加长 `page.waitForTimeout(2500)` 买绿；⛔ 不抬 `:208` 的 `setTimeout(120_000)`，也不抬 goal 门的 60s 上限（60s 在本环境是不可抬的硬上限，抬它只把一次可署名的红换成不可归因的看门狗杀）；不改 `src/modules/chat/**`、`shared/asr/**`、`useVoiceInput` 等链路生产代码；不改其它 spec；不改 `goals/AC-115-*.md` 的记录。

<!-- dedup-ref -->
机制侧相关、均已 `done` 的同族（都跑在别的 spec 上，不是本判据的载体）：`gap-voice-dashscope-criterion-boot-dep-reopt-race`（AC-142，把预热与有界前导回灌 `e2e/voice-dashscope-written.spec.ts`）、`gap-transcript-follow-criterion-boot-dep-reopt-race`（AC-108，同族，另一 spec）、`gap-session-filter-criterion-bounded-boot-guard`（AC-121 族，护栏本体）。另一条机制侧相关、覆盖 AC-122 的任务（点名共享 scratch 根）已 `done` 并把修复合入 `develop`。以上都不替代本任务：AC-115 的判据命令跑的是 `e2e/voice-identifier-repair.spec.ts`，而 `warmClientStartup` 在该文件里计数为 `0`。

## AC

- [ ] AC1 基线三条原文：`npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` 连跑 3 次各自退出 `0`、输出含 `[voice-identifier] upload: container=…` 与 `1 passed`；三条命令 + 退出码 + 关键行进 DoD。同时把 `quay-e2e-ZyKMIe` / `quay-e2e-rCsLQk` 两份 `error-context.md` 的 `# Error details` 原文（或它们已被回收的读数）记进 DoD。
- [ ] AC2 复现（承重）：在宿主并发下把这条腿红出至少一次，且两条读数共同说明红在前导、不在 AC-115 的断言上 —— (a) 该次运行自己的 stdout 里 `grep -c "\[voice-identifier\] upload:"` → `0`（判据自己的读数行没被打印到）；(b) 该次 `error-context.md` 的 `# Error details` 第一条是浏览器拆除类错误（`Channel closed` / `Target page, context or browser has been closed`），不是断言失败。复现命令、并发度、当时 `load average`、失败目录路径与该段原文进 DoD。**没有复现就没有归因** —— 复现不出来时不许按候选机制直接改。
- [ ] AC3 点名：写出 AC2 的复现点名的是 M1 还是 M2，以及它如何被移走。若点名 M1，须给出同一并发度下「预热前 / 预热后」整条腿时长的对照读数，且预热后不再复现 AC2。若两条候选都被证伪，如实写明实际点名的资源与修法。
- [ ] AC4 修后终态：AC2 的同一命令、同一并发度，连跑 `N >= 3` 批**全部退出 `0`**，每份都有 `[voice-identifier] upload:` 行；原文与退出码进 DoD。
- [ ] AC5 取假（承重）：把 S2 的改动还原 ⇒ AC2 的复现重新红（原文与退出码进 DoD）；随后还原，`git status --porcelain` 只剩本任务文件。⚠️ 已提交的改动 `git stash` 是空操作 —— 用 `git checkout <SHA> -- <paths>`（或 `git stash push -- <paths>` 后核对 `git stash list` 真的多了一条）。若还原后同并发度下不再红，如实登记为「该并发度下取假不成立」并补一档更高并发度的读数；⛔ 不许把「取假不成」写成「已取假」。
- [ ] AC6 判据未被削弱、预算未被抬高（同命令在建任务时的分叉点 develop 上同值，可用 `git show develop:e2e/voice-identifier-repair.spec.ts | grep -cF …` 逐条复核）：`grep -cF "expect(UTTERANCE).toContain(SPOKEN)"` → `>= 1`；`grep -cF "expect(UTTERANCE).not.toContain(identifier)"` → `>= 1`；`grep -cF "toHaveValue(expected"` → `1`；`grep -cF "expect(value).toContain(identifier)"` → `1`；`grep -cF "expect(value).not.toContain(SPOKEN)"` → `1`；`grep -cF "setTimeout(120_000)"` → 与 develop 同值（建任务时为 `1`）；`git diff $(git merge-base HEAD develop)..HEAD -- e2e/voice-identifier-repair.spec.ts | grep -cE '^\+.*(60_000|120_000|retries|test\.skip)'` → `0`。
- [ ] AC7 `npm run typecheck` 退出 `0`；`npm run lint` 退出 `0`。
- [ ] AC8 scoped 门：`bash scripts/test.sh --for-task gap-voice-identifier-criterion-boot-dep-reopt-race --allow-thin` 的退出码与 `suite-scope-check` 行进 DoD（若 Touches 里没有 `*.test.*` 而走 thin 分支，如实登记）。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-115 在 `.quay/gate-events.jsonl` 的尾巴由 `2026-09-26T12:04:08.514Z` 的 fail 转回 pass，并连续两轮不再翻回。
- **真落地**：不是「多了一段等待」，而是**前导的代价被移出被测窗口**，且前导自己有界、会署名。承重证据是 AC5 —— 把它还原，AC2 的复现必须重新红。
- **归因如实**：两次 fail 的落点（`Channel closed` + `#username` / `Stop recording`，未触到任何断言）与两份 `error-context.md` 原文进完成记录；并写明本次红**不是** `gap-voice-identifier-repair-unwired`（把修复接进 `useVoiceInput`）或 `gap-voice-identifier-browser-e2e`（写下本 spec）的修复失效 —— AC1 的三条现场绿读数就是它们仍在的证据。
- **若复现证伪了两条候选**：如实登记，写明实际点名的资源与修法；不许把候选机制当成已证实写进完成记录。
- **读数原文**：AC1 三条、AC2 一条、AC3 对照两条（或证伪读数）、AC4 `N` 条、AC5 一条 —— 命令 + 退出码 + 关键输出行。
- **L_D 该轴仍暗，理由**：本任务只改测量侧的前导与归因（一个 spec 的 `beforeAll`），不新增领域数据能力，没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 读数是前导耗时、并发度与退出码，不是生成质量轴读数；目标层判据由 GOAL-005 的其余判据承担。

## Touches

- e2e/voice-identifier-repair.spec.ts
- tasks/gap-voice-identifier-criterion-boot-dep-reopt-race.md