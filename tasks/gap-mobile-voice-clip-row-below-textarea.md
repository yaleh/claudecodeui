---
id: gap-mobile-voice-clip-row-below-textarea
title: 移动端录音回放独立成 textarea 与 footer 之间的 chip 行：原始/裁剪后两条都可访问，不再挤占主操作栏；桌面仍在左侧工具组
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mobile-composer-footer-single-row-more-menu
---
## Proposal

来源方案：`docs/proposals/mobile-workspace-and-composer-layout.md` 第 3 节（本任务自包含）。仅前端，范围 `src/modules/chat/composer/ChatComposer.tsx`。

现状：`ChatComposer.tsx` 在左侧 `PromptInputTools` 里、语音按钮右侧渲染 `VoiceClipButton`（`clipSlot` 存在才渲染，可含 original 与 trimmed 两条）。390px 下出现回放时 footer 由一行折成两行（93px）。前序任务已把移动端主操作栏收敛为 `[附件][语音][更多] … [模型][权限][发送]`，本任务处理回放的落位。

目标：

```text
┌ 输入文字……                         ┐
│ [▶ 原始 0:15] [▶ 裁剪后 0:09]      │   ← 仅 clipSlot 存在时出现的独立行
├───────────────────────────────────┤
│ 附件 语音 更多       模型 权限 发送 │
└───────────────────────────────────┘
```

- `<768px`：回放控件放到 textarea 与 footer 之间的独立行；该行**只在 `clipSlot` 存在时**出现。单条与双条回放都允许在 chip 行**内部**换行，但**不得**导致 footer 换行；出现/消失回放时 footer 的高度与位置不变，变化只发生在 chip 行。
- `>=768px`：继续把回放控件放在当前左侧工具组（位置与现在一致）。
- `VoiceClipButton` 的回放、停止、时长、原始/裁剪后区分，以及单槽播放（一次只播一条）语义**保持不变**；两处渲染（若采用桌面/移动各一份）必须**共享同一个播放状态**（`clipPlayState` / `toggleClipPlayback`），不得各自持有一份。
- 无障碍：任何时刻可访问性树里只能有**一套**回放按钮。若实现选择「渲染两份 DOM、用 CSS 显隐」，隐藏的那份必须以 `display:none`（如 `hidden` / `md:hidden`）从可访问性树与布局中完全移除，不能只是 `opacity-0` 或移出屏幕，也不能让屏幕阅读器读到两套 `Replay original` / `Replay trimmed`；若实现选择用 `isMobile` 信号只渲染一份，则同样要保证信号边界与 md（768px）一致。两种机制都可以，但**必须有一个在真浏览器里读出的可访问性树读数**（见 DoD）。
- 边界（方案已声明，不要试图“顺手解决”）：录音 chip 自身占约 36px，存在录音时输入区总高度仍约 159px；本任务解决的是主操作栏换行与信息层级，**不承诺**消除这 36px，不压缩 chip 高度，不自动丢弃最近录音。

不做：不改语音识别、录音裁剪、播放的业务行为；不改 `VoiceClipButton` 内部的回放/停止/时长逻辑（如确需改动，先用 task_write 把该文件补进 Touches 并说明原因）；不碰 `ActivityIndicator` 与消息 pane。

实施规范：按 `.agents/skills/frontend-module-standards/SKILL.md`。`voiceClipPlayback.test.tsx` 里现有断言的措辞「回放位于 composer 工具行」是旧布局的假设，要按新落位更新，而不是删掉断言。

## AC

- [ ] `npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` 退出码 0；更新后的用例分别验证移动档与桌面档，且失败信息打印实际读数：(a) 移动档、`clipSlot` 含 original 与 trimmed：`Replay original` 与 `Replay trimmed` 均存在、可区分、可点击，且它们所在容器在 DOM 顺序上**位于 textarea 之后、footer 之前**，且**不在** footer 内；(b) 桌面档：两条回放仍在左侧工具组（footer 内、语音按钮之后）；(c) 无 `clipSlot` 时移动档**不渲染** chip 行（该行的容器整体不存在，不是空容器）；(d) 单槽播放语义不变：播放 original 时点 trimmed，original 被停止、trimmed 接管（沿用该文件既有的这组断言）。
- [ ] 同一档位下回放按钮只有一套：`src/modules/chat/tests/chatComposerResponsive.test.tsx` 新增用例，在移动档与桌面档各自读 `getAllByRole('button', { name: 'Replay original' })`，可访问元素数**恰为 1**（对照：若渲染两份 DOM，测试须能读出被隐藏那份确实处于 `display:none`——jsdom 不解析 Tailwind 时，用注入等价 `display:none` 规则的样式表，或改用 `isMobile` 单份渲染，二者择一，并在失败信息里打印命中数）。
- [ ] 断点边界：`grep -nE '(^|[^a-zA-Z-])sm:' src/modules/chat/composer/ChatComposer.tsx` 中与回放行/回放容器相关的行无 `sm:` 命中（用 `grep -n` 读出行号并逐行核对，不以行号推断——静态判据的行号必须用 `grep -n` 现读）。这是机制层辅助闸，不变量由 DoD 的真浏览器读数证明。
- [ ] `npx vitest run src/modules/chat` 退出码 0（既有 chat 测试不回归）。
- [ ] `npm run typecheck` 与 `npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 预先非 0，不作判据）。

## DoD

真实落地判据：不是「测试存在」。要求在真实浏览器里通过语音调试上传入口（`?voiceDebug=1`，沿用 `e2e/voice-trim.spec.ts` 的录音/上传路径，产生**真实**的 original + trimmed 两条 clip，不得替身 `clipSlot`）读出下表并写进 Evidence，逐格记录实际数字：

| 视口 | 无回放 footer 高度 | 单条回放 footer 高度 | 双条回放 footer 高度 | `footer.scrollWidth === footer.clientWidth`（双条时） | chip 行位于 footer 之前 |
|---|---|---|---|---|---|
| 320×700 | 记录 | 必须与左栏相等 | 必须与左栏相等 | 必须 true | 必须 |
| 360×800 | 记录 | 同上 | 同上 | 必须 true | 必须 |
| 390×844 | 记录（改动前含回放为 93、两行） | 同上（目标 ≤57） | 同上（目标 ≤57） | 必须 true | 必须 |
| 767×900 | 记录 | 同上 | 同上 | 必须 true | 必须 |

（「必须相等」即回放出现前后 footer 高度保持不变，变化只发生在独立 chip 行。）另读四条：① 移动 390 下**可访问性树**里 `Replay original`/`Replay trimmed` 各恰 1 个（用 accessibility snapshot 或 `getByRole` 计数，不得用 `querySelectorAll` 数 DOM 冒充）；② 768 与 1280 下回放仍在左侧工具组原位、可访问性树同样各恰 1 个；③ 两条音频都真的可播放/停止：点 original 出现 `Stop original playback`，再点 trimmed 后 original 停止；④ 输入区总高度随录音出现而增加的量，如实记录（预期约 36px，方案已声明不消除，读数不得被写成「已消除」）。

读数如实标注边界：一次性探针不入库；永久回归矩阵由同一方案的 e2e 矩阵任务承担。

L_D 该轴仍暗，理由：本任务只移动一个既有控件的落位并更新旧断言，不产出领域数据或文档语义读数。

L_G 该轴仍暗，理由：同上；验证读数就是 DoD 里真浏览器的 footer 高度表与可访问性树计数。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- tasks/gap-mobile-voice-clip-row-below-textarea.md
