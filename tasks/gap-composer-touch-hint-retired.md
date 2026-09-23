---
id: gap-composer-touch-hint-retired
title: 触摸设备不再显示发送键提示行：还原 `hidden lg:block`（手机省 20px），并把已达成 AC 的判据迁移到新的不变量
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

触摸设备的发送键提示行（`Tap ➤ to send • Return adds a line`）以 `basis-full` 独占 footer 一整行，常驻高度 = `leading-4`(16px) + footer `gap-y-1`(4px) = **20px**，且该行在任何宽度都渲染（`ChatComposer.tsx:612` 的 `touchOnly ? '' : 'hidden lg:block'`）。本任务：触摸设备回到"完全不显示这一行"。

形态沿革（已用 git 核实，不是推测）：

- 2025-07-11 `fc2a94a2` → 2025-11-06 `1e50cfda`：移动端有一个 `absolute bottom-1 left-12 right-14 … sm:hidden` 浮层，**0 高度**、仅在输入框聚焦且为空时显示，且文案是**键盘措辞**（在触摸设备上念 Shift/Ctrl）。
- 2025-11-06 `1e50cfda` 删除了该浮层 → 2026-09-22 `7d842d4c` 之前，移动端**完全不显示** hint（`hidden lg:block`，390px 与 780px 实测 `display:none`）。
- 2026-09-22 `7d842d4c`（`gap-composer-send-key-touch-scoped` 的落地）把触摸 hint 加了回来，形态变成 footer 独占一行 = 20px。**20px 这个形态只存在了 1 天。**

本任务要回退的正是最后这一步。做出该产品决定的理由（写在这里是为了让后来者不必重新论证）：

1. `Tap ➤ to send` 与紧邻的 ➤ 发送按钮完全重复，零信息——点箭头发送是通用约定。
2. `Return adds a line` 只在"行为**违背**预期"时才有价值。`gap-composer-send-key-touch-scoped`（done）的修复恰恰让行为**回到**平台惯例（软回车换行、由按钮发送；同类产品无一例外）。所以它在告诉用户他们本来就默认的事。
3. 唯一受益人群是"已养成回车=发送习惯的存量移动用户"，而那个习惯本身就是被修掉的缺陷；他们的困惑一次按键即自纠正。
4. 代价是**每一台触摸设备、每一次会话** 20px，而移动端是最缺纵向空间的一档。

**关键实现决定（不要做纯 revert）**：若只把类名改回 `hidden lg:block`，`submitHint` 就只剩 `enter`/`ctrlEnter` 两个分支，于是 **≥1024px 的触摸平板（iPad 横屏、Surface）会显示 `Enter to send • Shift+Enter for new line • Tab to change modes`**——软键盘没有 Shift，这正是 `gap-composer-send-key-touch-scoped` 要修的那一类缺陷。而现有 e2e 触摸 leg 只跑 390px，**测不到这个宽度，会静默通过**。因此类名必须是 `touchOnly ? 'hidden' : 'hidden lg:block'`：触摸设备任何宽度都不可见；键盘设备 <1024px 不可见、≥1024px 可见（维持桌面现状）。

行为**不变**：`src/modules/chat/hooks/useSendOnEnter.ts` 与 `src/modules/chat/hooks/useChatComposerState.ts` 的 keydown（约 :1108-1124，触摸设备 Enter 换行、Tab 切模式）**一行不动**。变的只是"要不要把这件事说出来"。

i18n 死键：改动后 `input.hintText.touch` / `touchQueue` / `touchUpdateQueued` 永不渲染（触摸设备整行不可见，键盘设备只走 enter/ctrlEnter 分支），12 个 locale 全删。留着会让"某 key 必须非空"这类判据变成空洞的真。

已达成 AC 的迁移（必须显式记录，不能静默重写）：done 任务 `gap-composer-send-key-touch-scoped` 的 AC-70 与 AC-71 随本次改动失去主体，但**失效方式不同**，处理也不同：

- AC-70（`touchOnly` 真时提示文案不含 Shift/Ctrl，且容器类名不含 `hidden`/`lg:block`）的验证命令是 `npx vitest run src/modules/chat/tests/sendOnEnter.test.tsx`。删掉两条 touch 用例后该文件**仍然退出 0**（键盘四条用例还在）——即命令绿、而其描述的内容已不存在。这是判据空洞，必须换成下面的 AC-1/AC-2，不能拿"文件还是绿的"当证据。
- AC-71（一条未入库的 `node -e` 脚本，校验 12 个 locale 的 `input.hintText.touch` 非空）会**真的变红**。它必须由下面的 AC-4 显式取代。
- AC-72（e2e 触摸 leg 的三条 Enter 行为断言）与 AC-74（抗假变体）**一字不动**：它们证的是行为，与文案无关。这正是本次改动安全的根据——删掉的是行为的**描述**，不是行为的**守卫**。

顺带记录但**不在本任务范围内**（避免范围蔓延）：`input.queue.*`（`QueuedMessageCard` 的文案）在 12 个 locale 里有 7 个整块缺失（de、fr、it、ja、ru、tr、zh-TW），卡片在那 7 种语言下渲染英文 fallback。另外，触摸 hint 删掉后 queue 态仍有两条独立信号（按钮变为 ↑、上方 QueuedMessageCard 显示内容与"会自动发送"），并非无提示。

落位按 `.agents/skills/frontend-module-standards/SKILL.md`。本任务**不新增、不移动任何测试文件**（改写已达成 AC 所钉的文件路径会连带把那些 AC 判红）。

