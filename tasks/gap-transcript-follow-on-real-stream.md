---
id: gap-transcript-follow-on-real-stream
title: 真实流式输出全程贴底：e2e 内 mock gateway 以 SSE 慢速吐 ≥20 个 text delta，经 realtime →
  store → React 就地改写逐帧 gap ≤1px，且 e2e spec 由红转绿（AC-108 判据
  e2e/transcript-follow.spec.ts）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-transcript-follow-on-content-resize
goal_ac: AC-108
---
## Proposal

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提；显式前驱只有 frontmatter 的 depends_on 那一条）：几何驱动跟随的实现、以及 `e2e/transcript-follow.spec.ts` 这条判据仪器的建立，出自 [[gap-transcript-follow-on-content-resize]]（AC-106）；[[gap-transcript-follow-on-pane-shrink]]（AC-107）同样改写该 spec 文件——两者 Touches 重叠，由池的 disjointness 门自动串行，不需要人工再串一条链。e2e 夹具约定与登录后置锚点约定出自 gap-session-filter-real-browser-e2e（done）与 gap-e2e-onboarding-anchor-seeded-transcripts（done）；本任务不重复申领 e2e 工具链本身。

### 现状（2026-09-21 源码核对 + 两次 SDK 实测）

判据表层红因与 AC-106/107 相同：`e2e/transcript-follow.spec.ts` 不存在，playwright 报 No tests found（红先行）。

但本条的红因比它们深一层：**claude 路径今天根本不产生「同一行就地改写」的帧**，所以即便 AC-106 的几何跟随已落地，本条的流式半仍然必红——没有 delta 就没有「最后一行慢慢长高」这件事。三条证据：

1. `server/modules/providers/list/claude/claude-runtime.provider.js:220` 的 `mapCliOptionsToSDK` 从不设置 `includePartialMessages`。实测（本机 SDK 0.3.165，直连一个本地 mock Anthropic SSE 端点跑 `query()`）：不设该选项时消息类型只有 `["system","assistant","result"]`；设 `includePartialMessages: true` 才出现 `stream_event:content_block_delta`。SDK 也只在选项为真时才给 CLI 加 `--include-partial-messages`（`sdk.mjs` 内 `if(Go)V.push("--include-partial-messages")`）。
2. 即便打开了该选项，`server/modules/providers/list/claude/claude-sessions.provider.ts:691` 判的是 `raw.type === 'content_block_delta'`，而 SDK 的 partial 消息形状是 `{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }`（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 `SDKPartialAssistantMessage`），全仓 grep `stream_event` 零命中 ⇒ 该分支永不命中，`stream_delta` / `stream_end` 永远发不出去。
3. 客户端链路是现成的，帧一到就会跑：`src/modules/chat/hooks/useChatRealtimeHandlers.ts:189` 把 `stream_delta` 缓冲 100ms 后 flush 给 `sessionStore.updateStreaming`（`src/modules/chat/hooks/useSessionStore.ts:810`），后者用**固定 id** `__streaming_<sessionId>` **替换同一行** ⇒ `chatMessages.length` 不变 ⇒ `useChatSessionState.ts:563-589` 的 follow effect（依赖数组 `[chatMessages.length, isActive, isUserScrolledUp]`）不触发。这正是 AC 写明的取假形态。

另：`docs/architecture/02-realtime-stream.md` 里「A streaming reply does not re-trigger auto-scroll … Within one streamed block the browser pins the pane」这句被 GOAL-004 的实测证伪，需随本条改正（AC-107 的同类改正落在 `05-scrolling.md`，两处不重叠）。

附带实测（本轮已验，供实现参考）：开启 `includePartialMessages` 后 CLI **不**把 partial 事件写进落盘 transcript——两次 probe 的 JSONL 里 `content_block_delta` 计数为 0，整段 assistant 仍以一条 `assistant` 记录落盘。所以「打开它会不会污染持久记录 / 让 synchronizer 从盘上产出 stream_delta 行」这个风险，用一条 AC 钉住即可，不必预先绕道。

### 方案

**A. 服务端：把 partial 消息这条路打开，并让 normalizer 认识 SDK 的真实形状**

