---
id: gap-ac188-criterion-body-budget-below-its-turn-walk-floor
title: AC-188 的用例体预算 20s 低于它自身回合行走的实测地板，负载下假红
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-188
---
## Proposal

**现象（台账 + 直接重跑，两次独立读数）**

门账本里 AC-188 的 `gate=goal` 事件在 2026-10-07T04:17:04.300Z 与 04:19:13.255Z 两次 pass（树
`0399dd59f91c8de4746a2ae4955f67bd854ea21e`），随后 2026-10-07T04:21:00.709Z 记 fail，树
`e9bf1390f58734e44b82abe833cb172229d481b5` —— 这正是当前树的 treeSha。fail 的 `reason` 被截断到
WebServer 的 stderr（`[BABEL] Note … exceeds the max of 500KB`、`[DEP0190]`），读不出失败落点，所以本轮
**没有再依赖 reason 尾巴**，而是按本仓的方法论直接重跑判据。

本轮立案前直接重跑（同一棵树 `e9bf1390` == `git rev-parse HEAD^{tree}`，spec 与 `playwright.config.ts`
均 clean），四次墙钟：**18798ms pass / 20810ms FAIL / 18864ms pass / 18545ms pass** —— 1/4 假红。

**失败断言（逐字，来自 repeat 1）**

```
Error: the case body must land inside its own budget
expect(received).toBeLessThanOrEqual(expected)
Expected: <= 20000
Received: 20810
  at e2e/activity-dock-truthful.spec.ts:1384
```

即 `console.log('dock.wall=…')` 报出 20810ms，撞上用例自己的 `toBeLessThanOrEqual(20_000)`。

**关键：红的是预算，不是读数。** 同一次失败运行里，AC-188 的**每一个实质读数都是对的**：

- `dock.count.desktop=1  legacy.tab=0  legacy.inline=0  resident.activityMarkers=[]`
- `dock.count.mobile=1  legacy.tab=0  legacy.inline=0  resident.activityMarkers=[]`
- `resident.panel.controls={"start":1,"close":1,"copy":1,"address":1,"pid":1}`
- `consistency.turn.desktop={"dock":"in-turn","sidebar":true,"send":"stop"}`，mobile 同形
- `consistency.afterTurn.{desktop,mobile}` 全为 `{"dock":"absent","sidebar":false,"send":"send"}`

于是这不是「判据假」（`[data-activity-dock]` 数量、旧标记计数、resident 忙闲迁移、各处一致性全部成立），
而是**判据在负载下会红**——与 AC-199（`gap-ac199-criterion-wallclock-load-scaled-fixed-cost`）同形的
负载墙钟假红。

**地板实测（为什么 20s 不够）**

用例体里 `await clock` 走完调试 agent 的一整个回合（`unattended-turn@0` → `turn-end@5000` → `wait@5500`）
实测返回在 **~15.0–15.4s**（`walk-done @15024ms` / `@15373ms`）。行走之后还必须做：收尾后重新导航两个视口、
`await expect(page.locator(DOCK)).toHaveCount(0, { timeout: 20_000 })`、以及对回合结束窗口的 8×55ms 采样
（AC6 的窗口）——合计再加 ~3.5–5.5s。**用例体天然落在 ~18.5–20.8s，而守卫是 20_000ms**，几乎没有余量。
行走的 ~15s 是结构性的（spec 内 `:902-908` 的注释说明控制面拾取请求本身就要数秒），体不可能压到 ~15s 以下。

**为什么早先的修法没守住**

`gap-activity-single-dock-global-consistency`（现 `done`）建了这个用例，并在 AC8 里设下
`expect(wall, 'the case body must land inside its own budget').toBeLessThanOrEqual(20_000)`。它把上限
卡在 20s，而用例的地板本身就在 ~15s 的行走 + 强制的收尾/采样之上——**这个上限从一开始就贴着地板，
没有留出负载余量**。在旧树（`0399dd59`）上它 pass 了 19 次；当 mcp-ui-visible-context 合入、树变成
`e9bf1390`、宿主负载升到 round 425 记录的 `load1: 43.5`（`hostFreeBytes: 4250836992`）时，同一个用例体
越过了这条自己设的线。所以早先的修法不是「被回归打破」，而是**它设的内部守卫本身离地板太近**，在更重的
负载下必然偶发。

