# Claude 会话「活动」的统一架构：一个真实、持续、可操作的底部活动坞

- 状态：analysis + design（只做调查、实测与架构讨论，未改业务代码、未立 task）
- 日期：2026-10-01
- 范围：仅 Claude Code（resident 与 per-run 两条路径）；其它 provider 不在范围内
- 扩展自：`docs/proposals/claude-background-work-observability.md`（本文把它的 Task 实体纳入更大的“会话活动”模型，并补上控制面、计划任务、入站消息与真实性）
- 关联：`docs/proposals/claude-resident-sessions.md`、`docs/proposals/chat-transcript-streaming-architecture.md`

> 图用 PlantUML 写成。本机没有渲染器，**图未渲染校验**，提交前请在能渲染的环境里过一遍。
> “实测”＝本次对真实 SDK/CLI（`@anthropic-ai/claude-agent-sdk` 0.3.165，CLI 2.1.165）的运行；“读代码”＝只读调查，未运行；“推断”＝由二进制字符串或代码结构推出，未验证。

---

## 0. 要解决的问题与结论

**用户的诉求**

1. 现在底部有两处互不相干的“忙”提示：一个是 `Thinking...` 的活动指示（`ActivityIndicator`），一个是 resident 状态栏里“有几个后台任务”的计数。应当**合并成一处，持续显示在助手输出的底部**。
2. `Thinking...` 是**假的**：服务器挂了它还在显示、计时器还在走。
3. 要能看到后台 subagent / Monitor / Workflow 的**具体状态**，并能**控制**它们（停止、转后台）。
4. 还要表达 cron、ScheduleWakeup（计划任务）、`paused` 状态，以及**收到的 SendMessage 消息**。

**结论**

1. 需要一个服务端权威的 **`SessionActivity`** 模型（回合 ⊕ 任务 ⊕ 计划 ⊕ 入站消息 ⊕ 连接），经推送加快照交给客户端，由**唯一**一个“活动坞”渲染；`ActivityIndicator`、`ResidentStatusBar` 的忙闲部分、侧栏运行视图都读同一个来源。
2. “假”的根源不是某个 bug，而是**活动的真相被拆在四个互不联系的来源里，且没有任何一个携带“我还活着”的证据**。修法必须包含一个**客户端可见的心跳/新鲜度**，并把“连接中断”作为一等状态，而不是继续沿用本地时钟。
3. 这件事可以**分层交付**，其中“真实性”（诚实地显示连接中断，不再假装在思考）是一条独立、小、风险低、可最先落地的线。
4. 控制面应当与 `chat.cancel-queued` 同构，但要修它的两个弱点：没有请求关联、没有会话归属校验。

---

## 1. 实测与调查事实

### 1.1 “Thinking...” 为什么是假的（读代码，无实测）

客户端的“处理中”是一张 `processingSessions` 表（`useSessionProtection.ts`）。它只有这几条**写入**路径：发送时本地打标、`chat_subscribed{isProcessing:true}`、`permission_request`、带文本的 `status`、每 5 秒一次对 `/api/providers/sessions/running` 的轮询。**清除**路径只有：`complete`、`protocol_error`、一次 `isProcessing:false` 的订阅应答、以及轮询成功且列表里没有它。

服务端宕机时这些都不会发生：

| 排名 | 原因 | 症状 |
|---|---|---|
| 1 | 服务端宕机/不可达：没有 `complete`、没有应答，轮询失败只写日志（`SessionProtectionContext.tsx`），`isConnected` 被聊天模块完全忽略 | 条目永久保留，计时器用本地时钟一直走，停止按钮仍在 |
| 2 | WS 关闭但服务端活着：发送时本地先打标，`sendMessage` 在 socket 关闭时只 `console.warn` | 约 15 秒内闪一下，**停止按钮静默无效** |
| 3 | 半开连接：客户端没有 ping | 浏览器可能很久才发现对端消失 |
| 4 | 只被代理拦掉的轮询请求 | 条目停到下一个 `complete` |
| 5 | 状态栏的 `busy` 来自 1 秒一次的 `/api/session-hosts` 轮询，失败时**保留旧快照** | 与上面同因，状态栏也会陈旧 |

另外：
- 服务端对 Claude **从不发带文本的 `status` 帧**（只有 `token_budget`），所以 `statusText` 恒为空；标签是按已用时间轮换的 “Thinking / Processing / Analyzing …”，**不携带任何信息**。
- 服务端有 WS 协议级 ping/pong（30 秒，终止无应答的 socket），但那在浏览器 JS 之下，**客户端看不到**。
- 它不能表达这些状态：连接中断/重连中、等待权限、正在运行某个工具（及其名字）、只剩后台任务、计划唤醒待触发、服务端重启后 run 丢失（只能靠重连后的一次空闲应答或轮询得知）。
- **四个互不相干的“忙”来源**，可以互相矛盾：

| 指示 | 真相来源 |
|---|---|
| 活动页签/内联行、发送按钮的停止态、侧栏“运行中”圆点 | 同一张 `processingSessions` 表（WS 帧 + 5 秒轮询 + 本地打标） |
| resident 状态栏的 idle/busy/exited、侧栏 resident 标记 | `useSessionHosts` 1 秒轮询 `/api/session-hosts`；`busy` 的含义是宿主有 `turn` 租约，**不等于**聊天 run 注册表 |

