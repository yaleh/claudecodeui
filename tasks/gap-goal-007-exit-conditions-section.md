---
id: gap-goal-007-exit-conditions-section
title: GOAL-007 缺 `## 退出条件` 小节：提议补上独立小节以解除机械短路，并把两处无在域 AC 覆盖的范围项交人裁定
status: needs-human
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: 跟进提案：GOAL-007 缺 `## 退出条件` 小节（机械层 goal-driver.ts:866 在任何在域 AC
    被考虑之前短路 ⇒ verdict 恒为 insufficient，语义 judge
    从未被咨询）。本任务只提议文本修订，须人裁定是否采纳，以及两处无在域 AC 覆盖的范围项（「不跑真 CLI」否命题、裁决 A 的 UI
    显示身份）是明示不作退出条件还是另立 AC。
---
## Proposal

选型 **(b)：修订 GOAL-007 的退出条件文本**——不新增 AC，不改任何 GOAL/AC 状态。

### 未被覆盖的部分（逐字引用）

GOAL-007 的正文**没有 `## 退出条件` 小节**，退出条件从未写下。被漏掉的正是目标标题本身给出的两个半句：

> 调试 Agent：不跑真 CLI 也能产出与历史一致的输出，且关闭态结构性不存在

### 为何现有 AC 集被判 insufficient（机械层的成因，逐行）

`plugin/scripts/goal-driver.ts`：

- `:834` 的 `exitConditionsText()` 经同文件 `:818` 的 `extractSections()` 以正则 `##[ \t]+(退出条件[ \t]*)\r?\n([\s\S]*?)(?=\r?\n##[ \t]|$)` 取节；标题**逐字匹配**，`allowHeadingSuffix` 对退出条件**刻意不开**（`:814` 注释：「退出条件**不开**该项：`hasExitConditions` 是机械可证层，其语义不得因本次改动而变」）。
- `:840` 的 `hasExitConditions()` = `exitConditionsText(body).length > 0`。
- `:866` 的 `goalSufficiencyVerdict()` 第一条就是 `if (!hasExitConditions(String(goal.body ?? ""))) return "insufficient";`——在语义判定入口（`:868` 的 `not-evaluated`）**之前**短路返回。
- `:858` 的函数注释**逐字点名本目标**：「insufficient 结构上可证覆盖不成立：GOAL body 无【非空】`## 退出条件` 文本（退出条件从未写下，覆盖无从谈起——**GOAL-005/007/008 空 body 形态**），或零在域 AC（空集合无法覆盖）。」

所以 verdict 恒为 `insufficient`，**语义 judge 从未被咨询**。轮日志逐字为证：`.quay/goal-round.jsonl` round 3395 的 `goal-sufficiency` 事实是 `{"sufficiency":{"goal":"GOAL-007","verdict":"insufficient"}}`，reason `sufficiency=insufficient（在域 AC 6 条）`——reason 里**没有任何语义 judge 的产物**。`.quay/goal-sufficiency-followup.json` 记 `GOAL-007.since=2026-09-22T15:00:02.127Z`、`filedAt=null`（即本任务为首次跟进立案）。

### 为什么本目标只能选 (b)：(a) 解不开这个死锁

短路在 `:866` 发生在**任何**在域 AC 集合被考虑之前——`:867` 那条「零在域 AC ⇒ insufficient」都还没轮到。故**新增一条 AC 不会改变 `hasExitConditions` 的取值**，verdict 仍是机械 insufficient，goal 仍卡在 `active`。要解除死锁，改的必须是**退出条件文本**。这与 `:213-219` 的注释一致：充分性裁决是确定性的，输入变化只可能来自「（a）人改 GOAL 标题/退出条件/范围节，或（b）在域 AC 集合增删改」，而「一个已超过该周期仍未变的 insufficient，**不再有任何机制会自己去改它**；唯一剩下的改变途径正是本条信号要请人做的那件事（改退出条件，或改 AC 集合）」。本目标属 (a) 那一类。

