---
id: gap-transcript-follow-ac109-window-baseline-race
title: AC-109 判据偶发假红（本轮 1/3，与 driver 同形同值 −90）：窗口的参照 offset 与写记录锚在设桩之前，慢速流式的一个
  delta（≈120px）落进设桩间隙，被读成「手势没把视图上移」
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-109
---
## Proposal

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提）：本条判据由 [[gap-transcript-follow-small-gesture-detaches]]（done，AC-109）落地，它把「脱离」从 50px 距底阈值改成用户意图并把这条窗口判据写了出来；[[gap-transcript-follow-key-detach-vs-commit-pin]]（done，AC-109）修的是产品侧的另一个机制（PageUp 已按下、浏览器尚未报 scroll 的那一帧里 commit-time 增长 pin 把视图抢回），与本条的参照系缺陷不同；[[gap-transcript-follow-criterion-boot-dep-reopt-race]]（done，AC-108）与 [[gap-transcript-follow-ac110-case-nav-skips-boot-guard]]（done，AC-110）是同一族「判据可测性缺陷」的姊妹条，本任务沿用它们的取证与对照写法。e2e 工具链本身与登录后置锚点约定出自 gap-session-filter-real-browser-e2e（done）与 gap-e2e-onboarding-anchor-seeded-transcripts（done），本任务不重复申领。

### 现状（2026-09-30 实测，宿主 load1 ≈ 28 / 128 核）

判据：`npx playwright test e2e/transcript-follow.spec.ts -g "AC-109"`。

- 本轮直跑 3 次：**2 绿 1 红**。绿次读数恒为 `wheel: movedUpBy 30, highestOffsetDelta 0, detachFrames 60+, growthsInWindow 4~5, paneWrites [], pageWrites [], buttonVisible true, buttonAppearancesInWindow 1, unpinned [], settledGap 0`（键盘半 `movedUpBy 402`）。
- 红形态（与 driver 留下的那次**同形同值**）：

  ```
  Error: wheel: the gesture has to have moved the viewport up, or "nothing wrote it back" is a statement about a pane the user never moved
  expect(received).toBeGreaterThan(expected)
  Expected: > 0
  Received:   -90
  ```

- driver 的红：`.quay/gate-events.jsonl` 里 `id=bc3f84ef-b439-4954-bbd4-345c021e0f7a`、`item_id/pipeline_id=AC-109`、`gate=goal`、`actor=goal-cli`、`verdict=fail`、`timestamp=2026-09-29T21:40:19.600Z`；其 data-dir 为 `/data/scratch/yale/quay-e2e-geK0h1`（同一目录的 `test-results/transcript-follow-transcri-41527-k-for-the-rest-of-the-reply/error-context.md` 与 `trace.zip` 是那次现场，值与本轮红一致：`Received: -90`）。本轮复现的现场是 `/data/scratch/yale/quay-e2e-Ayo9kW`。

### 机制：窗口的参照系锚在设桩之前（读数缺陷，不是产品缺陷）

`runAc109Window`（`e2e/transcript-follow.spec.ts`）在**手势之前**为「窗口」取了三样东西，而这三样之后还夹着 5~6 次 CDP 往返（`readGeometry` → `installAc109PaneWriteCounter` → `locator.count()`（`buttonAtOpen`）→ `clearInstruments` → `startAc109Sampler` → `page.evaluate(performance.now)` → `pointAtPane` 的 boundingBox + `mouse.move`）：

1. 参照 offset：`const before = await readGeometry(page)`（`before.scrollTop`）；
2. pane 自己的写计数：`installAc109PaneWriteCounter(page)`；
3. 窗口级仪器：`clearInstruments(page)`。

回复每 250ms 吐一个 delta（`AC109_DELTA_INTERVAL_MS`），每个 delta 让转录行长高 ≈100~120px。只要**有一个 delta 落在这段设桩间隙里**，被跟随中的 pane 就会在「参照已读、手势未发」之间合法地继续向下（或由 follow 的 pin 写下去）——那一刻用户还没动手，这不是缺陷。但三条读数都把它算进了窗口：

- `movedUpBy = before.scrollTop − min(offsets)` = `30 − 120 = −90`：把跟随期的合法增长读成「手势没把视图上移」；
- `highestOffsetDelta = max(offsets) − before.scrollTop` 会把同一段增长读成「被拉回」（这条只是排在 `movedUpBy` 之后，本轮红没走到）；
- `paneWrites` / `pageWrites` 同样把设桩到手势之间的 pin 计入窗口（同样排在后面）。

