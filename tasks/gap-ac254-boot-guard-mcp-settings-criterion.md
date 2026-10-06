---
id: gap-ac254-boot-guard-mcp-settings-criterion
title: "AC-254 判据 e2e/mcp-settings.spec.ts 启动路径无界：宿主 net::ERR_NETWORK_CHANGED
  打断在途模块加载被拖成 #username 30s 超时；移植 warmClientStartup + navigateBounded 有界启动守卫"
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-254
---
## Proposal

<!-- dedup-ref --> 同机制溯源（本段只作溯源，不声明任何依赖边）：`grep -rn '^goal_ac: *AC-254' tasks/*.md` 只命中两份**已 done** 的任务 —— `gap-ac254-mcp-settings-block-scope-checkboxes`（AC-254 的 UI/scope 出货）与 `gap-ac254-criterion-harden-against-repo-dotenv`（把判据从部署方 `.env` 解耦）。按 `standing-violated` 的规矩，done 不是重复而是「早先那次出货没有守住」的证据，故本条另立新任务。在飞（todo/ready/needs-human）任务里没有任何一份带顶层 `goal_ac: AC-254`（`gap-ac255-mcp-settings-i18n-completeness` 顶层是 `goal_ac: AC-255`，正文里提到 AC-254 只是溯源）。本条的机制与前两份都不同：前两份是「读数 / 环境耦合」，本条是「启动路径无界」。

**红因（本轮直接测量，非台账残影）**

- 台账：`.quay/gate-events.jsonl` 中 AC-254 最近四条 ——
  - `2026-10-06T03:10:38.631Z` verdict=pass treeSha=8c913f5c508f0b78c2bc0f074a49826a1e23036c
  - `2026-10-06T03:13:22.149Z` verdict=pass treeSha=eae097a097deabaa96726b2b98518792760f6370
  - `2026-10-06T03:15:47.995Z` verdict=pass treeSha=eae097a097deabaa96726b2b98518792760f6370
  - `2026-10-06T03:18:31.665Z` verdict=fail treeSha=eae097a097deabaa96726b2b98518792760f6370（reason 被截成 `acceptance failed (exit 1) — [WebServer] [BABEL] Note: …`，尾行不是失败点）
  同一 treeSha `eae097a0…` 先 pass 两次再 fail 一次 ⇒ **是 flake，不是稳定的回归**。本检出 `git rev-parse HEAD^{tree}` 正是 `eae097a0…`（HEAD `1bf3cd8e`）。
- 失败现场（driver 那次运行的数据目录仍在）：`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-092BfG/test-results/mcp-settings-CloudCLI-MCP--72d80--renders-no-connect-command/error-context.md`，逐字：

```
Error: expect(locator).toBeVisible() failed
Locator: locator('#username')
Expected: visible
Timeout: 30000ms
Error: element(s) not found
  281 | const reachAppShell = async (page: Page): Promise<void> => {
> 283 |   await expect(page.locator('#username')).toBeVisible({ timeout: LANDING_TIMEOUT_MS });
```

- 同目录 `trace.zip` 的 `1-trace.network`：导航本身成功（`GET /`、`/src/main.tsx`、`/src/App.tsx` 均 200），紧接着 **9 条在途模块请求以 `net::ERR_NETWORK_CHANGED`（status `-1`）收场**：`@fs/…/deps/react-router-dom.js`、`@fs/…/deps/react-i18next.js`、`src/shared/context/ThemeContext.tsx`、`src/shared/context/UiPreferencesContext.tsx`、`src/modules/auth/index.ts`、`src/modules/task-master/index.ts`、`src/shared/context/WebSocketContext.tsx`、`src/modules/plugins/index.ts`、`src/modules/project-workspace/index.ts`。模块图未执行、React 未挂载 ⇒ `#username` 永不出现 ⇒ 无界的 30s 等待（`LANDING_TIMEOUT_MS = 30_000`，`e2e/mcp-settings.spec.ts:54`）被拖成红。

**机制（本仓能修的那一半）**：触发源在渲染器之外 —— Chromium 的 `net::ERR_NETWORK_CHANGED`（本机 docker/veth 变动是网络变更通知的真实来源）把应用在途的模块请求整批打断，页面停在 boot 中途。`e2e/mcp-settings.spec.ts` 的启动路径既没有客户端预热、也没有有界导航探针：本轮实测 `grep -c warmClientStartup` = **0**、`grep -c navigateBounded` = **0**，文件里唯一的导航是 `:324` 的裸 `page.goto(booted.clientUrl, { waitUntil: 'domcontentloaded' })`，其后 `reachAppShell` 的 `#username` 30s `toBeVisible` 是这条路上唯一的等待。于是一次瞬时的模块加载中断被拖成红，而不是一次自愈的重放。

**为什么早先那次没守住**：`gap-ac254-criterion-harden-against-repo-dotenv` 的 AC6 明确要求「若出现 `net::ERR_NETWORK_CHANGED` 或空白页一类非确定性失败，如实记录并给出修法」，但它只把读数从部署方 `.env` 解耦，**没有**在启动路径上加守卫（所以今天这两个计数仍是 0/0）。

**交付（移植既有杠杆，不新造、不弱化断言）**

