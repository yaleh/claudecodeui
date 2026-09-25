# 会话生命周期统一与 Claude 常驻会话模式 Proposal

*2026-09-25 · 状态：草案，未实施*

## 摘要

本提案做两件事：

1. **统一会话生命周期管理**。新增一个宿主层（session host），统一回答所有 provider（Claude、Codex、Cursor、OpenCode）的三个问题：进程为什么还活着、什么时候关、怎么关。现有的每轮一个进程模式（下称 **per-run**）完整纳入这一层。
2. **给 Claude 增加第二种运行模式：常驻（resident）**。常驻会话的 `claude` 子进程在两轮之间不退出，stdin 一直由服务端握着，用户的每条消息都推进同一个进程。这样 `CronCreate`、`ScheduleWakeup`、`Monitor`、后台 subagent 和跨会话 `SendMessage` 都能跨轮工作，会话也有了稳定的进程地址。

已定原则：

1. 服务重启后常驻进程**不自动恢复**。
2. 常驻会话**默认放开权限**（`bypassPermissions`），以便无人值守时也能运行。
3. 常驻会话**不限数量**，但长期不活动的会话自动关闭。
4. per-run **完整纳入宿主层**。第一步只做包装，不改变任何现有行为。
5. 宿主与会话按 **1:N** 建模：一个宿主进程可以承载多个会话。Claude 始终是 1:1，但 Codex `app-server`、`opencode serve` 这类多路复用进程可以直接接入。
6. 常驻会话忙时（包括无人轮进行中）收到用户消息，行为**与 Claude Code CLI 一致**：服务端不自行排队，也不拒绝，而是立即写入进程输入，这条消息落在哪一轮由 CLI 决定。

per-run 仍是所有 provider 的默认模式，行为不变。

## 背景与实测读数

### 生命周期现在散落在四处

`IProviderRuntime`（`server/shared/interfaces.ts:30`）只有 `run(command, options, writer, context)` 和 `abort(sessionId)` 两个方法，默认把 `run` 的 promise 当作"这一轮"。各 provider 各自维护活跃表，管理层看不到：

| Provider | 活跃表 | 进程形态 |
|---|---|---|
| Claude | `activeSessions`（`claude-runtime.provider.js`） | 每轮一个 SDK `query()`；启动了后台工作时持有 stdin，静默 30 分钟后释放 |
| Codex | `activeCodexSessions`（`codex-runtime.provider.ts`） | SDK 每轮起一个 `codex exec`；`app-server` 只用于 fork，每次操作起一个进程 |
| Cursor | `activeCursorProcesses` | 每轮 spawn `cursor-agent` |
| OpenCode | `activeOpenCodeProcesses` | 每轮 spawn `opencode` |

轮次层已经统一：`chatRunRegistry` 按 app session 记录"是否有 run 在跑"，支持无连接的写入者（定时消息即如此），并按 `seq` 回放。

**Claude 其实已经有"进程比轮次活得长"的第三种状态。** `result` 到达时，客户端已经收到 `complete`；但持有期间 `for await` 循环还在继续，`run()` 的 promise 要等进程退出才结束。这段持有期只存在于 Claude runtime 内部，管理层既列不出来，也无法手动关闭。

### Claude 现在的进程形态

聊天标签页通过 `@anthropic-ai/claude-agent-sdk`（0.3.165）的 `query()` 驱动 `claude` 二进制，`entrypoint` 为 `sdk-ts`。SDK 用的就是全局安装的那个 `claude.exe`（`CLAUDE_CLI_PATH` 未设置，从 PATH 解析）。

`server/modules/providers/list/claude/claude-runtime.provider.js` 的行为：

- 每次 `chat.send` 调用一次 `query()`，也就是起一个新进程。同一会话 12:45:59 起的 pid 3829233，到 14:15 已不在，换成 14:15:32 起的 pid 1290562；peer 名也从 `claudecodeui-a5` 变成 `claudecodeui-a0`。
- 已有"持有 stdin"机制（`createHeldPromptStream` + `scheduleRelease`）。只有这一轮启动了后台工作（`startsBackgroundWork`：`Monitor`、`ScheduleWakeup`、`CronCreate`、`TaskCreate`、`Workflow`、后台 `Bash`、后台 `Agent`）才持有，**静默 30 分钟**（`BG_WAIT_CEILING_MS`）后释放。
- 新的一轮会**顶替**旧的持有（`getSession(...)?.releaseInput?.()`），旧进程退出。

### 这造成的问题

| 能力 | per-run 下的实际行为 | 依据 |
|---|---|---|
| `Monitor` | 可用，在到期前收到通知 | 实测：历史 sdk-ts 会话 46 次调用中 41 次收到通知 |
| `CronCreate` | 预计最多触发一次；周期大于 30 分钟则不触发；用户一说话就丢 | 代码推导，**未实测**；历史转录中 0 次使用 |
| `ScheduleWakeup` 大于 30 分钟 | 预计不触发 | 代码推导，未实测 |
| `SendMessage` 收 | 仅在某一轮运行或持有期间可达；peer 名和 socket 每个进程都变 | 实测：同一会话先后出现 `quay-ac` → `quay-a8` → `quay-8a`，旧 socket `ENOENT` |
| 空闲会话 | 没有进程，不可达 | 实测：`~/.claude/sessions/` 中查不到该 sessionId |

### SDK 提供的能力（`sdk.d.ts`）

- `Query` 控制方法：`interrupt()`、`setPermissionMode()`、`setModel()`、`setMaxThinkingTokens()`、`applyFlagSettings()`、`stopTask()`、`streamInput()`、`close()`。所以改模型、改思考强度**不需要重启进程**。
- `Options.extraArgs`：可透传 `--name` 等 CLI 参数。
- `Options.spawnClaudeCodeProcess`：可自定义进程启动方式，用于把每个常驻进程放进独立 cgroup scope。
- `permissionMode: 'bypassPermissions'` 要求同时设 `allowDangerouslySkipPermissions: true`。

### 其他 provider 的长驻潜力

