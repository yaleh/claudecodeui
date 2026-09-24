---
id: gap-mobile-activity-inline-single-stop
title: 移动端执行状态进入消息流末尾（无 Stop、不覆盖消息），只保留右下角主 Stop 一个入口；桌面仍用 composer 上沿 tab 状态
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mobile-voice-clip-row-below-textarea
---
## Proposal

来源方案：`docs/proposals/mobile-workspace-and-composer-layout.md` 第 4 节（本任务自包含）。仅前端，范围 `src/modules/chat/`。

现状：执行中，`ChatComposer.tsx` 在输入框上沿渲染 tab 形 `ActivityIndicator`（含 Stop 与 Esc 提示），同时右下角 `PromptInputSubmit` 也变成 Stop——移动端出现**两个**可访问名为 Stop 的入口；`ChatMessagesPane` 在 `hasActivityIndicator` 时给消息区底部预留 `pb-12 sm:pb-14` 以避让这块浮层。`ChatInterface.tsx` 已持有 `sessionActivity`（来自 `useChatSessionState`），并把 `hasActivityIndicator` 传给 pane。

目标：

- `<768px`：在 `ChatMessagesPane` 的**消息内容末尾**渲染紧凑状态行（脉冲点、活动文本、elapsed time）。状态行参与正常文档流，**不使用覆盖消息内容的绝对/固定定位**；**不带 Stop**；右下角 `PromptInputSubmit` 是唯一停止入口。composer 上沿的 tab 形 `ActivityIndicator` 在移动端不渲染。
- `>=768px`：继续使用 composer 上沿 tab 形 `ActivityIndicator`，保留现有 Stop 与 Esc 提示；桌面布局与行为不变。
- `ActivityIndicator.tsx` 增加 inline / tab 两种展示 variant；inline variant 不渲染 Stop；**计时与退出动画逻辑只保留一份**，两种 variant 共用，不得复制一份。
- `hasActivityIndicator` 对消息 pane 底部 padding 要区分断点：移动端已有流内状态，不再为浮层预留 48px；桌面端继续预留。
- 权限请求出现时继续隐藏普通活动状态，维持当前优先级（移动与桌面一致）。
- 状态跟随：inline 状态行进入消息流后必须继续触发现有 follow-to-bottom 逻辑；**用户主动向上滚动时不能强行拉回底部**。
- `ChatInterface.tsx` 把现有 `sessionActivity` 传给 `ChatMessagesPane`；**不新增可由它派生的状态**。移动/桌面边界用 `md`（768px），与 `useDeviceSettings().isMobile` 一致，不用 `sm`。

不做：不改中止/排队/发送的业务行为，不改 `sessionActivity` 的产生方式，不改 WebSocket 协议；不碰 header、录音回放与 footer 的其它布局（前序任务负责）。

实施规范：按 `.agents/skills/frontend-module-standards/SKILL.md`（导出组件消费者注释、新增 state 须注释用途、新测试跨模块只经 barrel 导入）。若实现发现跟随逻辑在 `ChatMessagesPane.tsx` 之外的文件里（如滚动 hook），先用 task_write 把该文件补进 Touches 再改。

## AC