### 同族对照：本形态只剩本目标一条

`grep -c '^## 退出条件' goals/GOAL-*.md` 在 GOAL-001 / 002 / 003 / 004 / 005 / 006 / 008 上均为 **1**，**只有 GOAL-007 为 0**。而 `:858` 点名的三兄弟里，GOAL-005 与 GOAL-008 都已有该小节——GOAL-007 是这个形态的最后一条。

### 同一配方的第三次应用（前两次均已 done）

- `gap-goal-001-exit-conditions-section`（done）：行内退出条件 → 独立小节；其 Evidence 记着修订后 round log 中 GOAL-001 的 verdict 由机械 insufficient 变为语义 judge 给出的 `covered`。
- `gap-goal-003-exit-conditions-section`（done）：同一形态。其 Resolution 记下的根因值得引用——初稿**过度回避任何小节写法**造成的是**死锁**（verdict 恒为机械 insufficient ⇒ goal 永远卡在 active），不只是格式瑕疵；落地的退出条件小节逐条列 AC-103 / AC-104 / AC-105。

### 内容上是否有缺口：两半之一齐，另有两处欠账（如实登记，供人裁定）

- **「关闭态结构性不存在」：齐。** AC-123 的三面（registry 无键 / watcher 无根 / 路由未挂载）逐条覆盖，AC-128 补上「门控关闭时同一路径不以控制面的应答作答」与「门控而非鉴权才是安全边界」。
- **「产出与历史一致」：齐。** AC-124（transcript 真实落盘 + `grow` 同 id 内容变化 + socket 帧 id 集与 REST 重取 id 集之交集覆盖本次产出的每一条 + `seq` 严格递增），AC-125（外部写入经真实观察者送达且 REST 含该内容），AC-126（禁止第二套词表的可判真伪守卫），AC-127（fixture 根来自门控变量）。
- ⚠️ **「不跑真 CLI」这个否命题没有一条直接断言。** AC-124 通过「场景指定的确定性内容必须逐条落盘」与「帧的 `seq` 由 run registry 分配」**间接**排除真 CLI（真 CLI 产不出场景指定的确定性内容），AC-126 只断言调试模块不持有帧词表——这是**蕴含**，不是正面读数。今天没有任何 AC 直接读「本次运行没有拉起任何 CLI 子进程」。
- ⚠️ **范围段第 2 条按裁决 A 的 UI 项未被任何在域 AC 覆盖。** 范围写着「UI 上必须给它**明确的显示身份**，不接受被落穿显示为 Claude」。AC-123..128 中**无一条**覆盖它；它在任务 `gap-debug-agent-engine-and-scenario-ops` 的 AC4 里是**任务级**判据，不是目标级判据。

**这两处欠账不在本任务范围**（本任务只做退出条件文本的结构修订）。它们供人裁定：明示「由 AC-124 / AC-126 的耦合间接保证，不单列退出条件」，或另立 AC。**但它们必须写进退出条件小节并标注覆盖状态**——否则语义 judge 拿到的输入是一份「退出条件 = 六条 AC 全列」的文本，它只会给出 covered，把这两处欠账重新藏回去。

### 建议的修订文本

（与 GOAL-001 / GOAL-003 同一房屋风格：小节标题 + 逐条 AC 编号 + 该条的实质判据。）在 `goals/GOAL-007-调试-agent-不跑真-cli-也能产出与历史一致的输出-且关闭态结构性不存在.md` 正文末尾新增下列小节：

