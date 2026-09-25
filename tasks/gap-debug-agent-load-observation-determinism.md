---
id: gap-debug-agent-load-observation-determinism
title: AC-125 的装载观测由推断改为读数：观察者自身的就绪证据 + 确定性伪证臂（判据从偶发红转可靠绿）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-125
---
## Proposal

**交付物：`goals/AC-125` 的判据从「偶发红」变成「可靠绿」——把装载事件的观测（load step）从推断改成读数。**

判据逐字为 `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts`。

**现场读数（本仓，2026-09-25）。**

- 驱动自己的 gate 记录（`.quay/gate-events.jsonl`）里 AC-125 共 116 条 `goal` 事件、45 条 FAIL；其中 43 条是 2026-09-22 的**红先行**期（测试文件尚不存在，红因逐字是 `Could not find 'server/modules/debug-agent/tests/debug-agent-external-write.test.ts'`）。**文件落盘之后（2026-09-22T16:08 之后）72 次运行里红 2 次**，都在今天：`2026-09-25T08:29:34Z`、`2026-09-25T09:07:27Z`。
- 同一时刻驱动的 frozen recheck 把 AC-125 记为 `verdict=pass / outcome=cleared / cause=now-true`，连过 7 轮（round 96–102，各约 23.1s）。⇒ gate ledger 说 violated、recheck 说 cleared，两读并存——这正是偶发判据的指纹。
- 在 author 检出上直接跑同一命令 4 次：**红 1 次、绿 3 次**。

**红在哪里（本条任务的全部要点）。** 两次记录在案的失败与这次复现形状一致，且都**没有走到送达断言**：

- 父进程在 `requireReading`（`server/modules/debug-agent/tests/debug-agent-external-write.test.ts:688`，调用点 `:809`）抛 `external-write: the probe child printed no reading`；
- 子进程真正的红在 `armObservedFixture`（`:433`）：`the observer never logged an add for 3 armed fixture(s), so there is no load event to drain`，三次 attempt 全 `addObserved:false`（`LOAD_ATTEMPT_MS = POLL_INTERVAL_MS + 2000 = 8000`、`MAX_LOAD_ATTEMPTS = 3`，见 `:117-118`）。

也就是说判据的 (i) 排空、(ii) 新的 upsert、(iii) 正面控制、(iv) REST 重取**一条都没被评估**——红的是**装载事件本身没被观测到**。这与「外部写入没送达」是两件事：今天的红**不能**读成产品链路坏了，但**能**读成这条 AC 的 ledger tail 不可信。

**为什么早先的修复没有站住。** 认领本 AC 的 `tasks/gap-debug-agent-external-write-path.md`（`done`）与随后两笔只动同一文件的性能提交——`bd756211`「收掉最重文件的死等」、`a78b6db9`「短窗口试次并入臂内终态等待，收掉最重文件的叠死等」——改的都是这个文件的**时长**，不是它 load step 的**确定性**：

- 装载就绪靠 `waitForObserverWalk()`（`:360-378`）：它**另起一个探针 watcher**，把**探针的 `ready`** 当成「观察者的首次遍历已完成」的证据，理由只是一条排序论证（探针建得更晚、要走更多树，所以不可能先 ready）。产品侧没有可等的就绪信号，所以这是**推断**而不是读数。
- 就绪之后 `armObservedFixture` 的补试上限是 3 × 8s；文件自己的注释写明补试「stays the bound it is documented to be rather than the normal path」，即补试**不该是承重路径**。一旦探针的 `ready` 与观察者自己的遍历不一致（或轮询周期在负载下超过 8s），三次全 miss，判据在评估任何断言之前就红。
- 那两笔提交在 `waitForObserverWalk` / `armObservedFixture` 里一个字符都没改。⇒ **红一直在**，只是两次都盯着别的读数。

**诊断口径（实施者必须自己定，不要照抄本条）。** 本任务只证明「红在装载观测」，**根因归属未证**。要么是 harness 的就绪推断（探针 `ready` ≠ 观察者遍历完成；8s 窗口没绑在观察者自己的证据上），要么是产品侧（watcher 构造时根不存在 / 遍历窗口内落下的文件被 `ignoreInitial` 吞掉）。实施者必须用读数把这两条分开（例如打印：装载时 fixture 根是否已存在、观察者是否对**任何**文件报过事件、`ensureProviderWatchRoots()` 是否建了根），再决定改哪一侧。

**三条硬边界。**