**边界的澄清。** AC-188 记录的 `expect:` **没有要求任何墙钟上限**——它要求的是「任一时刻恰有一个
`[data-activity-dock]`、旧标记计数为 0、resident 状态栏不再有忙闲字样、各处状态一致，桌面与移动各读一次，
外加两个假形态」。20_000 是这个任务自己加的用例体守卫，不是 AC 的约束。因此**重标这条内部守卫不等于放宽
AC**（这与 AC-199 的情形不同：那里的 40s 是 `expect:` 明文要求的，不得放宽）。⛔ 但 `SINGLE_SPEC_CEILING_MS
= 55_000` 与 60s 闸门**不动**，任何实质读数**一字不删**。

<!-- dedup-ref -->
追溯：唯一携带顶层 `goal_ac: AC-188` 的任务是 `gap-activity-single-dock-global-consistency`（`done`）——
它已 done，故按机制去重规则不是重复（done 恰恰是「早先修法没守住」的证据），本任务为新立。同机制的同类先例
（均为 `done`，各自别的 AC）：`gap-ac199-criterion-wallclock-load-scaled-fixed-cost`（AC-199）、
`gap-ac180-enter-criterion-load-flake-stabilize`（AC-180）、`gap-suite-criterion-wallclock-budget`（AC-103）。
以上仅为同类机制的追溯参照，不构成任何前置。

## Plan

1. **先量地板，再动预算。** 不改任何断言前，先在同一棵树上重跑判据并采集读数：`dock.wall=` 的序列、
   `walk-done @Xms`（行走地板）、以及回合结束后的收尾耗时（重新导航 + `toHaveCount(0)` + 8×55ms 采样）。
   把这些逐字写进 `## Evidence`——新预算必须从实测地板推出来，不许拍脑袋。
2. **优先削地板，其次才抬上限（二选一，必须给出实测理由）。**
   - 削地板：若能把固定成本做成对负载不敏感——例如把收尾阶段的等待改成对真实信号的确定性握手，或
     在不删 AC6 的回合结束窗口采样、不删 AC7 移动读数的前提下减少重复导航——则优先这么做，预算上限可保持不动。
   - 抬上限：若地板是结构性的（行走的 ~15s 无法压缩，收尾/采样也不能删），则把 `e2e/activity-dock-truthful.spec.ts`
     里 AC-188 用例体的预算（现 `:1384` 的 `toBeLessThanOrEqual(20_000)`）抬到实测地板之上并留出负载余量
     （参考值 **30_000**，须以实测为准）。抬完必须验证整次调用仍落在 `SINGLE_SPEC_CEILING_MS = 55_000`
     与闸门 60s 之内。
3. **保读数是硬约束。** AC-188 的每一条实质断言（单坞数量、`LEGACY_MARKERS` 计数为 0、
   `RESIDENT_ACTIVITY_MARKERS` 为空、`resident.panel.controls`、`consistency.turn` / `consistency.afterTurn`
   的两个视口读数）逐条保留，一个字都不许删或放松；`## DoD` 判的是这些读数仍在，不是「用时更短」。
4. **假形态回归。** 重跑 AC-188 记录里写死的两个假形态，证明它们**仍然会红**：
   (i) 恢复 `.chat-activity-tab` 与 `data-slot="chat-activity-inline"` 的挂载 ⇒ 数量读数必须红；
   (ii) 让 `src/modules/sidebar/RunningView.tsx` 改读 1 秒 `/api/session-hosts` 轮询 ⇒
   `consistency.turnOpen` 必须在回合刚结束的窗口内红。两个假形态必须各给出一条红的实测记录。
5. **稳定性验证。** 判据在改后连续 ≥8 次 pass，其中至少一次与立案时同量级的负载下运行（round 425 记
   `load1: 43.5`）。若仍见红，先判定是地板还是别的机制，不要把红藏起来。