- **Codex**：`codex app-server` 讲 JSON-RPC（`thread/start`、`turn/start`、`turn/interrupt` 加通知流），天然是长驻、一个进程多个 thread 的协议。本仓已用它做 fork（`codex-app-server.client.ts`），但每次操作都起一个新进程。
- **OpenCode**：`opencode serve` 是一个进程承载多个会话的 HTTP 服务。
- **Cursor**：暂无已知的长驻入口。

后两种多路复用形态决定了宿主与会话要按 1:N 建模（原则 5）。

### 外部实测（`orchestration/SPEC-web-session-observability-and-control-2026-08-24.md`，本仓未复核）

- stream-json 形态下，stdin 不关，进程就不退出；静默 15.3 分钟后仍能处理新消息。
- 后台 subagent 可以在轮次结束后异步完成并推送结果。
- `-p` / SDK 进程会注册为可寻址会话，`SendMessage` 送达 25/25。

## 目标

1. 所有 provider 的活跃进程由同一个宿主层管理，共用一套状态机、保活理由、关闭原因和列表接口。
2. per-run 纳入宿主层后，现有行为和测试不变。
3. 常驻会话中，`CronCreate`、`ScheduleWakeup`、`Monitor`、后台任务能跨多轮、跨用户消息持续工作。
4. 常驻会话存活期间有**稳定**的 SendMessage 地址，界面可以复制。
5. 无人值守触发的轮次（cron、Monitor 通知、跨会话消息）能执行，并出现在聊天记录中。
6. 用户能看到哪些会话在常驻、为什么还活着，并能手动关闭。
7. 长期不活动的常驻会话自动关闭；常驻进程失控时只杀它自己，不连累服务和别的会话。

## 非目标

- 服务重启后恢复常驻进程或其 cron（原则 1）。
- 持久化 cron（把 `CronCreate` 转成 CloudCLI `scheduled-messages`）。需要"持久定时"的用户用现有的定时消息功能。
- 本期**不实现** Codex、Cursor、OpenCode 的常驻模式。但宿主层接口必须能容纳它们（含 1:N 多路复用）。本期它们以 per-run 宿主身份进入统一的宿主列表。
- Shell 标签页（PTY 里的交互式 CLI）本身的行为变化。唯一改动是常驻会话中不提供 Shell 标签页（§12、§15.9）。
- 依赖 Claude Code 自带的 `--bg`/daemon：本机日志显示它一周内因二进制修改时间变化自重启 613 次，最后一次重启失败（`EACCES`），不适合作为基础。

## 方案

### 1. 分层

```
L1 轮次层   chatRunRegistry（已有，小改）   run = 一轮；来源 user | scheduled | unattended
L2 宿主层   SessionHostManager（新）        宿主状态机、会话绑定、保活理由、策略、关闭原因、空闲回收、停机
L3 进程层   ProcessContainment（新）        spawn 包装（systemd scope、内存上限）、启动时残留清扫
```

- **L1** 只加两样东西：run 的来源字段，以及由宿主主动开 run 的入口（无人轮用）。前端看到的仍是 run 与 `seq`/replay/`complete`，不需要区分进程形态。
- **L2** 是新增的核心，per-run 和 resident 共用，区别只在策略参数（§3）。
- **L3** 与 provider 无关：Claude 通过 `spawnClaudeCodeProcess` 接入；Codex app-server、cursor、opencode 本来就是自己 spawn 进程，可以直接套用。

L2、L3 放进新模块 `server/modules/session-hosts/`，只通过 `index.ts` 暴露。跨模块共享的类型放 `server/shared/types.ts`，driver 接口放 `server/shared/interfaces.ts`（按 `backend-module-standards`）。

### 2. 宿主模型：ProcessHost 1 — N SessionBinding

```ts
type ProcessHost = {
  hostId: string;
  provider: LLMProvider;
  mode: 'per-run' | 'resident';
  state: HostState;                 // 见 §3
  pid: number | null;
  scopeUnit: string | null;         // L3 的 systemd scope，没有则为 null
  startedAt: number;
  bindings: Map<string, SessionBinding>;   // key = appSessionId
  closeReason: HostCloseReason | null;
};

type SessionBinding = {
  appSessionId: string;
  providerSessionId: string | null;
  state: 'idle' | 'busy';
  leases: HostLease[];              // 见 §3
  lastActivityAt: number;
  peerName: string | null;          // 可寻址时的 SendMessage 地址
  detachReason: HostCloseReason | null;
};
```

- manager 维护两个索引：`hostId → ProcessHost` 和 `appSessionId → hostId`。后者用来强制单写者不变量（§13）。
- **保活理由与空闲判定挂在绑定上**：cron 属于某个会话，而不属于某个进程。**宿主在所有绑定都解除后关闭**。
- 解除绑定具体做什么由 driver 决定。Claude 是 1:1，解除即关闭进程；多路复用的 provider 可以只注销这个 thread 或会话，进程只要还有别的绑定就继续运行。
- 本期所有宿主都只有一个绑定：per-run 每轮一个宿主，Claude resident 每个会话一个宿主。

### 3. 保活理由、策略、状态机与关闭原因

**保活理由**（lease）表示"这个会话为什么还需要宿主"：

```ts
type HostLease =
  | { kind: 'turn'; runId: string }
  | { kind: 'background-task' | 'monitor'; id: string }
  | { kind: 'cron'; id: string; recurring: boolean; expiresAt: number }
  | { kind: 'resident-policy' };        // 常驻本身就是一条永久保活理由
```

**策略**把 per-run 和 resident 表达为同一组参数：

| 参数 | per-run | resident |
|---|---|---|
| `supersedeOnNewTurn`：新的用户轮是否顶替旧宿主 | `true`（现行为） | `false` |
| `closeWhenLeasesEmpty`：没有保活理由时是否立即关闭 | `true` | `false` |
| `quietCeilingMs`：静默多久强制关闭 | 30 分钟（现 `BG_WAIT_CEILING_MS`） | `RESIDENT_IDLE_TIMEOUT`，默认 24 小时 |
| 忙时收到新用户消息 | 由前端排队（现行为） | 立即写入进程（原则 6，§8） |

