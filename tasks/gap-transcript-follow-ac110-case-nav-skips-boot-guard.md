---
id: gap-transcript-follow-ac110-case-nav-skips-boot-guard
title: AC-110 判据偶发假红（近 16 次 gate 事件 2 红）：判据自己那条 case 在 beforeAll
  守卫之外重导航（全文件唯一一条这样做），页面被反复替换时 click 无界重试撞上 55s watchdog 杀浏览器，台账只留 "Channel
  closed"
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-110
---
## Proposal

**本轮的直接测量（两次读数都登记，不取台账尾巴）**

- 台账尾巴：`.quay/gate-events.jsonl` 里 AC-110 最后一条是 `verdict=fail`，`at=2026-09-25T10:04:32.495Z`，`actor=goal-cli`，`payload.reason` 只有 `acceptance failed (exit 1)` 加一段 stderr 尾巴（`[WebServer] No .env file found…`、一条 `[BABEL] … deoptimised the styling of …/quay-e2e-9atUIN/vite-cache/deps/react-scan.js`、`DEP0190`）——**没有一个字关于判据本身**。
- 本轮直跑判据（HEAD `af4b5442`，`npx playwright test e2e/transcript-follow.spec.ts -g "AC-110"`）：**`EXIT=0`**，`1 passed (19.9s)`，case 自报 `6.3s`，`real 0m20.652s`。判据自报读数全真：

```
AC-110 readings {"viewport":{"width":1440,"height":6000},"rowsBeforePrepend":20,"rowsAfterPrepend":24,
"scrollHeightBefore":5776,"scrollHeightAfterPrepend":6620,"paneClientHeight":5776,"restoreWrite":[683],
"gapAfterRestorePx":179,"scrollTopAfterRestore":665,"offset0Px":485,"samples":11,
"offsets":[485×11],"scrollTops":[665×11],"gaps":[299×11],
"driftPx":0,"scrollTopRisePx":0,"smallestGapPx":299,"scrollWritesInWindow":[0],"downwardWritesInWindow":0}
```

**所以本轮的诚实结论是：判据不是「假」的，是「偶发假红」的。** 近 16 次 gate 事件 14 pass / 2 fail（`08:40:41.042Z`、`10:04:32.495Z`），两次 fail 的 reason 都只有 stderr 尾巴。上一轮 gap prompt 的前提「criterion is false as of now」被本轮直跑证伪，本任务据此**不**声称几何保证回归（下面 AC5 反而要求把这条保证再钉一次）。本任务要修的是**判据的可测性**：一个约 2/16 概率死在夹具自己启动路径上的判据，每轮给台账的都是噪声。

**现场（本轮逐行复核过原始产物，不是从 reason 尾巴猜的）**

`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-9atUIN/test-results/transcript-follow-transcri-9252a-re-that-lands-at-the-bottom/error-context.md` 原文：

```
# Test info
- Name: transcript-follow.spec.ts >> transcript follow in a real browser >> AC-110 a prepend the wheel asked
        for stays the user's across the restore that lands at the bottom
- Location: e2e/transcript-follow.spec.ts:2221:3
# Error details
Error: Channel closed
Error: locator.click: Target page, context or browser has been closed
Call log:
  - waiting for locator('a[href^="/session/"]').filter({ hasText: 'transcript-follow' })
    - locator resolved to <a href="/session/e2e-transcript-follow" class="…">…</a>
  - attempting click action
    - waiting for element to be visible, enabled and stable
  - element was detached from the DOM, retrying
```

同一份文件里的 `# Page snapshot` **不是空白页**：`heading "CloudCLI"` 在，`button "Refresh projects and sessions (Ctrl+R)"`、`button "Create new project"`、`button "Hide sidebar"` 都在——**应用是活的、侧栏渲染完了**，只有那条 session 链接在反复 detach。

`trace.zip` 里的 `test.trace` 时间线：`beforeAll` 在 19.81s 结束（**守卫通过了**），AC-110 的 case 依次做 `Set viewport size`、`Set fixed time`、`Navigate`（20.00s），那个 `click` 在 22.42s 打开后**跑了 33.5s** 到 55.95s；55.58s 是 harness 的 After Hooks —— 即 `playwright.config.ts:229` 的 `RUN_CEILING_MS = 55_000` 看门狗结束了这次运行。控制台侧那份文档在约 10s 内被替换了至少 3 次（22.75s / 28.60s / ~32.0s，每次都是 `[vite] connecting…` → React DevTools → `SW registered` 一整套）。

