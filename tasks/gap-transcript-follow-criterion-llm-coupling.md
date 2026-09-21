---
id: gap-transcript-follow-criterion-llm-coupling
title: AC-108/AC-109 的帧来源改由页内 wire double 夹具驱动：判据不再依赖 LLM 客户端（删掉 ANTHROPIC_*
  仍绿），两条 expect 与 GOAL-004 退出条件同批重写，AC-109 退回 active
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

AC-108（真实流式输出全程贴底）与 AC-109（流式期间向上的小幅手势立即脱离）的判据命令都跑 `e2e/transcript-follow.spec.ts`，而这条 spec 制造「流式」的方式是：经 composer 发一条消息 → 服务端 `claude-runtime.provider.js` 的 Agent SDK `query()` → spawn `claude` CLI 子进程 → HTTP 打到 spec 内 mock gateway 的 SSE → CLI stdout → 归一化 → ws → 客户端。也就是说，一条**前端几何**判据的帧来源是一个真实的 LLM 客户端。

2026-09-21 实测：这条判据在 goal ring 里被评估 **101 次、fail 101 次**，从未通过；而它的产品读数（`unpinnedFrames []`、`maxGrowthFrameGapPx 1`、`nodeRuns [1]`、`offBottomFrames 0`）与通过时**逐项一致**。红因不在产品，而在夹具对进程环境的耦合：

- goal 环用 driver anchor 的进程环境 spawn 判据（`runAcceptance({ command: criterion, cwd: root })`，env 继承 anchor）；
- anchor 环境没有 `ANTHROPIC_DEFAULT_HAIKU_MODEL`；
- spec 的 mock gateway 靠**模型 id** 把「本轮回合」与「SDK 自己起标题的请求」分开（`streamReplyFor`：`if (modelId !== AC108_MODEL.id) return null`）；
- 该变量缺省时，起标题那次调用落在**同一个模型 id** 上 → gateway 把两条请求都 streamed → `expect(streamedHits).toHaveLength(1)`（`e2e/transcript-follow.spec.ts:2738-2743`）直接红。

复现证据（本机实测，非推断）：在我的 shell 环境单跑 `1 passed (18.8s)`；换成 anchor 环境 `rc=1`、红在同一句；A/B 对消——从我的环境删掉 `ANTHROPIC_*` ⇒ 红，给 anchor 环境加回 ⇒ 绿；单变量——只给 anchor 环境加 `ANTHROPIC_DEFAULT_HAIKU_MODEL` ⇒ `rc=0`。

同一套 CLI+gateway 夹具还被 AC-109 用着（同文件、同样 New Session + 选 gateway 模型）。AC-109 只是没有对 `streamedHits` 计数（全文件只有 2739-2743 用它），所以在同一环境下侥幸绿——同一个耦合留在了一条已 achieved 的判据里。

**方案：伪造传输/来源，绝不伪造消费者。** 把帧的来源从 LLM 客户端换成**页内 wire double**——在 app 首个脚本前包装 `window.WebSocket`，向 app 自己 new 出来的实例派发真实 `MessageEvent`（data 为服务端同形的 JSON）。该技术在本文件里已被证明可行：现有的 `instrumentStreamFrames`（`:124-143`）就是同一个包装，而 AC-108 读数里的 `stream_delta: 22` 正是它记下的，说明这个包装确实抓到了 app 自己的 socket 实例；本次只是把它从「观察」变成「可注入」。⛔ 帧只能经 socket 的 message 事件进入 app，不得调 `sessionStore`、不得直接改 DOM。

已排除的方案（本轮回合定案，理由一并记下）：

- **transcript watcher 路径**：查证后不成立。watcher 只广播 `broadcastSessionUpsertedBatch`（`sessions-watcher.service.ts:147`），而该事件的自我说明是「everything a **sidebar** needs」（`session-upsert-broadcast.service.ts:11-19`）；客户端 chat 侧对该帧直接 return（`useChatRealtimeHandlers.ts:176`），打开的会话**不会**因此重取消息。pane 的唯一帧生产者是 `chatRunRegistry.startRun`，只被 `chat-websocket.service.ts:228` 调用（chat.send / edit-send）→ provider runtime → LLM 客户端。今天**不存在**「非 LLM、又能让打开中的 transcript 就地增长」的应用内路径，用它当载体等于测一件不会发生的事。
- **服务端 replay 动词**：为测试在生产 WS 协议上新增动词 + 环境守卫，买的是这条**前端**判据没有声称的服务端真实性。
- **最小修**（把 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 写进模型条目 `config.env`）：只让今天的夹具在任意环境稳定，CLI/SDK 仍在环里，SDK 版本一变仍会翻，不满足「判据不依赖 LLM 客户端」。

**覆盖面转移**（AC-108 改完不再承担的部分，逐条交代去向）：

- 「SDK 的 partial frame → 线上 `stream_delta`」：`server/modules/providers/tests/claude-stream-event-unwrap.test.ts`（其导出注释原文即 without a live CLI in the loop）。
- 「`stream_delta` → 订阅者逐帧、带 seq」：`server/modules/websocket/tests/chat-run-registry.test.ts:48-73`。
- 「消息经 composer 真的发到模型端点」：AC-027（GOAL-001，achieved）。
- **唯一无人守的一环**：`claude-runtime.provider.js:963-977` 的 `for await (const message of queryInstance) { … for (const msg of normalized) ws.send(msg) }`——「归一化出来的每一帧真的交给 writer」。已另立 `gap-claude-runtime-frame-forwarding-coverage` 承接（本条不申领）。

