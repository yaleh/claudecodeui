---
id: gap-mobile-layout-e2e-viewport-matrix
title: 移动端工作区 header / composer 布局的真浏览器验收矩阵：320/360/390/767/768/1280 ×
  idle/单回放/双回放/执行中，边界框 + 溢出 + 单一 Stop + 桌面无回归
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mobile-workspace-header-single-row-selector
  - gap-mobile-composer-footer-single-row-more-menu
  - gap-mobile-voice-clip-row-below-textarea
  - gap-mobile-activity-inline-single-stop
  - gap-composer-footer-tier-follows-own-width
---
## Proposal

来源方案：`docs/proposals/mobile-workspace-and-composer-layout.md` 「验证方法 2」与「验收标准」（本任务自包含）。本任务是同一方案的最后一环：把前四个实现任务各自一次性读出的真浏览器读数，固化成**永久的** Playwright 回归矩阵。它不修改任何 `src/` 代码；若矩阵读出真实缺陷，缺陷属于对应实现任务的范围，本任务应如实记录并 gap-file，而不是改判据迁就。

**判据收紧与依赖（2026-09-25 补记）：** 首次单跑 22/22 通过，但读数里 `@768` 档 footer 叠成两行（`sameRow=false stacked=true`，空闲 93px、含一对回放 129px），而 spec 当时把 `@768 double playback` 一格放宽成只看「不横向滚动」、高度仅作观察读数——那是判据迁就现状，与上一段的规则相反。该缺陷属于 composer 实现范围，已单独立案 `gap-composer-footer-tier-follows-own-width`；本任务 `depends_on` 它，并把 768 判据收回到下面的桌面断言（同一行、高度不随回放增长），不再放宽。

新建 `e2e/mobile-workspace-composer-layout.spec.ts`，在真实 Chromium 里对真实后端 + Vite 客户端（由 `playwright.config.ts` 起，隔离数据目录）验证：视口与状态两个维度。

视口：320×700、360×800、390×844、767×900、768×900、1280×720。
状态：idle、单条回放、双条回放（original + trimmed）、执行中。

**移动端（<768）断言：**

- `header.height <= 56`（PWA safe-area 单独扣除）。
- `footer.scrollWidth === footer.clientWidth`（无横向溢出）。
- footer 左右两个主控组的垂直区间相交，证明处于同一行；按钮高度允许造成最多 4px 的 top 差。
- 出现单/双条回放时 `footer.height <= 57`，且回放行位于 footer 之前；回放出现前后 footer 高度相等。
- 页面中可见且可访问的 Stop **恰好一个**（执行态）。
- Token usage、Commands、Schedule 不在 footer 内，可从「更多」打开（两次点击以内）。
- 工作区 dialog 里所有入口的触控尺寸至少 44×44px；选中后 dialog 关闭并切到该工作区。
- 可访问性树里 `Replay original` / `Replay trimmed` 各恰一个，不是两套。

**桌面（>=768）断言：**

- 768 与 1280 均显示完整 tablist，不出现 collapsed trigger；767 显示 collapsed trigger 且无 tablist（断点两侧各读一次）。
- 768×900（侧栏展开，composer 容器约 445px）与 1280 一样：footer 两个主控组处于同一行（垂直区间相交，top 差不超过 4px）、`footer.scrollWidth === footer.clientWidth`、含单/双条回放时 footer 高度与该视口无回放时相等；读数前先断言容器宽度确实落在窄档（记录 `footer.clientWidth`），否则该格没有测到它要测的东西。**此格不得放宽成「只要不横向溢出」**：叠成两行本身就是失败。
- 1280×720 下 header 与 composer/footer 的边界框相对改动前基线不发生非预期变化（基线：header 57px；用 `git stash`/`git worktree` 在未含前四个实现任务的基线上现读，不得抄方案里的数字充当读数）。
- Token、Commands、Schedule、语音回放仍位于当前桌面位置；执行态桌面仍是 composer 上沿 tab 状态 + 主 Stop。

夹具与约定（沿用既有 e2e 惯例，不发明新机制）：

- **优先复用**既有种子工作区与其长标题会话；若确需新增夹具（长标题会话、启用的插件等），在 `playwright.config.ts` 里按既有 `seed*` 函数的写法**服务启动前**写 transcript（中途写入会被 watcher 当成 `session_upserted` 并标 needs attention 导致随机红），并证明新夹具没有让其它 spec 的无作用域 `.first()` 定位符改选到它（既有 spec 全跑一遍仍绿）。
- 录音回放沿用 `e2e/voice-trim.spec.ts` 的录音/上传路径产生**真实**的 original + trimmed clip，不得替身 `clipSlot`。
- 执行态沿用 `e2e/transcript-follow.spec.ts` 的 in-page WebSocket 替身：`page.addInitScript` 包住 `window.WebSocket`，向 `url.includes('/ws')` 且 `readyState===1` 的实例 `dispatchEvent(new MessageEvent('message', …))`——伪造传输层，绝不伪造消费者。
- 视口由 `test.use({ viewport })`（触摸相关由 `hasTouch/isMobile`）一并给出，不靠运行中途 `setViewportSize` 与 CDP 半翻转（会出现「1280 宽视口下测触摸设备」）。
- **一次调用一个库**：全部用例放在同一个 spec 文件里、共用一次运行与同一个 `DATABASE_PATH`，不要拆成第二个 spec 文件（会踩「一次运行一个库」的鉴权坑）。
- 320px 与 767px 用例必须使用**长模型名**与**较长翻译**（zh-CN 或 de），不能只测 `Chat`、`Files` 等英文短词。
- 新库首次启动走 onboarding，`beforeAll` 等 `#username` 在负载下有约 1/7 概率超时（安静时约 11s）——按墙钟归因，**不加重试**。

