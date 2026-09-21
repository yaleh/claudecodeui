---
id: gap-transcript-follow-finalize-remount-loses-bottom
title: turn 收尾换 key 导致重挂载：pane 塌陷后可能停在底部之外；增长帧的 offset 亦被浏览器 clamp 到 0 ——
  钉死机制并修到 AC-108 能改回字面量「全程逐帧 gap ≤1px」
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra: {}
---
## Proposal

<!-- dedup-ref -->同机制关联（记给出处，不是本任务的前提）：本任务是 [[gap-transcript-follow-on-real-stream]]（AC-108）收尾时**找出但按范围排除**的那件事，读数与证据都由那一轮的 spec 留证（`e2e/transcript-follow.spec.ts` 的 AC-108 用例，`growthFrameGaps` / `postArrival*` / `firstCollapse` / `writesAtExcursions`）。AC-108 的收窄（把「全程最大 gap ≤1px」换成「除增长帧外逐帧贴底 + 增长帧必须下一帧修复 + 不越底」）就是因为本任务要修的东西在那里不可满足；**本任务做完之后，AC-108 应能改回字面量**。兄弟任务 [[gap-transcript-follow-browser-scroll-not-user-intent]]（AC-111，已 achieved）与本任务共享症状面但**场景不同**：AC-111 是「程序改 DOM 让上方一行变矮」，本任务是「turn 收尾时最后一行被换 key 导致重挂载」；[[gap-transcript-follow-on-content-resize]]（AC-106）、[[gap-transcript-follow-on-pane-shrink]]（AC-107）提供几何跟随与采样仪器，本任务不重复申领。⛔ 不重复申领 AC-109/110 的手势/翻页语义。

### 现状（2026-09-21，AC-108 实跑留证）

AC-108 的流式用例里有两个读数，都是**内容塌陷 ⇒ 浏览器把 `scrollTop` clamp 到 0 ⇒ 跟随要么下一帧修、要么没人修**，但两者的确定性不同：

1. **确定发生、且已直接观测：turn 收尾时的塌陷。** `stream_end` 到达后 `finalizeStreaming`（`src/modules/chat/hooks/useSessionStore.ts:836-853`）把该行的 id 由 `__streaming_<sid>` 换成新的 `text_<ts>_<rand>`；React 按 id keyed，所以这是 **unmount + mount** 而不是 reconcile。重挂载期间该行落到 `LazyMessageRow`（`src/modules/chat/transcript/LazyMessageRow.tsx:68-74`）的占位盒上（`height: measuredHeight ?? 100`，`measuredHeight` 只在行**离开**视口时才写），pane 的内容高度随之塌；随后替换回来的高度与塌前**完全一致**，`ResizeObserver` 因此看不到变化、从不回调，跟随也就从不被问「还该不该贴底」。实测：`firstCollapse` 帧读到 `scrollHeight` 落到自己的 `clientHeight`（496），最后一行盒高 240px（= 估算值 + 该行自身的 chrome），紧接着 `complete`。
2. **机制未证：每个 delta 增长那一帧的 clamp。** AC-108 的 `growthFrameGaps` 里 22 个增长帧的 `top` **全部为 0**（不是「落后一步」的 `bottom − step`），最坏读 1393px；同时 `writesAtExcursions` 为空、`zeroWrites 8` —— 那些帧上**没有任何 JS 写 `scrollTop`**，是浏览器自己 clamp 的，说明那一帧内 pane 的内容高度确实短暂塌过。**谁把它塌的还没证。** `LazyMessageRow` 是常驻嫌疑，但它的 observer 是 1200px `rootMargin`、无 threshold（`src/modules/chat/hooks/useLazyRowObserver.ts:49-52`），对一个 1671px 的行按几何算是 intersecting —— 嫌疑不等于结论，⛔ 不要把未证的机制写成本任务的前提。

收尾塌陷的后果**间歇**：一次跑 `postArrivalFrames 48`、`postArrivalSpanMs 765` 仍在窗外未恢复（`lastSampleGap 1355`，pane 停在距底 1355px 处，且此后不再有任何触发信号）；另一次第 409 帧就恢复（`postArrivalRecoveredAtFrame 409`）；还有一次只差 3 帧。间歇本身就是「重挂载与 observer 投递之间是竞态」的证据。

### 方案

1. **先把两个塌陷的机制钉死**，而不是先改代码：在 AC-108 的采样仪器上扩一个探针，逐帧记（a）pane 的 `scrollHeight` 与最后一行盒高、（b）该行的 `data-message-timestamp` / React key（重挂载会让 DOM 节点身份变化）、（c）该行是否处在 `LazyMessageRow` 的占位态（盒高 == `measuredHeight ?? 100`）、（d）`scrollTop` 的写入者（是否走过本项目自己的写路径）。增长帧那个 clamp 的写入者是「浏览器 clamp 而非 JS 写」已由 `writesAtExcursions` 为空证到；本步要证的是**谁在那一帧把内容塌了**。
2. **修收尾塌陷**（确定的那一个）。候选方向，实现时择一并记理由：(a) 让 turn 收尾不换 key（或换 key 同时保持 DOM 节点身份，例如把 streaming 行与 settled 行做成同一 key 的两种渲染态）；(b) 让 `finalizeStreaming` 之后跟随被显式问一次（把「贴底」的重申挂在收尾事件上，而不是只挂在几何观察上）；(c) 让 `LazyMessageRow` 对**最后一行**不退化到占位盒。⛔ 不许把「贴底」做成对 `chatMessages.length` 的依赖（那正是 AC-108 的抗假变体 (i) 打死的形态）；⛔ 不许在 pane 上加 CSS 钉底或依赖浏览器 scroll anchoring。
3. **增长帧的 clamp**：机制钉死后若与第 2 步同因，一并修；若不同因，修它并在完成记录里把两者的区别写清楚。两个都修完，AC-108 的第二条应能把豁免去掉、改回字面量「流式全程逐帧 gap ≤1px」。
4. **回归面**：`e2e/transcript-follow.spec.ts` 里 AC-106/107/108/110/111 五条既有用例全部保持绿；AC-108 的活性断言与两个抗假变体的红灯不得被削弱。

