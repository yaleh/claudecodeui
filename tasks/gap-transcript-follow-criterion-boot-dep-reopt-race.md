---
id: gap-transcript-follow-criterion-boot-dep-reopt-race
title: AC-108 判据在并发负载下偶发假红（本轮实测 2/5）：夹具的 fresh-DB 启动无守卫，一次 Vite 依赖重优化/reload
  把页面从测量脚下抽走（守卫已在 voice-trim 修过，未回灌到本判据）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-108
---
## Proposal

**本轮的直接测量（不是台账尾巴）**：driver 的 goal-cli 在 `2026-09-23T17:58:00.347Z` 记 AC-108 `fail`（`.quay/gate-events.jsonl`，reason 只有 `acceptance failed (exit 1)` 加 `[truncated, 1954 chars of stderr omitted]`）。本轮在同一 HEAD `bc46f9e0` 上直跑判据 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"` 共 5 次：

```
run1 rc=0 wall=21s   run2 rc=0 wall=20s   run3 rc=1 wall=56s
run4 rc=1 wall=55s   run5 rc=0 wall=34s          → 2/5 红
```

绿次的自报读数是判据全真：`1 passed (18.7s)`、`stream_delta:22`、`stream_end:1`、`rowMutationCount:1`、`writesAtExcursions:[]`、`zeroWrites:0`、每一帧 `gap0`。**红次里 AC-108 的断言一次都没有被执行到**——两次都死在夹具的启动阶段，死在几何采样之前。

**现场（可逐行复核，driver 那次运行）**：`/data/scratch/yale/quay-e2e-Yo1GVO/test-results/transcript-follow-transcri-1a4d0-hile-one-row-grows-in-place/`

- `error-context.md`：`Error: Channel closed`；`Error: locator.fill: Target page, context or browser has been closed`，call log 停在 `- waiting for locator('#username')`，`- Location: e2e/transcript-follow.spec.ts:2147:3`；**没有 `# Page snapshot` 段**——页面空白到没有东西可快照。
- `trace.zip`：`test.trace` 的顺序是 `"beforeAll" hook timeout of 180000ms exceeded` → `error | Error: Channel closed` → 那次 `Frame.fill params {selector:"#username", … value:"e2euser"}` 仍停在 `waiting for locator('#username')`；`1-trace.trace` 的控制台是成串的 `Failed to load resource: net::ERR_NETWORK_CHANGED`，全部落在 app 自己的模块 URL（`http://127.0.0.1:21039/src/modules/auth/index.ts`、`…/shared/context/WebSocketContext.tsx`、`…/i18n/config.ts`、`…/plugins/index.ts` …），而 `before` 帧快照的 body 是 `"html": [[1, 54]]`。

**本轮自己那两次红的现场更直接**：`[e2e] watchdog: this run crossed its own 55000ms ceiling at 55005ms and is ending here with exit 1 at 55008ms — stuck at stage "browser-launch-or-cases"`，而紧接着的上一行是

```
[WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/scratch/yale/quay-e2e-9RyXr4/vite-cache/deps/react-scan.js?v=934580e0 as it exceeds the max of 500KB.
```

——本次运行**自己的** `vite-cache/deps` 正在做一次冷重优化。run4 同形（`quay-e2e-UUieuE`，同样止步于 55s watchdog）。

**机制（两处合流到一个夹具盲点）**：

1. 每次运行的 client 走私有缓存：`playwright.config.ts:942` 把 `VITE_CACHE_DIR` 指到本 run 的 `viteCacheDir`，热启动靠 `seedViteCache()`（`playwright.config.ts:858`，在 `:888` 被调用）从共享 `node_modules/.vite/deps` **拷**一份。该函数自述这份拷贝「只在共享缓存由**本 root** 写时可用（`configHash` 含 root）」，其余情况在 catch 分支里**静默降级为从零预构建**——代价正好落在第一次 `page.goto('/')` 里。而 `gap-e2e-shared-vite-dep-cache-invalidates-inflight-page` 的完成记录已实测出这是**结构性**的：Vite 的 `root` 取进程 cwd，`configHash` 把它计入，故任何一个 **worktree 里**的 e2e 运行写下的共享缓存，都让主 checkout 里的这份种子失效。本机同时有别的 lane 在跑时就是这条路。
2. 预构建/重优化期间，Vite 对已在飞的模块请求答 `504 Outdated Optimize Dep`，并由**它自己的客户端 `location.reload()`**；被这次 reload 打断的模块请求在 DevTools 侧读作 `net::ERR_NETWORK_CHANGED`——与上面 trace 完全吻合：导航本身成功、没有任何页面错误、body 近乎空、`#username` 永不出现。`e2e/voice-trim.spec.ts:684` 起的注释把这条机制写得比本任务更清楚：`Neither blank throws on its own: the navigation succeeded, so nothing surfaces until the wait for the form runs out.`
3. 而判据自己的 spec 没有这道守卫：`e2e/transcript-follow.spec.ts:1659` 是 `await page.goto('/')`，`:1660` 紧接着 `await page.locator('#username').fill('e2euser')`——**无启动探针、无重载、无响亮失败**。页面被 reload 掉之后，这次 `fill` 等的是一个已经不存在的文档：它或者等到 `:1644` 的 `test.setTimeout(180_000)`，或者被本 run 自己的 55s watchdog 杀掉；两条路都**先于** `:2279` 的几何采样，也都不给台账留下任何判据信息（`runAcceptance` 的失败摘要偏好 stderr，playwright 的报告在 stdout 上被整段丢弃）。