**机制（哪一处是盲点，及为什么它是盲点）**

`e2e/transcript-follow.spec.ts` 里**只有两处导航**：`:1872` 的 `await page.goto('/')`（在 `beforeAll` 里）和 `:2227` 的 `await page.goto('/')`（**在 AC-110 这条 case 自己的体内**）。AC-106（`:1945`）、AC-107（`:2003`）、AC-111（`:2113`）、AC-108（`:2381`）、AC-109（`:2854`）全部复用 `beforeAll` 的那份文档，**只有 AC-110 重导航**。

而启动守卫只包住了前一处：`warmClientStartup(clientUrl)`（`:1739` 定义、`:1851` 调用）+ `appears()` 有界探针 + ≤2 次 `page.reload()` 有界重放 + 耗尽后抛出**含页面文本与 console/requestfailed 证据**的错误（`:1874–1893`）。这条守卫自己的注释声称它挡的是「the app's own `location.reload()` after `504 Outdated Optimize Dep`，**or any other restart of the document**」——但它只在**第一次**导航外生效。AC-110 的 `:2227` 是第二次导航，守卫不在它外面：落地之后那条 `sessionLink()` 的 `click` 是**无界**等一个「visible, enabled and stable」的元素，页面每被替换一次它就 detach 重试一次，撞上的是本 run 自己的 55s 看门狗，而不是任何断言。

**为什么早先的修复没挺住（本任务存在的理由）**

- `gap-transcript-follow-prepend-restore-not-reattaching`（done，`goal_ac: AC-110`）把**几何**修对了（`55dfad8b`，2026-09-21 17:10:46 +0800），本轮复测它确实真（`driftPx 0`、`smallestGapPx 299`、`downwardWritesInWindow 0`）。**但那条 `:2227` 的 `goto` 正是这次提交引入的**（`git log -S"await page.goto('/')" -- e2e/transcript-follow.spec.ts` 指向 `55dfad8b`）：因为 `page` 来自共享 `beforeAll`、视口 1440×6000 没法用 `test.use({viewport})` 表达，它只好在 case 内部重新导航一次。**这一改动无意中把一条导航放到了守卫的覆盖面之外。**
- 启动守卫是**后到的、而且是逐 spec 回灌的**：`gap-transcript-follow-criterion-boot-dep-reopt-race`（done，AC-108）它落进 `e2e/transcript-follow.spec.ts` 的 `beforeAll`；`gap-session-filter-criterion-bounded-boot-guard`（ready，AC-101）本轮把它落进 `e2e/session-filter.spec.ts`（`069c663d`，2026-09-25 18:05:21 +0800）；出处是 `e2e/voice-trim.spec.ts`。**这条家族线每一站都停在「spec 的第一份文档」上，从没有一站走到「同一条 spec 里 case 自己的第二次导航」**——所以本判据的盲点一直没人回灌。
- 另需如实登记：那次红的**触发源本轮没有确证**。`trace` 里**没有 504、没有 `net::ERR_NETWORK_CHANGED`、没有 `ERR_FAILED`**（失败项只有 `net::ERR_ABORTED`，即被撕掉的在途请求，以及那条始终没建立的 `/ws?token=…`），也没有 API 轮询暴涨（各 API 端点 ≤12 次；请求量是 dev 模块图本身）。文件里也不存在客户端自发的 reload 逻辑：`src/` 里 `window.location.replace` 只有 `src/modules/version-upgrade/VersionUpgradeModal.tsx:51` 一处、且需要用户点 Update Now 加 120s 倒计时；`public/sw.js` 没有 reload-on-controllerchange。**所以本任务只认领「无界等待落在守卫覆盖之外的那个站点」，不认领触发源**，修法也因此必须对**任何**形式的文档替换都成立（这正是 `:1874` 那条注释原本的措辞）。

**修法（最小切片，全部在夹具侧；判据断言一行不动）**

