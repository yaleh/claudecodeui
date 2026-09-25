---
id: gap-claude-resident-phase0-experiments
title: Claude 常驻会话阶段 0 实验 E1–E8：用真实 claude 二进制取得读数，定下忙时输入基准与内存上限，结论写回 proposal
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

<!-- dedup-ref -->
相关任务 `gap-claude-session-cgroup-scope`（needs-human，未合入 develop）已实现「每个 Claude 会话进自己的 systemd scope + 内存上限 + 启动清扫」，并测得真实会话子树约 390–470MB。E5 与 E7 若在该服务可用时进行，记录注明读数是在 scope 内还是 scope 外取得的；proposal §11 的 L3 以后应复用该服务而不是另起一套，本任务只在结论里指出，不改代码。

## Plan

1. 写实验脚本 `scripts/resident-experiment.mjs`：子命令 `e1`…`e8` 各跑一个实验并把原始读数追加到记录文件；公共部分是「起 mock 端点」「起临时实例并核对 DATABASE_PATH」「用 SDK 的 `query()` 以不结束的 AsyncIterable 作 prompt 驱动常驻进程」。`--check-record` 检查记录文件是否八节齐全、每节都有 `读数：` 与 `结论：` 行，缺哪节就打印哪节并 exit 1。
2. 给脚本的安全护栏写测试 `scripts/resident-experiment.test.mjs`：未显式给出临时 `DATABASE_PATH`（或它等于 shell 导出的值）时拒绝运行；`--check-record` 对缺节、缺 `结论：` 的记录 exit 1 并点名。
3. 依次跑 E1、E3、E4、E5、E6、E8（mock 端点），E2 两种形态，E7 浸泡。每个实验的原始读数（pid、时间戳、流中出现的消息类型序列、RSS 样本）原样写进 `docs/proposals/claude-resident-sessions-experiments.md` 对应小节，结论单独一行。
4. 把结论写回 `docs/proposals/claude-resident-sessions.md`：新增「阶段 0 结论」小节；按结论修订 §5 `residentFeatures` 各项取值、§8 忙时输入基准、§11 两个上限的数值、§12 peer 名格式；E5 结论决定清扫是否必需。
5. 请人 yale 确认 E2/E3 基准（一致时确认沿用，不一致时裁定），由人在记录文件里写下确认行。

## AC

- [ ] 实验脚本的护栏测试通过：`node --test scripts/resident-experiment.test.mjs` exit 0（覆盖：未显式给临时 DATABASE_PATH 时拒绝运行；`--check-record` 对缺节记录 exit 1 并点名缺的小节）
- [ ] 记录文件八节齐全：`node scripts/resident-experiment.mjs --check-record docs/proposals/claude-resident-sessions-experiments.md` exit 0（E1–E8 每节都有 `读数：` 与 `结论：` 行；缺任何一节即打印节名并 exit 1）
- [ ] proposal 已写回结论：`grep -n '阶段 0 结论' docs/proposals/claude-resident-sessions.md` 有输出且 exit 0
- [ ] 人工关卡——忙时输入基准已由人确认：`grep -n '^E2/E3 基准确认：' docs/proposals/claude-resident-sessions-experiments.md` 有输出且 exit 0（该行只能由人 yale 写入，内容为「沿用 CLI 行为」或裁定采用的形态；执行者不得代写）
- [ ] `npm run lint` exit 0

## DoD

- 八个实验都**真实跑过**：真实 `claude` 二进制（E7 为真实模型），记录里的读数是原始输出（pid、时间戳、消息类型序列、RSS 样本），不是转述；每节写明取数时间、`claude --version`、是否在 systemd scope 内。
- E1 的周期 cron 连续触发 ≥3 次的时间戳写在记录里；E4 读到 `interrupt()` 之后同一 pid 仍在、cron 仍触发；E5 给出服务进程被 kill 后常驻进程退出所用的秒数（或「不退出」）；E7 覆盖 ≥24 小时，给出曲线的起点、峰值、终点，以及据此建议的两个上限。
- E2 的交互式形态与 stream-json 形态各有一份读数，结论写明两者是否一致。
- 临时实例的 `DATABASE_PATH` 经 `/proc/<pid>/environ` 核对并写进记录；实验期间 :3001 未重启；结束后无残留进程与 scope（附 `systemctl --user list-units` 与 `pgrep` 的读数）。
- 真实模型费用写进记录。
- **前四条 AC 通过而人工关卡那条未勾时，本任务的正确终态是 needs-human，不是 done。**

## Touches

- scripts/resident-experiment.mjs (new)
- scripts/resident-experiment.test.mjs (new)
- docs/proposals/claude-resident-sessions-experiments.md (new)
- docs/proposals/claude-resident-sessions.md
- tasks/gap-claude-resident-phase0-experiments.md