**宿主状态机**（两种模式共用）：

```
starting → idle ⇄ busy → lingering → closing → closed
                    ↑________|
```

- `busy`：存在 `turn` 保活理由。
- `lingering`：轮次已结束，但还有后台、monitor 或 cron 保活理由。现在 Claude 的"持有 stdin"就是这个状态，**第一次变得可观测**。
- 没有其他保活理由时，resident 停在 `idle`（它还有 `resident-policy`），per-run 则直接进入 `closing`。

**关闭原因**（两种模式共用一个枚举，写入 `closeReason` 或 `detachReason` 并在界面显示）：

| 原因 | 适用 | 触发 |
|---|---|---|
| `turn-complete` | per-run | 一轮结束，且没有保活理由 |
| `released` | per-run | 持有期结束（后台工作已回报，或静默到上限） |
| `superseded` | per-run | 新的一轮顶替了持有中的进程 |
| `aborted` | per-run | 用户停止（per-run 下停止即杀进程） |
| `user` | 两者 | 用户点"关闭常驻进程"，或删除、归档会话 |
| `idle` | resident | 空闲超时（§10） |
| `mode-change` | 两者 | 在两种模式之间切换 |
| `rewind` | resident | 编辑已发送的消息，需要带截断点重启（§13） |
| `exited` | 两者 | 进程自行退出或崩溃，附 `detail`：`oom`、`signal` 或 `error` |
| `server-shutdown` | 两者 | 服务正常停止 |

### 4. Provider driver 接口与默认包装

`IProviderRuntime` 不变，新增一个可选 facet，写法与现有的 `fork?`、`rename?` 一致：

```ts
interface IProviderHostDriver {
  /** 起一个宿主进程；多路复用的 provider 可以返回已有的进程。 */
  startHost(init: HostStartInput, sink: HostEventSink): Promise<HostHandle>;
  /** 在宿主上打开一个会话绑定（Claude：与 startHost 同一动作）。 */
  bind(host: HostHandle, binding: BindInput): Promise<void>;
  /** 用户输入。per-run：等价于现在的 run()；resident：写入进程输入。 */
  submit(host: HostHandle, appSessionId: string, turn: TurnInput): Promise<void>;
  /** 只停当前一轮。per-run 实现为杀进程（现行为）。 */
  interrupt(host: HostHandle, appSessionId: string): Promise<boolean>;
  /** 改模型、思考强度、权限模式；返回立即生效还是下一轮生效。 */
  reconfigure(host: HostHandle, appSessionId: string, patch: HostReconfigure): Promise<'live' | 'next-turn'>;
  unbind(host: HostHandle, appSessionId: string, reason: HostCloseReason): Promise<void>;
  closeHost(host: HostHandle, reason: HostCloseReason): Promise<void>;
}

/** driver 向 manager 上报：轮次开始/结束、保活理由增减、pid、peer 名、进程退出。 */
type HostEventSink = { /* turnStarted, turnEnded, leaseAdded, leaseRemoved, identity, exited */ };
```

`IProvider` 新增 `readonly hostDriver?: IProviderHostDriver`。

**默认包装**（阶段 1a）。没有 `hostDriver` 的 provider，由 manager 用现有的 `run`/`abort` 生成一个 per-run 宿主，**不改任何 runtime 代码**：

- `submit` 调用 `runtime.run()`，宿主进入 `busy`。
- writer 上观测到 `complete` 时，解除 `turn` 保活理由。
- 如果此后 `run()` 的 promise 还没结束，就进入 `lingering`（Claude 的持有期就这样自然显现），等 promise 结束再关闭。
- promise 在 `complete` 之前或同时结束，记为 `turn-complete`；在它之后结束，记为 `released`。
- `interrupt` 调用 `runtime.abort()`，记为 `aborted`；`closeHost` 同样调用 `runtime.abort()`。

这样四个 provider 从第一步起就都出现在统一的宿主列表里。Claude 的顶替和 30 分钟释放仍在它的 runtime 内部完成，manager 只观察结果。到阶段 1b 再实现 Claude per-run driver，把这两项迁入 manager 的策略，并能区分出 `superseded`。

### 5. 能力矩阵

在 `provider-capabilities.service.ts` 中增加以下字段。前端据此渲染，不在组件里按 provider 分支：

```ts
lifecycleModes: ('per-run' | 'resident')[];
multiplexedHost: boolean;            // 一个进程承载多个会话
residentFeatures?: {
  interruptKeepsProcess: boolean;
  liveReconfigure: ('model' | 'effort' | 'permissionMode')[];
  unattendedTurns: boolean;          // cron、wakeup、跨会话消息
  addressable: boolean;              // 有稳定的 SendMessage 地址
  inputWhileBusy: boolean;           // 忙时输入直达进程（原则 6）
};
```

| Provider | `lifecycleModes` | `multiplexedHost` | 备注 |
|---|---|---|---|
| Claude | `['per-run', 'resident']` | `false` | `residentFeatures` 各项依实验 E1–E8 确认后填写 |
| Codex | `['per-run']` | `false` | 将来接 app-server 时改为两者，`multiplexedHost: true`，`unattendedTurns: false` |
| Cursor | `['per-run']` | `false` | |
| OpenCode | `['per-run']` | `false` | 将来接 `opencode serve` 时可改为两者，`multiplexedHost: true` |

### 6. 模式与数据模型

`sessions` 表新增一列（沿用 `migrations.ts` 的 `addColumnToTableIfNotExists` 写法）：

- `lifecycle_mode TEXT DEFAULT 'per-run'`：取值 `'per-run' | 'resident'`，表示用户对该会话的**偏好**，不代表进程是否存在。写入时按能力矩阵的 `lifecycleModes` 校验，不支持的模式拒绝写入。

宿主、绑定和保活理由都只在内存中，不入库（原则 1 决定了它们没有跨重启的意义）。

