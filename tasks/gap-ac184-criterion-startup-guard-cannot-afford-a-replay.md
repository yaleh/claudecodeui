---
id: gap-ac184-criterion-startup-guard-cannot-afford-a-replay
title: e2e/activity-dock-truthful.spec.ts 的有界启动守卫预算算不过来：首跳超时后 12s 只剩 4s，永远到不了重放
  ⇒ AC-184 判据在负载下死在启动形态（同一棵树 05:20 pass / 05:22 fail）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-184
---
## Proposal

来源：本轮 gap-filing 的**直接测量**（判据物 + 台账 + 直接重跑 + 判据文件的静态算式），不是台账尾巴。

**判据物（逐字）**：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"`。

**AC 状态**：`goals/AC-184-真实浏览器-服务端不可达时坞显示连接中断-不再出现-thinking-计时冻结-停止按钮置灰并说明-恢复后回到真实状态.md` 记 `status: achieved`，其 GOAL-014 已 achieved、已离开 reverify scope，且未声明 `long-term: true`；台账最近一拍为 fail ⇒ 按 CURRENTLY FALSE 立案。

**（1）台账尾巴是同一棵树上的 pass→fail —— flake 签名，不是产品退化。**
`.quay/gate-events.jsonl` 里 AC-184 `gate=goal` 最后两拍（`grep '"AC-184"'` 后按 timestamp 排序）：
- `2026-10-07T05:20:34.982Z` `goal-cli` **pass**，`treeSha=4d605c2b981df0ca7879d83fab8f4d87ee45f0e6`
- `2026-10-07T05:22:35.245Z` `goal-cli` **fail**，`treeSha=4d605c2b981df0ca7879d83fab8f4d87ee45f0e6`
treeSha 逐字相同，且 `4d605c2b` 就是当前 HEAD `fb4743b9`（`git log --all --format='%H %T %ci %s'` 命中）。⇒ 两分钟内同一棵树先绿后红。

**（2）红不在坞的任何断言上 —— 死在 `beforeAll` 的启动守卫里。**
失败跑数据目录 `~/.cache/quay-e2e-tmp/quay-e2e-W6Qo1x`，`test-results/activity-dock-truthful-act-4a2b3-e-app-socket-is-partitioned/error-context.md` 逐字：

```
Error: the project row for activity-dock-workspace never rendered, so this run's client never came up to a document that stays (the navigation itself failed: page.goto: Timeout 8000ms exceeded.
Call log:
  - navigating to "http://127.0.0.1:1293/", waiting until "load"
): the page shows ""; console errors: <none>; failed requests: <none>
```

抛出点是 `e2e/activity-dock-truthful.spec.ts:560`（`navigateBounded` 的预算耗尽分支）。读数是「页面为空、无任何 console 错误、无任何失败请求」—— 文档根本没到。坞的 (i)–(v) 五条读数一条都还没开始读。

**（3）机制（本条承重的静态读数）：守卫的预算算不过来，慢的那一跳之后永远没有重放。**
`e2e/activity-dock-truthful.spec.ts` 的常数：`STARTUP_PROBE_DEADLINE_MS = 12_000`（:477）、`NAVIGATION_PROBE_MS = 8_000`（:459）、`STARTUP_PROBE_MS = 8_000`（:455）。`navigateBounded`（:531）逐字算：attempt 1 的 `timeout = min(8_000, budget=12_000) = 8_000`；一次**超时**的 `page.goto` 之后 `budgetMs() = 12_000 − 8_000 = 4_000`，落点探针 `min(8_000, 4_000) = 4_000`；探针耗尽即 `elapsed = 12_000 ≥ deadline` ⇒ 抛在 :560，**attempt 2 从未开始**。⇒ 守卫只在「首跳 ≤ ~4s 就结束」时才可能重放；而它存在的理由恰是「导航本身慢、或被 Vite 中游 full-reload 换掉文档」（见 `warmClientStartup` 头注释：Vite 对 mid-run 重优化提交推 `full-reload` 把文档整个换掉，`page.reload()` 重放正是为它设计的恢复）。设计注释（:475）声称「still fits the first 8s landing probe plus a full 3s replay」，该算式在导航本身超时时不成立。