- [ ] `npx vitest run src/modules/chat/tests/activityIndicatorResponsive.test.tsx` 退出码 0，用例各自独立、失败信息打印实际读数：(a) inline variant 渲染活动文本与 elapsed time，且其子树内**无** Stop 按钮（无可访问名含 Stop 的元素）；(b) tab variant 渲染活动文本与 Stop，且 Esc 提示仍在（桌面不变的正向对照）；(c) elapsed time 随（假）时钟前进，且 inline 与 tab 两种 variant 读到同一份计时来源（同一 `activity.startedAt` 下读数一致）；(d) `activity` 由非空变为 `null` 时按现有退出动画行为收起，inline variant 与 tab variant 行为一致；(e) 移动档 `ChatMessagesPane` 在消息列表**末尾**渲染 inline 状态行（DOM 上位于最后一条消息之后、且位于滚动容器内部），其类名不含 `absolute` 与 `fixed`；(f) 桌面档 pane 不渲染 inline 状态行。
- [ ] `npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx` 退出码 0，新增用例：`activity.canInterrupt=true` 时，把 composer 与 pane 一并渲染的移动档可访问性视图里，可访问名含 Stop 的按钮**恰好 1 个**（且为 `PromptInputSubmit`）；桌面档保持现状（tab 状态 Stop + 主 Stop 的既有读数原样，不得因本任务变化）；存在 pending 权限请求时，两档均**不**渲染普通活动状态（inline 与 tab 都没有）。
- [ ] 底部 padding 按断点区分：移动档 `hasActivityIndicator=true` 时 pane 内容底部间距**不含**为浮层预留的 `pb-12`，桌面档仍预留（用例读出两档实际的类名或计算值并打印）。
- [ ] 跟随行为不回归：`npx vitest run src/modules/chat/tests/transcriptScrollOwnership.test.tsx src/modules/chat/tests/messageStreamEnd.test.tsx` 退出码 0；并在 `activityIndicatorResponsive.test.tsx` 新增用例——inline 状态行挂载/更新（elapsed 文本变化）时，用户处于底部则继续贴底；用户已主动上滚离底则**零次**程序化写 `scrollTop`（对照：与不带 inline 状态行的同一场景读数一致）。
- [ ] 断点边界：`grep -nE '(^|[^a-zA-Z-])sm:' src/modules/chat/composer/ActivityIndicator.tsx` 无命中（退出码 1）；`grep -n 'pb-12' src/modules/chat/transcript/ChatMessagesPane.tsx` 的命中行都带 `md:` 前缀或在桌面分支内（逐行核对）。这是机制层辅助闸，不变量由 DoD 的真浏览器读数证明。
- [ ] `npx vitest run src/modules/chat` 退出码 0（既有 chat 测试不回归）；`npm run typecheck` 与 `npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 预先非 0，不作判据）。

## DoD

真实落地判据：不是「测试存在」。要求对一个**真实执行中的会话**（或经既有 e2e 约定的 in-page WebSocket 替身喂入的真实 realtime 帧——伪造传输层、绝不伪造消费者，见 `e2e/transcript-follow.spec.ts`）在真浏览器里读出并写进 Evidence：

| 视口 | 可见且可访问的 Stop 个数 | 状态行相对最后一条消息的位置 | 消息正文是否被状态行覆盖 | 状态行是否随消息滚动 |
|---|---|---|---|---|
| 390×844 执行中 | 必须恰 1 | 紧随最后一条消息之后（文档流内） | 必须否（状态行与最后一条消息的边界框不相交） | 必须是（滚动后其 `getBoundingClientRect().top` 随之变化） |
| 320×700 执行中 | 必须恰 1 | 同上 | 必须否 | 必须是 |
| 767×900 执行中 | 必须恰 1 | 同上 | 必须否 | 必须是 |
| 768×900 执行中 | 主 Stop + tab 状态 Stop 与改动前读数一致 | composer 上沿 tab | — | — |
| 1280×720 执行中 | 同上 | 同上 | — | — |

另读：390 下发起一个权限请求时，普通活动状态消失（inline 状态行不在 DOM 里），权限提示可见；向上滚离底部后再来一段流式输出，页面**不被拉回底部**；活动结束后 inline 状态行按退出动画收起、pane 底部间距回落。「可见且可访问的 Stop」必须用可访问性树（`getByRole('button', { name: /stop/i })` 且可见）计数，不得用类名或 `querySelectorAll` 估算。

读数如实标注边界：一次性探针不入库；永久回归矩阵由同一方案的 e2e 矩阵任务承担，本任务不宣称已覆盖；若执行态由传输层替身喂入，须在 Evidence 里写明喂了哪些帧、没伪造什么。

L_D 该轴仍暗，理由：本任务改的是活动状态的呈现位置与一个 variant，不产出领域数据或文档语义读数。

L_G 该轴仍暗，理由：同上；验证读数就是 DoD 里真浏览器的 Stop 计数与状态行边界框读数。

## Touches

- src/modules/chat/composer/ActivityIndicator.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/activityIndicatorResponsive.test.tsx (new)
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- tasks/gap-mobile-activity-inline-single-stop.md