入口：新建会话时可以选"常驻"；已有会话可以在会话菜单中"转为常驻"或"关闭常驻模式"。两个入口只对能力矩阵中列出 `resident` 的 provider 显示。关闭常驻模式会先以 `mode-change` 关闭常驻进程。交互细节见 §15。

### 7. Claude 常驻 driver

新文件 `server/modules/providers/list/claude/claude-host-driver.provider.ts` 实现 `IProviderHostDriver`。resident 宿主持有：

- 一个**不结束**的 `AsyncIterable<SDKUserMessage>` 输入队列，作为 `query()` 的 `prompt`；
- 这个 `Query` 对象；
- 一个贯穿进程生命周期的读取循环，按 `result` 切分轮次，通过 `sink` 上报；
- 保活理由检测：复用 `startsBackgroundWork`，并识别 `CronCreate`、`CronDelete` 和一次性任务的触发（§10）。

与 per-run 的操作差别：

| 操作 | per-run | resident |
|---|---|---|
| `chat.send` | 新建 `query()` | 若已有宿主：写入输入队列；否则先启动 |
| 一轮结束 | `result` 后释放 stdin，进程退出 | `result` 只表示一轮结束，进程继续 |
| 停止当前回答（abort） | 杀掉整个运行 | `query.interrupt()`，进程和 cron 保留 |
| 改模型/思考强度 | 下一轮带新参数 | `setModel()` / `setMaxThinkingTokens()` |
| 改权限模式 | 下一轮带新参数 | `setPermissionMode()`（见 §9） |
| 关闭 | 不适用 | 结束输入队列（stdin EOF），CLI 正常退出；超时后 `close()` |

SDK 选项构建（`mapCliOptionsToSDK` 等）从 `claude-runtime.provider.js` 中抽出，供两种模式共用。

### 8. 轮次、事件通道与忙时输入

一个常驻进程里会出现两类轮次：

- **用户轮**：由 `chat.send` 写入的消息引起；
- **无人轮**：由 cron 触发、Monitor/后台任务回报或跨会话消息到达引起，没有对应的发送动作，可能也没有浏览器在线。

**轮次归属**：driver 的读取循环按 CLI 输出流中的轮次边界（`result`）上报 `turnStarted`/`turnEnded`，manager 据此在 `chatRunRegistry` 中开、结 run：

- 用户轮的 run 由 `chat.send` 路径打开，来源记为 `user`；
- 无人轮的 run 由 manager 打开，来源记为 `unattended`；定时消息沿用现有来源 `scheduled`。
- 所有 run 沿用 seq、replay、`complete` 语义，前端不需要区分进程形态。无人轮没有连接也照常记录，浏览器连上后可以回放。

**忙时输入（原则 6：与 Claude Code CLI 一致）**：

- 常驻会话 `busy` 时收到 `chat.send`，不论当前是用户轮还是无人轮，服务端都**不返回 `RUN_IN_PROGRESS`，也不自行排队**，而是立即把消息写入进程输入。
- 这条消息是并入当前轮，还是等当前轮结束后另起一轮，由 CLI 决定。服务端只按输出流中实际出现的轮次边界切分 run，并把这条用户消息记进它实际所属的那一轮。
- 前端依据 `residentFeatures.inputWhileBusy` 跳过本地排队，直接发送（§15.7）。per-run 会话的前端排队不变。
- 行为基准是交互式 Claude Code CLI 在同样情况下的表现。实验 E2/E3 要同时记录交互式 CLI 和 SDK stream-json 输入两种形态下的实际行为。**如果两者不一致**，把差异写回本文档，由用户决定：是在服务端补齐到交互式 CLI 的行为，还是接受 stream-json 的行为。

**兜底**：无人轮同样写进转录文件，现有的转录监听和同步会把它补进会话。实时推送是"尽力而为"，转录才是最终来源。

**通知**：无人轮结束时复用现有的 `notifyBackgroundWorkCompleted`（Web Push），文案区分"定时任务触发"和"收到跨会话消息"（仅在能从轮次首条输入识别时）。

### 9. 权限：默认放开

- 常驻进程以 `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` 启动。原因：cron 或跨会话消息触发的轮次，服务端在它开始前无法预知，只有整个进程放开，才能保证无人时不卡住。
- 用户在常驻会话中切换到别的权限模式时，调用 `setPermissionMode()`，**并提示**：切换后，无人轮遇到权限确认会按下一条的规则处理。
- 无人时的交互式请求（在 `canUseTool` 回调中处理）：
  - 若当前没有浏览器连接，或没有用户轮在进行：普通工具权限请求在 bypass 下不会出现；`AskUserQuestion`、`ExitPlanMode` **自动拒绝**，附一句"当前无人值守，请在下次用户消息中再问"，同时推送通知。
  - 有人在线时维持现有弹窗流程，超时（`TOOL_APPROVAL_TIMEOUT_MS`）后按现有逻辑处理。
- 启用常驻时，界面必须明确告知：该会话会以跳过所有权限确认的方式运行。

**风险须写明**：按外部 SPEC §7.3，`<cross-session-message>` 直接进入对方上下文，不经审批。常驻 + bypass 意味着**本机同一 Unix 用户下的任何 Claude 会话都能让这个会话不经确认执行任意命令**。信任边界因此等于"同一 Unix 用户"，这一点要在界面和文档里写清楚。

### 10. 常驻的启动、空闲判定与服务重启

**启动**：用户首次在常驻会话中发送消息，或手动点"启动"时，才懒启动。**不在服务启动时自动拉起**。

**空闲判定**（按绑定）：`lastActivityAt` 在任何一轮开始或结束、收到任何流消息、用户发送时更新。**浏览器打开或停留在该会话不算活动**，否则一个忘了关的标签页会让进程永不回收。满足下列全部条件，且持续 `RESIDENT_IDLE_TIMEOUT`（默认 **24 小时**，可配置），即以 `idle` 解除绑定：

1. 绑定状态为 `idle`；
2. 除 `resident-policy` 外，没有 `background-task`、`monitor` 保活理由；
3. 没有未过期的 `cron` 保活理由。