1. `claude-runtime.provider.js` 的 `mapCliOptionsToSDK` 里设 `sdkOptions.includePartialMessages = true`。
2. `claude-sessions.provider.ts` 的 `normalizeMessageRows` 按 `raw.type === 'stream_event'` 拆包，再按 `raw.event.type` 分派：`content_block_delta` + `event.delta.text` → `stream_delta`；`content_block_stop` → `stream_end`。⛔ 不得改动 `assistant` 记录的既有处理：delta 只是临时态，整段 assistant 与落盘记录仍是权威（`finalizeStreaming` 用固定位置换 id 让 React 复用同一 DOM 的语义不许变）。
3. 不为此改动 wire 协议或客户端 store 的既有语义；`realtimeMessages` 的修剪/去重规则不动。

**B. e2e 仪器（`e2e/transcript-follow.spec.ts` 内新增一条用例，标题必须含字面量 `AC-108` 以便 `-g` 选中）**

- spec 内起 mock gateway（`http.createServer`，仿 `e2e/model-library.spec.ts` 的形状，它已证明「模型条目的 `ANTHROPIC_BASE_URL` → SDK 请求真的落到本机 socket」这条链路可用），对**被选中的内容请求**以 SSE 慢速吐：≥20 个 `content_block_delta`（`text_delta`）、整段 ≥5s、累计文本足以让最后一行长高超一屏。
- 选中规则按**请求体内容**，不按 URL：SDK 起标题的请求走同一 base URL。把每个请求体都记下来（含未被选中的），让「选错请求」可证伪；标题请求要么即时回一个空壳、要么立即失败，不得占用那 ≥5 秒。
- 经模型配置把该 gateway 写成某个自定义模型条目的 `ANTHROPIC_BASE_URL`，然后**经真实 UI 发送一条消息**（⛔ 不得 stub 后端、不得用 evaluate 直接改 store 冒充发送）。
- 采样：流式全程逐帧采 `gap = scrollHeight − scrollTop − clientHeight`，采样点必须在**布局与 ResizeObserver 回调之后**（页面内一个后注册的 ResizeObserver，或 rAF 内再 setTimeout 0）；⛔ rAF 内直接读 scrollHeight 读到的是 pin 之前的状态，不得当绘制态。取最大值断言 ≤1px。
- **活性断言（防空洞通过）**：流式期间行数 `chatMessages.length` 不变、而最后一行累计长高 > 一屏，且可归因的增长步数 ≥ 网关实际吐出的 delta 数（≥20）。没有这条，一个「根本不流式、一次性渲染完」的实现也能绿。
- 抗假变体（真跑、留输出、须还原）：(i) 把跟随改回 React 信号（`chatMessages.length`）⇒ 本条必须红；(ii) 网关一次性返回终态（零 delta）⇒ 活性断言必须红。
- 登录后置锚点不得等 Choose Your Project 空态（播种会让该 workspace 自动成为项目），锚在真实视图里必然存在的元素（如 Settings 按钮）上。

**C. 判据墙钟 ≤30s 的现实约束（如实登记）**

本轮实测：一条只跑 4 个用例、不涉及发送的既有 spec（`e2e/model-library-layout.spec.ts`）**整条命令 14.86s**（两个 webServer 启动 + Chromium + 4×2.2s 用例）。⇒ 30s 预算里固定开销约 6–8s，留给「登录 + 模型配置 + ≥5s 流式」的余量很薄。若实测超 30s，允许的削减手段是**夹具成本**（例如在 `beforeAll` 里经 REST 建账户/模型，而不是一路点 UI），⛔ 不得削减 ≥5s/≥20 delta 的下限，也不得把「经界面发送」降级成直接调 API。

### 非目标

- 不追查「流式更新成块到达」（实测一次 DOM 冻结 19 秒后一次性增长 1825px）——GOAL-004 已明确它属于 realtime 刷新链路，另立任务。
- 不实现 AC-109/110/111 的语义（向上手势立即脱离、顶部翻页不被抢回、非用户输入滚动不改意图）。
- 不依赖浏览器 scroll anchoring 或 CSS 钉底技巧。

## AC

