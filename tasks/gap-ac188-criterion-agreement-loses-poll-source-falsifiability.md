---
id: gap-ac188-criterion-agreement-loses-poll-source-falsifiability
title: AC-188 的 AC6 回合一致性判据在坞合并后失去对「轮询驱动第二 busy 源」的证伪力——坞成为链路最快的源（回合打开即
  in-turn、回合间 absent），1 秒 /api/session-hosts 轮询侧的假形态在 e3f86d82
  改窄后的任何采样窗口都落不了红；先量坞的心跳节拍与轮询侧真实滞后，再定修窗口还是按 AC-172/177/178 家族先例退役该假形态
status: todo
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

<!-- dedup-ref --> 机制去重读数（立案前实测，不是关键字碰运气）：`grep -l '^goal_ac: *AC-188' tasks/*.md` → **2** 份——
`gap-activity-single-dock-global-consistency`（**done**，当年建了该用例并设下 20s 用例体守卫）与
`gap-ac188-criterion-body-budget-below-its-turn-walk-floor`（**needs-human**，正在落地预算 20_000→30_000，
并已按人工裁决把假形态 (ii) **移出**到本条）。机制侧扫描 `grep -ln 'afterTurn|轮询驱动|poll-driven|证伪力'` 命中的
邻居 `gap-activity-idle-beat-clears-open-turn-anchor`（**done**，AC-184）、`gap-activity-dock-phase-truthful`
（**done**，AC-187）、`gap-activity-dock-background-browser`（**done**，AC-194）各自是**别的 AC、别的机制**，
无一认领「回合一致性判据的证伪力」。⇒ 本条不是重复：done 的那两份恰恰是「上一次的修法没兜住」的证据，
在飞的只有本条要承接的那个移出项。

**现象（判据实测，不读台账 `reason` 的 stderr 尾巴）**

AC-188 用例（`e2e/activity-dock-truthful.spec.ts` 的 `AC-188` test）里有两条一致性断言：

- 回合**打开**时的窗口（`:1214-1228`，8×70ms）：`!inTurn(s.dock) && (s.sidebar || s.send === 'stop')` 必须为空；
- 回合**结束**后的窗口（`:1319-1332` + `:1366-1372`，每视口 8×55ms）：同一条过滤必须为空。

两条都是**单向**的：只抓「坞不在回合里、而 sidebar 或发送键还在说忙」。这本来正对着「第二个轮询驱动的
busy 源」——用例 `:1183-1196` 的注释逐字写着这个意图：「a sidebar reading the one-second host listing
lights up here, while the dock — reading the server's own activity — does not … One source, one answer:
every sample must agree.」

**这条证伪力已经没有了。** 在 `gap-ac188-criterion-body-budget-below-its-turn-walk-floor` 立案时，把
`src/modules/sidebar/RunningView.tsx` 的 busy 集合改成读 1 秒 `/api/session-hosts` 轮询后重跑，**两种实现
都让判据 exit 0**（逐字读数见 `## Evidence`）：

- 读 `useSessionHosts().snapshot` 的 lease 列表（历史写法，即被 `ad1bb63a` 换掉的那版）→ `/tmp/ac188-falsify-ii.log`：`1 passed`；
- 字面的 1 秒轮询（`api.sessionHosts.list()` + `setInterval(…, 1000)`）→ `/tmp/ac188-literalpoll2.log`：`1 passed`。

关键读数（字面轮询那次）：

```
consistency.turnOpen=[{"dock":"in-turn","sidebar":true,"send":"send"} ×8]
consistency.afterTurn.desktop=[{"dock":"absent","sidebar":false,"send":"send"} ×8]
probe.afterWalk.0={"dock":"in-turn","sidebar":true,"send":"send"}
probe.afterWalk.1={"dock":"in-turn","sidebar":false,"send":"send"}
probe.afterWalk.2={"dock":"absent","sidebar":false,"send":"send"}
```

即：**假形态确实让 sidebar 亮起来了，但它亮着的时候坞正读 `in-turn`**，正落在单向过滤器的容差侧；
等到坞转 `absent`（`probe.afterWalk.2`，约 200ms 后）sidebar 已经自己灭了。**没有任何一个采样时刻同时满足
「坞不在回合里」与「sidebar 说忙」。**

**根因（两条都在本条之前，都在 HEAD 与 develop 的祖先里）**