**为什么早先的修复没挺住（本任务存在的理由）**：

- `gap-transcript-follow-on-real-stream`（done）把 AC-108 的几何断言做成了真——本轮复测它确实真（22 帧全 `gap0`）——但它的 DoD 只要求「连续 ≥2 次绿」。**2 连绿挡不住 ~1/3 的夹具猝死**：本轮 5 次里红 2 次。
- 更关键的是这条盲点**已经在另一个 spec 上被修过，只是没有回灌**到这里：`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page`（AC-121，done）为 `e2e/voice-trim.spec.ts` 写了有界冷加载守卫（`appears` 在 `:309`，守卫在 `:700` 起：8s 探针 → ≤3 次 `page.reload()` → 耗尽后抛出**含页面文本与 console 错误**的错误），并把依赖缓存按 run 隔离。那条守卫至今只活在 voice-trim 里；判据自己的 spec 仍是「goto 完直接 fill」。同一轮修复把「共享目录被别的 run 重写」换成了「每个 run 自己可能冷启动」——共享缓存的写竞争没了，冷启动的代价却搬进了判据的测量窗口。
- 所以本轮要修的不是几何，而是**判据的可测性**：GOAL-004 的复验要能反复读到真值；一个 ~1/3 概率死在启动阶段的判据，每轮给台账的都是噪声。

<!-- dedup-ref -->
同机制关联（记给出处，不是本任务的前提）：`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page`（done，AC-121）是这道守卫的出处与修法来源；`gap-e2e-onboarding-anchor-seeded-transcripts`（done，AC-027）是「夹具共享前提被后一次改动拆掉」的同类前例。本任务不重复申领 AC-121 / AC-027，也不回退它们的修法，只把守卫补到判据自己的路径上。

**修法（最小切片，两处，都在夹具侧；判据断言一行不动）**：

1. **把冷优化的代价移出测量窗口** —— `playwright.config.ts` 增一个 `globalSetup`（该文件现在没有；Playwright 先起 `webServer` 再跑 `globalSetup`，故此刻两服务器都已应答），用已有的 `CLIENT_URL`（`:159`）对本次运行自己的 client **有界地**请求一次 app 入口（`/src/main.tsx` 或 `/` 上的入口 chunk），拿到 200 再返回；超时则在这里响亮报错并附该 URL 的状态码。这样本 run 的 optimize / re-optimize 在任何页面存在之前完成，`seedViteCache` 那句「只在本 root 写的缓存上有效」不再决定判据能不能开始。
2. **把 voice-trim 已经验证过的有界启动守卫就地搬进判据自己的 `beforeAll`**（照搬模式，**不新建文件**，避免 e2e 新文件触到 lint 边界）：短超时探 `#username` → 未出现则有界 `page.reload()`（各次预算之和留在判据自己的时间预算内）→ 仍不出现则抛出**含页面文本 + console.error / requestfailed 证据**的错误。这一条同时把「无界等待」变成「有界自报」：修后真正的启动失败会在 ~20s 内以夹具自己的话退出，而不是被 gate 的 60s 从外面杀掉、也不是 180s hook 超时。

⛔ 换绿禁令（与下面 AC6 的 anti-fake 同源）：不得加 `retries`、不得 `skip` / `fixme`、不得放宽或删除 AC-108 的任何断言（尤其 `:2279` 的 `unpinned` 至今**没有上界豁免**，不得加）、不得把几何采样挪出 `-g "AC-108"` 那次运行、不得改 goal gate 的上限、不得用 `--repeat-each`、不得以桩或镜像替掉真实 Chromium + 真实后端。

## AC