旁证：失败 reason 尾部带 `[BABEL] Note: … deoptimised the styling of …/vite-cache/deps/react-scan.js … exceeds the max of 500KB`；`src/main.tsx:3` 顶层 `import { scan } from 'react-scan'`（`package.json:208` 有 `react-scan ^0.5.7`）⇒ 这是一次 Vite 对 500KB 新依赖的转换/重优化窗口。

**（4）直接重跑（本轮立案测量）—— 静默条件 3/3 绿。** 当前 HEAD（`author`，`fb4743b9`）直跑判据物三次：`1 passed`、`EXIT=0`、`dock.wall=14511/14512/14511ms`、`dock.recovered.elapsed=6596/6522/6305ms`；五条读数齐（`dock.state.before=in-turn`、`dock.state.after=unreachable`、`dock.words.hit=[]`、`dock.frozen.samples=["0s","0s"]`、`dock.composer.stop.disabled=true`）。⇒ 坞的承诺没有退化，红的是判据的**启动鲁棒性**。

**修什么（机制级、最小）**：把 `navigateBounded` 的预算改成「首跳即便用满自己的界，仍留得下一次有界重放 + 落点探针」，并让它在落界时**署名地**记录执行过的每一跳（首跳 / 第 N 次 `page.reload()`）。可选杠杆（二选一或并用，由实现者按实测取）：抬 `STARTUP_PROBE_DEADLINE_MS`，或把首跳的 `NAVIGATION_PROBE_MS` 收紧到「首文档迟迟不到就不再等」的量级，从而把重放预算腾出来。总墙钟仍须留在本族天花板内（`playwright.config.ts` 的 per-test `timeout: 60_000` 与单 spec 55s 看门狗之内）。⛔ 不动坞的断言、⛔ 不动 `dock.wall ≤ 20_000` 的用例体预算、⛔ 不改判据命令、⛔ 不加 retries/skip、⛔ 不动 `playwright.config.ts`。