- [ ] `npx playwright test e2e/transcript-follow.spec.ts -g "AC-108"` 退出码 0，且**实测墙钟 ≤30s**（含两个 webServer 与 Chromium 启动；把 wall time 记入完成记录）。
- [ ] 同一 spec 的流式半：mock gateway 对按请求体选中的内容请求以 SSE 慢速吐出 ≥20 个 `content_block_delta`、整段耗时 ≥5s；断言最后一行累计长高超一屏，且流式全程逐帧 gap ≤1px；采样点在布局与 ResizeObserver 回调之后（后注册 ResizeObserver 或 rAF 内 setTimeout 0），⛔ 不得用 rAF 内直接读 scrollHeight 当绘制态。
- [ ] 同一 spec 的活性断言：流式期间 `chatMessages.length` 不变、最后一行长高 > 一屏、可归因增长步数 ≥ 网关吐出的 delta 数（≥20）；并断言 gateway 收到的请求体里被选中的确实是内容请求，未被选中的标题请求体一并留证。
- [ ] 抗假变体真跑并留输出后还原：(i) 跟随改回 `chatMessages.length` 信号 ⇒ 本条红；(ii) 网关一次性返回终态 ⇒ 活性断言红；`git diff` 证明 spec 的真实断言一条未删、未经 stub/skip。
- [ ] 服务端单测（新建 `server/modules/providers/tests/claude-stream-event-unwrap.test.ts`，经模块 barrel 导入）：`{type:'stream_event', event:{type:'content_block_delta', delta:{type:'text_delta', text}}}` 经 `normalizeMessage` 产出 `kind:'stream_delta'` 且 content 正确；`content_block_stop` 产出 `stream_end`；`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-stream-event-unwrap.test.ts` 退出码 0。
- [ ] 落盘不被污染：跑完判据那轮之后，该会话的 transcript JSONL 与 REST 历史里**没有** `stream_delta` / `stream_end` 行（用断言或可复跑的命令钉住，不是人工目测）。实测依据：2026-09-21 两次 probe 的 JSONL 中 `content_block_delta` 计数为 0，assistant 仍以一条记录落盘。
- [ ] `npm run test:client`、`npm run typecheck`、`npm run lint` 退出码 0（`npm run lint` = `oxlint src/ server/`；⛔ 裸 `npx oxlint` 在干净 develop 上就退出 1，不作为判据）。
- [ ] `docs/architecture/02-realtime-stream.md` 里「流式期间浏览器把 pane 钉在底部 / 流式不重新触发 auto-scroll」的表述已改正为几何驱动跟随；`git diff --stat` 可见未碰该节之外的内容。

## DoD

真实落地判据：不是 spec 文件存在，也不是某一次恰好绿。要求在真实实例（vite + 后端，隔离数据目录）上由该 spec 驱动真实浏览器走完 AC-108 全文——经界面发送、mock gateway 真吐 ≥20 个 delta 跨 ≥5s、真实 realtime → store → React 就地改写、布局与 ResizeObserver 回调之后的逐帧采样——判据命令**可重复地**退出 0（连续 ≥2 次），并把两个抗假变体的红灯输出与还原证据记入完成记录；AC-108 在驱动器下一轮经 `goal_ac: AC-108` 独立核验时由红翻绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。

⛔ 不得靠 spec 里 `evaluate` 打补丁、不得靠注入脚本模拟「跟随」换绿——判别方式就是两个抗假变体必须红。⛔ 也不得把判据缩短成「无 delta 也绿」：活性断言就是防这个的。

⛔ 已知仪表风险，如实记录而不是谎报绿：goal gate 的 `runAcceptance` 有 60s 硬超时，而本条自设 30s 预算、且要起两个 webServer 再跑一次 Chromium（同形既有 spec 实测 14.86s）。取得读数时**同时记 wall time**；若某次以「acceptance timed out」收场，那是判据仪表的读数丢失，点名它，不要把超时当绿、也不要把超时当代码缺陷。

登记（避免下一轮踩同一坑）：e2e 端口 47101/47173 写死在 `playwright.config.ts`，并发 worktree 的 e2e 会撞死端口，取得读数前先确认端口空闲（`ss -ltnp | grep -E '47101|47173'`）。`scripts/test.sh` 的 scoped 门对 `e2e/*.spec.ts` 判 thin，照常跑判据命令、服务端 lane、`npm run test:client`、`npm run typecheck`、`npm run lint`。本任务**预期不需要**改 `src/modules/chat/hooks/useChatSessionState.ts`（几何跟随由 AC-106 落地）；若确实需要改，把它加进 Touches 再改。

L_D 该轴仍暗，理由：本任务开放的是流式帧的传输与前端几何跟随，不新增领域数据能力，没有可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是浏览器里的像素几何（gap / 行高增长步数）与网关请求体的选择，不是生成质量轴。

## Touches

- e2e/transcript-follow.spec.ts
- playwright.config.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/modules/providers/tests/claude-stream-event-unwrap.test.ts (new)
- docs/architecture/02-realtime-stream.md
- tasks/gap-transcript-follow-on-real-stream.md