- 版面：桌面端活动页签绝对定位在输入框顶沿之上，浮在转写末尾；移动端是转写末尾的内联行；resident 状态栏在转写滚动区**上方**另占一行，两者从不同处。

### 1.2 per-run 路径同样推送 `task_*`（实测）

用一次性查询（字符串 prompt，非流式输入）启动后台 Bash：`task_started`（`task_type=local_bash`、`description`）、`task_updated`、`task_notification` 的形态与 resident 完全一致。**这回答了此前未核实的问题：per-run 的 CLI 同样推送 `task_*`。**

顺带的发现：本次因为用的是字符串 prompt，**`result` 之后约 5 秒后台任务被 `killed`**（`task_updated{killed}` + `task_notification{stopped}`），这是 stdin 关闭的后果，也正是仓库里“持有 stdin 等待后台工作”的 per-run 做法要避免的。**因此本次只能证明“事件形态一致”，不能证明仓库里 per-run 的持有逻辑下事件时序一致。**

### 1.3 Workflow、cron、ScheduleWakeup（实测）

一次流式输入运行，让主代理创建每分钟 cron、60 秒后的唤醒、并启动一个最简 Workflow：

| 对象 | 是否有 `task_*` 事件 | 观察到的形态 |
|---|---|---|
| **Workflow** | **有** | `task_started{task_type:"local_workflow", workflow_name:"simple-workflow-ok", description}`；`task_progress` 的 `description` 是步骤标签（如 `Say OK: say-ok`），带 `summary`（2 条）；`task_updated{completed}`；`task_notification{completed, summary}` |
| **CronCreate** | **无** | 只有 `tool_use` 与 `tool_result` 文本：“Scheduled recurring job d5d51903 (Every minute). Session-only … Auto-expir…” |
| **ScheduleWakeup** | **无** | 只有 `tool_result` 文本：“Next wakeup scheduled for 20:47:00 (in 110s). Nothing more to do this turn — the harness re-invokes you when the wakeup…” |

cron 与唤醒到点后各自开启一个**没人输入的回合**（流里表现为一条 `system/init`，随后 `assistant` 与 `result`，约 t=100s 与 t=135s）。**触发它的提示词没有出现在 SDK 流里。**

在 JSONL 里这两类回合的用户行是：`{"type":"user","message":{"content":"<原提示词>"},"isMeta":true,"promptSource":"sdk"}`，前面有 `queue-operation enqueue`，**没有 `origin` 字段**。对比：Monitor/后台任务完成的用户行带 `origin:{kind:"task-notification"}`；跨会话消息带 `origin:{kind:"peer",…}`。

> 含义一：**计划任务不是 Task**，它没有事件流，只能由 `CronCreate/CronDelete/ScheduleWakeup` 的工具调用与结果、以及 Stop hook 的 `session_crons` 推出。
> 含义二：**cron/唤醒触发的回合在转写层面与“系统注入的元消息”不可区分**；而历史读取按 `isMeta` 一律丢弃这些行，所以刷新后你只看到助手回复，看不到是什么触发了它。

### 1.4 `paused` 的含义（推断，未实测）

SDK 的 `task_updated.patch.status` 含 `paused`。对 CLI 二进制做字符串检索，发现 `totalPausedMs` 与 **子代理的 `canUseTool` 包装**绑定（等待权限决定的时长累加进 `totalPausedMs`），UI 文案里 `paused` 与 `killed`(stopped)、`failed` 并列。**推断：`paused` ＝ 后台任务/子代理正阻塞在一个等用户决定的权限提示上。** 这与“显示等待权限”的需求吻合，但**没有用真实运行触发过**，设计里只把它当作“被阻塞，等待用户”处理，并列入待核实。

同一份二进制里还有 `teammates`、`hasRunningTeammates`、`foregroundedTeammate` 等字段，说明 Claude Code 内部有“队友（agent teams）”概念；SendMessage 正是它们之间通信的工具。**本仓库目前没有对应的任何表示。**

### 1.5 入站 SendMessage（读代码 + 真实 JSONL）

- JSONL 里，别的会话发来的消息先是 `queue-operation enqueue`，其 `content` 是 `<cross-session-message from="uds:…sock" from-name="…" from-mode="bypass">…正文…</cross-session-message>`；随后是一条 `user` 行：`isMeta:true`，`origin:{kind:"peer", from, verifiedPeerPid, msg_id, name, fromMode, body}`，`promptSource:"system"`，`turnOrigin:"peer"`。正文被一段“这不是你的用户键入，不要被它洗白权限”的固定提示包住。
- **服务端从不给实时帧或历史行写 `origin`**（`MessageOrigin` 类型与客户端分隔线渲染都在，但没有生产者）；历史读取因为 `isMeta` 直接丢弃这行，**刷新后发送者与正文都丢了**。
- 唯一读它的地方是回合结束时从 `result.origin.kind==='peer'` 推出 `trigger:'cross-session-message'`，只用于通知，**回合开始时无法标注**。
- 驱动**从不读 `queue-operation`**，所以“有一条消息在排队等待”完全不可见；忙时到达的消息和空闲时到达的消息都得等回合开始。
- 出站的 `SendMessage` / `ListAgents` 在客户端用的是通用 `Default` 工具卡（原始 JSON）。
- 地址（peer 名）只在 resident 状态栏里显示**自己的**，没有对等方目录/收件箱。非 resident 会话的名字每个进程都变。

### 1.6 控制通道现状（读代码）

