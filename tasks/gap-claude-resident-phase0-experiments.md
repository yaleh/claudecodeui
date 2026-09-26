---
id: gap-claude-resident-phase0-experiments
title: Claude 常驻会话阶段 0 实验 E1–E9：用真实 claude 二进制取得读数，定下忙时输入基准、控制协议用法与内存上限，结论写回 proposal
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

来源：`docs/proposals/claude-resident-sessions.md`（提交 e88175cf）。人 yale 2026-09-25 裁定：拆成两个 goal，GOAL-A「统一宿主层」现在激活，GOAL-B「Claude 常驻」暂不激活，**等本任务把 E1–E8 的结论写回 proposal 之后再定 AC 并激活**；验证只靠 HTTP/WS 加脚本，不加 `cloudcli` 子命令。

本任务只取读数、不写产品代码。它回答 proposal「验证方法 / 阶段 0」表里的八个问题，其中两个结论会直接成为 GOAL-B 的判据基准：

- **E2/E3（忙时输入）**：原则 6 规定常驻会话忙时收到用户消息，行为与 Claude Code CLI 一致——服务端不排队、不拒绝，立即写入进程，由 CLI 决定消息落在哪一轮。基准必须由实测给出：同一情形（进程正在一轮中，再推入一条用户消息；以及无人轮进行中推入）在 **SDK stream-json 输入** 与 **交互式 CLI** 两种形态下各测一次，记录消息被并入当前轮还是另起一轮、是否丢失。两者不一致时由人裁定采用哪一种（见 AC 的人工关卡）。
- **E7（内存）**：proposal §11 的单进程上限与 slice 总上限不给拍脑袋的数，由至少 24 小时浸泡的 RSS 曲线给出。

取读数的办法（尽量不花钱、可重复）：

- 除 E7 和 E2 的交互式那一半外，一律用**真实 `claude` 二进制 + mock Anthropic 兼容端点**，做法照 `server/modules/providers/tests/model-gateway-end-to-end.test.ts`（AC-025）：mock 端点按脚本返回 `tool_use`（CronCreate、ScheduleWakeup、Monitor、AskUserQuestion、SendMessage），工具在本地 CLI 里真实执行。mock 端点会额外收到 SDK 的标题请求，按请求体识别，不按 token。
- E2 的交互式那一半：在 tmux 里跑交互式 `claude`，指向同一个 mock 端点，用 `tmux send-keys` 在一轮进行中输入第二条消息。
- E7 用真实模型，按常驻的实际用法跑（多轮 + 一个周期 cron + 一个 Monitor），每 5 分钟采一次 RSS（主进程与整棵子树分开记）。费用写进记录。
- 所有实验用一次性临时实例：**显式设置临时 `DATABASE_PATH`** 并读 `/proc/<pid>/environ` 核对（本机 shell 已导出 `DATABASE_PATH` 指向真实库）；**不重启 :3001**；端口避开 3001；实验结束后 `systemctl --user list-units` 与进程表里没有本实验的残留。

**人 yale 2026-09-25 追加 E9（控制协议清单）。** 对 `claude` 2.1.282 二进制的静态分析与对 `sdk.d.ts`（0.3.165）的核对表明，常驻 driver 可以直接用 CLI 的控制协议事件，而不必推测：`session_state_changed`（轮次边界）、`task_started` / `task_notification`（后台任务保活理由）、Stop hook 输入的 `session_crons` / `background_tasks`（cron 与后台任务的权威清单）、用户消息的 `origin`（无人轮触发类型与跨会话发送方）、`priority` 三档与 `cancel_async_message`（CLI 自己的输入队列与撤回）、`onElicitation` 与 `request_user_dialog`（除 `canUseTool` 外另两个需要人回应的入口），以及 flag settings 里的 `remoteControlAtStartup` / `isolatePeerMachines`（常驻 + bypass 进程若被 Remote Control 桥接出去，信任边界会超出同一 Unix 用户）。proposal 已据此修订（任务分支提交 `41bd6abf`），其中写着「由 E9 确认」的地方都等本任务的读数定稿。E9 的问题清单见 proposal「阶段 0：实验」表的 E9 行。取读数的办法同上：真实 `claude` 二进制 + mock 端点；「交互式 CLI 用哪一档 `priority`」一项在 tmux 里跑交互式 `claude` 取数。SDK 类型里没有的 subtype（`scheduled_task_fire`、`side_question`、`peer_message_hold`、`claim_session`）如果出现，记录原始 JSON。