## AC

- [ ] `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts` 退出码 0，且输出中 6 个视口 × 4 个状态的每一格都有对应的通过用例（用 `--list` 打印用例清单并计数：移动 4 个视口 × 4 状态 + 桌面 2 个视口 × 相关状态，覆盖上文全部断言；用例名必须含视口宽度与状态，以便失败时一眼看出是哪一格）。
- [ ] 每条视口断言都在**读数前先断言前提**：页内 `window.innerWidth` 等于用例声明的宽度，否则以该读数直接 fail；执行态用例先断言活动状态确实出现（消息流里的状态行或桌面的 tab 状态存在），录音用例先断言两条 clip 确实都已生成；没有这些前提，spec 在错误配置下会静默通过。
- [ ] 每条断言失败时**打印实际读数**（header 高度、footer scrollWidth/clientWidth、两组 top/bottom、可见 Stop 计数与其可访问名、chip 行与 footer 的 top），不是布尔 `false`。
- [ ] 抗假变体（四个，逐个执行，每个还原后全绿且 `git diff` 只剩本任务声明的写点）：① 把 footer 的 `flex-nowrap` 去掉（或让 `ChatComposer.tsx` 恢复 `flex-wrap`）→ 移动档「footer 单行/同一行」那一格变红；② 让移动端重新渲染 tab 状态里的 Stop → 「可见且可访问的 Stop 恰一个」那一格变红；③ 把 `WorkspaceHeader.tsx`/`WorkspaceTabs.tsx` 的 `md:` 改回 `sm:` → **767 那一格**变红（这是唯一证明断点统一的判据）；④ 把 `useComposerCompactTier` 改成只返回视口规则 → **768 侧栏展开那几格**（空闲与含回放）变红，1280 与移动档仍绿（这是唯一证明 768 不再叠成两行的判据）。四个变体分别只让对应的格变红、其它格仍绿，证明格与格不是共享同一条断言；变体只在探针里做（`git stash`/临时改动），还原用 `git checkout` 而非手工回写。
- [ ] 桌面基线来自现读：Evidence 里记录在**不含前四个实现任务**的提交上现跑同一 spec 的桌面用例所读出的 header/footer 边界框，与含实现后的读数并排；两者之差必须在声明的容差内（不得把方案文档的数字直接当基线）。
- [ ] 全量前端检查：`npm run test:client`、`npm run build:client`、`npm run typecheck`、`npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 预先非 0，不作判据）。
- [ ] 既有 e2e 不回归：`npx playwright test` 全量（所有 `e2e/*.spec.ts`，同一次调用）退出码 0；若新增了夹具，此项同时证明它没有让其它 spec 的无作用域定位符改选。

## DoD

真实落地判据：不是「spec 存在」。要求把一次完整的 `npx playwright test e2e/mobile-workspace-composer-layout.spec.ts` 运行的**逐格读数表**（6 视口 × 4 状态，每格的 header 高度、footer 溢出、同一行读数、footer 高度、可见 Stop 计数）原样写进 Evidence，并记录整次调用的墙钟（含配置求值、seed、服务启动、浏览器启动）与通过/失败个数。四个抗假变体各自的「变红的那一格与其读数」逐条记录。

方案里 MCP 浏览器人工复核（临时可撤销 observer 身份进入现有长标题会话、保存 accessibility snapshot 与截图、通过语音调试上传生成真实 clip、观察一个真实执行中的会话）属于**人工复核**，不属于本任务的自动判据；若执行了它，须按「账号观察 token 协议」自行取得授权（向账号所有者索取，不得复用 MCP 会话），结束后撤销 observer subject、探测 `/api/auth/user` 返回 401、删除临时 token，并在 Evidence 里逐步记录；若没有执行，Evidence 里明写「未执行，理由」，不得留空也不得声称已复核。

读数如实标注边界：视口来自 Chromium 的 viewport/触摸模拟，不是真机；PWA safe-area 不在 headless 环境里生效，header ≤56 的读数是不含 safe-area 的读数；执行态由传输层替身喂入，须写明喂了哪些帧。

L_D 该轴仍暗，理由：本任务只新增一个验收 spec，不产出领域数据或文档语义读数。

L_G 该轴仍暗，理由：同上；本任务的验证读数就是 DoD 里的逐格读数表与四个抗假变体的变红读数。

## Touches

- e2e/mobile-workspace-composer-layout.spec.ts (new)
- playwright.config.ts
- tasks/gap-mobile-layout-e2e-viewport-matrix.md

## Needs-Human

**执行 2026-09-25T06:43:45.597Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：AC 未全勾（checked 0/7，剩余未勾 7）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：4b5faa54-4c26-49cc-8b5b-56770924cf30