> ## 退出条件
>
> 标题的两个半句各自落到实处才算达成：
>
> - **AC-123 关闭态结构性不存在（三面）**：门控在**进程启动时**求值，故判据在两个独立子进程里各取一次读数。关闭态逐一断言 registry 无键（按 id 解析失败**与拼错一个 id 逐字相同**）、watcher 无根（fixture 根不在观察路径集合里且该目录不被创建）、路由未挂载（控制面路径**不以控制面的应答作答**——**不得写成状态码 404**，本仓库 SPA catch-all 对无扩展名路径返回 `200 text/html`）；开启态三面对照存在；取值不认识、或开了但 fixture 根为空，一律按关闭处理并打印判定原因。
> - **AC-124 不跑真 CLI 也能产出与历史一致的输出（产出侧）**：装载含 `row` 与 `grow` 两种 op 的场景后**走真实 runtime 产出帧**——transcript 真实落盘、行数与 `expect.rows.delta` 相符、文件含 `expect.content.mustContain` 每一条；`grow` 使行数不变、末行字节数增加、且归一化为**同一条**消息 id 的内容变化；socket 收到的帧 id 集与 REST 重取（`/api/providers/sessions/:id/messages`）历史的 id 集之交集**覆盖本次产出的每一条**；帧上的 `seq` 由 run registry 分配且严格递增。
> - **AC-125 外部写入经真实文件观察者送达**：判据自带排空（先排掉装载那一次 `session_upserted`）、随后要求一条**新的** upsert、并以观察者自己的 `change event for provider "…"` 日志行作**正面控制**；外部追加的内容出现在 REST 重取结果里。
> - **AC-126 禁止第二套词表**：调试模块源码范围内不出现任何帧字段名或事件名字面量，且该模块存在指向归一化入口（`normalizeMessage` / `createNormalizedMessage`）的**真实 import 语句**；守卫**可判真伪**——在调试模块里手写一个帧字面量必须让它红。
> - **AC-127 fixture 根来自门控变量而非 `os.homedir()`**：产物只出现在门控根下、**不在** decoy HOME 下；**正面断言**真实 home 本次运行没有新增（修改时间 + 条目数双读数）；teardown 后整目录删除；清理顺序是**先让索引收敛、再删根**。
> - **AC-128 控制面在门控开启时可用、缺凭据 401，且门控而非鉴权才是安全边界**：装载场景 / 推进时钟 / 读自检结果三个动作各自可达，「读自检结果」在无记录时给出**可辨的 404 而非空 200**；缺凭据 401、凭据有效但无权限 403，两者不混用；门控关闭时同一路径**不以控制面的应答作答**。
> - **AC-123 至 AC-128 六条全部 achieved**；或由人裁定放宽 / 取消其中任一条。
>
> **覆盖状态如实登记（供人裁定）**：标题两半中「关闭态结构性不存在」与「产出与历史一致」已由上列六条逐条承载，内容无缺口，缺的只是结构。以下两处**没有**在域 AC 直接覆盖，需人裁定是「明示不作退出条件」还是「另立 AC」：
> - 标题里的「**不跑真 CLI**」这一**否命题**：AC-124 / AC-126 只**蕴含**它（真 CLI 产不出场景指定的确定性内容，且帧只能来自真实归一化），没有任何 AC 直接读「本次运行没有拉起任何 CLI 子进程」。
> - 范围段第 2 条按**裁决 A** 的「UI 显示身份不得落穿为 Claude」：AC-123..128 无一条覆盖；它今天只是任务级判据。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务——按「goals/GOAL-007 的退出条件小节 / 充分性文本修订」检索零命中。相邻但机制不同的是 GOAL-007 下的六条派工任务（`gap-debug-agent-gate-structural-off` = AC-123、`gap-debug-agent-engine-and-scenario-ops` = AC-124、`gap-debug-agent-external-write-path` = AC-125、`gap-debug-agent-no-second-vocabulary-guard` = AC-126、`gap-debug-agent-fixture-home-isolation` = AC-127、`gap-debug-agent-control-plane-http-auth` = AC-128）：它们各自实现**判据所测的机制**，本任务只修订**退出条件文本**，不写代码、不改那六条 AC 的 criterion，也不是它们的先行条件（本任务不解除任何 AC 的红）。

## AC