**cron 保活理由是推测出来的**：driver 观察流中的 `CronCreate`（记录 id 与 `recurring`）、`CronDelete` 和一次性任务的触发。按工具说明，周期任务 7 天后自动过期，`expiresAt` 取创建时间加 7 天，所以**有 cron 的会话最多再保活 7 天**。推测可能不准（例如模型没有显式删除），后果只是多活一段时间或按上限关闭，可以接受。周期任务每次触发也会刷新 `lastActivityAt`。

界面**不显示**"即将因空闲关闭"的预告。关闭后会话显示 `idle` 原因，用户下一次发送即重新拉起。

**服务重启**（原则 1）：

- 正常停止时，manager 以 `server-shutdown` 对所有宿主调用 `closeHost`，两种模式都包括：resident 结束输入队列，最多等待 N 秒，超时则 `close()`；per-run 沿用 `abort`。统一接入 `server/index.ts` 的 `shutdownRuntimeServices`。
- 常驻进程放在独立 scope（§11）后会**逃出服务的 cgroup**：服务被杀时它们不会随之被杀，只会因 stdin EOF 退出。为防止 CLI 未及时退出，服务启动时由 L3 **清扫**残留的 `cloudcli-host-*.scope`（`systemctl --user stop`），只清理、不接管。
- 重启后，会话的 `lifecycle_mode` 仍为 `resident`，但进程已不存在，界面显示"常驻进程已随服务重启关闭，定时任务已丢失"。用户下一次发送时重新拉起（`--resume`）。这是用户触发的，不属于自动恢复。

### 11. 资源：不限数量，但要有内存包络（L3）

原则 3 不限数量。但 2026-09-25 的事故说明，不设上限的进程群会把整机拖进换页：负载一度到 4309，OOM 杀了 36 次。所以建议**不限个数，只限内存**：

- L3 提供统一的 spawn 包装：`systemd-run --user --scope --unit=cloudcli-host-<短ID> --slice=cloudcli-resident.slice -p MemoryMax=<单进程上限> -p MemorySwapMax=0`，可复用 `scripts/with-memory-cap.sh` 的思路。Claude 通过 `spawnClaudeCodeProcess` 接入；将来的 Codex app-server、`opencode serve` driver 直接调用同一个包装。
- 本期只对 resident 宿主启用这个包装；per-run 宿主保持现状，是否纳入另行决定。
- `cloudcli-resident.slice` 设一个总的 `MemoryMax`/`MemoryHigh`。超出时，内核只在常驻进程之间选受害者，服务本身和 per-run 会话不受影响。
- 被 OOM 杀掉的宿主显示 `exited`，`detail = oom`（从 journal 或退出信号判断）。
- 没有 systemd 时退化为不包装，并在日志里说明一次。

两个上限的具体数值需要实测后再定（见实验 E7），这里**不给拍脑袋的数**。

**待确认**：是否接受"不限个数，但有总内存上限"。如果连总内存上限也不要，常驻进程就只能和服务一样没有保护。

### 12. 身份与寻址

- 通过 `extraArgs: { name: '<标题 slug>-<会话 ID 前 6 位>' }` 给常驻进程一个稳定的 peer 名，driver 以 `identity` 事件把它上报到绑定的 `peerName`。标题变化时不改名，名字在进程生命周期内固定。中文和空格是否被接受需要验证（E6）；不接受则只用 ID 前缀。
- 会话菜单新增"复制 SendMessage 地址"，仅当绑定存活且 `addressable` 时可用。
- 会话详情显示 pid、peer 名、启动时间、内存（读 scope 的 `memory.current`）、状态和保活理由。这些数据来自统一的宿主接口。
- 在 Shell 标签页执行 `claude --resume` 会让同一会话多出第二个写入者。因此**常驻会话不支持 Shell 标签页**：只按 `lifecycle_mode` 判断，与进程是否存活无关，也不提供强行打开。关闭常驻模式后恢复可用。

### 13. 跨模式规则

1. **单写者不变量**：同一个 provider session 在任何时刻最多只有一个绑定。由 manager 的 `appSessionId → hostId` 索引强制执行；从阶段 1b 起，它取代 Claude runtime 内部的 `releaseInput` 顶替逻辑。
   - per-run 转 resident 时，若旧的 per-run 宿主仍在持有期，先以 `superseded` 关闭它。
   - Shell 标签页按 §12 对常驻会话禁用。在 tmux 或外部终端里 `--resume` 仍无法阻止（见风险）。
2. **停止与关闭分开**：
   - `chat.abort` 调用 `interrupt`：per-run 下杀进程（现行为），resident 下只停当前一轮。
   - 新增的关闭动作调用 `unbind(..., 'user')`，只对 resident 开放。
3. **模式切换**：宿主 `busy` 时不切换（前端按 `!isProcessing` 禁用入口，§15.2），本轮结束后才能切换。resident 转回 per-run 时，以 `mode-change` 解除绑定。
4. **编辑已发送消息**（`chat.edit-send`，即 Claude 的 `resumeSessionAt`）：resident 下无法就地回退，只能以 `rewind` 关闭进程，再带截断点重新拉起。cron 和后台任务会丢失，前端必须先确认，确认框列出会丢失的内容（格式同 §15.2）。
5. **分叉出的会话**默认 per-run，不继承 `lifecycle_mode`。

### 14. 与现有功能的关系

| 功能 | 处理 |
|---|---|
| 定时消息（`scheduled-messages`） | 常驻会话：`interruptActiveRun` 为真且 busy 时，先 `interrupt()` 再写入输入；否则按 §8 的忙时输入规则直接写入。不重启进程 |
| 分叉会话 | 新会话默认 per-run，不继承常驻 |
| 编辑已发送消息 | 常驻会话按 §13 第 4 条处理 |
| 归档/删除 | 先以 `user` 关闭常驻进程 |
| Running sessions 视图 | 改为读统一的宿主接口；分"正在运行"和"常驻（空闲）"两组；侧栏徽标只计正在运行的（§15.8） |
| Shell 标签页 | 常驻会话不提供（§12） |
| `claude.exe` 被替换 | 常驻进程已加载旧版本，不受影响；新启动可能失败，按 `exited` 报告，可以重试 |