### 非目标

- 不实现 AC-109/110/111 的语义（向上手势立即脱离、顶部翻页不被抢回、非用户输入滚动不改意图）。
- 不改 wire 协议；不动 `realtimeMessages` 的修剪/去重规则。
- 不修「流式更新成块到达」（GOAL-004 已明确属于 realtime 刷新链路，另有任务）。

## AC

- [ ] 探针把两个塌陷的机制各钉到一处可复跑的读数上：增长帧的内容塌陷由**哪个提交/哪次写入**引起（点名文件与行），收尾塌陷由**哪次重挂载**引起（记 DOM 节点身份变化与占位态盒高）；⛔ 不接受「疑似 `LazyMessageRow`」这种未证结论，也不接受只有相关性没有因果的读数（判别方式：把该原因去掉后那一帧的 `scrollHeight` 不再塌）。
- [ ] 收尾塌陷被修掉：`e2e/transcript-follow.spec.ts` 内新增/加强的断言要求从 finalize 帧起 pane 逐帧贴底（`gap ≤1px`，沿用 AC-108 的采样点：rAF 内再 `setTimeout 0`），并且**活性断言要求那次塌陷真的被观测到**（未发生塌陷则本用例红，防空洞通过）；本断言在修之前必红、修之后连续 ≥2 次绿。
- [ ] 增长帧的 clamp 被修掉或按上面第 3 步如实分流；修掉之后 AC-108 的第二条改回字面量「流式全程逐帧 gap ≤1px」并连续 ≥2 次绿（把两次墙钟一并记入完成记录）；若分流为「不同因、本任务不修」，则必须在完成记录里给出该因的独立读数与另立任务的 id。
- [ ] `e2e/transcript-follow.spec.ts` 的既有用例（AC-106/107/108/110/111）全部保持绿：`npx playwright test e2e/transcript-follow.spec.ts -g "AC-1"` 退出码 0；AC-108 的两个抗假变体（`chatMessages.length` 信号、一次性终态）仍然分别红在原来的断言上，留输出后还原。
- [ ] `npm run test:client`、`npm run typecheck`、`npm run lint`（= `oxlint src/ server/`；⛔ 裸 `npx oxlint` 在干净 develop 上就退出 1，不作判据）退出码 0；若改到 `src/` 的跟随几何，服务端 lane 亦绿。
- [ ] `docs/architecture/02-realtime-stream.md` 中与「`finalizeStreaming` 换 key ⇒ unmount/mount ⇒ 占位盒塌陷」有关的表述按最终实现改正（本任务如改了机制，前一条任务的改正文本可能过时）。

## DoD

真实落地判据：不是「改了一处代码」，而是两个塌陷各自被钉到一处可复跑的读数、且修完之后 **AC-108 能回到字面量**（不再需要「除增长帧外」这个豁免）。判据在真实实例（vite + 后端、隔离数据目录、真实 Chromium）上由 spec 驱动，命令可重复地退出 0（连续 ≥2 次），并留下修前必红、修后转绿的两份输出。

⛔ 不得靠改判据换绿：本任务的成功标准包含「AC-108 的断言变严而不是变松」；把豁免改成别的豁免、或把活性断言调松，都算没做完。⛔ 不得用 stub/skip 或 `evaluate` 打补丁绕过重挂载。

登记（避免踩同一坑）：e2e 的端口对与 `outputDir` 已是 per-run（`playwright.config.ts`，2026-09-21 落地），并发 worktree 不再互相杀端口；但 fresh-DB 首次 onboarding 的 `beforeAll` 有约 1/7 的概率在 ~184s 超时红（见记忆 e2e-fresh-db-onboarding-hook-timeout），按墙钟归属并重跑，⛔ 不要加 retry。goal gate 的 `runAcceptance` 有 60s 硬超时，取读数时同时记墙钟。

L_D 该轴仍暗，理由：本任务修的是浏览器内的几何跟随与重挂载竞态，不新增领域数据能力，没有可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是像素几何（gap / 行盒高 / DOM 节点身份）与观测器回调时序，不是生成质量轴。

## Touches

- e2e/transcript-follow.spec.ts
- src/modules/chat/transcript/LazyMessageRow.tsx
- src/modules/chat/hooks/useLazyRowObserver.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/hooks/useSessionStore.ts
- docs/architecture/02-realtime-stream.md
- tasks/gap-transcript-follow-finalize-remount-loses-bottom.md