- [ ] **AC1 退出条件小节落地**：`grep -c '^## 退出条件' goals/GOAL-007-调试-agent-不跑真-cli-也能产出与历史一致的输出-且关闭态结构性不存在.md` 输出 **1**，且按 `goal-driver.ts` 的**同一条正则** `##[ \t]+(退出条件[ \t]*)\r?\n([\s\S]*?)(?=\r?\n##[ \t]|$)` 取出节体、去空白后字符数 **≥ 40**。命令逐行打印实际计数与字符数；不足时打印实际取到的节体，并以非 0 退出。
- [ ] **AC2 人（yale）已裁定并被记录**：本任务的 `## Resolution` 小节写明 (i) 是否采纳本修订（采纳 / 改措辞 / 不采纳并另立 AC），以及 (ii) 两处无在域 AC 覆盖的范围项（「不跑真 CLI」否命题、裁决 A 的 UI 显示身份）各自的处理方式——**明示不作退出条件**，或**另立 AC 并给出任务 id**。二者缺一即本 AC 不满足。
- [ ] **AC3 机械短路不再触发**：修订后下一轮 `.quay/goal-round.jsonl` 中 GOAL-007 最新 `goal-sufficiency` verdict 的 reason **不再是纯机械短路形态**（即不再是 `sufficiency=insufficient（在域 AC 6 条）` 这一类、reason 里没有任何语义 judge 产物的读数），而是语义 judge 给出的 `covered` / `insufficient` 结论。命令打印该 goal 的 `goal-sufficiency` 序列**最后两条**。
- [ ] **AC4 本任务未触及 Touches 之外的文件**：命令 `git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都必须能对应到 Touches 内的一条；命中 Touches 之外时逐行打印并以非 0 退出。用 merge-base 而非裸 develop——develop 会随他人 fan-in 前进。

## DoD

人工授权后，由**被授权的 goal 写入路径**（而非本 agent）真实修改 `goals/GOAL-007-调试-agent-不跑真-cli-也能产出与历史一致的输出-且关闭态结构性不存在.md`：新增上面那节退出条件文本；并在其后的**真实 round log** 中观察到 GOAL-007 的 sufficiency verdict 不再恒为机械 insufficient（语义 judge 被实际咨询并给出结论）。**仅有文本改动而无后续 verdict 观察不算完成。**

承重性由三件事正面证明：

(a) **死锁的成因被指名，不是猜的**——`goal-driver.ts:866` 的短路在语义判定入口之前，且 `:858` 的注释逐字点名 GOAL-007；本提案据此说明为何 (a) 新增 AC 解不开、必须是 (b) 改文本（否则这份提案只是「照抄 GOAL-003」而说不出为什么）；
(b) **落地后 `hasExitConditions` 由 false 变 true**，verdict 越过短路落到 `not-evaluated` / 语义判定——AC3 要求在**真实轮日志**上读到这一变化，而不是在提交信息里声称；
(c) **两处欠账被写进小节并在人面前显式登记**（AC2），不被一份「退出条件 = 六条 AC 全列」的文本藏回去——否则语义 judge 只会给 covered，而欠账仍在。

另需如实登记：本任务**不**让 AC-123..128 中任何一条转绿（它们的 checker 与模块由那六条派工任务承担——`gap-debug-agent-gate-structural-off` 的验证记录显示其 checker 已存在并在 worktree 上跑过，但 AC-123 在 round 3395 的轮日志上仍为 `fail`）；本任务也不裁决两处欠账该不该另立 AC——**只要求裁定被写下**。

本任务由跟进 agent 只提议：不改 `goals/*.md`，不改任何 GOAL/AC 状态，不把任何 AC 标 achieved / active / draft / retired。

## Touches

- goals/GOAL-007-调试-agent-不跑真-cli-也能产出与历史一致的输出-且关闭态结构性不存在.md
- tasks/gap-goal-007-exit-conditions-section.md