### 15. 前端交互

用户只需要回答两个问题：**这个会话是不是常驻的**（偏好，静态标记），和**它的进程现在在不在、为什么**（运行状态，动态）。界面上不出现"per-run"字样：默认模式不加任何标记，只有常驻会话多一个标记。常驻入口按能力矩阵的 `lifecycleModes` 显示（本期只有 Claude）。

#### 15.1 状态的视觉映射

侧栏已用三种信号：绿色脉冲点（活跃）、琥珀点（需要处理）、旋转图标（处理中）。常驻标记**不用点**，而用静态小图标，放在 provider logo 旁、`SessionBranchBadge` 的位置。

| 状态 | 侧栏行 | 会话内状态条 |
|---|---|---|
| 常驻，进程未启动或已关闭 | 空心图标 | `常驻 · 未运行（原因）` + [启动] |
| 常驻，空闲 | 实心图标 | `常驻 · 空闲 · 2 个定时任务 · 1 个监视` |
| 常驻，运行中 | 实心图标 + 现有旋转图标 | 同上，状态为"运行中" |
| `exited` / OOM | 红色图标 | 横幅 + [重新启动] |
| 有未读的无人轮输出 | 沿用现有"最近活跃"点 | — |

状态条上的计数直接来自绑定的保活理由（§3）。不提供"即将因空闲关闭"的预告（§10）。

#### 15.2 开启与告知

- **新建会话**：在 `ProviderSelectionEmptyState` 的 provider/model 卡旁加"常驻"开关，仅对能力矩阵含 `resident` 的 provider 可见。打开开关后**就地展开**告知，不弹窗，内容有两点：该会话会跳过所有权限确认；同一 Unix 用户下的任何 Claude 会话都能不经确认驱动它执行命令（§9）。告知下方是"我了解"勾选框，未勾选时发送按钮禁用。每个常驻会话开启时都要勾选一次。
- **已有会话**：`SessionOptions` 菜单加"转为常驻…"，打开同样内容的告知与勾选框，确认后生效。会话正在处理时禁用该项（与 `canFork` 一样按 `!isProcessing` 判断）。
- **关闭常驻模式**（菜单项文案，即转回 per-run）：若推测仍有存活的 cron 或未结束的后台工作，确认框**列出会丢失的内容**（如"2 个定时任务、1 个监视将停止"）；没有就直接切换。
- **归档 / 删除**：进程存活时，现有确认框补一句"常驻进程会被关闭，定时任务会丢失"。
- **分叉**：新会话默认 per-run，不需要额外提示。

#### 15.3 会话内状态条

放在消息区顶部、标题下方，**不放进 composer 底栏**（底栏在移动端已没有余量）。点开为 popover，移动端为 sheet：

```
┌ 常驻 · 空闲 · 2 个定时任务 · 1 个监视 ─────────────── ⌄ ┐
│ SendMessage 地址  fix-login-a1b2c3        [复制]        │
│ pid 1290562 · 启动于 14:15 · 内存 412 MB                │
│ 后台工作                                                  │
│   ⏰ CronCreate  每 30 分钟  (推测存活，重启即丢失)       │
│   📡 Monitor     tail build.log                          │
│ 定时消息（持久）  1 条  → 打开                            │
│                               [关闭常驻进程]  (危险样式) │
└──────────────────────────────────────────────────────────┘
```

Claude 自建的 cron 标注"推测存活，重启即丢失"，与持久的 `scheduled-messages` 分开列出，让用户分清两者。

#### 15.4 停止与关闭分开

- composer 的停止按钮在常驻会话中只调用 `interrupt()`，提示文字为"停止当前回答（进程和定时任务保留）"。
- "关闭常驻进程"是破坏性操作，只出现在状态条 popover 和会话菜单，不出现在 composer。有后台工作时要二次确认。

#### 15.5 权限菜单

复用 `ComposerPermissionMenu` 现有的 `bypassPermissions` 橙色警告样式。常驻会话从 bypass 切到其他模式时，在菜单内就地显示一行"无人值守时的确认请求会被自动拒绝"，不另弹窗。

#### 15.6 无人轮在聊天记录中的呈现

无人轮不能看起来像用户消息。每个无人轮前加一条分隔标签：

- `⏰ 定时任务触发 · 14:00`
- `✉ 来自 quay-ac 的跨会话消息 · 14:03`：正文用独立的气泡样式并**显示发送方**，在界面上落实 §9 的信任边界。
- `📡 监视通知 · build.log`

无人值守时被自动拒绝的 `AskUserQuestion` / `ExitPlanMode` 显示为卡片："无人值守时已自动拒绝"，附 [现在回答]，点击后把问题带入 composer。

能否识别发送方和触发类型，取决于流中是否带有这些信息（§8"能识别时"）。识别不出时统一显示"非用户触发"。

#### 15.7 运行中发送

按原则 6，常驻会话（`inputWhileBusy` 为真）运行中发送时：

- **不走** `QueuedMessageCard`。那是前端本地排队，消息还没离开浏览器；常驻会话的消息会立即送进进程。
- 消息立即出现在聊天记录中，状态标注跟随 CLI 的实际行为（E2/E3）：并入当前回答时标"已并入当前回答"；CLI 留到当前回答结束后处理时标"将在当前回答结束后处理"。两种情况都不伪装成前端排队。
- 无人轮进行中发送，规则相同。
- per-run 会话维持现有的 `QueuedMessageCard` 排队。

#### 15.8 Running 视图与侧栏徽标

- 数据来自统一的宿主接口（`GET /api/session-hosts`）。
- 侧栏 Running 徽标的数字**只统计正在运行的会话**，空闲的常驻会话不计入。
- Running 视图分两组："正在运行"和"常驻（空闲）"。第二组每行都有 [关闭]。

#### 15.9 其他入口

- **复制 SendMessage 地址**：放在 `SessionOptions` 中，紧挨现有"复制会话 ID"（`useProviderSessionIdCopy`）。进程不在时该项禁用并写明原因，不隐藏。
- **Shell 标签页**：常驻会话中禁用，提示"常驻会话不支持 Shell，关闭常驻模式后可用"。

