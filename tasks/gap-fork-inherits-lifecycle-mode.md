---
id: gap-fork-inherits-lifecycle-mode
title: fork 继承源会话的 lifecycle_mode（resident 源 → resident fork）：推翻 AC-169 判据 (3)「分叉不继承」
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测）：`grep -il "createForkedSession\|forkSessionById" tasks/*.md` 命中已完成的 `gap-lifecycle-mode-matrix-and-host-api`（AC-169）——它**正是本条要推翻的那一条**：其判据 (3) 与假形态 (b) 要求「分叉不继承 lifecycle_mode」。无任何在飞任务在改 `createForkedSession` 的列清单；`gap-fork-from-assistant-reply-anchor` 只动锚点与按钮位置，不碰落库列。⇒ 不是重复。

**人的裁定（yale，2026-10-07，对话原话）**：「AC-169 作废。fork 后自动继承 resident。」即：`docs/proposals/claude-resident-sessions.md` §13.5「分叉出的会话默认 per-run，不继承 `lifecycle_mode`」与 §14「分叉会话：新会话默认 per-run，不继承常驻」不再成立；一个 resident 会话被 fork 后，新会话的 `lifecycle_mode` 为 `resident`。

**现状（实测）**：`server/modules/providers/services/sessions.service.ts` 的 `forkSessionById` 调 `sessionsDb.createForkedSession` 时传了 `model` / `effort` / `permissionMode`，**没传** lifecycle_mode；`server/modules/database/repositories/sessions.db.ts` 的 `createForkedSession` 的 INSERT 列清单也不含 `lifecycle_mode`，新行拿列默认 `'per-run'`。线上库读数：最近 15 个 fork 里，10-05 与 10-06 的三个 resident 源产出的 fork 全是 per-run（共 136 个 resident、5413 个 per-run 会话）。发送路径（`server/index.ts:473`）按 `getSessionLifecycleMode` 选 resident / per-run，所以 fork 会静默退回 per-run。

**方案**：
1. `createForkedSession` 入参加 `lifecycleMode`，写进 INSERT 的 `lifecycle_mode` 列。
2. `forkSessionById` 用 `sessionsDb.getSessionLifecycleMode(sessionId)`（未知值回落 `per-run`）取源会话的模式并传入。
3. **只复制偏好值，不拉起进程**：fork 出来的会话没有 host，进程在第一次发送时才起（偏好不等于进程已存在，`schema.ts` 对该列的注释）。fork 之后 `sessionHostManager.notifyHostsChanged()` 已在位，无需另加。
4. **知情确认**：本条按裁定「自动继承」，不为 fork 另加知情勾选（源会话进入 resident 时已过 `gap-claude-resident-consent-gate` 的知情面）。这一点在完成记录里如实写明，不扩展成新的确认流。
5. **推翻侧的同步**：`lifecycle-mode.test.ts` 的 `(3)` 用例与 `assertForkDoesNotInherit` 改为断言「继承」，假形态 (b) 反向（fork 丢掉模式 ⇒ 红）；`docs/proposals/claude-resident-sessions.md` §13.5 与 §14 写明被 2026-10-07 裁定取代。per-run 源 fork 后仍是 per-run（正控制）。

**不在本任务范围**：`goals/AC-169-*.md` 的状态与 `expect` 文案——那是 goal 层对象，由人或 goal-driver 处理，worker 不改（见 AC 中的（待外部）项）。fork 按钮位置与锚点见 `gap-fork-from-assistant-reply-anchor`。

## Plan

1. **先红**：在 `session-fork.test.ts` 加「resident 源 fork 后读回 resident」用例，在当前树上跑出红态文案（`forkedMode=per-run`）。
2. 改 `createForkedSession` 与 `forkSessionById`（上面方案 1–3）。
3. 同步 `lifecycle-mode.test.ts` 的 (3) 与假形态 (b)；跑出反向假形态的红态读数。
4. 改 proposal §13.5 / §14。
5. **收尾**：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出 0；按 AGENTS.md 单文件直接跑各判据；写完成记录（含「不另加知情确认」的说明）。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-fork.test.ts` 退出码 0，且新增用例断言——resident 源 fork 后新会话 `lifecycle_mode` 读回 `resident`（打印 `sourceMode=resident forkedMode=resident`），`forked_from_session_id` 指向源，且 fork 之后**没有**任何 host 被拉起（打印 `hostsStartedByFork=0`，证明只复制偏好、不启进程）。
- [ ] 正控制：同文件用例断言 per-run 源 fork 后仍是 `per-run`（打印 `sourceMode=per-run forkedMode=per-run`），防「一律写 resident」。
- [ ] 推翻侧同步：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/lifecycle-mode.test.ts` 退出码 0 且 `fail 0`；其 (3) 用例现断言继承（`sourceMode=resident forkedMode=resident`），文件里不再有断言 `forkedMode` 为 `per-run` 的 resident 源用例；其余 (1)(2)(4)(5) 用例与假形态 (a)(c)(d)(e) 不变且仍绿。
- [ ] 假形态承重：把 `forkSessionById` 改回不传 lifecycleMode 后，上面两个命令里与「继承」相关的用例**必须红**（完成记录写出实测红文案）；还原后转绿。
- [ ] `docs/proposals/claude-resident-sessions.md` 的 §13.5 与 §14 不再写「默认 per-run，不继承」，并注明被 2026-10-07 人的裁定取代：`grep -n "不继承" docs/proposals/claude-resident-sessions.md` 的剩余命中逐条核对，没有一处仍在主张 fork 不继承（核对结果写进完成记录）。
- [ ] `npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出码均为 0。
- [ ] `goals/AC-169-*.md` 的状态与 `expect`（其中 (3) 仍写「分叉出的会话为 per-run」）按人的裁定作废或改写，该行只能由人或 goal-driver 写入，执行者不得代写（待外部）

## DoD

真实落地：在真实服务实例（临时 `HOME` + 临时 `DATABASE_PATH`）里，用一个 `lifecycle_mode='resident'` 的会话（已有 transcript），经真实路由 `POST /api/providers/sessions/:sessionId/fork` 对它 fork：(1) 直接读库，新行 `lifecycle_mode` 为 `resident`、`forked_from_session_id` 为源 id；(2) `GET /api/session-hosts` 里 fork 之后**没有**为它新增的 host；(3) 对该 fork 发第一条消息后，该会话出现在 `GET /api/session-hosts` 的投影里且 `mode=resident`（走的是 resident 发送路径，不是 per-run）。同样对一个 per-run 会话 fork，读回 `per-run`。三处读数写进完成记录。

## Touches

- server/modules/database/repositories/sessions.db.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/tests/session-fork.test.ts
- server/modules/session-hosts/tests/lifecycle-mode.test.ts
- docs/proposals/claude-resident-sessions.md
- tasks/gap-fork-inherits-lifecycle-mode.md