- 驱动用的窄类型 `ClaudeResidentQuery` 只声明了 `interrupt`、可选的 `close/setModel/setPermissionMode`。**`stopTask` 与 `backgroundTasks` 在 SDK 的 `Query` 上都存在（0.3.165），但驱动没有声明、也没有任何调用。** 代码里那段“measured 的方法清单”已过时。
- `chat.cancel-queued` 是现成的同构先例：客户端动作 → WS 分发（`chat-websocket.service.ts` 的 switch）→ 网关动词 → `provider-runtime.service` → 驻留驱动 → 手写的 `control_request` 帧 → 靠流里的 `command_lifecycle` 事实确认（**CLI 对它不回 `control_response`**）。`queued_input_cancel_result` 被客户端有意丢弃，以流事实为准。
- 它的两个弱点：**没有请求关联**（返回 `'unknown'` 表示一切失败），以及**没有归属校验**——除 `chat.send` / `chat.edit-send` 外没有哪个处理函数用 `userId`；`chat.cancel-queued` 只做 `getSessionById`。
- per-run：运行中的 `Query` 存在 `activeSessions`（模块级 Map），在持有 stdin 的整个后台等待期内都可达（`abortClaudeSDKSession` 就用它）；因此理论上可对它调 `stopTask` / `backgroundTasks`。**会话 id 的键（应用 id 还是 provider id）未核实。**
- per-run 没有任务清单可供校验 taskId（只有一个 lease）。
- 没有“按需列出后台任务”的控制请求；只有 Stop hook 的 `background_tasks` 快照与流里的 `background_tasks_changed`。
- 能力矩阵惯例：`ResidentFeatures.cancelQueuedInput: false`（“未验证”），新能力应同样**默认 false**。
- 可复用的测试夹具：`claude-resident-busy-input.test.ts`（真 CLI 对接 mock `/v1/messages`，含 `holdFrom/releaseHeld`、假 socket、`waitFor`）、`claude-resident-idle.test.ts`（E9 真实帧形态）、`chat-edit-send.test.ts`（WS 处理函数用网关桩）。

---

## 2. 现状架构

```plantuml
@startuml
title 现状：四个互不相干的“忙”来源，没有一个带“我还活着”的证据

skinparam componentStyle rectangle

package "服务端" as S {
  [Run Registry\n(内存 Map, 每 run 一份 seq)] as RR
  [SessionHostManager\nbinding.leases {kind,id}] as HM
  [GET /providers/sessions/running\n(仅 sessionId/provider/startedAt)] as R1
  [GET /api/session-hosts] as R2
  [WS: complete / chat_subscribed / status(token_budget)] as W
  [WS 协议级 ping/pong 30s\n(浏览器 JS 看不到)] as PING
}

package "客户端" as C {
  [processingSessions 表\n(本地打标 + 帧 + 5s 轮询)] as PS
  [ActivityIndicator\n轮换文案 + 本地时钟计时] as AI
  [发送按钮停止态 / 侧栏运行点] as BTN
  [useSessionHosts\n1s 轮询, 失败保留旧快照] as UH
  [ResidentStatusBar\n按 kind 数个数] as SB
  [WebSocketContext\nisConnected: 聊天模块不读] as WSC
}

RR --> W
RR --> R1
HM --> R2
R1 --> PS : 失败只写日志
W --> PS : 仅 complete/应答能清除
R2 --> UH
UH --> SB
PS --> AI
PS --> BTN
WSC ..> AI : 无连接
PING ..> C : 不可见

note bottom of PS
  服务端宕机：没有 complete、没有应答、轮询失败 →
  条目永久保留，本地计时器一直走，停止按钮静默无效。
end note
@enduml
```

---

## 3. 缺口

| # | 缺口 | 原因 |
|---|---|---|
| A1 | `Thinking...` 在服务端不可达时仍显示并计时 | 无心跳/新鲜度；`isConnected` 被忽略；失败的轮询不改变状态 |
| A2 | 标签无信息：不知道在思考、写作、跑哪个工具、等权限 | 服务端不发带文本的 status；标签按时间轮换 |
| A3 | 连接断开时点“停止”无效且无提示 | `sendMessage` 在 socket 关闭时只 warn |
| A4 | 状态栏与活动指示可互相矛盾；失败的轮询让状态栏也陈旧 | 两个真相来源，且都保留旧值 |
| B1–B8 | 看不到后台任务清单/进度/耗时/最近动作，不能停，不知道会话还有活 | 见 `claude-background-work-observability.md` §2 |
| C1 | 看不到有哪些 cron / 唤醒在等、下次何时触发 | 没有 `task_*` 事件；服务端只对 `CronCreate/CronDelete` 做租约推断，没有记录 cron 表达式/提示词/下次时间；`ScheduleWakeup` 完全未处理 |
| C2 | cron/唤醒触发的回合没有来源；刷新后连触发它的提示词都看不到 | 流里没有该提示词；转写里是无 `origin` 的 `isMeta` 行，历史读取丢弃 |
| D1 | 看不到别的会话发来的消息：不知道谁发的、说了什么；忙时到达的看不到在排队 | 服务端不写 `origin`；`isMeta` 行被历史丢弃；驱动不读 `queue-operation` |
| D2 | 发送出去的 `SendMessage` 是一坨原始 JSON | 没有该工具的渲染配置 |
| D3 | 不知道自己能被谁寻址、有哪些对等方 | 只有自己的地址显示在状态栏 |
| E1 | 不能停某个任务，不能把前台任务转后台 | 驱动没有声明/调用 `stopTask`、`backgroundTasks` |
| E2 | 既有控制动词没有请求关联、没有归属校验 | `chat.cancel-queued` 的设计取舍 |