<!-- dedup-ref -->
相关任务 `gap-claude-session-cgroup-scope`（needs-human，未合入 develop）已实现「每个 Claude 会话进自己的 systemd scope + 内存上限 + 启动清扫」，并测得真实会话子树约 390–470MB。E5 与 E7 若在该服务可用时进行，记录注明读数是在 scope 内还是 scope 外取得的；proposal §11 的 L3 以后应复用该服务而不是另起一套，本任务只在结论里指出，不改代码。

## Plan

1. 写实验脚本 `scripts/resident-experiment.mjs`：子命令 `e1`…`e8` 各跑一个实验并把原始读数追加到记录文件；公共部分是「起 mock 端点」「起临时实例并核对 DATABASE_PATH」「用 SDK 的 `query()` 以不结束的 AsyncIterable 作 prompt 驱动常驻进程」。`--check-record` 检查记录文件是否八节齐全、每节都有 `读数：` 与 `结论：` 行，缺哪节就打印哪节并 exit 1。
2. 给脚本的安全护栏写测试 `scripts/resident-experiment.test.mjs`：未显式给出临时 `DATABASE_PATH`（或它等于 shell 导出的值）时拒绝运行；`--check-record` 对缺节、缺 `结论：` 的记录 exit 1 并点名。
3. 依次跑 E1、E3、E4、E5、E6、E8（mock 端点），E2 两种形态，E7 浸泡。每个实验的原始读数（pid、时间戳、流中出现的消息类型序列、RSS 样本）原样写进 `docs/proposals/claude-resident-sessions-experiments.md` 对应小节，结论单独一行。
4. 把结论写回 `docs/proposals/claude-resident-sessions.md`：新增「阶段 0 结论」小节；按结论修订 §5 `residentFeatures` 各项取值、§8 忙时输入基准、§11 两个上限的数值、§12 peer 名格式；E5 结论决定清扫是否必需。
5. 请人 yale 确认 E2/E3 基准（一致时确认沿用，不一致时裁定），由人在记录文件里写下确认行。
6. （2026-09-25 追加）给实验脚本加子命令 `e9` 并让 `--check-record` 要求 E9 节；按 proposal 的 E9 行逐项取读数写进记录文件的 E9 节；再把 proposal 里每一处「由 E9 确认」按读数改成定稿文字（读数否定了方案的，改方案并写明依据），并在「阶段 0 结论」表里补 E9 行。

## AC

- [x] 实验脚本的护栏测试通过：`node --test scripts/resident-experiment.test.mjs` exit 0（覆盖：未显式给临时 DATABASE_PATH 时拒绝运行；`--check-record` 对缺节记录 exit 1 并点名缺的小节）
- [x] 记录文件八节齐全：`node scripts/resident-experiment.mjs --check-record docs/proposals/claude-resident-sessions-experiments.md` exit 0（E1–E8 每节都有 `读数：` 与 `结论：` 行；缺任何一节即打印节名并 exit 1）
- [x] proposal 已写回结论：`grep -n '阶段 0 结论' docs/proposals/claude-resident-sessions.md` 有输出且 exit 0
- [x] 人工关卡——忙时输入基准已由人确认：`grep -n '^E2/E3 基准确认：' docs/proposals/claude-resident-sessions-experiments.md` 有输出且 exit 0（该行只能由人 yale 写入，内容为「沿用 CLI 行为」或裁定采用的形态；执行者不得代写）
- [x] `npm run lint` exit 0
- [x] E9 节齐全：`node scripts/resident-experiment.mjs --check-record docs/proposals/claude-resident-sessions-experiments.md` exit 0，且该命令要求 E1–E9 九节（护栏测试 `node --test scripts/resident-experiment.test.mjs` 含「缺 E9 节时 exit 1 并点名 E9」的用例，exit 0）
- [x] proposal 中不再有待 E9 定稿的文字：`! grep -n '由 E9 确认' docs/proposals/claude-resident-sessions.md` exit 0

