---
id: gap-claude-resident-name-mirror-window-opens-too-late
title: resident peer 注册名的镜像开窗时机太晚：只在回合 result 时才尝试，首轮进行期间 CloudCLI 显示名与可达地址长期不一致
  —— 改为转录出现已定稿 ai-title 即可发帧（先测飞行中控制帧是否生效）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**症状（实测，本会话就是证人）**：CloudCLI 侧栏/聊天头显示的是 ai-title，而 `~/.claude/sessions/<pid>.json` 里的地址还是 `derived` 机器名，两者在整个**首轮**期间不一致。用户照着标题发消息 ⇒ `No agent named … is reachable`。

读数（本会话 pid 3822352，app session `59fc5342`，均实测）：

- 进程 `startedAt` = 1790862416994；`nameSince` = 1790862779013（注册名由 `derived` 改为 `user`、值 = ai-title）⇒ **启动后 362 秒**才就位。
- 同一份转录：ai-title 首次出现在第 **16** 条（全文 271 条），写在第 17 条（**第一条 assistant 消息**）之前；19 次出现**只有 1 个取值**。
- 改名写入的 `custom-title`/`agent-name` 落在第 **233/234** 条 = 首轮**末尾**。
- 第二个证人：pid 3703039（同 cwd 的常驻，app session `7376d295`）busy 11 分钟时仍是 `claudecodeui-f0`/`derived`；其首轮结束后同样变为自己的 ai-title（`CloudCLI 重启后任务可用性`/`user`）。

⇒ 那 362 秒里属于「等标题定稿」的是 **0 秒**：按判据自身「同值连读两次」的规则，300ms 轮询下再等 600ms 即可满足。时间全部花在**等首轮结束**。窗口长度 = 首轮时长，**无上界**。

**根因**：`scheduleTitleMirror` 只有一个调用点，且它在 `result` 分支里（`server/modules/providers/list/claude/claude-host-driver.provider.ts:3959`，其上方 `:3951` 就是 `if (message?.type !== 'result') { return; }`）。整个回合进行期间 driver **不做任何尝试**。窗口 20s、轮询 300ms（`:1868-1869`）。

**代码给的理由与读数不符**：`:3250` 与调用点注释都写「开在 `result` 是因为 CLI 的标题生成落在那时」。本会话的转录直接推翻这条前提 —— 生成落在第一条 assistant 消息**之前**；`gap-claude-resident-name-live-mirror` 自己的语料读数（194 个带 ai-title 的转录，值真正变过的只有 1 个且在第 2 轮）同样说明取值在首见时基本已定稿。而判据「同值连读两次」本来就是**基于取值**的，任何时刻轮询都成立，开窗时机不必挂在回合边界上。

**要做的**：把开窗时机从「只在 `result`」放宽到「转录出现已定稿的 ai-title 之后即可」，让地址在首轮进行期间就位。

**承重未知（必须先测，未取到肯定读数前不得动产品代码）**：**回合进行中**向活进程 stdin 写 `rename_session` 控制帧，CLI 收不收、照不照做。`gap-claude-resident-name-live-mirror` 量通道时进程是空闲的，它的 B/A 两臂对照也是空闲态。旁证但不构成证明：driver 确实会往忙碌进程写控制帧（`cancelQueuedInput` → `writeRaw`，`:2533`），但那个帧按文档**不回 `control_response`**（§9.2），只能证明「收得下」，不能证明「飞行中会照做」。
若该读数为**否**，本任务收窄为：记录该约束，并把窗口提前到「首个可用的安全时机」，同时把「为什么早不了」写进 Evidence 与 proposal §12 —— 不得改成隔一轮/下一次启动才改名的其它形状来冒充修好。

**顺带一处（本次调查发现，同一条帧的副作用）**：改名除追加 `custom-title` 外，还追加了一条 **`agent-name`**（本会话转录在改名后 `custom-title`/`agent-name` 各 +1，值都等于镜像值；此后每轮各再追加一条）。`agent-name` 是 CLI 阶梯的**顶档** —— 也正是当年 `--name` 写的那一档。`gap-claude-resident-name-live-mirror` 的「副作用夹住」AC 只夹了 `custom-title`，**没夹 `agent-name`**。本条判据把两者都夹住。

<!-- dedup-ref --> **关系**：`gap-claude-resident-name-live-mirror`（done）建了这条控制帧通道、并按回合边界开窗，本条改的是**开窗时机**与一处未夹住的副作用；`gap-cloudcli-self-assigned-names-outrank-ai-titles`（done）撤掉 `--name`；`gap-claude-peer-name-follows-ai-title`（done）管启动时那一次交接。三者互不覆盖，本条也不依赖它们中的任何一条落地。

### 实现约束

- 本任务改 `server/**`，必须加载并遵守 `$backend-module-standards`（`.agents/skills/backend-module-standards/SKILL.md`）。
- 若另起模块文件或改动本 `## Touches` 未列出的文件，**必须在同一提交里把该文件补进 `## Touches`** —— anti-drift 是 NON-WAIVABLE 硬门。
- 新建测试文件放在 `server/modules/providers/tests/`，只 import 同模块/内置符号（`providers/tests/` → `providers/list/claude/` 属模块内深导入，不触 boundaries lint）。