---

## 4. 目标架构

### 4.1 设计原则

| # | 原则 | 取代的现状 |
|---|---|---|
| U1 | **一个真相源**：服务端权威的 `SessionActivity`；客户端所有“忙/闲”提示都是它的投影 | 四个来源各说各话 |
| U2 | **活动 = 回合 ⊕ 任务 ⊕ 计划 ⊕ 入站消息 ⊕ 连接**，一个坞表达全部 | 两处互不相干的提示 |
| U3 | **诚实**：不知道就说不知道。每一个“进行中”的声明都必须有**新鲜度证据**（心跳/`rev`），过期即降级为“不确定/连接中断”，**不用本地时钟编造进度** | 本地计时器永远走 |
| U4 | **推送与快照同源**：WS 增量带 `rev`，REST 快照给晚加入者，`rev` 不连续则重拉 | 1 秒/5 秒轮询，失败保留旧值 |
| U5 | **控制显式、以事件确认**：停止/转后台是命令，结果以 `SessionActivity` 的变化为准，界面不乐观改状态；命令带 `requestId` 与归属校验 | `cancel-queued` 无关联、无校验 |
| U6 | **转写仍是 CLI 的权威记录**：对转写只做**投影层**的折叠与标注，不改写历史 | — |
| U7 | **来源标注带置信度**：能确定就确定（读 JSONL 的 `origin`），只能推断就标“推断” | 回合来源要么没有要么“未知” |
| U8 | **默认 false 的能力**：新控制动词先在能力矩阵里置 false，实测后再开 | — |

### 4.2 概念模型

```plantuml
@startuml
title SessionActivity 概念模型

class SessionActivity {
  sessionId
  bootId : string        <<服务端进程标识; 变化 = 一切未知>>
  rev : int              <<会话级单调版本>>
  asOf : ts              <<服务端生成时刻>>
  turn : Turn
  tasks : Task[]
  schedules : Schedule[]
  inbox : InboundMessage[]
  host : HostInfo?       <<resident: 地址/pid/运行时长>>
}

class Turn {
  phase : idle | sending | thinking | writing | tool | awaitingPermission | compacting
  toolName? : string
  startedAt? : ts
  canInterrupt : bool
  trigger? : Trigger     <<回合由谁触发: 人 / 后台任务 / cron / 唤醒 / 对等会话>>
}

class Task {
  taskId, kind (subagent|shell|monitor|workflow|other)
  state : running | blocked | completed | failed | stopped
  blockedOn? : permission   <<paused 的推断含义>>
  description, command?, agentType?, workflowName?
  toolUseId?, parentTaskId?
  isBackgrounded
  startedAt, endedAt?
  usage?, lastToolName?, stepLabel?, summary?
  outputRef?
}

class Schedule {
  scheduleId
  kind : cron | wakeup
  spec : "每分钟" / cron 表达式 / 绝对时间
  prompt? : string
  nextFireAt? : ts
  recurring : bool
  expiresAt? : ts
  source : "tool-call" | "stop-hook"
}

class InboundMessage {
  msgId
  from : { name, address, mode }
  receivedAt
  state : queued | delivered | answered
  preview : string           <<正文前若干字符>>
}

class Trigger {
  kind : human | task | cron | wakeup | peer | unknown
  ref? : taskId | scheduleId | msgId
  confidence : certain | inferred
}

SessionActivity *-- Turn
SessionActivity *-- "0..*" Task
SessionActivity *-- "0..*" Schedule
SessionActivity *-- "0..*" InboundMessage
Turn --> Trigger

note right of Schedule
  cron/唤醒**不是 Task**：没有 task_* 事件。
  来源是 CronCreate/CronDelete/ScheduleWakeup 的
  tool_use+tool_result 与 Stop hook 的 session_crons。
end note
note right of Task
  Workflow 是 Task（实测有 task_*）：
  kind=workflow，stepLabel 取 task_progress.description。
end note
@enduml
```

### 4.3 服务端组件

```plantuml
@startuml
title 服务端：Activity Aggregator 是唯一把各来源合成 SessionActivity 的地方

skinparam componentStyle rectangle

package "输入（已有，仅被消费）" as IN {
  [SDK 流: stream_event / assistant / tool_progress /\nsystem task_* / init / result] as S1
  [Stop hook: background_tasks[], session_crons[]] as S2
  [Run Registry: run 起止, complete] as S3
  [权限请求/应答] as S4
  [JSONL 追尾: queue-operation, 带 origin 的 user 行] as S5
  [CronCreate / CronDelete / ScheduleWakeup\n的 tool_use + tool_result] as S6
}

package "Activity Aggregator" as AG {
  [Turn Tracker\n(phase, toolName, 触发者)] as TT
  [Task Reducer\n(task_* → Task, 与 Stop hook 校准)] as TR
  [Schedule Tracker\n(从工具调用/Stop hook 建表, 计算 nextFireAt)] as SCH
  [Inbox Tracker\n(queue-operation 的 cross-session-message)] as IB
  [Trigger Resolver\n(回合开始时判定来源 + 置信度)] as TG
  [ActivityStore\n(rev, bootId, 合并为 SessionActivity)] as ST
  [Heartbeat\n(每 5s 带 bootId+rev 的帧)] as HB
}

package "输出" as OUT {
  [WS: activity.snapshot / activity.patch / activity.heartbeat] as W
  [REST: GET /sessions/:id/activity] as R
  [Lease Deriver\n由 tasks+schedules 推出租约(保持现有行为)] as LD
}

S1 --> TT
S1 --> TR
S2 --> TR
S2 --> SCH
S3 --> TT
S4 --> TT
S5 --> IB
S5 --> TG
S6 --> SCH
TT --> TG
SCH --> TG
IB --> TG
TT --> ST
TR --> ST
SCH --> ST
IB --> ST
TG --> ST
ST --> W
ST --> R
ST --> LD
HB --> W

note bottom of ST
  不新增“来源”，只合并既有来源。
  与文本流式设计同一纪律：稳定 key、幂等归约、
  rev 不连续即重拉快照。
end note
@enduml
```