## AC

每条须独立可反红，并在失败信息里打印**实际读数**。

- [ ] AC-1 提示分支收敛且键盘四条不回归：`npx vitest run src/modules/chat/tests/sendOnEnter.test.tsx` 退出码 0，键盘四条提示断言（`enter` / `ctrlEnter` / `queue` / `updateQueued`）逐字符等于 `src/modules/i18n/locales/en/chat.json` 的取值；且该文件对 `input.hintText.touch` 的引用数为 **0**（`grep -c` 读数打印）。失败信息须打印实际取到的提示文案与期望的 locale 取值。
- [ ] AC-2 触摸设备提示行不可见，且带阳性对照：`npx playwright test e2e/mobile-composer-send-key.spec.ts` 退出码 0，同一次运行内断言三格并分别可反红——(a) 390×844 + touch emulation 下 `div.basis-full` 的 `display === 'none'`；(b) **阳性对照** ≥1024px + touch emulation 下**仍为** `'none'`；(c) **阳性对照** ≥1024px 键盘设备下为 `'block'`。没有 (b)(c)，(a) 对"把 `hidden` 删光"这种惰性实现同样成立（惰性实现也得 0）。失败信息打印三格的 `{viewportWidth, touchOnly, display}` 实际读数。
- [ ] AC-3 抗假变体：把类名里的 `hidden` 去掉（`touchOnly ? '' : 'lg:block'`）后重跑该 spec，AC-2(a) 必须变红；还原后全绿，且 `git diff` 只剩本任务声明的写点。
- [ ] AC-4 i18n 死键清零，且带阳性对照：一条脚本校验 12 个 `src/modules/i18n/locales/*/chat.json` 均**不含** `input.hintText.touch` / `touchQueue` / `touchUpdateQueued`（任一存在即非 0 退出并打印哪个文件哪个 key），且 12 个文件仍是可解析 JSON；同一脚本对 `input.hintText.enter` 必须报"存在"——证明该检查不是在把一个恒假条件当通过。
- [ ] AC-5 行为不回归且前提断言仍在：同一 spec 的触摸 leg 三条 Enter 行为断言（空输入 Enter → 值 `"\n"`；输入文本后 Enter → 值恰好多一个 `\n` 且 `location.pathname` 不变；点 `button[aria-label="Send"]` → `pathname` 变为 `/session/<id>`）与桌面 leg 全绿，且该 spec 的 PREMISE 断言（页内 `matchMedia('(pointer: coarse) and (hover: none)').matches` 为 true、账号偏好为关）**未被删除**。
- [ ] AC-6 空间读数（本次改动的目的，现有测试全都测不到）：390×844 下 composer 的 `offsetHeight` 比改动前小 **20px**（±1），与 AC-2(a) 同一次运行内取得。失败信息打印改动前/后两个高度读数。
- [ ] AC-7 `npm run typecheck` 与 `npm run lint` 退出码均为 0（`npm run lint` 即 `oxlint src/ server/`；裸 `npx oxlint` 在本仓库预先就有诊断且非 0，不作为判据）。
- [ ] AC-8 迁移记录：本任务 Evidence 里逐条写明 `gap-composer-send-key-touch-scoped` 的 AC-70/AC-71 被取代的方式与取代后的判据（即 AC-1/AC-2/AC-4），并且**不改写**那个 done 任务文件里的原始 AC 文本（保留历史真值），只在新任务里记"已取代"。

## DoD

真实落地判据：不是"测试存在"，而是真实浏览器里的三格读数。在**同一次** Playwright 运行内，对 390×844 触摸、≥1024px 触摸、≥1024px 键盘三格各记录 `{viewportWidth, touchOnly, hintDisplay, composerHeight}`，原样贴进 Evidence。

- composer 高度必须**跨改动前后各测一次**（对 `develop` 的一次对照运行，或改动前先取一次基线），证明那 20px 是真的少了，而不是自说自话。
- ≥1024px 触摸那格是本任务的核心风险读数：必须在真 Chromium 下读到 `display:none`，且同一次运行内键盘同宽度读到 `block`。宽度与 touch emulation 必须由同一处配置一起下发（CDP 的 `setDeviceMetricsOverride` 在会话断开后失效而 `setTouchEmulationEnabled` 会留下——`gap-composer-send-key-touch-scoped` 的原型曾因此一度在 1280px 视口下测"触摸设备"）。
- 边界如实标注：触摸来自 Chromium 的 touch emulation，**不是真机软键盘**。"存量用户习惯"这一条是产品判断、无实测数据，必须标注为判断而非读数。
- 既有 e2e 已知坑沿用而非新增：新库首次启动走 onboarding，`beforeAll` 等 `#username` 在负载下约 1/7 概率红在 ~184s（安静时约 11s），按墙钟归因、不要加重试。
- L_D 该轴仍暗，理由：本任务改的是 UI 空间与提示可见性，不产出领域数据或文档语义读数；12 个 locale 的键位完整性由 AC-4 单独机械钉住，除此之外该轴没有可分离的度量。
- L_G 该轴仍暗，理由：同上；本任务的验证读数就是 DoD 里三格 `{viewportWidth, touchOnly, hintDisplay, composerHeight}` 与跨改动前后的高度对照。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/sendOnEnter.test.tsx
- e2e/mobile-composer-send-key.spec.ts
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- tasks/gap-composer-touch-hint-retired.md

（若实施中确需改 `playwright.config.ts` 或新增其他文件，必须回到 AC 里补一条对应的判据，否则 Touches 与写入面不符。）