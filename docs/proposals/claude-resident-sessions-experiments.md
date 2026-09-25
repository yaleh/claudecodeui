# Claude 常驻会话阶段 0 实验记录（E1–E8）

由 `scripts/resident-experiment.mjs` 生成：`E1`…`E8` 每节含**原始**读数（pid、时间戳、消息类型
序列、RSS 样本、`/proc/<pid>/environ` 核对）与一行结论；`node scripts/resident-experiment.mjs
--check-record <本文件>` 逐节检查 `读数：`/`结论：` 是否齐全，缺哪节就点名哪节。

取数时间：2026-09-25。`claude --version`：2.1.282 (Claude Code)。驱动方式照 AC-025
（`server/modules/providers/tests/model-gateway-end-to-end.test.ts`）：真实 `claude` 二进制 +
本地 mock Anthropic 兼容端点，`tool_use` 由 mock 给出、工具在本地 CLI 里真实执行；**E2 的交互式
那一半**在 tmux 里跑交互式 CLI；**E7 用真实模型**（proposal 明文要求，走本机 `ANTHROPIC_BASE_URL`
指向的网关，模型 `v4.1flash`）。每个实验一个一次性临时实例，`DATABASE_PATH` 显式指向临时库并逐进程
读 `/proc/<pid>/environ` 核对。收尾另有一节「环境核对」：逐 pid 的 `/proc` 存活表、`:3001`
常驻服务未被本实验重启的证据、临时实例的 `DATABASE_PATH` 逐进程见证。

**待人工**：本记录还缺一行人证——以 `E2/E3 基准确认：` 开头的那一行（确认 E2/E3 的基准是否被接受）。
按任务的人工关卡约定，这行**只能由 yale 写**，执行者不得代写；因此本任务即使其余四条 AC 全绿，
正确的终态也是 `needs-human`。

## 结论速览

| 编号 | 问题 | 结论 |
|---|---|---|
| E1 | 常驻输入下 CronCreate 是否按时触发 | **是**。330s 内触发 5 次（要求 ≥3），每次是一次独立的无人轮（多一条 `result`）。 |
| E2 | busy 时推入用户消息（两种形态） | stream-json 与交互式 CLI 都**另起一轮**，不丢、不拒。 |
| E3 | 无人轮进行中推入用户消息 | **另起一轮**（注入后出现 2 条 `result`）。 |
| E4 | `interrupt()` 后进程与 cron 是否仍存活 | **仍存活**。同一 pid 继续跑，cron 从 1 次涨到 2 次。 |
| E5 | 服务进程被 kill 后常驻进程是否因 EOF 退出 | **不退出**（>120s）。清扫逻辑是必需的。 |
| E6 | `extraArgs.name` 是否生效 | **生效**，中文与空格被原样接受；判定通道是**本地转录**（`agent-name`），不是 API 请求体。 |
| E7 | 长驻内存增长（≥24 小时浸泡） | **窗口未达标**：真实模型下实际 0.10 小时（峰值树 RSS 262MB，$1.08），**不足以**定 §11 的上限数值。 |
| E8 | `bypassPermissions` 下 `AskUserQuestion` 走不走 `canUseTool` | **走**（被调用 1 次），可在回调里拦截。 |

取数过程中发现两条写驱动必须知道的通道细节（不是结论，是**方法**）：

1. 一轮开始时会发两条 `/v1/messages` 请求：一条 ~2KB 的预检、一条 ~77KB（完整 system prompt +
   skills 前导）的真 agent 轮。按序号、或按"请求里有没有用户文本"去认这一轮都会认错——把
   `tool_use` 发给预检那条时回复会被丢弃。要按**请求体体量**挑真轮（>10KB）。
2. 每轮以**正好一条** `result` 结束（`subtype: success/error`）。数轮次就数 `result`；不要用
   "最新一条消息里有没有某个标记"来数——cron 推入的那一轮里，标记同时出现在历史（`tool_use`
   的入参）和最新消息里，会数错。

# Claude 常驻会话阶段 0 实验记录（E1–E8）

本文件由 `scripts/resident-experiment.mjs` 写入：每节含**原始**读数（pid、时间戳、消息类型序列、
RSS 样本）与一行结论。`node scripts/resident-experiment.mjs --check-record <本文件>` 逐节检查
`读数：`/`结论：` 是否齐全。