### 4.4 真实性：心跳、新鲜度与连接状态

```plantuml
@startuml
title 真实性：客户端只相信“新鲜的证据”，没有证据就降级

participant "服务端\nActivity Aggregator" as S
participant "客户端 Activity Store" as C
participant "活动坞" as D

== 正常 ==
S -> C : activity.snapshot{bootId=B1, rev=40}
loop 每 5 秒
  S -> C : activity.heartbeat{bootId=B1, rev=40}   <<即使没有变化也发>>
end
C -> C : lastSeenAt = now
C -> D : 渲染  “● 思考中 · 12s”\n(12s 由 turn.startedAt 与服务端 asOf 推算)

== 服务端消失 ==
note over C : 15 秒没有任何帧\n(阈值待定, 约 3 个心跳)
C -> C : liveness = unreachable
C -> D : 渲染  “○ 连接中断 · 重连中… · 最后更新 18s 前”\n**不再显示 Thinking, 不再走计时, 停止按钮置灰并说明**

== 重连 ==
C -> S : 重连 + chat.subscribe
S --> C : activity.snapshot{bootId=B2 ≠ B1, rev=1}
C -> C : bootId 变了 ⇒ 丢弃所有本地“进行中”假设\n以快照为准
alt 快照里 turn.phase = idle 且无任务
  C -> D : 空闲 (坞收起)
else 仍有活动
  C -> D : 显示真实活动
end

== 发送时 ==
C -> D : phase = sending  (本地, 带 5s 超时)
C -> S : chat.send
S --> C : activity.patch{turn.phase=thinking}
note over C,D #FFEECC
  5 秒内没有任何回应 ⇒ 坞显示“发送失败/服务端无响应”，
  而不是继续显示 Thinking。
end note
@enduml
```

要点：

- **心跳是带 `bootId` 与 `rev` 的业务帧**（JS 可见），不是 WS 协议 ping。`bootId` 变化即服务端重启，客户端据此丢弃一切本地假设。
- **新鲜度阈值**是一个需要定的数字：太小在慢网络误报，太大又回到“假”。建议先 3 个心跳间隔（15 秒），并让它可配置。
- **时间显示**：已用时间由 `turn.startedAt` 与服务端 `asOf` 推算，**不在客户端本地自增**；连接中断时冻结并标注“最后更新 N 秒前”。
- 这一层**不依赖**任务/计划/入站的任何新数据，可单独先行。

### 4.5 回合的真实阶段（取代轮换文案）

`Turn.phase` 由服务端从真实信号推出，而不是靠时间：

| phase | 信号（均已存在于流里） |
|---|---|
| sending | 客户端本地：已发 `chat.send`，尚无任何应答 |
| thinking | `system/thinking_tokens`（实测一次运行 215 条，服务端目前忽略）、或已开始但还没有文本/工具的回合 |
| writing | `stream_delta` 在流 |
| tool | `assistant` 的 `tool_use` 已发出且尚无对应 `tool_result`；`toolName` 取自 `tool_use.name`（`tool_progress` 若出现可带耗时，**实测未出现**） |
| awaitingPermission | 已有的 `permission_request` 帧 |
| compacting | 已有的 `system/status` / `compact_boundary` |

### 4.6 活动坞的标题优先级与布局

```plantuml
@startuml
title 活动坞标题：按优先级只说一件最重要的事，其余作为次级摘要

[*] --> Unreachable : 无新鲜证据
[*] --> Evaluate
Unreachable : ○ 连接中断 · 重连中… · 最后更新 18s 前
Evaluate --> AwaitingPermission : turn.phase = awaitingPermission\n或有 blocked 的任务
Evaluate --> InTurn : turn.phase ∈ {sending, thinking, writing, tool, compacting}
Evaluate --> BackgroundOnly : 回合空闲但有未终结 Task
Evaluate --> ScheduledOnly : 无 Task, 但有 Schedule
Evaluate --> Hidden : 全空闲
AwaitingPermission : ◐ 等待你的决定 · <谁>
InTurn : ● <阶段/工具名> · <已用时>
BackgroundOnly : ◉ 空闲 · 后台 N 个
ScheduledOnly : ⏰ 空闲 · 下次 14:03
Hidden : (坞收起, 仅留入口)

note right of InTurn
  次级摘要恒在标题右侧：
  ▸ 2 个后台任务 · 1 个定时 · 1 条待处理消息
  点击展开成面板。
end note
@enduml
```