1. **把 `beforeAll` 已有那两件套就地用到 `:2227` 这次导航上**：重导航之后、`sessionLink().click()` 之前，插入同一形状的有界启动探针（短预算探一个「这份文档稳住了」的信号：`#username` 或侧栏容器）→ 未稳住则有界 `page.reload()`（或重放该次 `goto`）≤N 次 → 仍不稳住则抛出**含页面文本 + console errors + failedRequests** 的错误。**不新建文件、不改 `playwright.config.ts`、不改 `RUN_CEILING_MS`**（goal gate 的 60s 上限不可抬，看门狗是承重的，抬它就是掩盖）。
2. **把「无界等待」本身换成有界自报**：`sessionLink()` 的 `click` 走一个有界等待（预算之和留在判据自己的时间预算内），超预算即抛出夹具自己的话。这样真启动失败会在 ~30s 内以**夹具自己的错误信息**退出，而不是被 55s 看门狗从外面杀掉、也不是 180s hook 超时。
3. **不要**用「删掉 `:2227` 那次导航、改成复用 beforeAll 文档」来绕过——视口 1440×6000 与「首屏不可滚」的前置正是靠这次重新加载建立的，删掉它会把判据的测量前提换掉。守卫即可，不动测量。

⛔ 换绿禁令：不得加 `retries` / `--repeat-each`、不得 `skip` / `fixme`、不得放宽或删除 AC-110 的任何断言（`drift <= AC110_DRIFT_PX`、`highest - before.scrollTop <= 1`、`smallestGap > 2`、`downwardWrites` 为空）、不得改 `-g "AC-110"` 这条命令、不得改 `RUN_CEILING_MS` 或 goal gate 的上限、不得以桩/镜像替掉真实 Chromium + 真实后端、不得把这次导航移出 `-g "AC-110"` 那次运行。

<!-- dedup-ref -->
同机制关联（记给出处，不是本任务的前提）：`gap-transcript-follow-criterion-boot-dep-reopt-race`（done，AC-108）是这道守卫在**本 spec** 里的出处与修法来源；`gap-session-filter-criterion-bounded-boot-guard`（ready，AC-101）是它在本轮落进另一条 spec 的那一站；`gap-transcript-follow-prepend-restore-not-reattaching`（done，AC-110）是 `:2227` 那次导航的引入者。本任务不重复申领 AC-101 / AC-108 / AC-110 的既有裁决，也不回退它们的修法，只把守卫补到 AC-110 自己那条 case 的第二次导航上。另：`gap-mobile-layout-e2e-viewport-matrix`（todo）的 Touches 也含 `e2e/transcript-follow.spec.ts`，与本文构成池内串行，由 driver 的 Touches 门机制排序即可，无需人工串联。

## AC

