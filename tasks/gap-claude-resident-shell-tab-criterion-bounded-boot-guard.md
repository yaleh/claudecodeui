---
id: gap-claude-resident-shell-tab-criterion-bounded-boot-guard
title: AC-174 判据的启动阶段无界：本族既有的有界预热+启动探针未回灌到 e2e/resident-shell-tab.spec.ts——一次页面期
  Vite 依赖冷预构建/模块图中断被拖成夹具会话行 30s 超时记红（并伴随共享 e2e boot 越过 webServer.timeout=30_000
  的负载假红）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-174
---
## Proposal

来源：本轮 gap-filing 的直接测量，不是台账尾巴。AC-174 已离开 reverify 范围（其 GOAL-013 已 achieved、不再活），且未声明 `long-term: true`，台账尾部记为 CURRENTLY FALSE；本轮在立案前直接重跑了判据本身，并读失败轮/台账原始读数。

判据命令（不变）：`npx playwright test e2e/resident-shell-tab.spec.ts`。门限不变：driver-anchor 下 goal gate 的硬 60s；`playwright.config.ts` 的 `SINGLE_SPEC_CEILING_MS = 55_000`（spec 自身 `:543` 的 `elapsed < 55_000` 亦钉此数）。

**本轮的直接量（不是推断）**

- 台账 AC-174 最近 14 条 goal gate：12 pass、2 fail，两条 fail 是**两种不同的启动期形态**：
  - `2026-10-01T18:32:46.146Z` fail，`reason` 逐字 `acceptance failed (exit 1) — [WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-Zo6omf/vite-cache/deps/react-scan.js?v=f9b17d75 as it exceeds the max of 500KB.`——与本族既有结论逐字同形（本次运行自己的 `vite-cache/deps` 在**页面期**做了一次冷预构建/重优化，把在途模块图整批打断）。
  - `2026-10-01T18:42:07.669Z` fail，`reason` 逐字 `acceptance failed (exit 1) — … [e2e] server=1181 client=14247 Error: Timed out waiting 30000ms from config.webServer.`——**boot 阶段**：共享 e2e server（tsx 模块图加载）越过 `playwright.config.ts` 的 `webServer[].timeout: 30_000`。
- 本轮直跑三次：两次 `EXIT=1`、stderr 逐字 `Error: Timed out waiting 30000ms from config.webServer.`（run1/run2）；一次带 `DEBUG=pw:webserver` 的 `EXIT=0`、`1 passed (49.5s)`、`elapsed=49899`，其测得 server 从 spawn（`18:45:04.890`）到 `/health` 200（`18:45:24.684`）≈ **20s**、vite ready `255ms`、随后用例 ≈28s ⇒ **通过轮总计已逼近 55s 上限**，boot 的负载抖动没有余量。

**机制（本仓能修的那一半）**：`e2e/resident-shell-tab.spec.ts` 是本族**唯一**没有启动守卫的成员——逐份实测 `grep -c warmClientStartup`：本 spec **0**，`e2e/resident-running-view.spec.ts` 2、`e2e/resident-status-bar.spec.ts` 2、`e2e/resident-ui-layout.spec.ts` 7；`grep -c navigateBounded` 本 spec **0**。它的启动路径只有一次无预算导航（`:398` 的 ``page.goto(`/session/${SEEDED_SESSION_ID}`)``），这条路上唯一的等待是夹具会话行 `:360` 的 `toBeVisible({ timeout: 15_000 })` 与 `:399` 的 shell 标签 `waitFor 20_000`。于是一次页面期 Vite 依赖冷预构建被拖成超时记红，而不是一次自愈的重放。boot 那一条（`config.webServer` 30s）是**另一层**：它在任何页面存在之前发生，spec 侧守卫够不着。

