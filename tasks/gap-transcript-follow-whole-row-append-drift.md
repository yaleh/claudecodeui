---
id: gap-transcript-follow-whole-row-append-drift
title: 贴底跟随在「整行到达」时累积漂移：外部写入的会话每来一条新消息就比底部多留一截且不再自行修复（首帧 240px 占位盒 + 1px 偏移闸误读为手势）
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

**缺陷（实测）。** 被外部 CLI 驱动、app 仅旁观的会话里，跟随意图仍然成立时，**每到达一条新消息**（整行），视口就比底部多留一截，且跟随不再自行修复。2026-09-22 在运行中的服务上（会话 `b1d82965`，1440×900）逐帧读数：

```
t=8425  gap=0    rows=12 lastH=71
t=9058  gap=256  rows=13 lastH=240   ← 新行首帧高度 240px；scrollTop 自行 -116（无人写）
t=9074  gap=52   rows=13 lastH=36    ← 新行落到真实高度
… 每追加一行重复一次，单调累积 …
t=28674 gap=552  rows=18 lastH=240 → t=28690 gap=366
整段 "Scroll to bottom" 按钮从未出现（btn=false ⇒ 意图仍是跟随，不是用户离开）
```

读数与探针说明存于 `/data/scratch/yale/qa-follow-b1d8/evidence.md`；探针脚本与一次性观察凭据均已回收。

**代码侧的因果（读码 + 一次运行的相关性）。** 新行的首帧高度是占位高度，来自 `.chat-message.assistant` 的 `contain-intrinsic-size: auto 240px`（`src/index.css`）—— 与内容无关。随后 `judgeTranscriptGrowth`（`src/modules/chat/hooks/useChatSessionState.ts`）在 `|scrollTop − previousBottom| > TRANSCRIPT_FOLLOW_TOLERANCE_PX`（该常量为 1）时判为「用户把视口拿回去了」并 `return null`，不 pin。于是容差 1px 的闸把**布局引起的 offset 变化**读成用户意图，该会话的跟随就此关闭；又因为 `isUserScrolledUp` 仍为 false，`Scroll to bottom` 按钮不出现，用户连手动回到贴底的入口都没有。`isNearBottom()` 的 50px 判据（同一文件）在 gap 越过 50px 后还会让"外部更新"路径的延迟 `scrollToBottom()` 一并停止尝试。

**为什么现有判据覆盖不到。** GOAL-004 家族六条 AC 全部 achieved，形状分别是：就地增长（AC-106/108）、pane 变矮（AC-107）、手势脱离（AC-109）、prepend 恢复（AC-110）、非用户滚动不改意图（AC-111）。**没有一条是"新行到达"**：AC-106/108 量的是**同一行**就地长高（delta 形状），AC-111 量的是**意图**不被浏览器滚动改写（而不是那道偏移闸放行布局变化）。`goals/` 内 grep「整行」/「whole row」零命中。

**与已修的兄弟任务的区别（不是重复）。** `gap-transcript-follow-finalize-remount-loses-bottom`（done）修的是**同一行**的 React key 逐帧变化 → unmount/mount → 首帧按内在盒排布 → 浏览器 clamp → 跟随把被 clamp 的 offset 读成用户移动；它的修法是稳住 live 行 id。**新行没有可稳的 key** —— 它本来就是新的，首帧必然是那个占位盒。所以那次修复对本条无效，缺口的触发面不同（行**到达** vs 行**重挂载**）。

**判据形状的硬约束（本轮新增的实测事实）。** `stream_delta` 只由 `claude-sessions.provider.ts` 对 `raw.type === 'stream_event'` 的帧铸出，而没有任何 fixture 会往 `.jsonl` 里写 `stream_event` 行 —— 因此**任何以"写 transcript 行"方式产出的东西都造不出 delta**，只有行（`text`/`tool_use`/`tool_result`/`thinking`）。本条要复现的正是**行到达**的形状，所以判据必须走整行路径；这也意味着**不必**等 ADR-003 的调试 Agent，现有 e2e 的 in-page wire double（`e2e/transcript-follow.spec.ts` 的 `installWireDouble`/`__injectStreamFrame`）注入一条**整行**帧即可造出该形状。

**修法方向（不预设实现细节，但把不许破的边界写死）。** 让那道偏移闸不再把**布局引起的** offset 变化读成用户意图，同时**不得**削弱 AC-109：小幅手势脱离后必须仍然粘住、不被拉回。方向是把"这个 offset 是谁动的"从**数值比较**换成**归因**（谁的写入/哪次输入造成），而不是放宽容差、加固定延时、或直接删闸。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：本条与 `gap-transcript-follow-finalize-remount-loses-bottom`（行重挂载）、`gap-transcript-follow-browser-scroll-not-user-intent`（意图归因）、`gap-transcript-follow-on-content-resize`（就地增长触发信号）同族但触发面不同 —— 分别是"行到达"、"行重挂载"、"意图"、"就地增长"，本条是**行到达 + 偏移闸误读**，不重复其中任何一条。上述三条均已完成，不作为本条的前提，也不阻塞本条派发。

## Plan