## DoD

- 八个实验都**真实跑过**：真实 `claude` 二进制（E7 为真实模型），记录里的读数是原始输出（pid、时间戳、消息类型序列、RSS 样本），不是转述；每节写明取数时间、`claude --version`、是否在 systemd scope 内。
- E1 的周期 cron 连续触发 ≥3 次的时间戳写在记录里；E4 读到 `interrupt()` 之后同一 pid 仍在、cron 仍触发；E5 给出服务进程被 kill 后常驻进程退出所用的秒数（或「不退出」）；E7 覆盖 ≥24 小时，给出曲线的起点、峰值、终点，以及据此建议的两个上限。
- E2 的交互式形态与 stream-json 形态各有一份读数，结论写明两者是否一致。
- 临时实例的 `DATABASE_PATH` 经 `/proc/<pid>/environ` 核对并写进记录；实验期间 :3001 未重启；结束后无残留进程与 scope（附 `systemctl --user list-units` 与 `pgrep` 的读数）。
- 真实模型费用写进记录。
- E9 每一项都有原始读数（事件 JSON 原文或其逐字摘录、时间戳、`claude --version` 与 SDK 版本）；「flag settings 能否压过用户 settings 关掉 Remote Control」一项必须在一个 settings 里开着 `remoteControlAtStartup` 的临时配置目录下取数，不得改动真实的 `~/.claude/settings.json`。
- **前四条 AC 通过而人工关卡那条未勾时，本任务的正确终态是 needs-human，不是 done。**

## Touches

- scripts/resident-experiment.mjs (new)
- scripts/resident-experiment.test.mjs (new)
- docs/proposals/claude-resident-sessions-experiments.md (new)
- docs/proposals/claude-resident-sessions.md
- tasks/gap-claude-resident-phase0-experiments.md

## 完成记录

执行者：quay worker（分支 `task/gap-claude-resident-phase0-experiments`，实现提交 `f6cc58dd`，scoped 门 `--allow-thin` exit 0，
`tsc -p scripts/tsconfig.json` exit 0）。四条机器可验的 AC 已全绿；**AC4 人工关卡未勾**，因此按 DoD，本任务的正确终态是
`needs-human`，不是 `done`。

**交付物**

- `scripts/resident-experiment.mjs`：E1–E8 实验台。公共部分＝起 mock Anthropic 端点（按**请求体**识别 SDK 的标题请求，不按 token）、
  起一次性临时实例并核对 `DATABASE_PATH`、用 SDK `query()` 以不结束的 `AsyncIterable` 驱动常驻进程；每个子命令把**原始**读数
  （pid、时间戳、消息类型序列、请求体摘要、RSS 样本）追加进记录文件对应小节，结论单独一行。护栏三条：必须显式给临时
  `DATABASE_PATH` 且不得等于 shell 导出的值、路径必须落在临时根内、端口不得是 3001。
- `scripts/resident-experiment.test.mjs`：13 个具名用例，`node --test scripts/resident-experiment.test.mjs` exit 0。
- `docs/proposals/claude-resident-sessions-experiments.md`（新）：E1–E8 八节原始读数 + 逐节结论，外加「环境核对」附录。
- `docs/proposals/claude-resident-sessions.md`：新增「阶段 0 结论」小节，并据此修订 §5 `residentFeatures`、§8 忙时输入基准、
  §10（E5 结论：清扫不是可选项）、§11（上限数值仍待 24 小时浸泡）、§12（peer 名生效通道）。

**结论摘要**（原始读数与时间戳见记录文件，不是转述）

