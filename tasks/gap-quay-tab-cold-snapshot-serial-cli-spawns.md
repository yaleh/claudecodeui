---
id: gap-quay-tab-cold-snapshot-serial-cli-spawns
title: Quay tab 冷缓存快照 9.5s：collectSnapshot 串行 spawn 6 条 quay CLI，其中 server
  status 3.9s 只为取一个可选 dashboard URL（该读数失败还被静默吞掉）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->
机制去重读数（立案时实测）：`grep -rl "server status\|dashboardUrl\|SNAPSHOT_TTL\|串行 spawn\|snapshot" tasks/*.md` 只命中 `gap-quay-panel-task-adr-detail-list-and-dashboard-link`（done——建的就是这个面板与 dashboard 外链）与 `gap-ac247-overview-quay-cache-readonly`（done——管 MCP overview 的只读缓存）。二者都不认领本条的机制（快照冷路径的串行子进程累加），⇒ 本条不是重复。

**现象（MCP 浏览器 + curl，三次实测）**：在 CloudCLI 的 `quay` 项目会话（workspace `/data/home/yale/work/quay`）点开 Quay tab，冷缓存下 `GET /api/quay/<projectId>/snapshot` 耗时 **9.5s**（9558ms / 9509ms，curl 9625ms），响应体仅 11 KB，面板全程停在 loading。30s TTL 内重开为 1.6ms（`"cached":true`）。TTL 只有 30s（`server/modules/quay/quay.module.ts:10`），所以用户**每次隔一会儿再点都要重付一次 ~9.5s**，不是只慢第一次。

**根因**：`collectSnapshot`（`server/modules/quay/quay.service.ts:755-760`）把 6 条彼此独立的 quay CLI 命令用 `await` 严格串行 spawn，总时长是**累加**而非取最大。在 `quay` store（2575 任务 / 31MB markdown）上用该项目自己的 entrypoint 逐条实测：

| 命令 | 实测 | 面板实际用途 |
|---|---|---|
| `task list --json` | 2.9–3.0s（stdout 26MB） | 只要 10 行（`QUAY_RECENT_LIST_LIMIT`） |
| `goal list --json` | 1.3s（1.1MB） | 只要 10 行 |
| `adr list --json` | 0.36s（155KB） | 只要 10 行 |
| `driver status --kind worker --json` | 0.65s | driver 徽标（需要） |
| `config validate --json` | 0.13s | 配置问题数（需要） |
| `server status --json` | 3.9–4.65s | **仅 dashboard 外链，且失败静默** |

合计 9.4s，与端到端 9.5s 吻合。两条最刺眼的读数：

1. **`server status --json` 3.9s 只为拼一个可选 URL**（`readJsonQuietly`，失败连 warning 都不出）。用 `node --require` hook 住 `child_process` 实测其内部：它串行 spawn 6 个 `node --experimental-strip-types plugin/scripts/driver-runtime.ts status --kind <promotion|worker|outer|quality|meta|goal>`（525+465+471+233+1023+935 ≈ 3.65s），外加 12 次 `git worktree list`（每次 ~4ms）。这 6 个 kind 的数据 CloudCLI 一个都不用——`summarizeDashboardUrl`（`quay.service.ts:615`）只取 `services[name=web].{liveness.alive,host,port}`；而 `.quay/server.json` 里已现成存着 `services[].{host,port,up}`。
   附注（避免误判方向）：那 3.8s **不是网络**。直接 curl 探活端点只要 16ms；CPU profile 把 92% 记在 `spawnSync` 上，是 Node `spawnSync` 等子进程时自旋驱动 libuv 造成的归因假象。
2. **`task list --json` 2.9s 打印 26MB 只为渲染 10 行，但瓶颈不在打印**：加 `--page-size 10` 把 stdout 从 26MB 砍到 60KB，耗时几乎不变（2.83s）。CPU profile 显示 52.9% 在 `Buffer.concat`。对照读数：裸读同样 2583 个文件只要 **83ms** ⇒ 时间在 CLI 自身的解析/序列化路径里，不在磁盘。