1. 把 `e2e/access-tokens-settings.spec.ts` 的两个既有杠杆移植进 `e2e/mcp-settings.spec.ts`（同仓已有实现在该文件 `:43` 的 `warmClientStartup` 与 `:137` 的 `navigateBounded`；`e2e/model-library.spec.ts`、`e2e/session-filter.spec.ts`、`e2e/resident-running-view.spec.ts` 等兄弟 spec 同形）：
   - 有界客户端预热 `warmClientStartup(clientUrl)`：在 `bootState()` 返回（Vite 已 200）之后、`context.newPage()` 之前，对该态自己的 `booted.clientUrl` 预热 shell + `/src/main.tsx` + 一条已优化的 dep，把冷预构建移出测量窗口。
   - 单一有界导航探针 `navigateBounded(page, landing)`：把 `:324` 的裸 `page.goto` 改为经探针导航；landing 用「`#username` 或 Settings 按钮」；探不到就在 ≤14s 预算内 `page.reload()` 重放，超预算则以页面文本 + 失败请求列表**大声红**（不是静默等 30s）。
2. 两态（`MCP_ENABLED` 开 / 关）各自的 `bootState` 都有自己的 `VITE_CACHE_DIR`，所以预热与探针都要按态做（serial 模式下顺序执行）。
3. **不改任何断言**：三个假形态 (i)(ii)(iii) 与 (a)–(e) 读数一字不改；不加 `retries`、不 `skip`、不 stub、不改判据命令、不改 `LANDING_TIMEOUT_MS` 的语义。`server/`、`src/`、`shared/` 零改动。
4. 在文件顶部加注释，指名触发源（宿主 `net::ERR_NETWORK_CHANGED`）在仓库之外，本仓修的是**响应方式**（无界等待 → 有界重放）；守卫的稳定性依赖重放，不依赖触发源消失。

真落地标准：driver 下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`。

## AC

- [ ] AC1 红因与「flake 非回归」可复验：贴出 `grep -h '"item_id":"AC-254"' .quay/gate-events.jsonl | tail -4` 的逐字输出，指出同一 treeSha `eae097a0…` 的 pass/pass/fail 序列，并贴 `git rev-parse HEAD^{tree}`（应为 `eae097a0…`）。
- [ ] AC2 因可归因：贴失败现场 `error-context.md` 的逐字失败块（`locator('#username')` / `Timeout: 30000ms` / `element(s) not found`，spec `:283`），以及 `1-trace.network` 中 9 条 `net::ERR_NETWORK_CHANGED`（status `-1`）的模块 URL 列表；读者据此能解释「导航成功 + 模块图未执行 ⇒ React 未挂载 ⇒ `#username` 不出现」。
- [ ] AC3 守卫已移植：`grep -c warmClientStartup e2e/mcp-settings.spec.ts` ≥1 且 `grep -c navigateBounded e2e/mcp-settings.spec.ts` ≥1；`grep -n 'page.goto' e2e/mcp-settings.spec.ts` 显示导航只出现在探针内（不再有裸 `page.goto(booted.clientUrl` 的启动路径）。贴命令与输出。
- [ ] AC4 守卫承重（可证伪）：做一次负控制 —— 把探针改成「不重放、直接返回」或把 `STARTUP_PROBE_DEADLINE_MS` 置 0，令一次加载中断不再自愈 ⇒ 判据红，且红形与 driver 这次同形（`#username` 超时 / 页面证据）；恢复守卫即回绿。逐字记录变异 diff、两次读数、恢复命令。如实登记：driver 那次红的触发源本轮是否能确定性复现；不能则写明用的是「不重放 ⇒ 无界等待复现」这一等价负控制。
- [ ] AC5 判据未变宽：`git diff develop...HEAD -- e2e/mcp-settings.spec.ts` 中不出现对 `expect(` 断言行的删改；三个假形态 (i) 写 scope 默认勾选 ⇒ (d) 红、(ii) 关闭态仍渲染接入命令 ⇒ (b) 红、(iii) 命令内嵌真实令牌 ⇒ (c) 红，三条各自只红被指名的读数，逐条记录变异 diff、逐字失败行、恢复命令。
- [ ] AC6 稳定性：连续跑判据 ≥5 次都退出 0（写下每次 tests/passed/failed 与 wall）；其中至少一次与 ≥3 份兄弟 spec 并发（抬高负载）仍退出 0。若出现非确定性红，如实记录并给出修法，不得靠放宽读数掩盖。
- [ ] AC7 不回归与仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`e2e/access-tokens-settings.spec.ts`（AC-228）不改一字仍通过。
- [ ] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐；`git diff --stat develop HEAD -- server/ src/ shared/` 输出为空（出货源码零改动），把该输出原样打印。

## Touches

- `e2e/mcp-settings.spec.ts`（移植 `warmClientStartup` + `navigateBounded` 有界启动守卫，路由唯一导航）
- `tasks/gap-ac254-boot-guard-mcp-settings-criterion.md`（本任务自身）

## DoD

driver 的下一轮 goal-gate 重跑 AC-254 判据（`for f in e2e/mcp-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/mcp-settings.spec.ts`）退出 0，并把 pass 写进 `.quay/gate-events.jsonl` —— AC-254 的台账尾部不再是 fail。且这条绿不是「恰好那次没抖」：AC6 的 ≥5 连绿（含一次 ≥3 份兄弟 spec 并发）逐次读数写进完成记录；AC4 的负控制读数（不重放 ⇒ 红在同形 `#username` 超时）与恢复后的读数一并登记；AC5 机械证明三个假形态仍各自只红被指名的读数、且断言行未被改动。完成记录里必须写明：本仓修掉的是**响应方式**（无界等待 → 有界重放），触发源（宿主层 `net::ERR_NETWORK_CHANGED`）不在本仓可控范围内 —— 因此该判据的稳定性依赖守卫，不依赖触发源消失。⛔ 不得用改断言 / skip / `retries` / 改判据命令换绿。