<!-- dedup-ref --> 机制去重读数（本轮实测，checkout `/data/home/yale/work/claudecodeui`）：`grep -rn "^goal_ac: *AC-184" tasks/*.md` → 3 命中（`gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`、`gap-activity-idle-beat-clears-open-turn-anchor`、`gap-activity-dock-unreachable-degradation`），`status:` 逐字皆 `done`；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: AC-184`）→ 0 命中 ⇒ 无在飞认领者。同机制在飞扫描（`navigateBounded|STARTUP_PROBE|warmClientStartup|activity-dock-truthful`）→ 仅 `gap-ac188-criterion-body-budget-below-its-turn-walk-floor`（needs-human，**另一条 AC-188**，讲用例体 20s 预算而非启动守卫），与本条不同机制、不重复。

<!-- dedup-ref --> 「为什么先前的修复没兜住」（如实区分）：`gap-activity-dock-truthful-criterion-bounded-boot-guard`（done，commit `421afb84`）给这份 spec **引入**了守卫，把「无界启动」变成「有界启动、会署名」；本条不是它的回归，而是它的**下一个缺口**：守卫存在，但预算算术使它在最需要自愈的那一跳上无重放可走。`gap-ac184-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`（done）归因的是另一条红（运行期 HMR 把 `<ProjectWorkspaceRouteContent>` 打崩、红在 :680），机制不同、不重复。

## AC

- [ ] AC1 静态算式可检：改后的常数下，以「首跳用满 `NAVIGATION_PROBE_MS` 且其落点探针用满」为最坏情形，`首跳界 + 落点探针 + 重放一跳 + 重放落点探针 ≤ 改后的 STARTUP_PROBE_DEADLINE_MS` 成立。验证：把改后的常数与逐字算式入档（`grep -n "STARTUP_PROBE_DEADLINE_MS\|NAVIGATION_PROBE_MS\|STARTUP_PROBE_MS\|STARTUP_RELOAD_PROBE_MS" e2e/activity-dock-truthful.spec.ts`）。
- [ ] AC2 慢首跳真的自愈（承重）：在 `beforeAll` 的启动导航前注入一个**只在第一次文档请求**上把响应拖过 `NAVIGATION_PROBE_MS`、其后再正常服务的确定性 route（或等价的确定性慢首跳注入），`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"` 仍 `EXIT=0`，且逐字日志里能读出 **≥2 次导航尝试**（首跳 + 至少一次 `page.reload()`）后落点成功。登记注入 diff、逐字日志、`echo $?`、wall；随后还原并证明零残留（`git status --porcelain` 回到注入前）。
- [ ] AC3 take-fake 必须红（承重）：只在把守卫**还原成改前预算算术**（`STARTUP_PROBE_DEADLINE_MS=12_000` 且首跳界 `8_000`）时，**同一**慢首跳注入下守卫以非零退出、且日志只有 **1 跳**（无重放）、红落在守卫自己的署名错误（:560 一族）。登记变异 diff、逐字失败行、`echo $?`；`git checkout -- e2e/activity-dock-truthful.spec.ts` 还原后判据回到 `EXIT=0`。验证：变异跑与还原跑的 `echo $?`。
- [ ] AC4 坞的判定面一字未改：`git diff develop -- e2e/activity-dock-truthful.spec.ts | grep -c "^-.*expect("` 为 **0**；`git diff develop -- playwright.config.ts` 为空；判据命令逐字不变；(i)–(v) 五条读数与 `dock.wall ≤ 20_000` 的断言原样。验证：上述各命令的逐字输出。
- [ ] AC5 负载下连续绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"` 连续 ≥5 次全部 `exit 0`、每次 `dock.wall ≤ 20_000ms`、整跑墙钟留在本族天花板内（单 spec < 55s / < `playwright.config.ts` 的 `timeout: 60_000`）；其中至少一次与 ≥4 份兄弟 e2e spec 并发。如实登记：并发那次若兄弟 spec 自己红，须点名归因、不计入本条。验证：逐次 `echo $?` + wall。
- [ ] AC6 静态门：`npm run typecheck` 退出 0；本 spec 的 scoped lint 读数入档。验证：命令与退出码。

## DoD

- 判据物 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-184"`（逐字不改）在改后的树上**真的跑过**：静默条件 ≥5 连绿，且至少一次与 ≥4 份兄弟 e2e spec 并发时也不死于启动形态；逐次 `dock.wall` 与整跑墙钟逐字入档 —— 不是复述 `expect` 的文字，不是读台账尾巴。
- 守卫的「重放」不是声称而是**被观测到**：确定性慢首跳注入下运行日志逐字出现 ≥2 次导航尝试（首跳 + `page.reload()`）后落点成功；把预算还原成改前算术的同一注入则只有 1 跳并红。改前/改后两组读数 + take-fake 一并入档，任何人在同一 checkout 上可复现。
- 坞的承重面一个字节未动：diff 里 `e2e/activity-dock-truthful.spec.ts` 无 `expect(` 删除、无 `dock.wall ≤ 20_000` 改动、(i)–(v) 五条读数断言原样；`playwright.config.ts` 与判据命令零改动。
- 交付物只落在 `e2e/activity-dock-truthful.spec.ts` 与 `tasks/gap-ac184-criterion-startup-guard-cannot-afford-a-replay.md`；⛔ 不以 jsdom/组件层绿替代浏览器层绿；⛔ 不加 retries、不 skip、不改 timeout 来掩盖启动红。

## Touches

- `tasks/gap-ac184-criterion-startup-guard-cannot-afford-a-replay.md`（自触）
- `e2e/activity-dock-truthful.spec.ts`（改 `navigateBounded` 的预算算术与逐跳署名日志；坞断言零改动）
- `goals/AC-184-真实浏览器-服务端不可达时坞显示连接中断-不再出现-thinking-计时冻结-停止按钮置灰并说明-恢复后回到真实状态.md`（只读：criterion/expect 的逐字来源）