1. **不许削弱判据**：(i) 排空静默 > 一个轮询周期、(ii) 写入后一条**新的** upsert、(iii) 观察者自己的 `change event for provider` 行、(iv) REST 重取含追加内容——四条与抗假 bypass 臂（它必须让 (ii)+(iii) 红、盲判据仍绿）**等强保留**。把「必须观测到 add」改成「等一会儿就算」是禁止的。
2. **不许拿 sleep 换确定性**：加固定 sleep 或单纯抬高窗口，只是把偶发红换成更长的偶发红。`bd756211` / `a78b6db9` 正是为**收掉**这个文件的死等而做的（见 `tasks/gap-cold-baseline-path-exceeds-gate-cap.md`、`tasks/gap-suite-criterion-wallclock-budget.md`），本任务不得把时长加回去。
3. **Touches 只许这两个文件**：`server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 与本任务文件。若诊断落到**产品侧**，不要擅自扩围——先在任务体里登记读数并退回，由下一轮另立。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务。`tasks/gap-debug-agent-external-write-path.md` 认领本 AC 但状态是 **`done`**——按 `standing-violated` 的规则它是「早先修复没站住」的证据，不是重复。相邻而机制不同的是 `tasks/gap-session-watcher-native-or-adaptive-poll.md`（`needs-human`）：它改的是 watcher 的**机制选择与轮询退避**，并声明会同步本文件的轮询臂；本条改的是**装载观测的确定性**，两者不重复。它与本条只是 Touches 重叠，实施者按当前 `develop` 形状落改动并把改动限制在 load step 内即可减小后续合并冲突。

## Plan

1. **先把判定性测出来**：安静与受载两种条件下各跑判据若干次，逐次记录 `[load]` 行（`attempt` 与每条 `addObserved`）、装载时 fixture 根是否存在、观察者是否报过任何事件。把「红的条件」写成可复现读数，而不是「偶发」。
2. **把就绪从推断改成读数**：让 load step 等到**观察者自己的**证据（产品侧已暴露就绪就等它；否则用观察者对该根下某个文件的**自己的日志行**作证据），并把装载尝试的窗口绑在**超过一个轮询周期**的观察者证据上，而不是一个 8s 的猜测。
3. **加一条确定性伪证臂**：把今天红的那个条件显式构造出来（就绪证据不成立时装载，或遍历完成前装载），让判据在**未修**的形态下必红、修后必绿，并把两读打印出来。
4. **复核等强与时长**：逐条核对 (i)–(iv) 与 bypass 臂；并对比本任务前后的 `duration_ms`。

## AC

- [ ] AC1 判据本身绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 退出码 0、输出含 `fail 0`，且打印的 `[load]` 行给出**逐次 attempt 的 addObserved**。失败时把 `[load]`、`[criterion]`、`[control (iii)]` 三行原样打印。
- [ ] AC2 就绪是读数不是推断：同一次运行的输出里存在以 `[readiness]` 开头的一行，说明就绪证据来自**观察者自身**（不是第二个 watcher 的 `ready`）并给出该证据的实测值；该行数 ≥ 1。失败时打印实际存在的全部 `[` 前缀行。
- [ ] AC3 确定性伪证臂真跑并留两读：把今天红的条件显式构造出来时判据必须红、且红因逐字是「装载事件未被观测到」（never logged an add）而**不是**送达断言；还原后 AC1 绿。两段输出都贴进 Evidence，`git status` 干净。
- [ ] AC4 等强未削弱：AC1 命令的输出里四项读数齐备且都成立——(i) 排空静默 > 6000ms。(ii) 写入后新 upsert 数 ≥ 1。(iii) 该文件的 change 行数在写入后 > 0。(iv) REST 重取含追加内容。同一次运行里抗假 bypass 臂仍绿（它自己 (ii)+(iii) 红）。缺项时逐条打印实际值。读数为 `[drain (i)]`、`[delivery (ii)]`、`[control (iii)]`、`[history (iv)]` 四行。
- [ ] AC5 时长不增：AC1 命令的 duration_ms 不高于基线（现场单跑 ~25.6s、驱动 gate ~23.1s）；把前后两读并列打印。若确有增加，必须说明为何必要，且不得使该文件逼近 60s（goal 判据闸是 60s 硬超时，不可抬）。
- [ ] AC6 未触及 Touches 之外的文件：`git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都能对应到 Touches 里的一条；命中之外时逐行打印并以非 0 退出。
- [ ] AC7 `npm run typecheck` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：**这条 AC 的 ledger tail 从「说 violated」变成「稳定说 pass」**，而不是「这一次碰巧绿」。承重性由三件事正面证明：

(a) **就绪有读数**（AC2）——就绪证据来自观察者自身，能指着它说「观察者已完成首次遍历」，而不是指着第二个 watcher 的 ready 推断；
(b) **确定性伪证臂真跑过**（AC3）——把今天红的条件显式构造出来时必红，证明修的是一个**可达的**原因，而不是把偶发当运气；
(c) **等强与时长都被核对**（AC4/AC5）——没有把断言削成「等一会儿就算」，也没有把死等加回来。

另需如实登记：**连续跑若干次（建议 ≥5 次）的 `[load]` 逐次读数**（AC1 命令，安静条件），证明补试路径不承重；以及**受载条件下**的读数（本条 AC 的现场红正是在 load1 ≈ 18 时复现的）。

L_D 该轴仍暗，理由：本任务交付的是调试/测试机制里「装载观测」这一环的确定性，不改变产品领域能力，没有可读出的产品领域读数；判定面由 AC1 的 `[load]`/`[readiness]` 读数与 AC3 的两读承担。
L_G 本目标的判据是 `goals/AC-125`（外部写入经真实文件观察者送达客户端，判据自带排空与正面控制），本任务的 AC1/AC4 即该判据的命令与它的四项读数；AC3 是它的抗假与确定性对照。

## Touches

- server/modules/debug-agent/tests/debug-agent-external-write.test.ts
- tasks/gap-debug-agent-load-observation-determinism.md