**加重因素**：`QUAY_COMMAND_TIMEOUT_MS = 8000`（`server/modules/quay/quay-process.ts:16`）。`server status` 已跑到 4.65s，store 再大一点就会撞线，dashboard 链接会**静默消失**（该读数被 `readJsonQuietly` 吞掉，连 warning 都不进 warnings[]）。规模敏感性实测：同一代码路径，`quay`（2575 任务）9.5s vs `claudecodeui`（483 任务）~3s。

**修法（按收益排序，执行者可依实测调整）**：
1. dashboard 读数不再走 `server status`：改读 `.quay/server.json`（service 已有 `QuayFileReader` 边界），必要时在进程内探活以保留 liveness 语义 ⇒ 省 ~3.9s，并干掉 18 个子进程。
2. `collectSnapshot` 的各条独立命令改并发（`Promise.all`）⇒ 冷路径上界 9.4s → ~3.9s。
3. 列表类命令改有界读取（CLI 侧加在解析前截断的 `--limit`，或服务端直接扫 `tasks/*.md` 的 frontmatter）⇒ 再省 ~2–3s，上界降到 ~3.0s（`task list` 那条）。

**不在本任务范围**：quay CLI 自身 `task list` 的 store 加载性能（第 3 条的 CLI 侧实现若落在 quay 仓库，应另立任务）；MCP overview 的缓存语义（AC-247，已 done）。

## AC

- [x] AC1 并发性（结构判据，不靠墙钟稳定性）：`server/modules/quay/tests/quay.service.test.ts` 新增用例，给注入的 fake runner 每条命令加固定人为延迟（如 100ms），断言 collector 总耗时 < 各命令延迟之和（如 < 250ms 而非 ~600ms），且 runner 记录到的命令集合与改前逐字相同（防「漏读某一段」冒充加速）。
- [x] AC2 dashboard 读数不再 spawn CLI：同文件断言 collector 从不对 `['server','status','--json']` 调用 runner；且 `dashboardUrl` 仍能正确解析，并含负例（carrier 缺 `web` 服务 / 不可达 ⇒ `null`，且不产生 warning）。
- [x] AC3 假形态承重（实测红文案写进完成记录）：临时把并发改回串行后 AC1 用例**必须变红**，还原后转绿；临时让 dashboard 读数重新走 `server status` 后 AC2 用例**必须变红**，还原后转绿。
- [x] AC4 端到端冷路径实测：对真实运行的服务与真实 `quay` store（2575 任务）请求 `/api/quay/<id>/snapshot?refresh=1`，`time_total` < 6s；把 before(9.5s) / after 两个数字写进完成记录。
- [x] AC5 工具链：`npm run typecheck` 退出码 0；`server/modules/quay/tests/` 下两个测试文件全绿。⛔ **不得新增 `server/**/*.test.ts`**（仓库有按文件数 pin 的测试，新增会让它全线变红）；按 `docs/operations/process-isolation-and-memory-caps.md` 的单文件方式跑，不做无界 `--test` 扇出。

## DoD

真实落地：在真实运行的服务实例上（非替身），用 MCP 浏览器打开 `quay` 项目会话 → 点 Quay tab，冷缓存（`?refresh=1` 或 TTL 过期）下快照请求实测 < 6s，并记录浏览器 Network 面板的 duration 数字与截图；面板四张卡片（Task ledger / Stage goals / ADR / Tests+Fan-in）、driver 徽标、dashboard 外链的渲染与改前一致，`warnings[]` 不新增条目。仅「单测通过」不算达标。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/tests/quay.service.test.ts
- tasks/gap-quay-tab-cold-snapshot-serial-cli-spawns.md

## 完成记录

实现 commit `a2b174a7`（3 个文件：`quay.service.ts` / `quay.module.ts` / `quay.service.test.ts`，未新增任何 `server/**/*.test.ts`）。

**改了什么**

