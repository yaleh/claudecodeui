---
id: gap-voice-false-forms-gates-case-repeated-seven-times
title: 7 个 voice false-forms 文件各有一个「…and the repository gates still exit
  0」用例，各自串行重跑同一批兄弟判据、typecheck、lint，合计约 373s（server 阶段 139s
  的长杆）：合并为一次，套件已覆盖的改成「存在且被套件收集」的廉价断言
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象（台账 + 保留日志的逐用例耗时）**：2026-10-06 11:32Z 那轮全量绿里，server 阶段跨度 139s，**恰好等于最长的单个文件** `voice-error-classification.false-forms.test.ts`（139s）——LPT 排序已把它放到最前，下界不再是排队而是它自己。9 个 voice `false-forms` 文件的逐用例读数（来自保留日志，16 路并发下）显示，时间几乎全落在每个文件里**唯一的一个**用例上：

| 文件 | 那个用例 | 耗时 |
|---|---|---|
| `voice-error-classification.false-forms` | AC7 the criteria, the check scripts and the repository gates still exit 0 | **140.1s** |
| `voice-capture-secrets.false-forms` | AC10 the eight criteria and the repository gates still exit 0 | 48.6s |
| `voice-error-contract.false-forms` | AC6 the existing criteria and the repository gates still exit 0 | 41.6s |
| `voice-capture-audio.false-forms` | AC8 the seven criteria and the repository gates still exit 0 | 37.2s |
| `voice-capture-isolation.false-forms` | AC8 the seven criteria and the repository gates still exit 0 | 37.2s |
| `voice-capture-text.false-forms` | AC10 the six criteria and the repository gates still exit 0 | 35.5s |
| `voice-capture-off.false-forms` | AC6 the existing criteria and the repository gates still exit 0 | 32.5s |

合计 **372.7s，占 9 个文件用例耗时总和 388s 的 96%**；真正的变异用例都不超过 0.2s。这约占台账该轮 server 阶段 Σ 约 1445s 的四分之一。

**机制**：每个这样的用例用 `spawnSync` **串行**跑一份命令清单——兄弟判据（逐个 `npx tsx --tsconfig server/tsconfig.json --test <文件>`，这些文件本身都被套件收集、本来就会跑）、`npm run typecheck`（约 15s）、`npm run lint`（约 9s）（二者本来就是套件的两个静态阶段），以及**套件覆盖不到的 5 条**（在 `voice-error-classification.false-forms` 的 `AC7_COMMANDS` 里）：`node scripts/asr-dashscope-omni-check.mjs`、`node scripts/asr-contract-invariants-check.mjs`、`node --test scripts/asr-dashscope-omni-check.test.mjs`、`node --test scripts/asr-contract-invariants-check.test.mjs`、`npx vitest list src/shared/asr/tests/asrContractInvariants.test.ts`——`scripts/` 这条线（`npm run test:scripts`）不在 fan-in 套件里，所以这 5 条只有这里在跑，**不能直接删**。同一份清单在 7 个文件里各重复一遍。副作用：一个类型错误会同时让 `typecheck` 阶段和这 7 个文件都红（22:36Z 那轮 1 个 typecheck 红连带 7 个 false-forms 红，共 8 个）。