- E1：cron 在 330s 内触发 **5** 次（要求 ≥3），每次是一次独立的无人轮。
- E2：stream-json 与交互式 CLI **两种形态一致** —— busy 时推入的用户消息**另起一轮**，不丢、不拒。
- E3：无人轮进行中推入用户消息 → **另起一轮**（注入后出现 2 条 `result`）。
- E4：`interrupt()` 后**同一 pid 仍存活**，cron 从 1 次继续涨到 2 次。
- E5：扮演服务进程的子进程被 `SIGKILL` 后，常驻 `claude` **120s 内没有退出** → 清扫是必需的（实验自身在 `finally` 里清扫）。
- E6：`extraArgs.name` **生效**（中文与空格原样接受），但**只能读本地转录**判定，`/v1/messages` 请求体里看不到。
- E7：**未达标**。真实模型下观察窗只有 **0.10 小时**（峰值树 RSS 262532KB，花掉 $1.0836），远不到 ≥24 小时。
- E8：`bypassPermissions` 下 `AskUserQuestion` 仍走 `canUseTool`（被调用 1 次），可在回调里拦截。

**阻塞 `done` 的两条（本任务为什么停在 needs-human）**

1. **AC4**：记录文件里以 `E2/E3 基准确认：` 开头的那一行只能由人 yale 写，执行者不得代写。
2. **DoD 的「E7 覆盖 ≥24 小时」**：一次 dispatch 内跑不出 24 小时浸泡，本次只跑到 0.10 小时。§11 的两个上限数值仍**未定**，
   proposal 里保持"不给拍脑袋的数"，等一次真正的 24 小时浸泡。

**环境核对**（原文见记录文件「环境核对」节）

- 每个临时实例的 `DATABASE_PATH` 都在实例**还活着**时读 `/proc/<pid>/environ` 核对过，逐行写进记录。
- `:3001` 常驻服务**未被本实验重启**：实验脚本里 `systemctl` 调用 0 次，且 3001 是受保护端口（`GuardRefusal` 拒绝）；
  17:31:02 那次 Stopping→Started 是**环境侧**发生的，`journalctl` 原文已抄进记录。
- 收尾后逐 pid 查 `/proc`：记录里出现过的 **8 个 pid 全部已退出**；`pgrep` 与 `tmux ls` 均无残留；
  `systemctl --user list-units` 读数已抄进记录。

## Needs-Human

**执行 2026-09-25T10:24:19.304Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：AC 未全勾（checked 4/5，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：e06237e5-ed39-4739-b5a4-c35d7b4e2e81

## Needs-Human

**执行 2026-09-25T10:47:03.145Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：AC 未全勾（checked 4/5，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：c7f1eb34-033a-4783-b6d2-0879cce7073b

## 人工关卡（AC4）记录

人 yale 于 2026-09-26 指示写入该确认行，执行者据指示落笔并如实登记归属。记录文件（worktree 分支
`task/gap-claude-resident-phase0-experiments`）中已存在该行，提交 `44383195`；判据
`grep -n '^E2/E3 基准确认：' docs/proposals/claude-resident-sessions-experiments.md` 退出 0（命中第 47 行）。

确认内容与依据：沿用 CLI 行为——本记录 E2、E3 两节的实测读数**一致**（busy 时推入的第二条消息
另起一轮、不并入当前轮、未丢失；无人轮进行中推入同样另起一轮），因此不存在「在两种形态之间取舍」
的裁定项。该文件顶部原「待人工」段落已随之改为「人证已到」。

## Evidence（E9 轮，2026-09-26）

执行者：quay worker（分支 `task/gap-claude-resident-phase0-experiments`，实现提交 `7d37fd68`，scoped 门 `--allow-thin` exit 0，
`npm run lint` exit 0）。续做上一轮（`44383195`）的 E9 部分并把它跑完。

**本轮做了什么**

- 跑 `node scripts/resident-experiment.mjs e9 --database-path /tmp/resident-e9-r1/auth.db --cron-wait 80`：
  真实 `claude` 2.1.283 + mock Anthropic 端点，9.0–9.8 八个探针（含 tmux 里的交互式 CLI 那条腿），exit 0，
  读数写入记录文件的 E9 节（含 `session_crons` / `background_tasks`、`command_lifecycle` 序列、
  `elicitation` 控制请求原文、`/proc/<pane_pid>/environ` 的 `DATABASE_PATH` 见证）。