判 `−90 = 一个 delta 减去手势 30px` 的三条证据：

1. 绿次读数**恒为** `movedUpBy 30`、`highestOffsetDelta 0` —— 只有「设桩间隙里一个 delta 都没落」时才绿；间隙越短（负载越低）越容易绿，恰是本轮 1/3、driver 那次偶发红的形态。
2. 失败现场的页面快照里 **`- button "Scroll to bottom" [ref=f1e296]` 在屏**（`/data/scratch/yale/quay-e2e-Ayo9kW/test-results/transcript-follow-transcri-41527-k-for-the-rest-of-the-reply/error-context.md:215`，`geK0h1` 那份同形）。AC 记录自己写明的假形态是「沿用单一 50px 距底阈值判定脱离、并在增长时 pin（30px 手势仍判为跟随 → 被拉回）」——那个实现**根本不会**让按钮出现。按钮在屏 ⇒ 手势确实脱离了 ⇒ **产品侧的保证成立，红的是窗口的测量**。
3. 键盘半 `movedUpBy 402`（一页 ≈ 400px）：同一处缺陷，只是要它变负需要 ≥400px 的增长落进间隙，量级上更罕见。

### 要落地的不变式

**AC-109 窗口的三个读数——参照 offset、「不得增大（±1）」的上界、写记录——都必须锚在用户手势自己的输入时刻（`wheel` / `keydown`），不得锚在设桩之前。** 跟随在用户动手之前处理掉的增长属于「窗口之前」，不是窗口的行为。

建议实现（择一，或等价物；以不动 liveness 算术者优先）：

- **A（推荐）页内输入锚定**：手势前在 pane 上装 capture 相的 `wheel` / `keydown` 监听，同步记录 `{ t, scrollTop, scrollHeight, clientHeight }`（默认滚动动作发生在事件派发之后，故此值是手势的起点 offset）。窗口的 `movedUpBy` / `highestOffsetDelta` 以该记录为参照，写记录按 `t ≥ 输入时刻` 过滤。采样与写计数的 `t` 都是 `performance.now()`，可直接比较。
- **B（等价）让 delta 不可能落进间隙**：窗口设桩期间闸住 wire double 的投递，手势派发后再放行。窗口内的增长与 `completionPresent === false` / `stream.finished() === false` / `growthsInWindow > 0` 等 liveness 断言不变。

⛔ 不得用「删掉或放宽 `movedUpBy > 0`」来消红：那正是判据自带的假形态钉住的读数（一个从未被移动的 pane 会白过）。修复只改**参照系**，不改判据的区分力。⛔ 不得加 `retries` / `repeat-each` / `test.skip` / `test.fixme`，不得放宽 `AC109_*` 常量。

### 非目标

- **不改 `src/` 的跟随实现**：产品保证成立（证据见「机制」第 2 条），本轮不申领任何产品侧改动。若实现时发现产品侧确有写回，须回到本条说明并另立任务，不得顺手改产品代码。
- 不改 AC-106/107/108/110/111 的语义，但**不得破坏**它们（同一个 spec 文件）。
- 不引入 CSS 钉底技巧、不依赖浏览器 scroll anchoring；不新建 `e2e/*.ts` 文件（会踩 e2e 新文件的 lint 边界）。

## AC