**改动（只改这 7 个文件）**：
1. **盘点**：逐个列出 7 个用例各自清单里的每条命令，并给处置——(S) 套件静态阶段已覆盖（`typecheck`、`lint`）：删除；(C) 套件已收集的测试文件：改成廉价断言；(K) 套件覆盖不到：保留。**我只读了 classification 文件的清单；其余 6 个文件的清单没有逐条读过**，若盘点发现它们有各自独有的 (K) 命令，并入下一条的合并清单。
2. **一次合并**：把 (K) 命令去重后，只在 `voice-error-classification.false-forms.test.ts` 里保留的那个用例（沿用其用例名）里运行**一次**，用异步 spawn、并发不超过 4，保留现有的非空判据（tally / markers / 退出码）与 `optional` 处理。子进程读数放在 false-forms 文件里是既有约定（判据文件自身零子进程）。
3. **其余 6 个文件**：把重用例换成纯进程内的廉价用例，名字固定为 `AC<n> the named criteria exist and are collected by the suite`：对原清单里每个 (C) 路径，断言 `fs.existsSync` 且出现在套件的收集集合里（与 `scripts/test.sh` 同一个 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules` 表达式）。这保住了「判据被改名或删除会红」的非空性，代价是不再重复执行它们——它们本来就在套件里各自执行。
4. **不新增测试文件**：`server/shared/tests/quay-test-script.test.ts` 固定了服务端测试文件总数（`unknown=235` / `unknown=237`），新增一个文件会让它整片变红。
5. **保持不变**：全部变异用例；各文件的残留检查用例（`… temp copies … gained nothing`，按 pid 归属）；classification 的 `AC8: deleting a union member is a compile error…`（1.5s）；`voice-capture-audio` 的 `AC3/AC4 the named regression criteria still exit 0`（5.7s）；临时副本前缀约定 `__criterion-falsify-<tag>-…`。

**效果（推算，非实测）**：Σ 由约 1445s 降到约 1075s，下界变成 Σ/16 ≈ 67–70s，其次最长的文件是 `debug-agent-external-write`（36s），server 阶段跨度约 70s（现在 139s），整轮约 190s → 约 120s。

**不做**：不新增任何文件；不改非 false-forms 的判据文件、`voice-capture.ts`；不改 `package.json`、`scripts/test.sh`、`quay-test-script.test.ts`；不新增 `scripts/*.mjs`；不去做跨进程共享 typecheck 缓存（各文件是独立进程，易碎）。

**已知约束（来自本仓记忆）**：这批 false-forms 共用 `server/modules/voice/tests/` 一个目录，变异副本写在同目录，各文件的残留检查靠 pid 归属避免互相误报——合并用例只 spawn 命令、不创建副本，不要碰这套约定。

<!-- dedup-ref -->相关但机制不同：`gap-voice-error-classification-ac7-vitest-child-fragile`（已完成：把 AC7 里会拉起独立 vitest 的那一条改成 `vitest list`，同一方向——缩小这个用例对舰队的占用）；`gap-suite-server-dispatch-longest-first-and-parallel-static-stages`（已完成：LPT 派发，是它让「最长文件 = server 阶段跨度」这一事实变得清晰）；`gap-suite-server-phase-bypass-npx-and-tsx-cli-wrapper`（todo：改 `scripts/test.sh` 的进程链，与本任务无文件重叠）。

## AC

- [ ] AC1 自测（Touches 含 `*.test.*`，`suite-scope-check.sh` 要求带 `--for-task`）：`bash scripts/test.sh --for-task gap-voice-false-forms-gates-case-repeated-seven-times` → 退出码 0，输出含 `# fail 0`。
- [ ] AC2 只剩一个重用例，且在 classification 文件里：`grep -hc 'repository gates still exit 0' server/modules/voice/tests/voice-capture-audio.false-forms.test.ts server/modules/voice/tests/voice-capture-isolation.false-forms.test.ts server/modules/voice/tests/voice-capture-off.false-forms.test.ts server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts server/modules/voice/tests/voice-capture-text.false-forms.test.ts server/modules/voice/tests/voice-error-classification.false-forms.test.ts server/modules/voice/tests/voice-error-contract.false-forms.test.ts | awk '{s+=$1} END{print s}'` 的输出为 `1`；`grep -c 'repository gates still exit 0' server/modules/voice/tests/voice-error-classification.false-forms.test.ts` 的输出为 `1`。
- [ ] AC3 其余 6 个文件各有一个替代用例：对 audio、isolation、off、secrets、text、contract 这 6 个 `*.false-forms.test.ts`，`grep -c 'the named criteria exist and are collected by the suite' <文件>` 的输出均为 `1`。
- [ ] AC4 套件覆盖不到的 5 条仍在被执行，且合并用例不再自己跑 typecheck/lint：在 `voice-error-classification.false-forms.test.ts` 内 `grep -c 'asr-dashscope-omni-check.mjs'`、`'asr-contract-invariants-check.mjs'`、`'asr-dashscope-omni-check.test.mjs'`、`'asr-contract-invariants-check.test.mjs'`、`'vitest'` 各 ≥ `1`；`sed -n '/^const AC7_COMMANDS/,/^\];/p' server/modules/voice/tests/voice-error-classification.false-forms.test.ts | grep -cE "'typecheck'|'lint'"` 的输出为 `0`。
- [ ] AC5 没有命令被悄悄丢掉：设 `B=$(git merge-base HEAD develop)`，对这 7 个文件，取改动前版本（`git show $B:<文件>`）与改动后版本中全部形如 `server/…*.test.ts`、`scripts/…*.mjs` 的路径（`grep -oE '(server/[A-Za-z0-9_./-]+\.test\.ts|scripts/[A-Za-z0-9_./-]+\.m?js)'`），分别排序去重后 `comm -23 <改动前> <改动后>` 无输出。
- [ ] AC6 变异用例与残留用例未被误删：这 7 个文件里 `grep -c 'gained nothing'` 的结果与改动前（`git show $B:<文件>` 的同一计数）逐文件相等；各文件的 `…: the unmutated copy is green and the mutation reds …` 用例数与改动前逐文件相等。
- [ ] AC7 速度界限（相对改动前数十秒，留足余量，避免被负载抖动误伤）：对 audio、isolation、off、secrets、text、contract 这 6 个文件，各单独执行 `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test <文件>` 且墙钟 ≤ 15 秒；对 classification 文件同样执行，墙钟 ≤ 40 秒。动手前先各量一次改动前的单独运行墙钟，写进完成记录作对照。
- [ ] AC8 范围受控且不新增文件：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列；`git diff --name-status $(git merge-base HEAD develop) HEAD | awk '$1=="A"' | wc -l` 的输出为 `0`；集合中不含 `scripts/test.sh`、`package.json`、`server/shared/tests/quay-test-script.test.ts`。
- [ ] AC9 `npm run typecheck` → 退出码 0，`npm run lint` → 退出码 0。

## DoD

真实落地的标准有三个读数，须贴进完成记录。①**逐用例前后对照**：这 7 个文件改动前后各用例的耗时（改动前用本任务 Proposal 的表，改动后用 `ℹ`/`✔` 行里的毫秒数），并附盘点表（每条原命令的处置：S / C / K 及其去向）。②**真实 fan-in 的台账读数**：落地后第一轮 fan-in 的 `.quay/verification-round.jsonl` 里，server 阶段跨度（`server/` 项最早开始到最晚结束）预期 ≤ 约 90s（参照 139s），这 7 个文件各自耗时 ≤ 15s、classification ≤ 40s，且无新增红；若 server 跨度仍 ≥ 120s，说明长杆没消除，须先查明。③**放大效应消除**：在一次性的临时 worktree 里（不提交）加入一个故意的类型错误（例如 `scripts/zz-typeerr.mjs` 里一个无类型注解的参数），分别执行 `npm run typecheck`（须红）和 `bash scripts/test.sh <这 7 个文件>`（须全绿；改动前这 7 个文件会跟着红），把两条的输出贴出，证明一个类型错误不再同时红 8 处。再做两个负控：把合并用例里某一条 (K) 命令改成指向不存在的脚本（本地编辑，用 `git checkout -- <文件>` 还原，不要 `stash`），用例须红且点名该命令；在临时 worktree 里把某个被引用的兄弟判据改名，对应的替代用例须红。未验证项：其余 6 个文件的清单只读了用例名与计数，没有逐条核对，盘点必须以实际读数为准。

## Touches

- server/modules/voice/tests/voice-capture-audio.false-forms.test.ts
- server/modules/voice/tests/voice-capture-isolation.false-forms.test.ts
- server/modules/voice/tests/voice-capture-off.false-forms.test.ts
- server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts
- server/modules/voice/tests/voice-capture-text.false-forms.test.ts
- server/modules/voice/tests/voice-error-classification.false-forms.test.ts
- server/modules/voice/tests/voice-error-contract.false-forms.test.ts
- tasks/gap-voice-false-forms-gates-case-repeated-seven-times.md