1. **`e3f86d82`**（2026-10-02 16:29，"activity dock: share the announced silence budget across dock mounts"）
   把回合结束后的窗口从**活页面**（从坞离开 `in-turn` 起采 **24×55ms ≈ 1.3s**，注释逐字写着
   「span ~1.3s — past the one-second poll's own beat, which is the interval the old sidebar lagged by」）
   改成**重新导航两个页面之后**采 **8×55ms ≈ 0.5s**，起点已是坞转 `absent` 之后约 2.5s：1 秒轮询早已追平。
   （`git log -S"i < 24"` / `-S"one-second poll"` 各只指向 `ad1bb63a` 引入、`e3f86d82` 改写；
   ⚠️ 本条立案前姊妹任务曾把此提交误记为 `421afb84`，已复核更正。）
2. **`b9b177d1`**（2026-10-04，heartbeat 带上 run-in-flight 位）与 **`7fd3598b`**（回合状态画进消息流）之后，
   坞在回合打开时读 `in-turn`、回合间根本不画（`toHaveCount(0)`）。当年那条红是
   `consistency.turnOpen={"dock":"idle","sidebar":true,…}`——靠的是**旧的坞语义**（resident 在回合间留 `idle`），
   这个语义已经不存在了。

两条合起来的效果是：**坞现在是链路里最快的源**。轮询驱动的第二源在原理上只能**慢于**真相，而判据抓住的
方向恰恰要求它**快于**坞——这个方向在现架构里不存在。

**为什么这不是「判据假」。** 同一次运行里 AC-188 的每一条实质读数都是对的：`dock.count.{desktop,mobile}=1`、
`legacy.tab=0 legacy.inline=0`、`resident.activityMarkers=[]`、`resident.panel.controls={start,close,copy,address,pid}`、
`consistency.turn` / `afterTurn` 两视口一致。**绿的读数不是问题，丢的是证伪力**——判据现在无法区分
「一个源」与「一个源 + 一个恰好不越线的慢源」。

**边界。** ⛔ `SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸门不动；AC-188 的**每一条实质读数一字不删**；
本条的产物是**判据的证伪力**，不是「用时更短」也不是「多一条测试」。假形态的定义必须**忠实**：
挂载即拉取（首帧就是真相）与只在 tick 上学习（首帧最多滞后一个节拍）是两种不同的源，**两种都要量**，
不能只挑一种然后宣布不可满足。

**非目标。** 不动 AC-188 用例体的预算字面量（`toBeLessThanOrEqual(30_000)`，属
`gap-ac188-criterion-body-budget-below-its-turn-walk-floor` 的范围，不由本条改）；不修 AC-186/AC-187 的相位判据。

## Plan

1. **先量坞的节拍与两个边沿的迁移时刻。** 在**活页面**上量 `[data-activity-dock]` 的 `data-activity-state`
   从服务端 `turn-open` 到首次读 `in-turn`、以及服务端 `turn-end` 到离开 `in-turn` 的实测间隔；
   同时记下心跳的实际节拍（`HEARTBEAT_MS` 或等价常量的字面值与其在页面上的观测间隔）。
   逐字写进 `## Evidence`——判定必须建立在这些读数上，不许拍脑袋。
2. **量轮询侧的真实滞后，两种忠实实现各一次。** (a) 挂载即拉取 + `setInterval(…, 1000)`；
   (b) 只在 tick 上学习（首帧也等一个节拍）。每次记 `probe.afterWalk` 的逐样本序列与判据 exit code。
   加一条**健康树基线对照**（无假形态）过同一个窗口，证明该窗口在健康树上稳定为绿。
3. **判定，二选一，必须以上一步的实测序列为依据。**
   - **(a) 修窗口**：给出一个能让 1 秒轮询假形态**落红**的窗口——起点（相对哪个边沿）、时长、采样对象
     （活页面还是重新导航后的页面）逐条写明；并证明该窗口在**健康树上**连续 ≥8 次绿（即它不是靠健康树
     自身的不稳定来红的）。
   - **(b) 退役**：给出「任何窗口都落不了红」的实测论证（两个边沿 × 两种实现 × 健康树基线对照），
     并按同族先例（`gap-ac172/177/178-criterion-anchor-retired-by-dock-consolidation` 均 done）记录该假形态退役。
4. **落地（按第 3 步的判定）。**
   - 走 (a)：把窗口改进 `e2e/activity-dock-truthful.spec.ts` 的 AC-188 用例，并**当场用假形态 (ii) 复现红**
     （逐字贴出红的输出）——退役与修复的分界是「有没有一条真的红」。
   - 走 (b)：在 AC6 断言处写明它保留的方向（只抓坞 outstay 回合）与它**不再覆盖**轮询驱动的第二源，
     并把该判定逐字记入 `## Evidence`；⛔ 不得删除任何实质读数。
