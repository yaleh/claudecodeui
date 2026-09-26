---
id: gap-ac122-shared-assembly-starves-leg-budget
title: AC-122 判据在宿主并发下红在文件的共享装配阶段：装配与判据共用同一个 35s 预算，被饿死时与「双回放保证破了」同形
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

本任务承接 AC-122（回放同时提供原始录音与裁剪后音频两条）。判据命令是 `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"`。

### 立案测量一：判据对象为真

`env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 在本 checkout（`author`）连跑四次，**全部退出 0**：

```
[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-XVXAWs free-bytes=3837785788416 min-free-bytes=1073741824 (candidate /data/home/yale/.cache/quay-e2e-tmp)
[e2e] server=2843 client=22841
[voice-replay] original=2.640s/17416B trimmed=1.850s/177644B (the trimmed replay is the larger body: PCM WAV against the recorder's opus)
  ✓  1 e2e/voice-trim.spec.ts:1104:3 › the voice path end to end › AC-122 the recording is replayable beside the trimmed upload, one at a time (8.6s)
  1 passed (18.7s)
```

四次收尾分别是 `1 passed (18.7s) / (19.0s) / (20.2s) / (19.0s)`，读数行同形（第四次 `original=2.640s/17741B trimmed=1.870s/179564B`）。判据要求的四件事都在读数里：两条控件存在且可辨、两条 `data-clip-url` 不同源、裁剪那条 `RIFF`（1.850s）严格短于原始那条 recorder 的流（2.640s）、互斥由页内 `window.Audio` 注册表判定。

### 立案测量二：台账尾巴是红，两次失败目录都还在盘上

`.quay/gate-events.jsonl` 里 AC-122 的尾巴：

| 时间 (UTC) | actor | verdict | 运行目录 |
|---|---|---|---|
| 2026-09-26T01:05:13.351Z | goal-sweep | fail | `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-o3wIsz` |
| 2026-09-26T01:10:49.802Z | goal-cli | fail | `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-iqkbb2` |

两次的 `test-results/voice-trim-the-voice-path--95e1c-rimmed-upload-one-at-a-time/error-context.md` 原文（两个目录都在盘上，可直接复核）：

- `o3wIsz`：
  ```
  Test timeout of 35000ms exceeded.
  Error: locator.click: Target page, context or browser has been closed
  Call log:
    - waiting for getByRole('button', { name: /^voice-trim-workspace/ }).first()
  ```
  死在 `expandProject()` —— 侧栏还没渲染出该工程行。
- `iqkbb2`：
  ```
  Test timeout of 35000ms exceeded.
  Error: locator.click: Target page, context or browser has been closed
  Call log:
    - waiting for getByRole('button', { name: 'Stop recording' })
  ```
  死在 `recordOnce()`。失败时刻的 page snapshot 里 composer 已渲染、语音按钮仍叫 `Voice input`（录音不在进行中），而那两行 AC-122 专属文字（`[voice-replay]`、`the recording slot offers no replay of the trimmed upload`）**不在**这次失败里。

**两次都没有触到 AC-122 四条断言中的任何一条。** 台账 `reason` 里那串 `[WebServer] No .env file found…` / `[BABEL] … deoptimised the styling … /vite-cache/deps/react-scan.js` 只是 stderr 尾巴，不是失败原因。

### 机制：装配与判据共用同一个 35s 预算，且装配阶段没有署名

`e2e/voice-trim.spec.ts:1112` 的 `test.setTimeout(35_000)` 是**整条腿**的预算，它同时覆盖：

1. 文件共享装配：`page.goto` → `expandProject()` → `sessionLink().click()` → composer 渲染（`openComposer` 自带 15s 预算）；
2. 判据自己的录音与回放：`recordOnce()`（`Voice input` → `Stop recording` 的 start→stop 往返）到四条断言。

于是「装配被宿主并发饿死」与「双回放保证破了」在**退出码与失败行上同形**：都是退出 `1` 加一个裸的 `Test timeout of 35000ms exceeded.`。`the recording slot offers no replay of the trimmed upload` 是这条判据唯一能给「回放没了」署名的句子，而它只在装配成功之后才可能被读到 —— 装配一红，判据连说话的机会都没有。

### 已经修过的共享资源（只作溯源，本任务不重做）

<!-- dedup-ref --> 这条判据是同一族缺陷的第 N 次显形；前几次各自点名并移走了一个共享资源。下面只作溯源，不构成任何关系：`gap-e2e-hardcoded-ports-collide`（done，端口按运行从内核取一对并在启动前探测）、`gap-e2e-data-dir-lands-on-a-full-root-fs`（done，data dir 按可用空间选点、不够则拒绝启动）、`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page`（done，`VITE_CACHE_DIR` 指到本运行自己的目录）。这三处今天都在生效 —— 失败目录里并存着 `vite-cache/`、`[e2e] data-dir=… free-bytes=… min-free-bytes=…` 与 `[e2e] server=… client=…` 三行读数就是它们。**判据仍然红，说明被点名的资源不是这一类里剩下的那一个。**

### 本任务的候选机制（必须由复现点名，不许先验写死）

per-run cache 的代价是它**每一次运行都是冷的**：浏览器第一次 `page.goto` 时才触发 esbuild 现做一次依赖预打包 —— 失败目录里 `vite-cache/deps/react-scan.js` 的存在、以及每次运行都出现的 `[WebServer] [BABEL] Note: The code generator has deoptimised the styling of …/vite-cache/deps/react-scan.js`，都是这件事的痕迹。并发 N 份 e2e 同时从冷 cache 起步 ⇒ N 份预打包争 CPU ⇒ 首次页面加载被推过预算，而失败落在装配阶段，没有任何判据专属文字可署名。

**这是候选，不是结论。** S1 的复现必须先把它证实或证伪；若复现点名的是别的资源，就修那一个，并在完成记录里写明本段被证伪。

### 边界（不做）

不削弱 AC-122：四条断言逐字不动（`data-clip-url` 两源、容器/字节/时长、互斥的 `window.Audio` 注册表读法），`the recording slot offers no replay of the trimmed upload` 与 `the recording and the trimmed audio were sounding at once` 两句各保留 1 处；**不抬高** `test.setTimeout(35_000)`，也不抬高 goal gate 的 60s 上限（60s 在本环境是不可抬的硬上限，抬它只会把一次可署名的红换成不可归因的看门狗杀）。不改 `src/modules/chat/**`、`shared/asr/**`、`src/shared/api.ts`、`src/shared/types.ts`。不改其它 spec 的判据。不引入第二份回放实现。

## Plan

- **S0 基线**：`env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 三次，记命令 + 退出码 + `[voice-replay]` 行；把上面两份 `error-context.md` 抄进完成记录（先确认两个目录还在盘上；若已被回收，写明并改用本轮自己的复现原文）。
- **S1 复现（承重）**：在宿主并发下把这条腿红出来。建议两条路：`K` 份同命令并发（`K` 从 2 起逐步加，上限是不把宿主压到 `load average > nproc`），或与 `scripts/test.sh` 的全量套件同时跑。直到复现出一次 `Test timeout of 35000ms exceeded`，记下：失败时刻的 `error-context.md` 原文、当时还在跑的进程与 `load average`、`vite-cache/deps/` 里被预打包的文件与时间戳。**没有复现就没有归因** —— 复现不出来时不许按候选机制直接改。
- **S2 点名 + 修**：由 S1 的复现点名剩下的那个资源，并按本族纪律**移走它**（不改任何人的预算、不放宽任何断言）。若复现指向冷 cache 预打包：把「浏览器第一次加载之前依赖预打包必须已完成」做成有界、可署名的一步 —— 新增 `scripts/e2e-assembly-budget.mjs` 承载决策（给定候选预热目标与预算，返回要预热什么、或一条拒绝理由），`playwright.config.ts` 只调用它，在 `webServer` 起好后、用例开始前完成预热；超出预算则点名是哪个目标超了、超了多少。预热读数必须能被外部复核（打印预热对象、耗时、判定）。
- **S3 单价（纯函数面）**：`scripts/e2e-assembly-budget.test.mjs`（`node --test`）覆盖四件：从没预热过 ⇒ 给出预热目标；已在预算内完成 ⇒ 不重复预热；预热本身超界 ⇒ 给出拒绝理由与超界的目标；显式给出的目标不被覆盖。
- **S4 取假**：把 S2 的改动整条还原 ⇒ S1 的复现必须重新红成 `Test timeout`。⚠️ 已提交的改动 `git stash` 是空操作 —— 用 `git checkout <SHA> -- <paths>`（或 `git stash push -- <paths>` 后核对 `git stash list` 真的多了一条）。随后还原，`git status --porcelain` 只剩本任务文件。
- **S5 复核**：`git diff --name-only $(git merge-base HEAD develop)..HEAD` 只落在 Touches 内；四条断言与两句专属文字、`setTimeout(35_000)`、60s 上限的 `grep -c` 读数。

## AC

- [ ] AC1 基线三条原文：`env -u TMPDIR npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 三次各自退出 `0`、输出含 `[voice-replay] original=…s/…B trimmed=…s/…B` 与 `1 passed`；三条命令 + 退出码 + 关键行进 DoD。同时把 `quay-e2e-o3wIsz` / `quay-e2e-iqkbb2` 两份 `error-context.md` 的原文（或它们已被回收的读数）记进 DoD。
- [ ] AC2 复现：在宿主并发下把这条腿红出至少一次 `Test timeout of 35000ms exceeded`，且失败时刻的 `error-context.md` 里**不含** `the recording slot offers no replay of the trimmed upload` 与 `[voice-replay]`（即红在装配阶段、不在 AC-122 的断言上）。复现命令、并发度、当时 `load average`、失败目录路径与 `error-context.md` 原文进 DoD。
- [ ] AC3 点名：写出 S1 复现点名的那个共享资源，以及它如何被移走。若点名的是冷 cache 预打包，须给出「预热前 / 预热后」在同一并发度下首次页面加载耗时与整条腿耗时的对照读数，且预热后不再复现 AC2。若复现点名的是别的资源，写下本 Proposal 里那段候选机制被证伪。
- [ ] AC4 修后终态：AC2 的同一复现命令、同一并发度，连跑 `N >= 3` 次**全部退出 0**（每次都有 `[voice-replay]` 行）；原文与退出码进 DoD。
- [ ] AC5 取假（承重）：把 S2 的改动还原 ⇒ AC2 的复现重新红（退出 `1`、`Test timeout`），原文与退出码进 DoD；随后还原，`git status --porcelain` 只剩本任务文件。
- [ ] AC6 判据未被削弱、预算未被抬高：`grep -c "the recording slot offers no replay of the trimmed upload" e2e/voice-trim.spec.ts` → `1`；`grep -c "the recording and the trimmed audio were sounding at once" e2e/voice-trim.spec.ts` → `1`；`grep -c "setTimeout(35_000)" e2e/voice-trim.spec.ts` → `1`（数值未变）；`git diff $(git merge-base HEAD develop)..HEAD -- e2e/voice-trim.spec.ts playwright.config.ts | grep -cE '^\+.*(60_000|35_000)'` → `0`；`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^shared/asr/'` → `0`；`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^src/modules/chat/'` → `0`。
- [ ] AC7 `npm run typecheck` 退出 `0`；`npm run lint` 退出 `0`；`node --test scripts/e2e-assembly-budget.test.mjs` 退出 `0`（用例数进 DoD）。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-122 在 `.quay/gate-events.jsonl` 的尾巴由 `2026-09-26T01:10:49.802Z` 的 fail 转回 pass，并连续两轮不再翻回。
- **真落地**：不是「多加了一句提示」，而是**被点名的那个资源真的不再被共享/争用**。承重证据是 AC5 —— 把它还原，AC2 的复现必须重新红。
- **归因如实**：本判据今日两次 fail 的机制（装配阶段超时、未触到任何 AC-122 断言）与两份 `error-context.md` 原文进完成记录；并写明本次红**不是** `gap-voice-clip-dual-playback` / `gap-voice-dual-replay-absent-under-shipped-recogniser` 的修复失效（AC1 的三条现场绿读数就是它们仍在的证据）。
- **若复现证伪了候选机制**：如实登记，写明实际点名的资源与修法；不许把候选机制当成已证实写进完成记录。
- **读数原文**：AC1 三条、AC2 一条、AC3 对照两条、AC4 `N` 条、AC5 一条 —— 命令 + 退出码 + 关键输出行。
- **L_D 该轴仍暗，理由**：本任务只改测量侧的装配与归因，不新增领域数据能力，没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 读数是装配耗时、并发度与拒绝行为，不是生成质量轴读数；目标层判据由 GOAL-006 的其余判据承担。
- **scoped 门**：`bash scripts/test.sh --for-task gap-ac122-shared-assembly-starves-leg-budget --allow-thin` 的退出码与 `suite-scope-check` 行进完成记录；若因 Touches 里的 `*.test.*` 是 `.mjs` 而落在 thin 分支，如实登记（本族前例同形，scoped 文件集的正则不含 `.mjs`）。

## Touches

- playwright.config.ts
- scripts/e2e-assembly-budget.mjs
- scripts/e2e-assembly-budget.test.mjs
- e2e/voice-trim.spec.ts
- tasks/gap-ac122-shared-assembly-starves-leg-budget.md