实现要点（留给执行者，都是实测过的坑）：

- 播种会话可直接用：`--resume` 要求 UUID 这件事只对 CLI 成立，夹具没有这个约束。AC-106 已在默认 viewport（1280×720，即 `AC108_VIEWPORT`）上滚动同一个种子会话，故**无需**改 `playwright.config.ts`。
- **不要用 `page.clock` 冻结时钟**：`updateStreaming` 每次 flush 重铸 `timestamp`，冻结后 `stampChanges` 恒为 0，机制断言变成不可观测（AC-108 现有注释已记此事）。改用真实时钟 + 250ms 投递间隔。
- goals 的改动落在**主 checkout**（`QUAY_NATIVE_GOAL_DIR` 是绝对路径），worktree 里那份会保持旧文本：写完把 `goals:` 提交 cherry-pick 到任务分支，否则 fan-in 的 ac-gate 读到的是旧 expect。
- ⛔ 不投 `complete` 帧：它会让 app 去服务端刷新一个夹具里不存在的回合。

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提）：本任务要替换的夹具由 [[gap-transcript-follow-on-real-stream]]（done）建立；AC-108 的收窄与其豁免形态出自 [[gap-transcript-follow-finalize-remount-loses-bottom]]（done，已把豁免改回字面量）；手势与翻页语义分别由 [[gap-transcript-follow-small-gesture-detaches]]、[[gap-transcript-follow-prepend-restore-not-reattaching]] 承载（均 done）；几何仪器由 [[gap-transcript-follow-on-content-resize]]、[[gap-transcript-follow-on-pane-shrink]]、[[gap-transcript-follow-browser-scroll-not-user-intent]] 建立。它们与本条 Touches 重叠，由池的 disjointness 门自动串行，本任务不重复申领它们的语义。

## AC

- [ ] AC1 新仪器下 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"` 退出码 0 且墙钟 ≤ 20s；读数满足 `unpinnedFrames []`、`offBottomFrames 0`、`nodeRuns [1]`、`stampChanges ≥ 20`、`growthStepsInStream ≥ 21`、`minGapPx ≥ -1`（读数行原样贴进完成记录）。
- [ ] AC2 判据不依赖 LLM 客户端：`env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"` 退出码 0——这正是今天必红的那个条件。
- [ ] AC3 夹具里不再有 LLM 面：`grep -cE "createServer|AC108_MODEL|streamReplyFor|transcriptFile|pollutedLines" e2e/transcript-follow.spec.ts` 输出 0。
- [ ] AC4 帧只能经 socket 进入 app：`grep -cE "updateStreaming\(|sessionStore\.|setMessages\(" e2e/transcript-follow.spec.ts` 输出 0（注入只经 `window.__injectStreamFrame` 派发 `MessageEvent`）。
- [ ] AC5 抗假变体在新仪器上重跑并留输出：(i) 跟随触发信号改回 `chatMessages.length` ⇒ 必红；(ii) 一次性终态（单帧投递全文）⇒ 必红（活性 `growthStepsInStream ≥ 21`）。两者各自完整还原后 `git diff -- e2e/transcript-follow.spec.ts` 为空。
- [ ] AC6 `npx playwright test e2e/transcript-follow.spec.ts -g "AC-1"` 退出码 0（AC-106/107/109/110/111 在同一次运行里全绿）。
- [ ] AC7 四份记录同步：`goals/AC-109-…md` 的 `status` 退回 `active`；`goals/AC-108-…md` 与 `goals/AC-109-…md` 的 `expect` 重写为夹具驱动表述并含「不含任何模型/CLI/外部服务」；`goals/GOAL-004-…md` 的退出条件中对应两行同步；`grep -c "spec 不存在" goals/AC-108-*.md goals/AC-109-*.md` 均为 0。
- [ ] AC8 静态与套件：`npm run lint` 退出码 0、`npm run typecheck` 退出码 0、`bash scripts/test.sh --for-task gap-transcript-follow-criterion-llm-coupling --allow-thin` 退出码 0。

## DoD

真浏览器（真实 bundle + 真实服务）里，一条**不含任何模型、CLI 或外部服务**的夹具把 22 个 `stream_delta` + 1 个 `stream_end` 经 app 自己的 socket 投递给客户端；pane 从最后一行首次增长起到采样结束（含收尾帧）逐帧贴底、两侧都界，行始终是同一个 DOM 节点被反复就地重投影（`nodeRuns [1]` 且 `stampChanges ≥ 20`），采样窗口内行数恒定。两个抗假变体在**新仪器**上各自红过并留输出（旧仪器上的红不算数）。AC-106/107/109/110/111 全绿。四份 goal 记录与新判据一致。「不依赖 LLM 客户端」由 AC2 直接证明（删掉 `ANTHROPIC_*` 仍绿），不靠声明。

## Touches

- e2e/transcript-follow.spec.ts
- goals/AC-108-真实流式输出全程贴底.md
- goals/AC-109-流式期间向上的小幅手势立即脱离跟随且不被拉回-按钮可回到跟随.md
- goals/GOAL-004-对话流在真实浏览器里跟随几何变化-贴底时始终看到最新输出-离开时不被拉回.md
- tasks/gap-transcript-follow-criterion-llm-coupling.md