- [ ] 判据 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"` 退出码 0，且在**同一窗口内有别的 e2e lane 在跑**的条件下连跑 ≥10 次全部退出码 0；逐次记录 `exit=… wall=…` 与 `git rev-parse HEAD`，10 行读数原文登记在完成记录里。
- [ ] 绿路径不因为守卫/预热而变慢：上述 10 次里每次 playwright 自报时长 ≤ 25s（修前绿次为 `1 passed (18.7s)`、wall 20~21s），给出最小/最大值；并记录每次日志里的 `[e2e] server=… client=…` 行与 `test -d <dataDir>/vite-cache/deps` 的退出码，证明用的是本次运行自己的端口与缓存目录。
- [ ] **阴性对照（冷优化 + 预热关闭必须红）**：把 client webServer 临时改成强制重优化（`npx vite --force`，或 `optimizeDeps.force`）并临时把预热改成空操作，跑判据 → 必须非 0，且失败形态落在夹具启动阶段（空白页 / `#username` 不出现 / 依赖重优化），复现修前那条路径；退出码与失败原文登记在证据里，之后全部还原。
- [ ] **阳性对照（冷优化 + 预热在必须绿）**：只恢复预热（仍 `--force`）→ 判据必须退出码 0。AC3 与 AC4 一起证明预热是承重的、不是装饰；之后 `git diff --stat` 证明 `vite.config.js` 与 `playwright.config.ts` 只剩预热那一处改动。
- [ ] 夹具不再无界等待：把 `beforeAll` 的启动探针指向必然不出现的哨兵选择器 → 该次运行必须在 ≤30s 内以**夹具自己的错误信息**结束，错误里含页面文本与 console / requestfailed 证据；不得表现为 180s hook 超时，也不得让 runner 撑到 goal gate 的 60s 才被杀。探针还原后判据复绿。
- [ ] 判据未被削弱（AC-108 自己的两条抗假变体仍必须红）：(i) 把 follow 触发信号改回 `chatMessages.length` → 判据退出码非 0；(ii) 单帧一次性终态（`growthStepsInStream` 读 1）→ 判据退出码非 0。两条都留输出并还原；`git diff` 证明 `e2e/transcript-follow.spec.ts` 里 AC-108 的断言（含 `maxLastRowHeight > paneHeight`、`stampChanges ≥ AC108_DELTA_COUNT - 1`、`nodeRuns` 长度为 1、`finalizeAt > 0`、`settleFrame > streamEnd`、以及 `:2279` 那条无豁免的 `unpinned`）一行未删未松。
- [ ] `npm run typecheck` 退出码 0；`npm run lint` 退出码 0。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-108 的尾巴由 `2026-09-23T17:58:00.347Z` 的 fail 转回 pass，并在其后**连续多轮** frozenRecheck 中保持 pass（并发不再把它偶发打红）。
- **真落地**：不是一个更长的等待，而是**判据的启动路径不再与依赖优化赛跑**——本 run 的 optimize / re-optimize 在任何页面存在之前完成（预热），且页面若真被抽走则以夹具自己的话在 ~20s 内报错退出（守卫）。证据是 AC1/AC2 的 10 个退出码与墙钟、AC3/AC4 的负正对照、AC5 的有界失败原文。
- **读数原文**：AC1 的 10 行 `exit=… wall=…`；AC2 的 `[e2e] server=… client=…` 行与最小/最大自报时长；AC3/AC4 的两次退出码与失败/通过原文；AC5 的失败错误全文（含页面文本与 console 证据）；AC6 两条抗假变体的退出码与判据断言差异。
- **前提与不可复现项如实登记**：必须写明本轮**没有**确证 driver 那次 `17:58:00Z` 的运行也走了冷预构建路径（它的 trace 只留下 `net::ERR_NETWORK_CHANGED` 与近乎空的 body），`/data/scratch/yale/quay-e2e-Yo1GVO/test-results/transcript-follow-transcri-1a4d0-hile-one-row-grows-in-place/` 是那次的现场；不得写成「已复现 driver 那次红」。同时写明本任务的红**不是** `gap-transcript-follow-on-real-stream` 的几何修复回归（22 帧全 `gap0` 已复测）。
- **L_D 该轴仍暗，理由**：本任务只改 e2e 夹具的启动路径与失败信息，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 读数是运行期退出码、墙钟与页面文本，不是生成质量轴读数；目标层判据仍由 GOAL-004 的其余判据承担。

## Touches

- `e2e/transcript-follow.spec.ts`
- `playwright.config.ts`
- `tasks/gap-transcript-follow-criterion-boot-dep-reopt-race.md`