<!-- dedup-ref --> **为什么上一次的修法没兜住**：`gap-claude-resident-shell-tab`（`goal_ac: AC-174`，**done**，2026-09 落地）把 Shell 标签的禁用/提示/已激活态守卫/「关闭常驻模式」菜单与判据都落对了，但它没有把本族既有的启动守卫带回本 spec。守卫家族在本仓早已成立并已回灌到多份兄弟 spec（`grep -c warmClientStartup` 均 ≥2）：`e2e/resident-running-view.spec.ts`（`gap-resident-running-view-criterion-bounded-boot-guard`，done）、`e2e/resident-status-bar.spec.ts`（`gap-resident-status-bar-criterion-bounded-boot-guard`，done）、`e2e/resident-ui-layout.spec.ts`（`gap-resident-ui-layout-criterion-bounded-boot-guard`，done），以及 `e2e/session-filter.spec.ts` / `e2e/transcript-follow.spec.ts` / `e2e/voice-dashscope-written.spec.ts` / `e2e/voice-error-messages.spec.ts` / `e2e/voice-identifier-repair.spec.ts`（各自 `gap-*-criterion-bounded-boot-guard` 或 `gap-*-boot-dep-reopt-race`，done）。`e2e/resident-shell-tab.spec.ts` 是这一族里剩下的那份「只有封顶、没有守卫」的 spec。

**修法（移植既有守卫，不发明新机制）**：把家族既有的两个杠杆搬进 `e2e/resident-shell-tab.spec.ts` 的启动路径：

1. **有界客户端预热**（`beforeAll` 内、`browser.newContext()`/`newPage()` 之前）：对 `baseURL` 依次取 `/`、`/src/main.tsx`、以及从 entry 文本里读出的一个本次运行当前的优化依赖 URL，直到 200；每步各自带 deadline，非 200 / 超时按 url+status 指名抛错（照 `e2e/resident-running-view.spec.ts:502` 的 `warmClientStartup` 形态与语义，含「客户端接了连接却不答」也要按名字失败）。
2. **有界启动探针**：`:398` 的启动导航改走 `navigateBounded`（照 `e2e/resident-running-view.spec.ts:625`），落点是夹具会话行；探到即返回，探不到就在 budget（如 14s）内 `page.reload()` 重放，并收集 `page.on('requestfailed')` / console 证据；预算耗尽时带页面文本 + 失败请求列表大声抛错，绝不静默继续。

**明确不动 / 不变式**：判据命令不改；60s 门限与 55s spec 上限不动；`:372` 那个用例的 `expect` 一字不动；不加 Playwright `retries`；不开 `reuseExistingServer: true`；不 stub、不 skip；不把禁用/提示/已激活态/菜单断言搬走；不删 AC-174 原本的假形态臂（按进程是否存活判定 ⇒ 常驻但未运行 Shell 可点，必须红）。预热与探针留在 spec 内，**不动 `playwright.config.ts`**（`globalSetup` 需要一个 `e2e/*.ts` 新文件，会触发 lint 边界，与 `gap-session-filter-criterion-bounded-boot-guard` 同一条理由）。

**boot 那一条如实登记**：`Error: Timed out waiting 30000ms from config.webServer.` 发生在共享 e2e server 的 tsx 模块图加载阶段（本机负载下实测 ~20s，尖峰 >30s），spec 侧守卫够不着它。本任务的可控目标是**把页面期那一条从偶发红改为有界重放**；若 boot 那一条在守卫落下后仍复发，须如实归因为**宿主负载**（本族既有记录：`scoped-gate-can-red-on-fleet-load-boot-timeout`、`resident-server-restart-boot-health-timeout-is-load-flake`），不得栽到本任务头上，也不得用改断言 / 加 retries 的方式掩盖。

## AC