- proposal 原先剩下三处「由 E9 确认」按读数定稿：§8 忙时输入落到协议上（三档都排队、`now` 出队先于 `later`、
  撤回判据改用 `command_lifecycle` 的 `cancelled` 而不是控制响应）、§9 三个「需要人回应」入口
  （`onElicitation` 读到实体请求；`side_question` 方向相反、移出要拦的三个入口；`request_user_dialog` 记为缺口）、
  §9 Remote Control 走最保守分支。并在「阶段 0 结论」表补 E9 行。
- **修正生成器里两处与自身读数相悖的结论**（记录文件的 E9 结论行同步改正）：flag settings 那条原本写
  「`--settings` 确实盖在用户 settings 之上」，而同一节的读数是 `get_settings` 两处都「（无响应）」——
  改为如实记作**读数缺口**并说明方案改走最保守分支；交互式忙时那条原本断言「等价于 priority=next」，
  改为「落在后一轮、与 stream-json 形态一致」，并写明**分不开三档**（`next` 档在 9.2 里被撤掉、没读到落点）。

**AC 逐条验证**（本轮实跑）

- AC1 `node --test scripts/resident-experiment.test.mjs` → 14 个用例全过，exit 0。
- AC2 `--check-record` → exit 0。
- AC3 `grep -n '阶段 0 结论'` → 命中（`docs/proposals/claude-resident-sessions.md`）。
- AC4 `grep -n '^E2/E3 基准确认：'` → 命中第 49 行（人 yale 指示写入的那一行）。
- AC5 `npm run lint` → exit 0。
- AC6 `--check-record` → `E1–E9 九节齐全`，exit 0；护栏测试含「缺 E9 节时 exit 1 并点名 E9」用例。
- AC7 `! grep -n '由 E9 确认' docs/proposals/claude-resident-sessions.md` → exit 0（三处全已定稿）。

**仍未满足的 DoD（如实记下，不因 AC 全绿而消失）**

- **E7 的「≥24 小时浸泡」仍未达标**：本轮未重跑 E7，记录里仍是 0.10 小时（真实模型、花掉 $1.0836）。
  proposal §11 的两个上限数值**仍未定**，保持"不给拍脑袋的数"。E9 的读数不改变这一点。
  另注：develop 本轮合入的 `scripts/soak.sh` / `soak-driver.mjs` / `soak-analyze.mjs` 看起来正是为这类浸泡准备的，
  下一轮若用它跑 E7，应采用它并注明读数是否取自 systemd scope 内。
- E9 自身有两处**读数缺口**已写进记录与 proposal：`next` 档执行时的落点（9.2 里被撤掉）、
  `request_user_dialog` 的实物（没触发到入口）。两处都不阻塞已定稿的三处文字，但定档/接线前应补读数。

## Needs-Human

**执行 2026-09-26T00:53:06.870Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 4 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/voice/tests/voice-capture-off.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red
- run_id：wk-prod-anchor
- session_id：5cc9441d-5e63-46ac-a4fe-7758bea05875
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-claude-resident-phase0-experiments~wk-prod-anchor~1790383818461-934706.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-claude-resident-phase0-experiments-wk-prod-anchor.log

## Evidence（typecheck 修复轮，2026-09-26）

执行者：quay worker（分支 `task/gap-claude-resident-phase0-experiments`，实现提交 `94bff354`）。
本轮**没有新实验**：修的是前四轮 suite-red 的真因——我自己分支上的 `npm run typecheck` 红了。

**根因：前四轮的判词是一句常量文案，而真因就在它上面一行，且点名的是本任务的文件。**

前四轮的失败步都读作 `a surface this task must not have moved is red`，落在
`server/modules/voice/tests/voice-capture-off.false-forms.test.ts`，被登记成「suite 红但归因不出
任何失败测试文件（基建/contract 疑似，非实现缺陷）」。读原始 suite 日志
（`.quay/fan-in-suite-gap-claude-resident-phase0-experiments~wk-prod-anchor~1790383818461-934706.log`），
那条 voice 读数**上面一行**就写着名字：

```
not ok - typecheck: scripts/resident-experiment.mjs(1616,27): error TS18048: 'child.pid' is possibly 'undefined'.
```

