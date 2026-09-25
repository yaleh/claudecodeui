---
id: gap-e2e-data-dir-lands-on-a-full-root-fs
title: e2e data dir 无条件落在 os.tmpdir()：根卷 99% 满时 AC-122 红成 ENOSPC /
  ERR_INSUFFICIENT_RESOURCES，读起来像应用缺陷
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-122
---
## Proposal

本任务承接 AC-122（回放同时提供原始录音与裁剪后音频两条）。**本轮的直接测量说明这条判据当前为真**；台账尾巴是 fail 的原因在测量环境，不在判据对象。

### 立案测量：判据为真（两条现场读数）

`TMPDIR=/data/home/yale/tmp/ac122-probe npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 在本 worktree 连跑两次，各自 **退出 0**：

```
[voice-replay] original=2.640s/17416B trimmed=1.850s/177644B (the trimmed replay is the larger body: PCM WAV against the recorder's opus)
  ✓  1 e2e/voice-trim.spec.ts:1104:3 › the voice path end to end › AC-122 the recording is replayable beside the trimmed upload, one at a time (8.6s)

  1 passed (18.6s)
```

第二次同命令、同一读数，`1 passed (19.2s)`。同一次会话里 `npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` **退出 0**、`Tests 22 passed (22)`。判据要求的四件事都在读数里：两条控件存在且可辨、两条 `data-clip-url` 不同源、裁剪那条 `RIFF`（1.850s）严格短于原始那条 recorder 的流（2.640s）、互斥由页内 `window.Audio` 注册表判定。

### 台账尾巴为什么是 fail：两次都是环境，不是判据对象

`.quay/gate-events.jsonl` 里 AC-122 今天的尾巴是 `2026-09-25T08:35:00.557Z` fail，之前 `08:23:20.651Z` 也 fail，**中间 `08:24:51.654Z` / `08:27:57.103Z` / `08:31:05.072Z` 三次连续 pass**。两次 fail 各自的运行目录都还在，它们自己的 `test-results/**/error-context.md` 写的是：

- `08:23:20.651Z`（`/tmp/quay-e2e-SLEkAt`）：
  `Error: browserContext._wrapApiCall: ENOSPC: no space left on device, write`
  （同屏还有 `Test timeout of 35000ms exceeded.`）
- `08:35:00.557Z`（`/tmp/quay-e2e-e44Jsx`）：
  `Error: page.reload: net::ERR_INSUFFICIENT_RESOURCES`

两条都**没有**触到 AC-122 的任何断言 —— 腿自己的失败行 `the recording slot offers no replay of the trimmed upload` 在两次里都不存在。台账 `reason` 里那串 `[WebServer] No .env file found…` 只是 stderr 尾巴，不是失败原因。

### 为什么落在那里

`playwright.config.ts:32`：

```ts
const dataDir = process.env.QUAY_E2E_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'quay-e2e-'));
```

它继承 `TMPDIR`，而驱动 anchor 的环境里**没有 `TMPDIR`**（`tr '\0' '\n' < /proc/$(cat .quay/anchor.pid)/environ | grep -c '^TMPDIR='` → `0`），于是 `os.tmpdir()` = `/tmp` = `/dev/vda2`：本机 **50G、99% 满、剩 499M**（`df -h /`）。`/tmp` 里积着 **216 个 `quay-e2e-*` 目录、共 12G**（`ls -d /tmp/quay-e2e-* | wc -l` → `216`；`du -sch /tmp/quay-e2e-* | tail -1` → `12G`），而 `playwright.config.ts` 里没有任何回收（`grep -n "rmSync\|prune\|cleanup\|unlink" playwright.config.ts` 只命中两处与本目录无关的行）。一次 e2e 运行要写 ~106M（vite-cache、trace、音频、sqlite），499M 的余量让它时成时不成 —— 这正是同一段台账里三次 pass 夹在两次 fail 之间的样子。

<!-- dedup-ref --> 与既有任务的关系（只作溯源，不构成任何依赖关系）：`gap-voice-clip-dual-playback`（done）与 `gap-voice-dual-replay-absent-under-shipped-recogniser`（done）建立的「两条并存」仍在 —— 上面两次现场读数就是它。**本任务不是它们的重复，也不是「前一次修复没有守住」**：红的是测量它的环境，不是它。`gap-voice-trim-default-flipped-by-unregistered-first-adapter`（done，AC-121）管登记面，`gap-asr-trim-capability-wiring`（done，AC-135）管裁剪决策接线，`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page`（done，AC-121）管共享 Vite dep cache 的作废。最后一条与本案同属「e2e 红成与判据对象无关的形状」，但机制不同：那条治的是**共享可变目录**（改路径即可），本案治的是**磁盘余量**（要读 `statfs`，且余量是运行那一刻的变量，不是配置里的常量）。

### 本任务做什么

1. **取基线**：跑 AC1 的两条读数并记原文。
2. **让判据在驱动自己的环境里也绿，且不取决于那一刻还剩多少盘**：`playwright.config.ts` 选 data dir 时不得无条件落在 `os.tmpdir()`。它必须在选择时刻读候选所在文件系统的可用空间，只挑真的装得下的候选；**一个都没有时必须非零退出、点名缺口**，而不是把 `ENOSPC` / `ERR_INSUFFICIENT_RESOURCES` 漏进一个此后与空间无关的断言里 —— 现在这样红，读起来像应用坏了（这是本案真正要治的东西）。
3. **让这条不变量可被机械证伪**：下限做成可抬的环境读数（见 Plan），于是「每个候选都不够 ⇒ 必须拒绝」不需要 root、也不需要造假一个小文件系统就能直接跑出来；把选点改回无条件 `os.tmpdir()`，这条必须不再拒绝。
4. **一次性回收**：`/tmp` 里 216 个陈旧 `quay-e2e-*`（12G）作为一次性操作清掉并记进完成记录。**不进判据** —— 历史目录的回收策略不是本判据的保证，判据只保证「余量不够时不装作够」。

边界（不做）：不改 `e2e/voice-trim.spec.ts` 的判据与任何断言（AC5 机械复核）；不改录音槽实现、`src/modules/chat/**`、`shared/asr/**`、`src/shared/api.ts`；不改其它 spec；不引入第二份回放实现；不把方向硬编码成某个主机路径（不变量是「有空间」，不是「在 /data」）。

## Plan

- **S0 基线**：`npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 两跑 + `npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx`，原文入库。
- **S1 选点**：把 data dir 的选择抽成一个可测的小模块（放 `scripts/`，纯函数：给定候选列表与下限，返回选中的候选或一条拒绝理由），`playwright.config.ts` 只调用它。候选顺序建议 `QUAY_E2E_DATA_DIR` → `TMPDIR` → `$HOME/.cache/quay-e2e-tmp` → `os.tmpdir()`，逐个 `statfs`。下限由环境读数给出（建议名 `QUAY_E2E_DATA_DIR_MIN_FREE_MB`），默认值取一次运行实测需求的数量级，且必须让本机 `/` 的 499M **不合格**、4T 卷合格。选中后把「data dir / 该 fs 可用字节 / 下限」三个数与既有的 `[e2e] server=… client=…` 一并打印。
- **S2 拒绝路径**：所有候选都不合格 ⇒ 在 `webServer` 启动任何东西**之前**非零退出（config 顶层 throw 或 `process.exit`），消息点名缺口与每个候选各自的可用字节。**不许**退化成「照旧用 `os.tmpdir()` 继续跑」。
- **S3 单元面**：新模块的 `*.test.mjs` 覆盖四件：够用则选它、不够用则跳过、全不够则给出拒绝理由、`QUAY_E2E_DATA_DIR` 显式给出时不被覆盖（既有语义）。
- **S4 取假 + 复核**：AC4 的变体跑一次并记原文，随后还原；`git diff --name-only $(git merge-base HEAD develop)..HEAD` 复核只落在 Touches 内。

## AC

- [ ] AC1 立案测量的两条现场读数：`TMPDIR=/data/home/yale/tmp/ac122-probe npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 两次各自退出 0、`1 passed`、读数同形 `[voice-replay] original=…s/…B trimmed=…s/…B`；`npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` 退出 0。三条命令与退出码原文进 DoD。**这条是基线，不是本任务要改的东西**：它证明判据对象为真，要修的是测量环境。
- [ ] AC2 驱动的环境下的终态：`env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 退出 0，且 `-g "AC-122"` 的输出含 `[voice-replay]` 行。佐证读数（证明这就是驱动的环境）：`grep -c '^TMPDIR=' /proc/$(cat .quay/anchor.pid)/environ` 输出 `0`。⚠️ 如实标注：修前这条在余量够时会偶然为绿（08:31:05Z 那次 pass 就是），它**不是**本案的承重断言 —— 承重的是 AC3/AC4。它红过的原文见 DoD 里两条 `error-context.md`。
- [ ] AC3 机制不变量（可机械证伪，不需要 root）：data dir 的选择必须在选择时刻读候选文件系统的可用空间并打印三个数（选中的 data dir、该 fs 可用字节、本次下限）。(a) 正常候选集 ⇒ 退出 0，且打印的可用字节 ≥ 打印的下限，且 `df` 对该 data dir 所在挂载点读出的可用量与之同量级；(b) 把下限抬到任何候选都满足不了的值（`QUAY_E2E_DATA_DIR_MIN_FREE_MB` 探针）⇒ 退出非 0，stderr/输出含空间缺口字样，且**不含**任何 AC-122 的断言行。两份原文与退出码进 DoD。
- [ ] AC4 取假（承重）：把选点改回当前的无条件 `fs.mkdtempSync(path.join(os.tmpdir(), 'quay-e2e-'))`（忽略下限）⇒ AC3(b) 的那条命令**不再拒绝**（退出 0，或红成与缺口无关的形状）。退出码与原文进 DoD；随后还原，`git status --porcelain` 只剩本任务文件。
- [ ] AC5 判据未被削弱、边界未被越过：`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^e2e/voice-trim.spec.ts'` 输出 `0`；`grep -c "the recording slot offers no replay of the trimmed upload" e2e/voice-trim.spec.ts` 输出 `1`；`grep -c "the recording and the trimmed audio were sounding at once" e2e/voice-trim.spec.ts` 输出 `1`；`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^shared/asr/'` 输出 `0`。
- [ ] AC6 `npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-122 在 `.quay/gate-events.jsonl` 的尾巴由 `2026-09-25T08:35:00.557Z` 的 fail 转回 pass，且在驱动自己的环境（`TMPDIR` 未设置）下连续两轮不再翻回。
- **真落地**：不是「加了个判断」，而是**余量不够时运行拒绝启动并说清缺口**，且选择时刻的可用空间与下限都被打印出来、可被外部 `df` 复核。承重证据是 AC4：把选点改回无条件 `os.tmpdir()` 后 AC3(b) 必须不再拒绝 —— 说明这条不变量由新代码承担，不是环境恰好够用。
- **归因如实登记**：本判据今日两次 fail 的机制是 `ENOSPC` / `ERR_INSUFFICIENT_RESOURCES`，各自运行的 `error-context.md` 原文进完成记录；并写明这不是 `gap-voice-clip-dual-playback` / `gap-voice-dual-replay-absent-under-shipped-recogniser` 的修复失效（两次现场绿读数就是它们仍在的证据）。
- **一次性回收如实登记**：清掉的陈旧 `quay-e2e-*` 目录数与释放量记进完成记录，并写明这是 stopgap、不进判据。
- **读数原文**：AC1 两条、AC2 一条、AC3(a)/(b) 各一条、AC4 一条 —— 命令 + 退出码 + 关键输出行。
- **L_D 该轴仍暗，理由**：本任务只让 e2e 运行拒绝在余量不足的文件系统上启动，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 本任务的读数是可用空间、下限与拒绝行为，不是生成质量轴读数；目标层判据由 GOAL-006 的其余判据承担。

## Touches

- playwright.config.ts
- scripts/e2e-data-dir-selection.mjs
- scripts/e2e-data-dir-selection.test.mjs
- tasks/gap-e2e-data-dir-lands-on-a-full-root-fs.md