- [ ] AC1 有界客户端预热真实生效：`e2e/resident-shell-tab.spec.ts` 里有 `warmClientStartup`（或等价命名）的定义与「任何页面之前」的调用，逐 URL 带 deadline，非 200 / 超时按 url 指名抛错。验证：`grep -n "warmClientStartup" e2e/resident-shell-tab.spec.ts` 同时命中定义行与调用行，且 `npm run typecheck` 退出 0。
- [ ] AC2 启动导航走有界探针：`grep -n "page\.goto(\|page\.reload(" e2e/resident-shell-tab.spec.ts` 的每一处都落在探针函数体内部（或为 `ensureSignedIn` 内部既有、已解释的重试导航），函数体外无裸启动导航；探针耗尽预算时抛出携带页面文本与 `requestfailed` 列表的错误。验证：上述 `grep -n` 输出逐行落界 + `npm run typecheck` 退出 0。
- [ ] AC3 有界失败的实测：把探针落点临时指向一个不可能存在的 sentinel 后，`npx playwright test e2e/resident-shell-tab.spec.ts` 在 **30s 内**以非零退出，且输出里带页面文本与失败请求列表；还原后该读数与还原读数一并登记。验证：两次运行的 `echo $?` 与 wall time。
- [ ] AC4 判据在负载下连续绿：`npx playwright test e2e/resident-shell-tab.spec.ts` 连续 ≥5 次全部 `exit 0`，且每一次 wall < 55_000ms（一次都不触发 55s 看门狗 / 60s 门限），其中至少一次与 ≥4 份兄弟 spec 并发。验证：逐次 `echo $?` + wall time。**如实登记**：本机负载高（本轮 load1 远超 10），并发那一次若兄弟 spec 自己红，须点名归因，不得算到本条头上。
- [ ] AC5 判定面未变：`git diff develop -- package.json playwright.config.ts` 为空；`git diff develop -- e2e/resident-shell-tab.spec.ts | grep -c "^-.*expect("` 为 **0**；判据命令 `npx playwright test e2e/resident-shell-tab.spec.ts` 与 AC 记录 `criterion:` 逐字一致。验证：三条命令的逐字输出。
- [ ] AC6 AC-174 的假形态仍然红（承重）：把禁用改成**按进程是否存活**判定（读 `GET /api/session-hosts` 的 host 存在性，或等价地把判定挂在「有没有 live host」上）⇒ 判据命令退出**非 0**，且红**落在 `shellTab.disabled === true` 那条断言**上（常驻但未运行时 Shell 仍可用）。登记变异 diff、失败断言逐字、退出码；恢复后判据回到 0。验证：变异跑与还原跑的 `echo $?`。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-174 的台账尾部不再是 CURRENTLY FALSE），且这条绿在此后连续多轮 frozenRecheck 中保持 pass——即并发负载下页面期 Vite 冷预构建不再把它偶发打红。AC4 的 ≥5 连绿（含一次 ≥4 份兄弟 spec 并发）逐次 wall/exit 写进完成记录；AC3 的有界失败读数（探不到时 <30s 红、带页面文本与失败请求列表）与还原读数一并登记；AC6 的假形态读数（按存活判定 ⇒ 常驻未运行 Shell 可用、红在 `shellTab.disabled` 断言）与还原读数一并登记。⛔ 不得用改断言 / skip / `retries` / 改判据命令换绿；`expect` 一字未改由 AC5 机械证明。完成记录里必须写明：本仓修掉的是**响应方式**（无界等待 → 有界重放），触发源（本次运行自己的 Vite 依赖冷预构建）不在本仓可控范围内——因此这条判据的稳定性依赖守卫，而不是依赖触发源消失；并如实登记 boot 阶段那条 `config.webServer` 30s 读数是否复发及其负载归因。

## Touches

- `e2e/resident-shell-tab.spec.ts`
- `src/modules/project-workspace/WorkspaceMain.tsx`（仅 AC6 假形态变异的临时写点，跑完还原，不进最终 diff）
- `tasks/gap-claude-resident-shell-tab-criterion-bounded-boot-guard.md`（自触）