- [ ] 判据 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-109"` 退出码 0，且在**同一窗口内有别的 e2e lane 在跑**的条件下连跑 ≥10 次全部退出码 0；逐次记录 `exit=… wall=… self=[…]`、`git rev-parse HEAD` 与每次日志里的 `[e2e] server=… client=…` 行（证明用的是本次运行自己的端口/缓存目录），10 行读数原文写进完成记录。
- [ ] 绿次读数里 `wheel: movedUpBy > 0`、`highestOffsetDelta ≤ 1`、`paneWrites []`、`pageWrites []`、`buttonVisible true`、`growthsInWindow > 0`、`unpinned []`、`settledGap ≤ 1`，`keyboard` 半同；给出 10 次里 `movedUpBy` 的最小/最大值（修前绿次恒为 `wheel 30 / keyboard 402`）。
- [ ] **阴性对照（修前的读数必须红，且确定性）**：保留一份修前参照实现（或临时把参照切回设桩前的 `before` / 不过滤写记录），并在参照与手势之间注入一段**约 400ms 的停顿**（保证恰好一个 delta 落进间隙）⇒ 判据必须非 0，失败形态落在 AC-109 窗口的 `movedUpBy ≤ 0`（本轮实测 `Received: -90`）；退出码与失败原文登记在证据里，之后全部还原。
- [ ] **阳性对照（同一注入 + 修后读数必须绿）**：保留同一段 400ms 停顿、只换成修后的输入锚定读数 ⇒ 判据退出码 0，且该次读数满足上一条的全部字段。AC3 与 AC4 一起证明「锚到手势时刻」是承重的，而不是把断言放宽或加长等待。
- [ ] **判据未被削弱（AC-109 自己的两条抗假变体仍必须红）**：(i) 按 AC 记录写明的取法，把脱离改回「单一 50px 距底阈值 + 增长时 pin」⇒ **wheel 半**必须红；(ii) 意图只由 wheel/touchmove 提供、不认键盘滚动键 ⇒ **键盘半**必须红。两条都留输出并还原，`git diff` 证明 `src/` 无残留。
- [ ] `git diff` 证明 AC-109 自己的断言（`movedUpBy > 0`、`highestOffsetDelta ≤ AC109_GAP_PX`、`paneWrites == []`、`pageWrites == []`、`buttonAppearancesInWindow > 0`、`buttonVisible === true`、`completionPresent === false`、`growthsInWindow > 0`、`pinnedGrowths > 0`、`unpinned == []`、`settledGap ≤ AC109_GAP_PX`）与常量（`AC109_WHEEL_PX`、`AC109_DETACH_WINDOW_MS`、`AC109_PINNED_TAIL_MS`、`AC109_DELTA_COUNT`、`AC109_DELTA_INTERVAL_MS`、`AC109_SCROLLABLE_MIN_PX`、`AC109_GAP_PX`）以及判据命令 `-g "AC-109"` 一行未删未松；diff 内没有 `retries` / `repeat-each` / `test.skip` / `test.fixme`。
- [ ] `npm run lint` 退出码 0（如实登记：root tsconfig 与 oxlint 的 include 都不含 `e2e/`，夹具代码另有 `scripts/test.sh --for-task … --allow-thin` 与 AC1 的真实跑动覆盖）。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-109 的尾巴由 `2026-09-29T21:40:19.600Z` 的 fail 转回 pass，并在其后**连续多轮** frozenRecheck 中保持 pass（并发与宿主负载不再把它偶发打红）。
- **真落地**：不是把断言放宽、也不是加长等待，而是 AC-109 窗口的**参照系**换成手势自己的输入时刻——跟随在用户动手之前处理掉的增长不再被读成窗口的行为。证据是 AC1 的 10 个退出码与读数、AC3/AC4 的负正对照。
- **读数原文**：AC1 的 10 行 `exit=… wall=… self=[…]` 与 `[e2e] server=… client=…` 行；AC2 的 `movedUpBy` 最小/最大；AC3/AC4 的两次退出码与读数原文（含注入的 400ms 停顿读数）；AC5 两条抗假变体的退出码与失败断言；AC6 的 diff 统计与 `grep` 退出码。
- **前提与不可复现项如实登记**：必须写明 driver 那次 `21:40:19.600Z` 的红**本轮以同形态、同数值复现**（`Received: -90`，直跑 3 次中 1 红），但**没有**验证它当时也一定是这个间隙竞争——保留的现场只有页面快照与 `error-context.md`/`trace.zip`，其中 `button "Scroll to bottom"` 在屏、而没有 `paneWrites` 之类读数。**不得写成「已确证 driver 那次红的机制」**。另登记：本轮直跑绿次读数、宿主 load1（≈28 / 128 核）、以及每次跑动用的是自己的 data-dir 与端口。
- **L_D = 0**。L_D 该轴仍暗，理由：本任务只改 e2e 判据的参照系，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G = 0**。L_G 该轴仍暗，理由：同上 —— 读数是运行期退出码与几何读数，不是生成质量轴读数；目标层判据仍由 GOAL-004 的其余判据承担。

## Touches

- `e2e/transcript-follow.spec.ts`
- `tasks/gap-transcript-follow-ac109-window-baseline-race.md`