5. **稳定性。** 改后 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` 连续 ≥3 次 pass
   （走 (a) 时另加：健康树 ≥8 次绿）。若仍见红，先判定是窗口还是别的机制，不要把红藏起来。
6. **静态闸。** 改动文件过 `npm run typecheck` 与 oxlint（`e2e/` 不在 lint 路径内时，
   单独 `npx oxlint e2e/activity-dock-truthful.spec.ts` 并说明既存错误）。
7. **落账并自检。** `task-schema-check.js` exit 0、`quay task check <id> --json` 的 `missing: []`，
   只把 Touches 里列出的文件加进提交。

## AC

- [ ] 节拍实测：活页面上量出坞在回合打开/结束两个边沿的状态迁移间隔与心跳节拍，逐字写入 `## Evidence`，并给出「坞落后服务端 ≤ X ms」的实测上界
- [ ] 轮询侧滞后实测：两种忠实实现（挂载即拉取；只在 tick 上学习）各跑一次，逐次记 `probe.afterWalk` 逐样本序列与判据 exit code；另加一次无假形态的健康树基线对照过同一窗口
- [ ] 判定：以上述实测序列为依据，二选一写出结论——(a) 修窗口（起点/时长/采样对象逐条写明）或 (b) 退役（「任何窗口都落不了红」的实测论证），二者必居其一
- [ ] 落地：走 (a) 时改后的窗口能让 1 秒轮询假形态落红并逐字贴出红的输出；走 (b) 时 AC6 断言处写明其保留方向与不再覆盖的范围，退判决逐字入 `## Evidence`；两条路都⛔不得删除任何实质读数，`SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸门不动
- [ ] 稳定性：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` 改后连续 ≥3 次 pass；走 (a) 时另加健康树窗口连续 ≥8 次绿
- [ ] 静态闸：改动文件过 `npm run typecheck` 与 oxlint（或本仓对该 spec 的等价静态检查），exit 0
- [ ] 任务自身 `tasks/gap-ac188-criterion-agreement-loses-poll-source-falsifiability.md` 已落账（自触）

## DoD

这是一次**判据证伪力**的落地，不是「多一条测试」也不是「文档已写」：

- 交付物是**被真实操作过的** `e2e/activity-dock-truthful.spec.ts`（真实浏览器、真实 webServer + Vite 客户端 +
  调试 agent 时钟），不是一份设计说明。走 (a) 时它必须**当场**被假形态 (ii) 打红过一次；走 (b) 时它必须
  带着写明的退役理由仍是绿的，且判定所依据的实测序列逐字在 `## Evidence` 里。
- 判定所依据的两组读数（坞的边沿迁移间隔、轮询侧两种实现的逐样本滞后）与一次健康树基线对照，
  在 `## Evidence` 里逐字留档——**没有这两组读数就不算落地**，无论选了哪条路。
- AC-188 的每一条实质读数一条未删、`SINGLE_SPEC_CEILING_MS = 55_000` 与 60s 闸门未动。

## Evidence

本条的立案读数来自姊妹任务 `gap-ac188-criterion-body-budget-below-its-turn-walk-floor` 的 `## Evidence` §4
（该任务的 Plan step 4 要求重跑这两个假形态，其中 (ii) 被证不可满足后按人工裁决移出到本条）。
留档日志（立案时仍在盘上）：

- `/tmp/ac188-falsify-ii.log` —— 历史 store-read 实现，`1 passed`
- `/tmp/ac188-literalpoll2.log` —— 字面 1 秒轮询，`1 passed`，含 `probe.afterWalk` 逐样本序列
- `/tmp/ac188-baseline-afterwalk.log` —— 无假形态的健康树基线对照：活页面在 `walk-done` 之后以 100ms 间隔
  连采 25 次，`{dock,sidebar,send}` = `in-turn,false,send` ×3 → `absent,false,send` ×22，**25/25 一致**
- `/tmp/ac188-falsification/fake-ii.diff`、`fake-ii-literal-poll.RunningView.tsx` —— 假形态源码存档

⚠️ 本条**不重新认定**该任务的结论，只承接它：第 1 步要量的是它没有量的那一半——**坞自己落后服务端多少**。
它当年只量了轮询侧（≤150ms），没量坞侧，所以「即便把活页面窗口搬回来也无从稳定落红」这句话目前只有一半证据。

## Touches

- `e2e/activity-dock-truthful.spec.ts`（AC-188 用例的一致性窗口与/或其注释）
- `tasks/gap-ac188-criterion-agreement-loses-poll-source-falsifiability.md`（自触）