6. **静态闸。** 改动文件过 `npm run typecheck`、oxlint 与本仓对该 spec 的静态检查。
7. **落账并自检。** `task-schema-check.js` exit 0、`quay task check <id> --json` 的 `missing: []`，
   只把 `tasks/gap-ac188-criterion-body-budget-below-its-turn-walk-floor.md` 加进提交。

## AC

- [ ] 复现并记录：在 HEAD 树上重复跑 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` ≥4 次，逐次记下 `dock.wall=`（立案时的实测序列为 18798 / 20810 / 18864 / 18545 ms，其中 20810ms 红），把序列写进 `## Evidence`
- [ ] 地板实测：记录一次 `await clock` 行走的墙钟（`walk-done @Xms`，立案时 ~15.0–15.4s）与回合结束后的收尾耗时，作为新预算的下界依据写进 `## Evidence`
- [ ] 预算重标：若走抬上限路线，`e2e/activity-dock-truthful.spec.ts` 中 AC-188 用例体的预算（现 `:1384` 的 `toBeLessThanOrEqual(20_000)`）被抬到实测地板之上并留余量（参考 30_000，以实测为准），且整次调用仍 `< SINGLE_SPEC_CEILING_MS = 55_000`
- [ ] 或削地板：若走削地板路线，收尾/行走的固定成本已对负载不敏感，且 AC6 的回合结束窗口采样与 AC7 的移动读数一条未删（二选一，二者必居其一，并给出实测理由）
- [ ] 假形态 (i)：恢复 `.chat-activity-tab` 与 `data-slot="chat-activity-inline"` 的挂载后重跑，AC-188 的数量读数**必须红**，并记下红的输出
- [ ] 假形态 (ii)：令 `src/modules/sidebar/RunningView.tsx` 读 1 秒 `/api/session-hosts` 轮询后重跑，`consistency.turnOpen` 在回合刚结束的窗口内**必须红**，并记下红的输出
- [ ] 稳定性：改后判据连续 ≥8 次 pass，其中至少一次在与立案同量级的负载（round 425 记 `load1: 43.5`）下运行，且每次 `dock.count`/`legacy.*`/`resident.*`/`consistency.*` 读数与 AC-188 的 `expect:` 相符
- [ ] 静态闸：改动文件过 `npm run typecheck` 与 oxlint（或本仓对该 spec 的等价静态检查），exit 0
- [ ] 任务自身 `tasks/gap-ac188-criterion-body-budget-below-its-turn-walk-floor.md` 已落账（自触）

## DoD

这是一次**判据可复现性**的落地，不是「测试存在」。判据是真实浏览器上的 `npx playwright test
e2e/activity-dock-truthful.spec.ts -g "AC-188"`，且在真实宿主负载下运行：

- 改后该判据连续 ≥8 次绿，并跨过一次与立案时同量级的负载（round 425 的 `load1: 43.5`）；早先那种「1/4 假红」
  不再出现。**真实对象是被操作过的**：真实 webServer + Vite 客户端 + 调试 agent 时钟，桌面与移动两个视口各读一次。
- 只用例体这一层的内部预算被重标（或地板被削），`SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸门未动；
  AC-188 的 `expect:` 未要求任何墙钟上限，故这是内部守卫的重标，不是放宽 AC。⛔ 不得放宽或删除任何实质读数。
- 两个假形态（旧标记挂载、1s 轮询 busy）**仍然会红**，各自的红有机读记录；这说明重标预算没有把判据的
  证伪力一起削掉。
- `## Evidence` 里逐字留档：墙钟序列、`walk-done @Xms` 地板、两个假形态的红、稳定性运行的读数。

## Touches

- `e2e/activity-dock-truthful.spec.ts`（AC-188 用例体的预算与/或收尾固定成本）
- `playwright.config.ts`（仅当需要为该 spec 声明 per-file 预算时；否则不动）
- `tasks/gap-ac188-criterion-body-budget-below-its-turn-walk-floor.md`（自触）