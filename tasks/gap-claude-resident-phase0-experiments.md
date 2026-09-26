---
id: gap-claude-resident-phase0-experiments
title: Claude 常驻会话阶段 0 实验 E1–E9：用真实 claude 二进制取得读数，定下忙时输入基准、控制协议用法与内存上限，结论写回 proposal
status: needs-human
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
- [ ] E9 节齐全：`node scripts/resident-experiment.mjs --check-record docs/proposals/claude-resident-sessions-experiments.md` exit 0，且该命令要求 E1–E9 九节（护栏测试 `node --test scripts/resident-experiment.test.mjs` 含「缺 E9 节时 exit 1 并点名 E9」的用例，exit 0）
- [ ] proposal 中不再有待 E9 定稿的文字：`! grep -n '由 E9 确认' docs/proposals/claude-resident-sessions.md` exit 0

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