1. **夹具**：在 `e2e/transcript-follow.spec.ts` 的页内 wire double 上增加"注入一整行"的能力（`kind: 'text'`、`role: 'assistant'`、带墙上时钟 `data-message-timestamp`），复用既有的几何采样约定（布局与 ResizeObserver 回调之后再采样：rAF 内 `setTimeout 0`，不得直接读 rAF 内的 `scrollHeight`）。行高必须**明显超过 pane 高度**，否则新行落在折线附近、占位盒不参与，族无法分离。
2. **红先行（并可如实为空）**：在今天的代码上跑该用例并逐帧打印 gap / rows / 末行高度 / 按钮可见性。**若不复现，立即停并如实登记读数与当时的窗口内容**（禁止为了让判据红而改夹具），本条按"未复现"收尾并把读数留给后续。
3. **判别移动者**：在同一用例里记录每一帧的 `scrollTop` 变化来源（应用写入 vs 浏览器 clamp/anchoring）。早先四组 CSS 热修改（`contain` 全关 / `overflow-anchor:none` / `contain-intrinsic-size:auto` / `content-visibility:visible`）**全部没能复现**（基线同时为绿，因为窗口内只剩矮行），因此那一轮不构成判别；本轮夹具必须让**基线红、关掉占位高度的那一版绿**，族才算可分。
4. **修复**：把偏移闸改为按来源判定；保持 `isUserScrolledUp` 语义、`nearBottom < 50`、`pendingScrollRestore`、搜索跳转、`loadOlderMessages` 一律不变；不得靠放宽阈值/加 debounce/删断言换绿。
5. **抗假变体（各留原始输出与还原证据）**：A) 删掉那道偏移闸（或改成恒 pin）⇒ **AC-109 必须红**；B) 改成"只在 `chatMessages.length` 变化时 pin"（回到行数信号）⇒ **AC-106/108 必须红**。两个变体各自只打一侧，合起来证明新用例与既有判据互为补集。
6. **文档**：`docs/architecture/05-scrolling.md` 记录了跟随的两道闸；若本次改动使其表述失真，同任务内同步（并在 Touches 内声明）。
7. 任何落在 Touches 之外的写入点，**先改本任务 Touches 再动手**（Touches 是声明面）。

## AC

- [ ] 新增 e2e 用例（标题以 `a whole row arriving while pinned` 起头），命令 `npx playwright test e2e/transcript-follow.spec.ts -g "a whole row arriving while pinned"`；**修前退出码非 0**，并逐帧打印 `gap` / `rows` / `lastRowH` / 按钮可见性；该命令墙钟 < 120s（打印实测值）。
- [ ] 红因是机制而非夹具：输出里 ≥5 个追加行的 gap 序列**单调增大**，且每行 `lastRowH` 的首帧值 = 240（±2）与落定值之差 ≥ 100px —— 即占位高度确实参与。若读数不满足，按 Plan 第 2 步如实收尾，不得改夹具凑红。
- [ ] 修后同一条命令连续 **≥2 次**退出码 0，且逐帧 `gap ≤ 1px`（或由本次运行导出的区间，写明区间来源）。
- [ ] 抗假变体 A 真跑并留输出：删掉偏移闸（或恒 pin）后 **AC-109 的命令必须退出码非 0**；`git checkout --` 还原后 `git status` 干净，并贴两次输出。
- [ ] 抗假变体 B 真跑并留输出：改为只在 `chatMessages.length` 变化时 pin 后 **AC-106 的命令必须退出码非 0**；还原同上。
- [ ] 新用例的几何断言之外**必须有内容/行数断言**（行数按注入次数增长、末行内容随注入变化）—— 只断言几何的用例挡不住"只改 DOM 不产出"的实现。
- [ ] `bash scripts/test.sh --for-task gap-transcript-follow-whole-row-append-drift` 退出码 0（本任务含 `*.test.*`，thin 亦为通过）；`npm run lint`、`npm run typecheck` 退出码 0。
- [ ] `git diff --name-only develop` 的全部改动落在 Touches 内；若必须动 Touches 之外的文件，Touches 已被先行更新。
- [ ] `docs/architecture/05-scrolling.md` 中与本改动冲突的表述已改正或明确无需改动（附 grep 读数）。

## DoD

真实落地判据（不是"用例存在"、也不是"某一次恰好绿"）：在**真实实例**（vite + 后端、隔离数据目录）上由该 spec 驱动真实浏览器客户端链路跑完全文 —— 注入整行、按帧采样、修前红 / 修后连续 ≥2 次绿，且两次抗假变体各自的红灯输出与还原证据记入完成记录。承重性由三件事正面证明：

(a) 红的是**机制**：gap 序列单调增大且占位高度（240px 首帧）参与（AC-2 的读数），不是夹具/端口/超时；
(b) 修的是**归因**而不是容差：删掉偏移闸 ⇒ AC-109 红（变体 A），回到行数信号 ⇒ AC-106 红（变体 B），两个变体各自只打一侧；
(c) 判据**两侧都亮**：新用例与 AC-106/108/109 在同一次运行里同时为绿，证明修法没有用"牺牲一侧"换另一侧。

环境噪声须如实登记（本机负载常驻 7~11）：若出现与被测机制无关的红（hook-timeout 类抖动），写明红因并给出"单独跑为绿"的对照读数，不得当作已完成证据，也不得靠加重试或删断言换绿。本条**不**依赖 ADR-003 的调试 Agent（尚未实现），也**不**以它为前提。

L_D 该轴仍暗，理由：本任务是渲染端跟随闸的一处归因修复，不新增产品领域能力，无可读出的领域读数。
L_G 该轴仍暗，理由：本任务不新增 goal 判据；若评审认为这一族需要目标级判据（可复现的整行到达漂移），应另行立案并把本用例的标题改点为对应 AC id。

## Touches

- e2e/transcript-follow.spec.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/tests/transcriptScrollOwnership.test.tsx
- tasks/gap-transcript-follow-whole-row-append-drift.md