## Plan

1. **判据先行**：新建 `server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts`（真 claude 二进制 + 临时 `CLAUDE_CONFIG_DIR`/`DATABASE_PATH`，读 `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` 与转录），做法照同目录既有的 `claude-resident-name-live-mirror.test.ts`。先取红态，再动产品代码。
2. **取承重读数**（AC2）：在**飞行中**的回合里发帧，读注册名 / `nameSince` / pid / `startedAt` / 该轮能否正常走到 `result`；负控制为同窗口不发帧。读数逐条打印。
3. **改开窗时机**：**仅当第 2 步肯定时**才动产品代码 —— 把 `scheduleTitleMirror` 的触发从 `result` 分支放宽到「流上出现消息且转录已有已定稿 ai-title」；`titleMirror.mirrored` 的闩锁、「不提前」「只发一次」三条不变量原样保留，脚本的读取预算按既有转录读预算核一遍。
4. **夹住副作用**：判据补 `custom-title` 与 `agent-name` 双双逐字等于镜像值。
5. **假形态逐条验红**（把开窗改回只在 `result` ⇒ AC3 必红；改成首读即发 ⇒ 「不提前」那条必红），验完 `git checkout --` 还原。
6. **留痕**：`docs/proposals/claude-resident-sessions.md` §12 补「开窗时机」与 `agent-name` 副作用两段。
7. 既有判据逐条不退；`scripts/test.sh --for-task <id>` scoped gate 绿。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts` 退出 0
- [ ] **承重读数（先于实现）**：同一个真 claude 进程，在**回合进行中**（尚未出现 `result`）经 `writeRaw` 写 `rename_session` 帧 ⇒ 注册表 `name` 逐字等于该串、`nameSince` 前移、**pid 与 `startedAt` 均不变**，且该回合仍能正常走到 `result`。**负控制**：同窗口不发帧的那条腿仍是 `derived`。命令与读数逐条打印。
- [ ] **改后：首轮 `result` 之前地址已就位**：新建会话跑一轮，在**首次观察到转录出现 ai-title 之后、`result` 之前**读注册表 ⇒ `name` 已逐字等于该 ai-title、`nameSource` 非 `derived`。**假形态**：把开窗时机改回只在 `result` ⇒ 本 AC 必须红（该读数会是 `derived`）。
- [ ] **不提前（守 A 臂）**：帧发出时该会话转录里**同时存在** ai-title 条目。**假形态**：改成首读即发 ⇒ 必红。
- [ ] **只发一次**：采纳成功后回合继续、转录继续追加同值 ai-title，rename 帧计数仍为 1。
- [ ] **副作用夹住（含 `agent-name`）**：采纳动作追加的 `custom-title` **与** `agent-name`（若有）其值逐字等于镜像值；出现任何其它值即失败。
- [ ] **既有判据不退**：`claude-resident-name-live-mirror.test.ts`、`claude-resident-addressable.test.ts`、`claude-peer-name-follows-ai-title.test.ts` 逐个独立进程退 0，逐条打印命令与退出码。
- [ ] `npm run typecheck` 三条链退出 0；`npm run lint` 退出 0（仅既有 warning）。
- [ ] `git diff --stat develop...HEAD` 只出现在 `## Touches` 列出的文件里。

## DoD

- 在**真实 :3001** 上新建一个 resident 会话，发一条会立刻产生 ai-title 的消息，**在该回合尚未结束时**读 `~/.claude/sessions/<pid>.json` ⇒ `name` 已逐字等于该 ai-title、`nameSource` 非 `derived`，**pid 与该进程的启动时刻均不变**（证明是活体、且确实提前了）；同一时刻 `ListAgents` 里该 peer 显示为该标题。
- 负控制：转录里没有 ai-title 的 resident 会话，在同一观察窗内仍是 `derived`。
- **提前量要有基线对照**：改前基线为本会话的 **362 秒**（另可对照 pid 3703039）；DoD 取改后同形态会话的首轮读数并写明差值。
- 上述会话的转录里没有出现任何 CloudCLI 自造的标题字符串（没有任何阶梯回退档被写进去）。

## Touches

- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts (new)（判据：真 claude 二进制 + 临时 CLAUDE_CONFIG_DIR / DATABASE_PATH，读 sessions/<pid>.json 与转录，量「飞行中发帧是否生效」与「开窗时机」）
- server/modules/providers/tests/claude-resident-name-live-mirror.test.ts （开窗时机改了，该文件的时间假设预计要跟着调；若最终未改，须在 Evidence 里说明为什么不用改）
- server/modules/providers/tests/claude-resident-addressable.test.ts （本体不改动，纳入 scoped gate 覆盖）
- docs/proposals/claude-resident-sessions.md
- tasks/gap-claude-resident-name-mirror-window-opens-too-late.md