```plantuml
@startsalt
title 活动坞（展开态）线框：桌面与移动共用同一数据，布局不同
{+
  { <b>● 运行 Bash · 12s</b> | . | [ 停止本回合 ] | [ 收起 ▲ ] }
  ----
  { <b>后台任务 (2)</b> }
  { ◉ 子代理 · general-purpose · "跑 sleep 12" | 运行中 · 35s · 10.4k tok · 最近 Bash | [ 停止 ] }
  { ◉ Workflow · simple-workflow-ok | Say OK: say-ok | [ 停止 ] }
  ----
  { <b>计划 (2)</b> }
  { ⏰ 每分钟 · "cron-ok" | 下次 20:47:00 | [ 取消 ] }
  { ⏰ 唤醒 · "wakeup-ok" | 20:47:00 (in 110s) | [ 取消 ] }
  ----
  { <b>消息 (1)</b> }
  { ✉ 来自 会话-5d88 (bypass) | 排队中 | “请在收到后 30 秒内回复…” }
  ----
  { <small>resident · uds:/run/…/2690307.sock [复制] · pid 2690307 · [ 关闭进程 ]</small> }
}
@endsalt
```

**与现有表面的关系**：

- `ActivityIndicator`（桌面页签/移动内联行）→ **并入活动坞**，不再有独立的轮换文案。
- `ResidentStatusBar` 的“忙/闲/计数”→ 由坞的标题与任务/计划计数取代；它剩下的内容（地址与复制、pid、起停/关闭）保留为坞展开面板底部的一行。
- 侧栏“运行中”视图 → 读同一个 `SessionActivity` 的摘要，从“会话列表”升级为“会话 → 持有什么”。
- 发送按钮的停止态 → 读 `turn.canInterrupt` 与连接状态；**连接中断时置灰并解释原因**，而不是静默丢弃。

### 4.7 计划任务（cron / ScheduleWakeup）

- **来源**：`CronCreate` 的 `tool_use.input`（表达式、提示词）加其 `tool_result`（“Scheduled recurring job <id> (…)”）；`ScheduleWakeup` 的 `tool_use.input`（延迟、提示词）加其 `tool_result`（“Next wakeup scheduled for HH:MM:SS (in Ns)”）；`CronDelete`；以及 Stop hook 的 `session_crons` 作为**权威校准**。现有的 `inferHeldWork` 只处理 `CronCreate/CronDelete`，需要补上 `ScheduleWakeup`。
- **nextFireAt**：cron 由表达式计算；唤醒由工具结果里的绝对时间给出。**cron 表达式的完整语法与时区**需要核实（实测只用了“每分钟”）。
- **取消**：SDK 没有“删除 cron”的控制请求（核对类型联合里没有）。可行做法是**向模型发一条用户消息让它调用 `CronDelete`**——这是“请求”而不是“控制”，结果以 Stop hook 的 `session_crons` 变化确认。是否接受这种间接语义，需要裁定（见 §6）。
- **触发标注**：见 §4.8。

### 4.8 回合来源：Trigger Resolver

没人输入的回合的触发提示词不在 SDK 流里，所以来源只能**事后读 JSONL 或事前推断**。

```plantuml
@startuml
title Trigger Resolver：回合开始时判定来源，并给出置信度

participant "SDK 流" as S
participant "Trigger Resolver" as R
participant "JSONL 追尾\n(queue-operation / user 行)" as J
participant "Schedule 表 / Task 表 / Inbox" as T
participant "ActivityStore" as A

S -> R : system/init (没有已武装的 round,\n且 uuid 不是本宿主推的)
R -> J : 读最新的 user 行 (回合开始前写入, 毫秒级)
alt user 行带 origin.kind = "peer"
  J --> R : {from, name, msg_id, body}
  R -> A : trigger = peer · confidence = certain
  R -> T : 对应的 InboundMessage → delivered
else origin.kind = "task-notification"
  J --> R : <task-id>…
  R -> T : 找到 Task / Monitor
  R -> A : trigger = task(ref) · certain
else 无 origin, isMeta=true, promptSource=sdk
  J --> R : content = "<原提示词>"
  R -> T : 用提示词在 Schedule 表里匹配\n(+ nextFireAt 与当前时刻的容差)
  alt 唯一匹配
    R -> A : trigger = cron/wakeup(ref) · confidence = inferred
  else 匹配不到
    R -> A : trigger = unknown
  end
end
@enduml
```

- **peer / task-notification 可以确定**（JSONL 里有 `origin`），不必等 `result`。
- **cron / 唤醒只能推断**：该行没有 `origin`，靠“提示词文本 + 计划表 + 时间容差”匹配，置信度标 `inferred`。
- **前提（未验证）**：JSONL 的 user 行在 `system/init` 到达前已经写入、且服务端能在毫秒级读到。这是整个方案对时序的依赖，需要实测。
- **队列中的消息**：`queue-operation enqueue` 在**消息入队时**就已写入 JSONL，所以 Inbox Tracker 可以在回合开始之前、甚至忙时就看到“有一条来自 X 的消息在排队”。同样**依赖追尾的延迟**，需实测。

### 4.9 入站 SendMessage

