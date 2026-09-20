---
id: gap-session-filter-real-browser-e2e
title: 会话列表过滤真实浏览器端到端（e2e）：经界面设规则使列表真的收敛、临时显示刷新后保持、搜索「已过滤」、隐藏同类预填
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
---
## Proposal

<!-- dedup-ref -->本任务只新增会话列表过滤的浏览器端到端 spec，不重复申领 e2e 工具链本身：工具链由 gap-launch-profiles-real-browser-e2e-toolchain（done）与 GOAL-001 的 AC-027 承载（后者当前仍红——实测 `npm run test:e2e` exit 127 `playwright: not found`，@playwright/test 已声明但主 checkout 未安装）。与三个实现任务（gap-project-session-name-filter-backend / -sidebar-ui / -hide-similar）的区别：那三个各自验证本层机制（纯函数、SQL 过滤契约、组件渲染），本任务立真实浏览器层的判据与回归保护。

背景：GOAL-002 的 AC-101 已立（判据 `npm run test:e2e -- e2e/session-filter.spec.ts`，当前红：spec 不存在）。三个实现任务均已 done 且各自单测/集成测试全绿（实测后端 9/9、前端 17/17），但没有任何真实浏览器层的回归保护——e2e/ 下只有 launch-profiles.spec.ts 与 model-library.spec.ts。

方案：
1. 新增 `e2e/session-filter.spec.ts`，沿用现有 e2e 约定：真实 Chromium 打真实后端 + Vite（由 playwright.config.ts 的 webServer 启动，隔离数据目录），首次运行走建号流程（e2euser），不 stub 任何请求、每条断言都关于 UI 真实渲染或真实发出的请求。
2. 断言链：登录 → 侧边栏展开项目 → 经项目菜单打开「会话过滤…」→ 在多行框输入 `-(task-worker|selector|fix-worker)$` → 预览给出命中/未命中数与会话名样本 → 保存 → 列表收敛且底部出现「已隐藏 N 个 · 显示 · 编辑规则」→ 点「显示」以 includeHidden 重新拉取、刷新页面后仍保持、再点收回 → 运行中/需关注/当前选中的会话即使命中规则也照常可见 → 标题搜索命中被隐藏会话时该条带「已过滤」标记 → 会话行菜单「隐藏同类」把推导出的正则预填成一行且不触发保存请求。
3. 复用 launch-profiles.spec.ts 已有的未翻译 key 正则（`UNTRANSLATED_KEY`，其命名空间前缀集合已含 `sidebar`），断言页面无未翻译的 i18n 字面量。
4. ⛔ 不得用 API 直建规则代替 UI 录入，也不得直接操纵组件状态绕过入口——判据的价值就在于入口与交互真的可用。
5. Touches 预先列出可能需加 test id 的侧边栏组件：这条线此前两次因 Touches 未穷举而被 anti-drift 拒绝并耗尽重试，宁可多声明。

## AC

- [ ] `npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 0（真实 Chromium + playwright webServer 启动的真实服务与隔离数据目录；不得 stub 后端、不得用 API 直建规则代替 UI 录入）。
- [ ] 同一 spec 断言：保存后列表收敛且底部「已隐藏 N 个 · 显示 · 编辑规则」出现；点「显示」后以 includeHidden 重新请求、刷新页面后仍保持展开、再点收回。
- [ ] 同一 spec 断言：运行中/需关注/当前选中的会话即使命中规则也仍可见；标题搜索命中被隐藏会话时该条带「已过滤」标记；会话行菜单「隐藏同类」预填推导正则且不触发保存请求；页面无未翻译 i18n 字面量。
- [ ] 抗假变体：把「显示」实现成清空库内规则、或去掉 keepSessionIds、或把过滤搬到客户端（分页后再过滤）时，该 spec 变红（至少一条真跑并留输出）。
- [ ] `npm run test:client` 与 `npm run typecheck` 退出码 0（既有前端测试不回归）。

## DoD

真实落地判据：不是 spec 文件存在，也不是 playwright 报了绿。要求在真实运行的 cloudcli（vite + 后端，连真实数据库）上由该 spec 驱动真实浏览器走完 AC-101 全文流程，并把 trace 或截图与运行输出记入任务的完成记录；AC-101 判据命令在 goal-driver 环里由红转绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。取假变体：把「显示」改成清空库内规则时该 spec 必须变红——仅有绿而无抗假变体证据不算完成。

## Touches

- e2e/session-filter.spec.ts (new)
- playwright.config.ts
- package.json
- package-lock.json
- src/modules/sidebar/SessionFilterEditor.tsx
- src/modules/sidebar/SessionFilterBar.tsx
- src/modules/sidebar/SidebarProjectSessions.tsx
- src/modules/sidebar/SessionOptions.tsx
- tasks/gap-session-filter-real-browser-e2e.md