1. `quay.service.ts` — `collectSnapshot` 的 9 条彼此独立的读取（5 条 CLI + `suite-state` + 两条 carrier tail + dashboard）收进一个 `Promise.all`；`readJson` 改为返回 `{ value, warning }`（不再往共享数组里 push），warnings 在 `Promise.all` 之后按固定顺序收集，所以并发不改变 warning 的顺序。
2. dashboard 读数改读 `.quay/server.json` 的 `services[name=web].{host,port}`，再经**新的注入边界** `probeWebService(host, port)` 探活后才给出链接。carrier 自己的 `up` 字段**故意不采信**——它是写入时的声明，被 SIGKILL 的 server 会把它留在 `true`。wildcard 绑定（`0.0.0.0` / `::` / `*`）经 `probeAddress` 映射到 `127.0.0.1` 再探。`['server','status','--json']` 从 `QUAY_READ_ONLY_COMMANDS` 白名单**删除**，并在该白名单的文档注释里写明了原因：不是「不再调用」，而是**不可达**。
3. `quay.module.ts` — 生产 `probeWebService`：进程内 `GET http://host:port/health`，2s 硬超时（`DASHBOARD_PROBE_TIMEOUT_MS`），永不 reject（拒连 / 超时 / 非 2xx 都读 `false`）。

**AC3 假形态承重（实测红文案，已还原）**

- AC1：把 `Promise.all` 还原成串行 `await` ⇒ `AssertionError [ERR_ASSERTION]: the independent reads must overlap / 1 !== 5`，该用例耗时 **1006ms**（`peakInFlight` 读到 1，期望 5）；还原后同一用例绿、**203ms**。
- AC2：把 `['server','status','--json']` 加回白名单、dashboard 重新走 CLI 读数 ⇒ carrier 用例 `actual: null, expected: 'http://172.28.0.1:3651/'`；wildcard 用例 `actual: [], expected: [{ host: '127.0.0.1', port: 3651 }]`；还原后 17/17 绿。

**AC4 端到端冷路径（真实运行的服务 + 真实 `quay` store，2589 任务）**

同一台机器、同一支浏览器探针（Playwright，取 `requestStart→responseEnd`）：

| 冷路径请求 | 改前（生产 :3001，旧代码） | 改后（worktree :3099，新代码） |
|---|---|---|
| 点开 Quay tab 触发的 `/snapshot` | **9366 ms** | **2840 ms** |
| `/snapshot?refresh=1` | **9459 ms** | **2972 ms** |

（另有一组 curl 读数，同一对服务：改前 9.14 / 9.80 / 9.76s，改后 3.52 / 3.60 / 3.90 / 4.16s，全部 < 6s。）响应体两侧逐键相同（tasks 2589 / goals 234 / adrs 36 / driver running / configIssues 0 / `dashboardUrl` `http://172.28.0.1:20119/` / `warnings: []`），唯一差异是 `driver.lastRecordAt` 这个活心跳在两次测量之间走动。

**DoD 浏览器实测**

真实服务实例上打开 `quay` 项目会话 → 点 Quay tab（冷缓存）：面板从点击到渲染 **2840 ms**，截图存于本次会话的 `/tmp/ac4-cold-snapshot/quay-panel-after-desktop.png`（同目录另有改前对照 `quay-panel-before-desktop.png`；截图不落分支，以免超出 `## Touches` 声明的 4 个文件）。渲染与改前逐项一致：四张卡片（Task ledger 2589 tasks、Stage goals 206 achieved、Tests green/inner/worktree/128 lanes + Fan-in、ADRs (36)）、driver 徽标 `Driver running`、dashboard 外链 `http://172.28.0.1:20119/`（`target="_blank"`）、Recent tasks 10 行；两侧 `warnings[]` 均为 `[]`，DOM 中无 warning/unavailable 文案。

**AC5**

`npm run typecheck` 退出码 0（三条 tsc 全部通过）；`server/modules/quay/tests/quay.service.test.ts` + `quay-process.test.ts` 按单文件方式运行 **24/24 pass**，退出码 0；`git ls-files 'server/**/*.test.ts'` 249 → 249，未新增。