- [ ] 判据 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-110"` 退出码 0，且在**同一窗口内有别的 e2e lane 在跑**的条件下连跑 ≥10 次全部退出码 0；逐次记录 `exit=… wall=… self=[…]` 与 `git rev-parse HEAD`，10 行读数原文写进完成记录；且这 10 次日志里 `Channel closed` 出现 **0** 次、`[e2e] watchdog … crossed its own 55000ms ceiling` 出现 **0** 次（用 `grep -c` 给退出码）。
- [ ] 绿路径不因为守卫而变慢：上述 10 次里每次 playwright 自报时长 ≤ 30s（修前绿次为 `1 passed (19.9s)`、case `6.3s`、wall `20.652s`），给出最小/最大值；并记录每次日志里的 `[e2e] server=… client=…` 行与 `[e2e] client warm-up: pre-bundle committed in …ms` 行，证明用的是本次运行自己的端口与缓存目录（不是别的 run 的）。
- [ ] **阴性对照（那次重导航的守卫必须承重）**：构造一个**确定性**的假形态，让 `:2227` 那次导航之后文档被替换 / 稳不住——例如把该处启动探针临时指向必然不出现的哨兵选择器，或在导航后从页面侧有界地强制重放若干次 `location.reload()`——跑判据 → 必须非 0，且失败形态**落在夹具启动阶段并以夹具自己的话结束**：错误信息里含页面文本与 console errors / failedRequests，**退出发生在 ≤30s**，**不得**表现为 `Error: Channel closed`、**不得**是 55s watchdog kill、**不得**是 180s hook 超时。退出码与失败原文登记在证据里，之后全部还原。
- [ ] **阳性对照**：只把 AC3 那处注入撤掉、守卫保留 ⇒ 判据必须退出码 0。AC3 与 AC4 一起证明这次补的守卫是承重的、不是装饰；之后 `git diff develop --stat` 证明改动面只剩 `e2e/transcript-follow.spec.ts` 一处（`playwright.config.ts` 一行未改）。
- [ ] **判据未被削弱（AC-110 自己的抗假变体仍必须红）**：按 AC 记录 `expect` 里已写明的假形态——「prepend 恢复结束后回到原 mode（首屏不可滚时原 mode 是跟随）⇒ 下一次增长把视图拉到底」——构造该变体，判据必须退出码非 0（修前该变体已实测为 `driftPx 120`、`smallestGapPx 0`、`downwardWritesInWindow 2`，本轮须复现同形）；留输出并还原。`git diff` 证明 `e2e/transcript-follow.spec.ts` 里 AC-110 的断言（`drift <= AC110_DRIFT_PX`、`highest - before.scrollTop <= 1`、`smallestGap > 2`、`downwardWrites` 为空）与常量（`AC110_VIEWPORT`、`AC110_FIRST_PAGE_ROWS`、`AC110_SAMPLE_WINDOW_MS`、`AC110_DRIFT_PX`）以及 `-g "AC-110"` 命令一行未删未松；diff 内没有 `retries` / `repeat-each` / `test.skip` / `test.fixme`，也没有 `RUN_CEILING_MS` 或 gate 上限的改动。
- [ ] `npm run lint` 退出码 0（如实登记：root tsconfig 与 oxlint 的 include 都不含 `e2e/`，故夹具代码另有 `scripts/test.sh --for-task … --allow-thin` 与 AC1 的真实跑动覆盖）。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-110 的尾巴由 `2026-09-25T10:04:32.495Z` 的 fail 转回 pass，并在其后**连续多轮** frozenRecheck 中保持 pass（并发不再把它偶发打红）；判据的启动路径在 AC1 的 10 连跑里 0 次 `Channel closed` / 0 次 watchdog kill。
- **真落地**：不是一个更长的等待，而是 **AC-110 自己那条 case 的第二次导航不再无界**——`beforeAll` 已有的两件套（有界探针 + 有界重放）就地覆盖到 `:2227` 之后；页面真被抽走时以夹具自己的话在 ≤30s 内报错退出（AC3），而不是被 55s 看门狗从外面杀掉、也不是 180s hook 超时。证据是 AC1 的 10 个退出码与墙钟、AC3/AC4 的负正对照、AC3 的失败原文（含页面文本与 console 证据）。
- **读数原文**：AC1 的 10 行 `exit=… wall=… self=[…]` 与两次 `grep -c` 的退出码；AC2 的 `[e2e] server=… client=…` 与 `pre-bundle committed in …ms` 行及最小/最大自报时长；AC3/AC4 的退出码与失败/通过原文；AC5 抗假变体的退出码与判据读数；AC6 的两条 lint 退出码。
- **前提与不可复现项如实登记**（这一段必须逐条写进完成记录，不得含糊）：
  1. **本轮直跑判据是绿的**（`EXIT=0`，`1 passed (19.9s)`，`driftPx 0` / `smallestGapPx 299` / `downwardWritesInWindow 0`）。**不得写成「已复现几何回归」**——本任务证明的是夹具可测性缺陷（近 16 次 gate 事件 2 红），不是 prepend/restore 保证不成立。
  2. **那次红的触发源本轮未确证**：`quay-e2e-9atUIN` 的 trace 里没有 504、没有 `net::ERR_NETWORK_CHANGED`、没有 `ERR_FAILED`（只有 `net::ERR_ABORTED` 与未建立的 `/ws`）。被确证的只有**站点**：`:2227` 那次导航在守卫覆盖之外，且其后的 `click` 是无界等待。**不得写成「已复现 driver 那次红」**；本任务能做到的是证明同形路径可被确定性地重放（AC3）并在内层封住。
  3. 现场 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-9atUIN/test-results/transcript-follow-transcri-9252a-re-that-lands-at-the-bottom/` 是那次红的原始产物（`error-context.md` + `trace.zip`），读数取自它而不是 ledger 的 `reason` 尾巴；`reason` 尾巴偏好 stderr，playwright 的报告在 stdout 上被整段丢弃。
  4. 端口/负载前提：本机与别的 lane 共享宿主（本轮直跑时 ports 47101 / 47173 已确认空闲，宿主 load ~84，fleet cgroup 曾记过 1 次 `oom_kill`）；AC1 的「有别的 lane 在跑」这一条要在完成记录里写清当时是哪个 lane、它的窗口与自己的读法。
- **L_D = 0**。L_D 该轴仍暗，理由：本任务只改 e2e 夹具的启动路径与失败信息，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G = 0**。L_G 该轴仍暗，理由：同上 —— 读数是运行期退出码、墙钟与页面文本，不是生成质量轴读数；目标层判据仍由 GOAL-004 的其余判据承担。

## Touches

- `e2e/transcript-follow.spec.ts`
- `tasks/gap-transcript-follow-ac110-case-nav-skips-boot-guard.md`