`npm run typecheck` 是三个 tsc 项目的合取（根 `tsconfig.json` && `server/tsconfig.json` &&
`scripts/tsconfig.json`）。E9 轮（`7d37fd68`）新增的 `describeEvent` / `e9Group` /
`e9EnvironmentWitness` 让 **scripts 项目**红在 6 处——全是类型问题，不是测试失败：

| 行 | 错误 |
| --- | --- |
| 1616 | `process.kill(-child.pid, 'SIGKILL')`：`spawn` 失败时 `child.pid` 是 `undefined` |
| 1623 | `describeEvent(event)` 缺 `@param`（`checkJs` 下隐式 `any`）|
| 1666 ×2 | `e9Group(label, lines)` 两个参数缺 `@param` |
| 1688 / 1689 | `cli.child.pid`（`number \| undefined`）传给 `databasePathWitness(number[])` / `readEnviron(number)` |

它为什么把四个 voice `.false-forms` 测试一起拖红：每个 `.false-forms` 的 AC6 用例把
`npm run typecheck`（和 `npm run lint`）当**子进程**跑，用来断言「本任务不该动的面没有动」；
typecheck 一红，那条集合断言就非空，而它的文案是**静态字符串**。于是本轮日志里五条 `not ok`
有四条长得一模一样，唯一点名的那条是 `not ok - typecheck:`。

这与 `tasks/gap-voice-capture-off-ac6-red-not-attributable.md` 的 Finding 完全吻合——它正确指出了
「断言文案静态、逐条读数随 runner 的 TMP 删除、本地与 15 路加压都复现不了」，并留下「哪一条子命令
非零目前没有读数」。**本轮补上那个读数：非零的子命令是 `npm run typecheck`，原因是本分支
`scripts/resident-experiment.mjs` 的类型错误**，与 lane 形状、负载、宿主都无关；它的「本地不复现」
也因此有了解释（当时那棵树上的 typecheck 是红的，只是没人把它和 voice 那条读数连起来）。
该任务要交付的「下次红能点名」是另一件事，本轮的修复不替代它。

**为什么前几轮没抓到。** 上一轮只跑了 `tsc -p scripts/tsconfig.json`（在 E9 轮**之前**的提交上它是绿的）
和 `npm run lint`，都没覆盖 E9 轮新增代码；而本任务的 scoped 门是 **thin** 的：

```
bash scripts/test.sh --for-task gap-claude-resident-phase0-experiments --allow-thin
→ no scoped test files for gap-claude-resident-phase0-experiments (thin)
```

它 exit 0 且**一条测试都没跑**——scoped 门的文件集正则不含 `.mjs` 测试。所以 step-1b 的「门绿」
对本任务不构成任何证据，真正兜住这个错的是 fan-in 的**全量** suite。这也是本轮把证据放在
`npm run typecheck` 与四个文件独立跑上、而不是放在 scoped 门上的原因。

**修法（6 处，只加类型护栏、不动行为）**

- `stop()`：先取 `const pid = child.pid`；`undefined` 时退回 `child.kill('SIGKILL')`，
  否则原样按进程组 `process.kill(-pid, 'SIGKILL')`（原语义不变，孤儿清理仍按组）。
- `describeEvent` / `e9Group`：补 `@param` JSDoc（含 `@returns`）。
- `e9EnvironmentWitness`：取 `const cliPid = cli.child.pid`；`undefined` 时 witness 如实记
  「（未取到：cli 进程没有 pid）」、`environ` 记 `null`（现有分支渲染成「（environ 读不到）」），
  不再把 `undefined` 当 pid 传给取数函数。

**本轮实跑读数（均在合并 develop 后的树上；修复前 / 修复后对照）**

- `npm run typecheck`：修复前 **exit 2**、6 处错误（逐字见上表）；修复后 **exit 0**（三个项目全绿）。
- `node --test scripts/resident-experiment.test.mjs` → 14 用例全过，exit 0（AC1/AC6 护栏）。
- `node scripts/resident-experiment.mjs --check-record docs/proposals/claude-resident-sessions-experiments.md`
  → `--check-record OK：E1–E9 九节齐全`，exit 0（AC2/AC6）。