## 需要修改的文件

服务端（按 `.agents/skills/backend-module-standards` 执行：新文件用 TypeScript，跨模块只经 `index.ts`）：

- 新增模块 `server/modules/session-hosts/`：
  - `index.ts`
  - `session-host-manager.service.ts`（L2：宿主表、绑定、保活理由、策略、默认包装、空闲回收、停机）
  - `process-containment.service.ts`（L3：scope 包装与启动清扫）
  - `session-hosts.routes.ts`
  - `tests/`
- `server/shared/interfaces.ts`：新增 `IProviderHostDriver`；`IProvider` 增加可选的 `hostDriver`。
- `server/shared/types.ts`：`HostState`、`HostLease`、`HostCloseReason`、`LifecyclePolicy`、`HostSnapshot` 等共享类型（按分组注释格式）。
- `server/modules/providers/list/claude/claude-runtime.provider.js`：抽出 SDK 选项构建，供两种模式共用；阶段 1b 把顶替与持有交给 manager。per-run 行为不变。
- 新增 `server/modules/providers/list/claude/claude-host-driver.provider.ts`：§7 的 driver。
- `server/modules/providers/list/claude/claude.provider.ts`：挂上 `hostDriver`。
- `server/modules/providers/services/provider-capabilities.service.ts`：§5 的字段。
- `server/modules/providers/services/provider-runtime.service.ts`：`run`/`abort` 改为经 manager 分派。
- `server/modules/websocket/services/chat-websocket.service.ts`：`chat.send`/`chat.abort` 经 manager；resident 忙时输入不再返回 `RUN_IN_PROGRESS`。
- `server/modules/websocket/services/chat-run-registry.service.ts`：run 来源字段；manager 开 run 的入口；resident 下由轮次边界决定 run 起止。
- `server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts`：常驻会话的投递路径。
- `server/modules/database/migrations.ts`、`schema.ts`、sessions 仓储：新增 `lifecycle_mode` 列。
- `server/index.ts`：停机时调用 manager；启动时调用 L3 清扫。
- REST 接口：
  - `GET /api/session-hosts`：列表，含 provider、模式、状态、绑定、保活理由、pid、内存、关闭原因；
  - `POST /api/session-hosts/:sessionId/start`；
  - `POST /api/session-hosts/:sessionId/close`。

前端（§15，按 `.agents/skills/frontend-module-standards` 放入对应模块）：

- `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx`：常驻开关、就地告知与勾选框。
- `src/modules/chat/`：
  - 会话内状态条与 popover；
  - 无人轮分隔标签、跨会话消息气泡、自动拒绝卡片；
  - 停止按钮文案；
  - `composer/ComposerPermissionMenu.tsx` 的切换提示；
  - `hooks/useChatComposerState.ts`：`inputWhileBusy` 时跳过本地排队（§15.7）。
- `src/modules/sidebar/SidebarSessionItem.tsx`：常驻图标及其状态。
- `src/modules/sidebar/SessionOptions.tsx`：转为常驻 / 关闭常驻模式、复制 SendMessage 地址、关闭常驻进程。
- `src/modules/sidebar/SidebarHeader.tsx` 与 Running 视图：改读宿主接口；徽标只计正在运行的会话；列表分两组。
- `src/modules/project-workspace/WorkspaceTabs.tsx`：常驻会话禁用 Shell 标签页。

文档：

- `server/modules/providers/README.md`：新增 `hostDriver` facet 说明，以及"如何接入常驻"。
- `docs/architecture/03-conversation-handoff.md`：补充宿主层，以及"一个进程多轮""一个进程多会话"的身份与轮次模型。
- `docs/operations/process-isolation-and-memory-caps.md`：补充常驻 slice 与清扫。

## 验证方法

### 阶段 0：实验（实施常驻前必须先做）

用一次性的临时实例，**显式指定临时 `DATABASE_PATH`**（本机 shell 已导出 `DATABASE_PATH`，指向真实库），用 SDK 最小脚本驱动，不碰生产会话。

| 编号 | 问题 | 通过条件 |
|---|---|---|
| E1 | 常驻输入下 `CronCreate` 是否按时触发，触发轮是否出现在输出流 | 1 分钟一次性任务按时触发；周期任务连续触发 ≥3 次 |
| E2 | 进程 busy 时推入用户消息，是并入当前轮还是另起一轮；**交互式 CLI 在同样情况下怎么做** | 两种输入形态的行为都有记录。一致，则直接作为 §8、§15.7 的基准；不一致，则写回差异，交由用户决定 |
| E3 | 无人轮（cron 触发、跨会话 `SendMessage`）进行中推入用户消息；busy 时跨会话消息到达 | 不丢失；记录并入或排队的方式，并与交互式 CLI 对照 |
| E4 | `interrupt()` 后进程与 cron 是否仍存活 | 进程存活，cron 继续触发 |
| E5 | 服务进程被 kill 后，常驻进程是否因 EOF 退出；多久退出 | 进程在 N 秒内退出；否则清扫逻辑是必需的 |
| E6 | `extraArgs.name` 是否生效，是否接受中文和空格 | peer 名等于设置值 |
| E7 | 长驻内存增长 | 至少 24 小时浸泡，记录 RSS 曲线，以此确定 §11 的数值 |
| E8 | `bypassPermissions` 下 `AskUserQuestion` 走不走 `canUseTool` | 能在回调中拦截 |

实验会真实调用模型，产生费用。

### 阶段 1 起：自动化测试

- **默认包装**（阶段 1a）：
  - 用四个 provider 现有 runtime 测试的伪造流，验证宿主经历 `starting → busy → closed`，关闭原因为 `turn-complete`。
  - Claude 伪造"`complete` 之后 promise 仍未结束"的情形，验证经过 `lingering`，原因为 `released`。
  - `abort` 记为 `aborted`。
  - 现有全部 runtime 与 chat 测试不改一行，照常通过。