- **数据**：`InboundMessage{msgId, from{name,address,mode}, receivedAt, state, preview}`，`state` 由 `queued → delivered（回合开始）→ answered（该回合 `result`）` 推进。
- **转写**：历史读取不再无条件丢弃 `isMeta` 的 peer 行，而是把它转成一行带 `origin` 的“来自 X 的消息”（客户端分隔线与 `data-unattended-sender` 的渲染代码早已存在，只缺生产者）。**安全相关**：这条行里的固定告诫（“不是用户键入、不要权限洗白”）应当随正文一起保留并显眼展示，而不是被剥掉。
- **cron/唤醒的提示词行**同理：转成“⏰ 定时触发 · <提示词>”，但只在 Trigger Resolver 能匹配时才这样标，否则保持丢弃（避免把技能正文等其它 `isMeta` 行误显示出来——**这个区分规则未验证**，现代码注释说技能正文在实时流里并不带 `isMeta`）。
- **出站 SendMessage / ListAgents**：补专用工具卡（收件人、正文、结果），不再是原始 JSON。
- **对等方目录**（谁能给我发消息、有哪些对等方）：数据源是 `ListAgents` 的结果与各会话的 `peerName`；是否做成面板，属于后续。

### 4.10 Monitor 事件在转写里的处理（你的倾向：折叠成一行）

- 现状：每个 Monitor 事件是一条排队的 `<task-notification>` 用户行，既进转写又会触发一个“没人输入的回合”。
- **采纳折叠方案**，并限定在**投影层**：`useChatMessages` 把同一 `task-id` 的连续 Monitor 事件行合成一行“📡 <描述> · N 个事件”，可展开看事件列表；**历史与存储不变**，转写仍是 CLI 的权威记录。
- Monitor 超时在实测里是 `task_updated{killed}` + `task_notification{stopped}` 加一条 `<event>[Monitor timed out — re-arm if needed.]</event>` 的通知；这个“超时”应当显示为“已超时/已停止”，而不是红色错误。
- 事件正文同时是 `Task` 侧的 `TaskEvent`（有上限的环形保留），在坞的任务详情里查看。

### 4.11 控制通道

```plantuml
@startuml
title 控制通道：与 chat.cancel-queued 同构，但补上请求关联与归属校验

participant "客户端 (坞)" as C
participant "WS 处理函数" as H
participant "provider-runtime" as P
participant "宿主驱动 / per-run 运行时" as D
participant "Claude CLI" as CLI
participant "Activity Store" as A

C -> H : chat.stop-task{sessionId, taskId, requestId}
H -> H : 校验: 会话存在 + **归属** (userId)\ntaskId ∈ ActivityStore.tasks (未终结)
alt 校验失败
  H --> C : control_result{requestId, result:"unknown-task"|"forbidden"}
else 通过
  H -> P : stopTask(provider, sessionId, taskId)
  P -> D : resident: query.stopTask(taskId)\nper-run: activeSessions[...].instance.stopTask(taskId)\n(Promise.race 限时)
  D -> CLI : control_request stop_task
  D --> H : "requested" | "unsupported" | "timeout" | "error"
  H --> C : control_result{requestId, result}\n**仅表示“请求已受理”**
  CLI -> D : system/task_notification{status:"stopped"}
  D -> A : Task.state = stopped
  A -> C : activity.patch (任务变为 stopped)\n**UI 以此为准, 不乐观改状态**
end
@enduml
```

动词（草案）：

| 动词 | 语义 | 备注 |
|---|---|---|
| `chat.stop-task` | `Query.stopTask(taskId)` | 终态由 `task_notification(stopped)` 确认；对已结束的任务应返回 `unknown-task` 而不是静默成功 |
| `chat.background-task` | `Query.backgroundTasks(toolUseId)` | **只暴露带 `toolUseId` 的单任务版本**；不带参数会把所有前台任务一起转后台，易误伤 |
| `chat.abort`（已有） | 中断本回合 | 保持；连接中断时在 UI 上置灰并说明 |
| `chat.cancel-queued`（已有） | 撤回排队的用户输入 | 补 `requestId` 与归属校验，作为同族动词一并规整 |

细节：

- **归属校验**是新增的：现有 WS 处理函数除 `chat.send` / `chat.edit-send` 外都不用 `userId`。这个应用看起来是单租户、在 WS 升级时鉴权，但新的“杀东西”的动词不应继续沿用“没有校验”的先例。需要裁定最小做法（见 §6）。
- **时限**：类型化的 `Query` 动词自己没有超时，必须 `Promise.race`，否则一个不返回的 `stopTask` 会挂住 WS 处理函数（分发器会把错误吞成 `INTERNAL_ERROR`）。
- **能力矩阵**：`ResidentFeatures` 新增 `stopTask`、`backgroundTask`，**默认 false**，实测（E 系列）后再开。
- **类型化调用优于手写 `writeRaw` 帧**：`stopTask` 会 resolve/reject，不像 `cancel_async_message` 那样没有应答、只能靠流事实。
- **接入点**（读代码的草图）：在 `ClaudeResidentQuery` 加可选 `stopTask?` / `backgroundTasks?`；`ClaudeResidentDriver` 加同名方法（查 `liveStateFor`、校验 `heldBackgroundTasks`）；`provider-runtime.service.ts` 加动词并按 `abort` 的分叉走 resident/per-run；`chat-websocket.service.ts` 加 `case` 与处理函数；per-run 在 `claude-runtime.provider.js` 的 `abortClaudeSDKSession` 旁加两个导出，**不得**调用 `releaseInput` / `removeSession`（它们是为了结束 run，而这里不能结束 run）。