- `npm run lint` → exit 0（只有既有 warning，无新增）（AC5）。
- 四个 `.false-forms` 文件在 worktree 里**各自单独跑全部 exit 0**，且每个 AC6 用例的**每一条子命令
  读数都是 0**，含 `AC6 exit=0 cases=n/a :: npm run typecheck` 与 `:: npm run lint`：
  `voice-capture-off` 4/4、`voice-capture-text` 6/6、`voice-error-classification` 7/7、
  `voice-error-contract` 4/4。这是「typecheck 是那一个变量」的对照读数：同一棵树、同四个文件，
  唯一的改变是 `npm run typecheck` 由红转绿。

**AC 逐条（本轮重验，命令与读数）**

- AC1 `node --test scripts/resident-experiment.test.mjs` → 14/14，exit 0。
- AC2 `--check-record` → exit 0。
- AC3 `grep -n '阶段 0 结论' docs/proposals/claude-resident-sessions.md` → 命中 proposal:581。
- AC4 `grep -n '^E2/E3 基准确认：' docs/proposals/claude-resident-sessions-experiments.md` → 命中第 49 行
  （人 yale 指示写入的那一行，非执行者代写）。
- AC5 `npm run lint` → exit 0。
- AC6 `--check-record` → E1–E9 九节齐全，exit 0；护栏测试含「缺 E9 节时 exit 1 并点名 E9」用例。
- AC7 `! grep -n '由 E9 确认' docs/proposals/claude-resident-sessions.md` → exit 0（三处已定稿）。

**仍未满足的 DoD（不因 AC 全绿而消失，照旧如实记下）**

- E7 的「≥24 小时浸泡」仍未达标：记录里仍是 0.10 小时（真实模型、$1.0836），proposal §11 的
  两个上限数值**仍未定**。
- E9 自身两处读数缺口照旧：`next` 档执行时的落点（9.2 里被撤掉）、`request_user_dialog` 的实物。

本轮修复不触碰以上三项，也不改变任何 E1–E9 的读数与结论。

## Evidence（falsification 变体：把错放回去，2026-09-26）

上一节那条「typecheck 是唯一变量」的对照，本轮又做了一次**直接证伪**：把 6 处类型错误里的第 1 处
（`stop()` 的 `-child.pid`）原样放回、其余不动，然后单独跑
`server/modules/voice/tests/voice-capture-text.false-forms.test.ts`：

- `npm run typecheck` → **exit 2**：`scripts/resident-experiment.mjs(1617,27): error TS18048: 'pid' is possibly 'undefined'.`
- 该文件 → **exit 1**，失败在 `AC10 the six criteria and the repository gates still exit 0`，逐字：

```
  AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red
  + actual - expected

  + [
  +   'npm run typecheck'
  + ]
  - []
```

并且它复现了 suite 日志第 250 行那条 mutant 读数（同一串，不是相似）：

```
falsify/failure-row-dropped mutant: mutation=failure-row-dropped baseExit=0 mutantRed=true
whichReading=AC4/failRow predicted=[failRow=0] red=4 [AC2 mode resolution and the two arms
AC4 the refused attempt keeps the upstream own answer AC5 the preflight refusal costs no
request and still tells the row AC6 the three answers a reachable service can end as]
```

放回前同一命令是 `red=0`、该文件 6/6 exit 0；放回后是 `red=4`、exit 1。`git checkout --` 还原后
`npm run typecheck` 回到 exit 0、该文件回到 6/6 exit 0，工作树 `git status` 干净（还原后 `HEAD=25286036`）。
**这条读数把「suite 里那 5 条 `not ok` 同源于一个类型错误」从推断变成了实测。**

顺带一条对 `gap-voice-capture-off-ac6-red-not-attributable` 有用的差别：`voice-capture-text` 的这条断言
把非零命令名**放进了消息**（`actual: [ 'npm run typecheck' ]`），而 `voice-capture-off` 的 AC6 用的是
**静态字符串**、不含命令名——这就是为什么同一轮里只有后者的红在日志里读不出凶手。