- **manager 状态机**：
  - 保活理由增减驱动的状态切换；每种关闭原因都要覆盖。
  - 1:N 下，解除一个绑定时，仍有其他绑定的宿主不关闭；最后一个绑定解除时宿主关闭。
  - 单写者冲突被拒绝。
- **空闲判定**：
  - cron 推测的正反例：有 cron 时 24 小时不关；7 天过期后关；`CronDelete` 后恢复正常计时。
  - 浏览器停留不刷新 `lastActivityAt`。
- **Claude resident driver**（伪造 SDK 流）：
  - 用户轮不重启进程；abort 调用 `interrupt` 而不关闭进程；
  - 无人轮会建 run，来源为 `unattended`，可以回放；
  - 忙时 `chat.send` 不返回 `RUN_IN_PROGRESS`，消息按伪造流给出的轮次边界归入对应的 run。
- **L3 清扫**：残留 scope 被停止而不被接管；没有 systemd 时正确退化。
- **迁移**：`lifecycle_mode` 默认为 `per-run`；写入不在 `lifecycleModes` 中的模式时被拒绝。
- **前端组件**：
  - 常驻标记的各个状态、关闭按钮；
  - bypass 告知，以及未勾选时禁用发送；
  - "已随服务重启关闭"提示；
  - 无人轮分隔标签；
  - Running 徽标计数与分组；
  - Shell 标签页禁用；
  - `inputWhileBusy` 时不走 `QueuedMessageCard`。

## 验收标准

1. per-run 会话的全部现有测试保持通过，行为没有变化。
2. 阶段 1a 之后，Claude、Codex、Cursor、OpenCode 的运行中会话都出现在 `GET /api/session-hosts` 中，带状态和关闭原因；Claude 的持有期显示为 `lingering`。
3. 常驻会话中，用户连续发送 3 条消息，pid 不变。
4. 常驻会话创建的 1 分钟周期 cron，在用户中途发送消息后仍继续触发，触发内容出现在聊天中。
5. 常驻会话在用户轮或无人轮进行中收到用户消息时，既不被拒绝，也不在前端排队；消息落在哪一轮，与 E2/E3 记录的 CLI 行为一致。
6. 常驻会话存活期间，另一个会话用界面上复制的地址 `SendMessage`，对方能收到并产生一轮。
7. 无浏览器在线时发生的无人轮，打开页面后可以看到。
8. 空闲超时到达后进程退出，界面显示 `idle` 原因；有已知 cron 时，不在 24 小时处关闭。
9. 重启服务后没有残留的常驻进程，会话显示"已随服务重启关闭"，下一次发送时重新拉起。
10. 常驻进程超出单进程内存上限时，只有它被杀，服务与其他会话不受影响。
11. 开启常驻时，未勾选"我了解"就无法发送；勾选后才能创建或转换。
12. 浏览器一直停留在某个常驻会话上，不会阻止它在空闲超时后关闭。
13. 侧栏 Running 徽标不计入空闲的常驻会话；Running 视图分"正在运行"和"常驻（空闲）"两组。
14. 常驻会话的 Shell 标签页不可用；关闭常驻模式后恢复可用。
15. 无人轮在聊天记录中带触发类型标签，不以用户消息的样式显示。

## 风险与注意事项

- **安全**：常驻 + bypass + 跨会话消息不经审批，意味着同一 Unix 用户下的任何会话都能驱动它执行命令。这是原则 2 的直接代价，需要让用户知情。
- **包装改动面大**：阶段 1a 让所有 provider 的 `run`/`abort` 改为经 manager 分派，所有聊天都走这条路径。回归护栏是"现有测试不改一行照常通过"；此外，manager 在 1a 只观察、不做决策。
- **忙时输入依赖 CLI 行为**：原则 6 把行为基准交给了 CLI。若 SDK stream-json 与交互式 CLI 不一致（E2），需要另做决定；CLI 版本升级也可能改变这一行为，轮次归属会随之变化。
- **cron 状态靠推测，可能不准**：服务端只能看到工具调用，无法调用 `CronList`；推测错误只影响关闭时间。
- **上下文增长**：多日常驻依赖 CLI 自身的自动压缩，长期行为未测。
- **二进制替换**：本机 `claude.exe` 的修改时间被频繁改动，来源未查明；常驻进程启动失败时要可见、可重试。
- **转录双写者**：Shell 标签页已通过禁用排除（§12）；但用户在 tmux 或外部终端里 `--resume` 同一会话仍无法阻止，后果未验证。
- **计费**：聊天已走 SDK，常驻不改变认证方式；但无人轮会在用户不在场时消耗额度，cron 频率过高时要让用户能看到用量。

## 推荐实施顺序

1. **阶段 0**：做实验 E1–E8，把结论写回本文档。
2. **阶段 1a（纯包装）**：`session-hosts` 模块、共享类型、默认包装；`provider-runtime.service.ts` 改为经 manager 分派；`GET /api/session-hosts`；停机接入。行为不变，现有测试不改。
3. **阶段 1b**：Claude per-run driver。把顶替与 30 分钟持有迁入 manager 的策略，能区分 `superseded`；单写者由 manager 强制。
4. **阶段 2（Claude 常驻最小版）**：`lifecycle_mode` 列、能力矩阵字段、Claude resident driver、输入队列、`interrupt`、手动关闭、L3 启动清扫、bypass 启动。默认关闭，仅能通过 API 开启。
5. **阶段 3**：无人轮进入 run 注册表与通知；按 E2/E3 的结论落地忙时输入；空闲自动关闭（含 cron 推测）。
6. **阶段 4**：L3 独立 scope 与总内存上限（依据 E7 的数值）。
7. **阶段 5**：前端（§15）——模式选择与 bypass 告知、状态标记与状态条、关闭、复制地址、无人轮呈现、Running 分组（改读宿主接口）、Shell 禁用、忙时直发（§15.7，依据 E2/E3 的结论）。
8. **阶段 6**：文档——providers README、架构 03、运维文档。
9. **以后**：Codex app-server、`opencode serve` 的多路复用 resident driver，接入同一个宿主层。
