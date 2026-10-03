---
id: transcript-prefetch-before-edge
title: AC-216 向上滚动在窗口边缘之前预取：触发点距边缘约两屏，每页 ≥50 条，前插锚点保持
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - transcript-long-session-e2e-seed
goal_ac: AC-216
---
## Proposal

现状读数（2026-10-04 读代码）：`useChatSessionState.ts` 的 `handleScroll`（约 1127-1175 行）在 `scrollTop < 100` 且未全量加载时才调用 `loadOlderMessages`，每页 `SESSION_MESSAGES_PAGE_SIZE = 20`（`utils/sessionMessagePagination.ts:3`）。用户已经滚到顶部边缘才开始取页，匀速向上滚动会撞到未加载的空白；页又小，一次连续滚动要发很多请求。

要做的事：(1) 触发点由绝对像素 100 改为「距已加载内容顶部边缘 ≤ 1.5～2 个视口高度」，按 clientHeight 计算，保留既有的 `topLoadLock` 防重入语义；(2) 页大小提高到 ≥50（取 50 起，实现者按真实夹具的读数调整并写下依据）；(3) 前插后沿用既有 `captureScrollRestoreState` 锚点恢复，漂移 ≤1px；(4) 一次连续滚动的取页请求数不得膨胀（每次触发后到响应落地前不重复触发）。本任务只改「向上加载」这条既有路径，不引入窗口模型（那是 store 窗口任务），也不改导航轨道。

## Plan

1. 先写判据文件 `e2e/transcript-prefetch.spec.ts` 的 AC-216 用例（用共用长会话种子 `e2e-transcript-jump`），含「触发点设回 scrollTop<100 时 (a) 必须红」的对照。先看它红。
2. 改 handleScroll 的触发条件与页大小常量；确认 wheel 上滚处理（约 989 行）使用同一触发语义。
3. 在 src/modules/chat/tests 里补一条纯逻辑单测：触发点按 clientHeight 计算、锁在响应落地前不重复触发。

## AC

- [ ] AC1 判据绿：`npx playwright test e2e/transcript-prefetch.spec.ts -g "AC-216"` 退出 0。红态基线：spec 文件不存在。
- [ ] AC2 取假形态必须红（先提交再变异，逐条记录 diff、逐字失败行与恢复命令）：(a) 页大小改大但触发点仍为 scrollTop<100 ⇒ (b) 断言红；(b) 预取但前插后不做锚点恢复 ⇒ (d) 断言红。
- [ ] AC3 既有跟随不回退：`npx playwright test e2e/transcript-follow.spec.ts` 保持绿（AC-106 至 AC-111），逐字写下读数。
- [ ] AC4 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

- 判据在真实浏览器里用真实滚轮对真实服务运行，网络层时间戳来自真实请求。
- 触发点与页大小的取值有实测依据，写在任务证据里。
- 遵守 `frontend-module-standards`；只动 `## Touches` 列出的文件。

## Touches

- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/utils/sessionMessagePagination.ts
- src/modules/chat/tests/prefetchTrigger.test.ts (new)
- e2e/transcript-prefetch.spec.ts (new)
- tasks/transcript-prefetch-before-edge.md