---

## 5. 与既有设计的关系

- **文本流式渲染（blockKey）**：无冲突。坞读的是 `SessionActivity`，不读转写行；`Turn.phase=writing` 只是“有 `stream_delta` 在流”，与块级归约无关。
- **`gap-chat-subscribe-cursor-needs-run-identity`（runId 游标）**：与坞的 `bootId` / `rev` 是相邻但不同的概念——前者管“重连后补发帧”，后者管“活动状态的新鲜度与重同步”。两者可并存；活动坞的 `rev` 不依赖 `seq`。
- **租约**：由 `SessionActivity` 的任务与计划**推出**（Lease Deriver），**行为不变**（静默关闭上限、`quietCeilingMs`、Stop hook 校准等都保持），先并存对照再收敛。
- **后台工作观察文档**：本文的 `Task` 与它一致；本文新增的是 `Schedule`、`InboundMessage`、`Turn`、`Trigger`、连接状态与控制面。

---

## 6. 需要先裁定的设计问题

1. **新鲜度阈值与心跳频率**：5 秒心跳、15 秒判定不可达是否可以接受？是否要在移动网络/后台标签页放宽？
2. **取消 cron/唤醒的语义**：没有直接控制请求，只能“请模型调用 `CronDelete`”。这是请求而非命令——是否接受，还是只展示、不提供取消？
3. **归属校验的最小做法**：沿用“应用是单租户”的前提只校验会话存在，还是给新动词加 `userId` 校验并顺带补齐 `cancel-queued`？
4. **`isMeta` 行的取舍**：历史读取要不要开始显示 peer 消息与（可匹配的）cron/唤醒提示词行？如何避免误显示技能正文等其它 `isMeta` 行？
5. **JSONL 追尾的时序依赖**：Trigger Resolver 与 Inbox Tracker 假定能在毫秒级读到刚写入的行；若做不到，退路是只在回合结束后再标注（失去“排队中”可见性）。
6. **per-run 与 resident 的一致性**：per-run 没有任务清单可校验 `taskId`，只能依赖 Aggregator 的 Task 表——需要 per-run 路径也完整消费 `task_*`（实测证明事件形态一致，但**持有 stdin 的真实 per-run 时序未测**）。
7. **`paused` 的真实含义**：见 §1.4，需用“后台子代理遇到权限提示”的真实运行核实。
8. **对等方目录是否纳入本期**：只做入站消息可见，还是同时做收件箱/目录。
9. **一个会话多个客户端**：`rev` 是会话级，各客户端各自持有游标；命令的 `requestId` 需要按连接隔离。

---

## 7. 分阶段路线（建议，尚未立 task）

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **P0 真实性** | 服务端心跳帧（`bootId`+`rev`）；客户端新鲜度与连接状态；`ActivityIndicator` 在不可达时降级、不再本地计时、停止按钮置灰并说明；发送超时提示 | 无 | 低；**可独立先行**，并立刻解决“服务器挂了还显示 Thinking” |
| P1 回合真实阶段 | `Turn.phase`/`toolName`（thinking_tokens、tool_use 配对、permission_request），取代轮换文案 | P0 | 低 |
| P2 Activity Aggregator + 快照/推送 | 合并 Task/Schedule/Turn 为 `SessionActivity`；REST 快照 + WS 增量 | P0 | 中：与现有租约并存 |
| P3 活动坞 UI | 并入 `ActivityIndicator`、`ResidentStatusBar` 的忙闲部分；展开面板；侧栏运行视图 | P2 | 中：版面（桌面浮层/移动内联）要重做 |
| P4 控制面 | `chat.stop-task`、`chat.background-task`，能力矩阵、校验、限时；规整 `cancel-queued` | P2；先做 E 系列实测 | 中 |
| P5 计划与入站 | Schedule Tracker、Trigger Resolver、Inbox Tracker；历史对 peer/cron 行的显示；SendMessage 工具卡 | P2；先验证 JSONL 追尾时序 | 高：依赖 §6.5 |
| P6 转写投影 | Monitor 事件折叠；通知行增强 | P2 | 低 |

**P0 与其余完全解耦**，建议单独立项。它不需要任何关于任务/计划/入站的新数据，却是用户当前最明确的痛点。

## 8. 本次未验证的内容

- 全部“读代码”结论未运行验证；尤其是 §1.1 的各条清除路径、`activeSessions` 的会话 id 键、`stopTask`/`backgroundTasks` 在真实 resident 控制通道上的行为。
- **`paused` 没有用真实运行触发过**，含义是由二进制字符串推断的。
- cron 只测了“每分钟”；其表达式语法、时区、`Auto-expir…`（自动过期）的具体时限、`ScheduleWakeup` 在 Stop hook 的 `session_crons` 里是否出现，都没有测。
- Workflow 只测了一个单步最简脚本；多步、失败、被停止、带权限提示的形态没测。
- cron/唤醒触发的提示词确实没有出现在 SDK 流里（本次运行未见），但**只测了一次**。
- JSONL 追尾的延迟（回合开始前行是否已可读）**没有测**。
- `isMeta` 行在**实时流**里是否带标记没有核实（代码注释说技能正文不带）。
- per-run 的真实持有逻辑下 `task_*` 的时序没有测（本次用的是字符串 prompt，结果被 stdin 关闭杀掉）。
- 线协议与字段名仅是草案；没有做体积或兼容性评估。