## E1 常驻输入下 CronCreate 是否按时触发
取数时间：2026-09-25T09:40:04.170Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
pid（运行中采样）：43674
DATABASE_PATH 核对（/proc/43674/environ）：/tmp/resident-db-DhMX/auth.db —— 与 --database-path 一致
跑时长：330s
标记：cron-tick-1790328873837
mock /v1/messages 请求总数：8
CronCreate 工具结果：isError=false text="Scheduled recurring job 91a3233d (Every minute). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."
result 条数：6（第 1 条是创建轮）⇒ cron 触发 5 次（要求 ≥3）
各轮结束时刻：2026-09-25T09:34:34.226Z | 2026-09-25T09:35:17.178Z | 2026-09-25T09:36:17.251Z | 2026-09-25T09:37:17.388Z | 2026-09-25T09:38:17.554Z | 2026-09-25T09:39:17.707Z
请求[0] 2026-09-25T09:34:34.186Z 回复=text bytes=1894 tools=Y lastUser=[{"type":"text","text":"<session>\n请创建一个每分钟触发的周期任务\n</sessio
请求[1] 2026-09-25T09:34:34.195Z 回复=tool_use:CronCreate bytes=77121 tools=Y lastUser="The following skills are available for use with the Skill t
请求[2] 2026-09-25T09:34:34.214Z 回复=text bytes=77558 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
请求[3] 2026-09-25T09:35:17.175Z 回复=text bytes=77654 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
请求[4] 2026-09-25T09:36:17.248Z 回复=text bytes=77734 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
请求[5] 2026-09-25T09:37:17.383Z 回复=text bytes=77814 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
请求[6] 2026-09-25T09:38:17.551Z 回复=text bytes=77894 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
请求[7] 2026-09-25T09:39:17.702Z 回复=text bytes=77974 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
消息类型序列：system/init → assistant → user → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → error
助手里的 tool_use：CronCreate
canUseTool 被调用：（无）
助手消息原文：{"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"tool_use","id":"toolu_cron_e1","name":"CronCreate","input":{"cron":"* * * * *","prompt":"cron-tick-1790328873837","recurring":true}}],"s ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa
result 原文：{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":47,"duration_api_ms":45,"ttft_ms":22,"time_to_request_ms":15,"num_turns":2,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117"," ¶ {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":8,"duration_api_ms":50,"ttft_ms":7,"time_to_request_ms":3,"num_turns":1,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117","tot ¶ {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":7,"duration_api_ms":55,"ttft_ms":6,"time_to_request_ms":3,"num_turns":1,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117","tot ¶ {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":13,"duration_api_ms":63,"ttft_ms":11,"time_to_request_ms":5,"num_turns":1,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117","t ¶ {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":9,"duration_api_ms":69,"ttft_ms":8,"time_to_request_ms":4,"num_turns":1,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117","tot ¶ {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":12,"duration_api_ms":77,"ttft_ms":10,"time_to_request_ms":4,"num_turns":1,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117","t
--- CLI stderr（尾部） ---
观察窗：330s（cron 为 * * * * *，期望 ≥5 次）
```
结论：周期任务连续触发 5 次（要求 ≥3），每次都以一次独立的无人轮（多一条 result）出现在流里；常驻输入下 CronCreate 按时触发。

## E2 busy 时推入用户消息（stream-json 与交互式 CLI 两种形态）
取数时间：2026-09-25T09:44:29.025Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
pid（运行中采样）：493584
DATABASE_PATH 核对（/proc/493584/environ）：/tmp/resident-db-1c9I/auth.db —— 与 --database-path 一致
第一轮延迟：20000ms（发给体量 >10KB 的真 agent 轮）
推入第二条的时刻：2026-09-25T09:43:48.742Z（第一条已发出请求）
mock 请求：2026-09-25T09:43:48.704Z bytes=77115 回复=delay20000 | 2026-09-25T09:43:48.753Z bytes=1893 回复=text | 2026-09-25T09:44:08.738Z bytes=77257 回复=text
result 条数：2（1 = 并入当前轮；2 = 另起一轮）
result 时刻：2026-09-25T09:44:08.722Z | 2026-09-25T09:44:08.746Z
消息类型序列：system/init → assistant → result/success → system/init → assistant → result/success → error
```
结论：stream-json 形态：busy 时推入的第二条消息**另起一轮**（出现 2 个 result），未丢失。





### 交互式 CLI 形态

取数时间：2026-09-25T09:47:52.779Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
tmux session：resident-e2-623914
交互式 CLI 的环境：env -i 起干净环境（不含本会话的 CLAUDE_CODE_* 身份变量），仅传 PATH/HOME/LANG/USER/SHELL/TMPDIR/XDG_RUNTIME_DIR + ANTHROPIC_BASE_URL/AUTH_TOKEN + CLAUDE_CONFIG_DIR + DATABASE_PATH
启动后会话仍存在：是
首启向导：主题选择：Enter → 安全说明：Enter → bypass 权限警告：Down+Enter（默认高亮是 No, exit） → 向导已走完（无已知对话框）
DATABASE_PATH 核对（/proc/623973/environ）：/tmp/resident-db-OAJZ/auth.db —— 与 --database-path一致
启动后 pane 尾部：▝▜██████▀  Opus 5.5 (1M context) · API Usage Billing /  ▝▝   ▝▝   /tmp/resident-e2tmux-hhJVLs / ────────────────────────────────────────────────────────────────────────────────────────────────── / ❯  / ──────────────────────────────────────────────────────────────────────────────────────────────────
推入第二条的时刻：2026-09-25T09:47:12.747Z（第一条的真 agent 轮已到达）
mock /v1/messages 请求数：3（其中真 agent 轮 2）
请求[0] 2026-09-25T09:47:12.701Z bytes=82668 回复=delay20000 lastUser=[{"type":"text","text":"# Environment\nYou have been invoked in the following environment: \n - Primary working director
请求[1] 2026-09-25T09:47:32.879Z bytes=4019 回复=text lastUser=[{"type":"text","text":"<session>\n第二条：我在你回答时插一句话\n</session>\n\nWrite the title in the predominant language of the sess
请求[2] 2026-09-25T09:47:32.881Z bytes=82865 回复=text lastUser=[{"type":"text","text":"<total_tokens>15000000 tokens left</total_tokens>","cache_control":{"type":"ephemeral"}}]
真 agent 轮数：2（1 = 第二条并入当前轮；2 = 另起一轮）
信任对话框出现过：否
实验结束时仍卡在对话框上：否
--- pane 原文（尾部） ---

──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents



































```
结论：交互式 CLI 形态：busy 时输入的第二条消息**另起一轮**（真 agent 轮数 2），未丢失。

## E3 无人轮进行中推入用户消息 / busy 时跨会话消息到达
取数时间：2026-09-25T09:46:46.479Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
pid（运行中采样）：561407
DATABASE_PATH 核对（/proc/561407/environ）：/tmp/resident-db-tePL/auth.db —— 与 --database-path 一致
标记：unattended-1790329525689
CronCreate 工具结果：isError=false text="Scheduled recurring job 78f10f63 (Every minute). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."
cron 触发的无人轮请求：2026-09-25T09:46:14.218Z（该轮被 __DELAY__16000 挂住）
注入时刻：2026-09-25T09:46:14.253Z（注入时无人轮仍在进行：是；注入前的 result 条数 1）
请求[0] 2026-09-25T09:45:26.261Z user bytes=1894 回复=text lastUser=[{"type":"text","text":"<session>\n请创建一个每分钟触发的周期任务\n</sessio
请求[1] 2026-09-25T09:45:26.283Z user bytes=77121 回复=tool_use:CronCreate lastUser="The following skills are available for use with the Skill t
请求[2] 2026-09-25T09:45:26.332Z tool-result bytes=77559 回复=delay16000 lastUser=[{"tool_use_id":"toolu_cron_e3","type":"tool_result","conten
请求[3] 2026-09-25T09:46:14.218Z tool-result bytes=77668 回复=delay16000 lastUser=[{"tool_use_id":"toolu_cron_e3","type":"tool_result","conten
请求[4] 2026-09-25T09:46:14.259Z user bytes=1889 回复=text lastUser=[{"type":"text","text":"<session>\n无人轮进行中我插一句\n</session>"}]
请求[5] 2026-09-25T09:46:30.239Z tool-result bytes=77729 回复=delay16000 lastUser=[{"tool_use_id":"toolu_cron_e3","type":"tool_result","conten
result 总条数：3
注入之后的 result：2 条 —— 2026-09-25T09:46:30.229Z | 2026-09-25T09:46:46.246Z
消息类型序列：system/init → assistant → user → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → error
```
结论：无人轮（cron 触发）进行中推入用户消息：**没有被拒绝，另起了一轮**（注入后出现 2 条 result：无人轮结束 2026-09-25T09:46:30.229Z、注入轮结束 2026-09-25T09:46:46.246Z）。

## E4 interrupt() 后进程与 cron 是否仍存活
取数时间：2026-09-25T09:37:23.957Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
interrupt 时刻：2026-09-25T09:35:51.878Z
DATABASE_PATH 核对（/proc/43673/environ）：/tmp/resident-db-xJGP/auth.db —— 与 --database-path 一致
interrupt 前 pid：43673
interrupt 后 pid：43673
进程仍存活：是
CronCreate 工具结果：isError=false text="Scheduled recurring job fb572570 (Every minute). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."
cron 触发次数：interrupt 前 1 → 之后 2
消息类型序列：system/init → assistant → user → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success
```
结论：interrupt() 只停了当前一轮：同一 pid（43673）仍在，cron 从 1 次继续涨到 2 次。

## E5 服务进程被 kill 后常驻进程是否因 EOF 退出
取数时间：2026-09-25T09:41:34.396Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
子进程（扮演服务进程）pid：296439
常驻 claude pid：296499
DATABASE_PATH 核对（/proc/296499/environ）：/tmp/resident-db-t5CH/auth.db —— 与 --database-path 一致
kill 前常驻存活：是
kill 时刻：2026-09-25T09:39:34.252Z
常驻退出用时：>120s（未退出）
残留清扫：已由本实验清扫（SIGKILL），无残留
```
结论：服务进程被 kill 后常驻进程 120 秒内**没有**退出——清扫逻辑是必需的。

## E6 extraArgs.name 是否生效、是否接受中文与空格
取数时间：2026-09-25T09:36:03.997Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
extraArgs.name（ASCII）：resident-e6-103193
--name 是合法旗标：-n, --name <name>                     Set a display name for this session
本地转录里找到的 agent-name：resident-e6-103193
本地转录里找到的 custom-title：resident-e6-103193
转录文件：/tmp/resident-e6-XkAu4Y/claude-config/projects/-tmp-resident-e6-XkAu4Y/8b8ea704-c102-4771-a5b9-681356ea7249.jsonl
mock 收到的请求体里出现该名：否（peer 名不进 API，这条不能用来判定生效与否）
system/init 原文：{"type":"system","subtype":"init","cwd":"/tmp/resident-e6-XkAu4Y","session_id":"8b8ea704-c102-4771-a5b9-681356ea7249","tools":["Task","AskUserQuestion","Bash","CronCreate","CronDelete","CronList","Edit","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","NotebookEdit","Read","ScheduleWakeup","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","WebFetch","WebSearch","Workflow","Write"],"mcp_servers":[],"model":"v4.1flash[1m]","permissionMode":"bypassPermissions","slash_commands":["deep-research","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","claude-api","run","run-skill-generator","clear","compact","context","heapdump","init","reload-skills","review","security-review","usage","insights","goal","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.165","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["deep-research","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","claude-api","run","run-skill-generator"],"plugins":[],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"f02d824d-6800-437c-b53e-7cebbe448a29","memory_paths":{"auto":"/tmp/resident-e6-XkAu4Y/claude-config/projects/-tmp-resident-e6-XkAu4Y/memory/"},"fast_mode_state":"off"}
extraArgs.name（中文 + 空格）：实验会话 中文 空格
本地转录里找到的 agent-name：实验会话 中文 空格
本地转录里找到的 custom-title：实验会话 中文 空格
转录文件：/tmp/resident-e6b-xZT4mH/claude-config/projects/-tmp-resident-e6b-xZT4mH/9543d779-147a-4c9c-81bd-cf8061c0c1df.jsonl
system/init 原文：{"type":"system","subtype":"init","cwd":"/tmp/resident-e6b-xZT4mH","session_id":"9543d779-147a-4c9c-81bd-cf8061c0c1df","tools":["Task","AskUserQuestion","Bash","CronCreate","CronDelete","CronList","Edit","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","NotebookEdit","Read","ScheduleWakeup","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","WebFetch","WebSearch","Workflow","Write"],"mcp_servers":[],"model":"v4.1flash[1m]","permissionMode":"bypassPermissions","slash_commands":["deep-research","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","claude-api","run","run-skill-generator","clear","compact","context","heapdump","init","reload-skills","review","security-review","usage","insights","goal","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.165","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["deep-research","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","claude-api","run","run-skill-generator"],"plugins":[],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"1dd3a676-513f-4f82-bcdd-33919a6d0721","memory_paths":{"auto":"/tmp/resident-e6b-xZT4mH/claude-config/projects/-tmp-resident-e6b-xZT4mH/memory/"},"fast_mode_state":"off"}
```
结论：extraArgs.name 生效：本地转录里 `agent-name` 与设定值逐字一致（ASCII="resident-e6-103193"，中文+空格="实验会话 中文 空格"），中文与空格**被原样接受**。该名不进 API 请求体（mock 端看不到），判定必须读转录。

## E7 长驻内存增长（≥24 小时浸泡）
取数时间：2026-09-25T09:49:49.426Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
端点：真实模型（沿用 ANTHROPIC_BASE_URL=http://127.0.0.1:26510/，模型 v4.1flash）
浸泡起点：2026-09-25T09:43:48.024Z
浸泡目标：0.1 小时；本机实际观察窗：0.10 小时 —— ⛔未达 ≥24h，本次读数不能用来定 §11 的上限
采样间隔：0.5 分钟，样本数：12
费用（SDK result.total_cost_usd 求和）：$1.0836
token：input=29080 output=11964 cache_read=300928 cache_write=0
浸泡期间 cron 触发的无人轮数：1
残留清扫：已由本实验清扫，无残留
起点 RSS：self=253888KB tree=253888KB
峰值 RSS：2026-09-25T09:44:48.188Z self=262532KB tree=262532KB
终点 RSS：2026-09-25T09:49:49.059Z self=233144KB tree=233144KB
2026-09-25T09:44:18.102Z +0.01h pid=493481 self=253888KB tree=253888KB
2026-09-25T09:44:48.188Z +0.02h pid=493481 self=262532KB tree=262532KB
2026-09-25T09:45:18.256Z +0.03h pid=493481 self=231236KB tree=231236KB
2026-09-25T09:45:48.345Z +0.03h pid=493481 self=231260KB tree=231260KB
2026-09-25T09:46:18.438Z +0.04h pid=493481 self=231224KB tree=231224KB
2026-09-25T09:46:48.509Z +0.05h pid=493481 self=231240KB tree=231240KB
2026-09-25T09:47:18.601Z +0.06h pid=493481 self=231872KB tree=231872KB
2026-09-25T09:47:48.708Z +0.07h pid=493481 self=231536KB tree=231536KB
2026-09-25T09:48:18.793Z +0.08h pid=493481 self=231552KB tree=231552KB
2026-09-25T09:48:48.886Z +0.08h pid=493481 self=232616KB tree=232616KB
2026-09-25T09:49:18.971Z +0.09h pid=493481 self=254124KB tree=254124KB
2026-09-25T09:49:49.059Z +0.10h pid=493481 self=233144KB tree=233144KB
样本原文：/tmp/resident-e7-MHsdWS/rss-samples.json
```
结论：浸泡 0.10 小时，离 ≥24h 还差 23.90 小时：峰值树 RSS 262532KB 只够说明"没有分钟级的暴涨"，**不足以**定 §11 的上限数值——§11 的数值仍待一次真正的 24 小时浸泡。

## E8 bypassPermissions 下 AskUserQuestion 走不走 canUseTool
取数时间：2026-09-25T08:58:34.632Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
permissionMode：bypassPermissions
canUseTool 被调用次数：1
拦截到的工具名：AskUserQuestion
消息类型序列：system/init → assistant → user → assistant → result/success
```
结论：bypassPermissions 下 AskUserQuestion **仍然**走 canUseTool（被调用 1 次，工具名 AskUserQuestion），可以在回调里拦截。

## 环境核对（全部实验跑完之后取的静止读数）

### 1. 每个一次性实例都显式指了临时 DATABASE_PATH（逐进程读 /proc/<pid>/environ 核对）

```
记录行 15:DATABASE_PATH 核对（/proc/43674/environ）：/tmp/resident-db-DhMX/auth.db —— 与 --database-path 一致
记录行 48:DATABASE_PATH 核对（/proc/493584/environ）：/tmp/resident-db-1c9I/auth.db —— 与 --database-path 一致
记录行 74:DATABASE_PATH 核对（/proc/623973/environ）：/tmp/resident-db-OAJZ/auth.db —— 与 --database-path一致
记录行 136:DATABASE_PATH 核对（/proc/561407/environ）：/tmp/resident-db-tePL/auth.db —— 与 --database-path 一致
记录行 161:DATABASE_PATH 核对（/proc/43673/environ）：/tmp/resident-db-xJGP/auth.db —— 与 --database-path 一致
记录行 180:DATABASE_PATH 核对（/proc/296499/environ）：/tmp/resident-db-t5CH/auth.db —— 与 --database-path 一致
```

见证方式：在实例**还活着**时读 `/proc/<pid>/environ`，比对 `DATABASE_PATH=` 与本次
`--database-path` 的取值；上面每一行都是当时进程自身的环境，不是脚本的自述。

### 2. :3001 常驻服务：本实验从未重启它

```
脚本里 systemctl 调用次数：0
端口保护：61:export const PROTECTED_PORT = 3001;
拒绝逻辑：108:    throw new GuardRefusal(`拒绝运行：端口 ${PROTECTED_PORT} 是本机常驻服务，实验一律避开`);
--- journalctl --user -u claudecodeui-server.service（本日窗口）---
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: Stopping claudecodeui-server.service - /data/home/yale/.nvm/versions/node/v24.21.0/bin/npm run server...
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: Stopped claudecodeui-server.service - /data/home/yale/.nvm/versions/node/v24.21.0/bin/npm run server.
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Consumed 20.641s CPU time, 1.0G memory peak, 0B memory swap peak.
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Failed to open /run/user/1004/systemd/transient/claudecodeui-server.service: No such file or directory
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Failed to open /run/user/1004/systemd/transient/claudecodeui-server.service: No such file or directory
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Failed to open /run/user/1004/systemd/transient/claudecodeui-server.service: No such file or directory
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Failed to open /run/user/1004/systemd/transient/claudecodeui-server.service: No such file or directory
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Failed to open /run/user/1004/systemd/transient/claudecodeui-server.service: No such file or directory
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: Started claudecodeui-server.service - /data/home/yale/.nvm/versions/node/v24.21.0/bin/npm run server.
```

17:31:02 那次 Stopping→Stopped→Started 是**环境侧**发生的（另一路会话/部署），不是本实验：
本实验的进程树里没有任何 `systemctl` 调用（上面计数为 0），且脚本把 3001 列为受保护端口、
任何拿 3001 起实例的调用都会被 `GuardRefusal` 拒绝。会话本身是 :3001 的子进程，重启它会杀掉
托管本次会话的服务——这也是「一律避开 3001、绝不重启」这条约束的由来。

### 3. 进程与 systemd scope 清扫

记录里出现过的每一个实例 pid，此刻逐个查 `/proc/<pid>`（活着才在，清扫干净则不在）：

```
pid 43674 → 已退出
pid 493584 → 已退出
pid 623973 → 已退出
pid 561407 → 已退出
pid 43673 → 已退出
pid 296499 → 已退出
pid 493481 → 已退出
pid 623914 → 已退出
（共 8 个 pid，仍在的 0 个）
--- pgrep：本实验的脚本/mock/tmux 常驻进程（已排除调用方自身）---
（无）
--- tmux 会话 ---
（无 resident-* 会话）
--- systemctl --user list-units（全机含 claude/resident 字样的 unit，含与本实验无关的）---
  ● oomprobe-2421772.scope                                                                              loaded    failed   failed    /data/home/yale/.nvm/versions/node/v24.21.0/bin/npx vitest run --reporter=json --outputFile=/data/scratch/yale/claude-1004/-data-home-yale-work-claudecodeui/8e45901a-04fe-4505-b574-338e574e729d/scratchpad/v.json src/__oomprobe__/oom.test.ts
    quay-drivers-claudecodeui-1790309708.scope                                                          loaded    active   running   /usr/bin/env QUAY_MEMORY_SLICE=quay-fleet.slice node /data/home/yale/.claude/plugins/cache/quay/quay/0.11.0/scripts/dist/start-drivers.js --root /data/home/yale/work/claudecodeui
    claudecodeui-server.service                                                                         loaded    active   running   /data/home/yale/.nvm/versions/node/v24.21.0/bin/npm run server
```

说明：上面这一批 unit 是**全机**范围，不全是本实验的——`claudecodeui-server.service` 是本机
常驻服务（本实验只读不动它），`quay-drivers-*.scope` 是 quay 驱动自己的，名字里带 `claude`
只是因为路径或服务名的巧合。本实验起的东西是**自己进程树的子进程**，收尾在脚本的 `finally` 里
做，所以真正的证据是上面那张 `/proc/<pid>` 逐 pid 表，不是 `list-units`。

E5 的读数说明为什么这节必须存在：服务进程被 kill 后常驻 `claude` 120 秒内不会自己退出；
同一个进程还在跑 cron，所以每次实验结束都要**主动清扫**（脚本在 `finally` 里 SIGKILL 自己的
后代并就地把清扫结果写进记录）。
