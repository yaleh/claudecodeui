---
id: gap-resident-edit-send-truncates-in-place
title: resident 会话的「编辑重发」在原会话内真正截断：关 host（rewind）→ 带 resumeSessionAt 重拉起 →
  追加替换消息，不新建会话
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

<!-- dedup-ref --> 机制去重读数（立案时实测）：`grep -l "resumeAnchorId\|resumeSessionAt" tasks/*.md` 只命中 `gap-fork-from-assistant-reply-anchor` 与 `gap-fork-inherits-lifecycle-mode`（二者谈 fork，不碰 edit-send 的 resident 路径，且均已 done）；`gap-session-hosts-lease-driven-lifecycle` 只登记了 `closeReason: 'rewind'` 这个枚举值，称其产品路径「属 AC-158/AC-159」，但没有任务认领 resident 的编辑重发。⇒ 本条不是重复。

**现象（人的报告）**：暂停（abort）一次输入的处理后，点界面上的「编辑」重新编辑最后一条消息再发出，被暂停的那条消息及其处理痕迹仍留在会话里。

**根因（代码读数，未在线复现）**：
1. `chat.edit-send`（`server/modules/websocket/services/chat-websocket.service.ts` 的 `handleChatEditSend`）经 `resolveEditAnchor` 算出 `resumeThroughId`（编辑目标之前最近的 assistant 行），作为 `resumeAnchorId` 随 `extraRuntimeOptions` 交给运行时。
2. 这个选项只在 per-run 运行时被消费：`claude-runtime.provider.ts` 把它映射成 SDK 的 `resumeSessionAt`（该处注释：`resumeSessionAt` 包含其所指 uuid，所以传的是要保留的最后一行）。全库 `grep resumeAnchorId|resumeSessionAt|resumeFromScratch`，除这两个文件外无任何读取方——**resident 的 host 驱动（`claude-host-driver.provider.ts`）完全不读**。
3. 能力矩阵对 Claude 统一声明 `supportsMessageEditing: true`（`provider-capabilities.service.ts:121`），不区分 per-run 与 resident，前端因此给 resident 会话也显示编辑按钮。
4. 所以 resident 会话的编辑重发实际等于「向活着的进程追加一条普通消息」：被暂停的旧消息与其痕迹仍在进程上下文里（模型仍能看到）；追加不会让两条用户 prompt 共享同一个 `parentUuid`，`dropSupersededPromptBranches`（`claude-sessions.provider.ts`）剪不掉旧分支；前端先收到 `history_truncated` 把旧消息暂时藏起来，`complete` 之后重读 transcript，旧消息又回来了。
5. 旁证：`session-host-manager.service.ts` 已有 `rewind(appSessionId)`（关宿主，`closeReason='rewind'`，注释写「Consumed by the edit-send rebuild path」），全库无任何调用方——设计意图在、消费方缺。
6. 数据旁证：最近 400 个会话里只有 2 个存在「同父节点两条 prompt」的编辑分支，且都是 per-run。

**人的裁定（2026-10-07）**：resident 会话编辑重发要**留在原会话里**（用户在会话列表里不得看见新会话）；不走「编辑即 fork 成新会话」的方案。

**方案**：
- `handleChatEditSend` 在 resident 会话上：先 `sessionHostManager.rewind(sessionId)` 关闭当前 host（等它真正退出），再以 `resume=<provider_session_id>` + `resumeSessionAt=<resumeThroughId>`（首条 prompt 被编辑时 `resumeFromScratch`）重新拉起 resident host，并把替换消息作为这个新进程的第一轮；会话的 app id、`provider_session_id`、`lifecycle_mode` 不变，jsonl 仍是同一个文件，被替换的分支靠既有的 `dropSupersededPromptBranches` 在读取时剪掉。
- host 驱动的启动路径（`startResidentSession` / `startResidentHost`）接受并透传 `resumeAnchorId` / `resumeFromScratch`，映射成 SDK 的 `resumeSessionAt`；占用检查（`findBackgroundSessionOwner`）、`resolveResumeModel`、Remote Control 门保持原行为。
- 重建期间 `history_truncated` 先发（沿用现有顺序，避免旧消息闪烁）；重建失败要结束本次 run 并发 `complete`，让客户端重读 transcript 还原，沿用 per-run 路径的失败语义。
- **止血**：在重建路径落地之前或同时，不允许 resident 会话静默走「普通追加」——要么走新路径，要么拒绝并给明确错误，不得再沉默地做错事。

**不在本任务范围**：fork 按钮迁移与 fork 继承 `lifecycle_mode`（已由 `gap-fork-from-assistant-reply-anchor`、`gap-fork-inherits-lifecycle-mode` 完成）；Codex 的 resident（Codex 不支持 resident）；resident 排队消息（`chat.cancel-queued`）语义。

## Plan

1. **先取读数（未取到肯定读数不动产品代码）**：在 `/tmp` 的临时 HOME 里，用真 claude 进程验证 resident 形态（SDK 的 held-input 流式输入）下 `resume` + `resumeSessionAt` 是否被接受、新进程是否仍把后续行追加到**同一个** jsonl、追加的替换 prompt 与旧 prompt 是否共享同一 `parentUuid`。打印 `residentResumeAt=<accepted|rejected> sameFile=<true|false> sharedParent=<true|false>`。若 `rejected`，停手并 park needs-human，记录 CLI 的拒绝文案，不自行换方案。
2. **判据骨架先红**：在 `server/modules/websocket/tests/chat-edit-send.test.ts` 与 `server/modules/providers/tests/claude-resident-process.test.ts` 里先写各断言，在当前树上跑出红态文案（不得新增 `server/**/*.test.ts` 文件：仓库有按文件数 pin 的测试，新增会让它全线变红）。
3. **host 驱动透传**：`startResidentHost` 的启动 options 接受 `resumeAnchorId` / `resumeFromScratch`，沿用 per-run 运行时同一份映射逻辑（不复制第二份）。
4. **编辑重建路径**：`handleChatEditSend` 在 `sessionsDb.getSessionLifecycleMode(sessionId) === 'resident'` 时走「`rewind` → 等待关闭 → 带截断点重拉起 → 发替换消息」；per-run 路径字节不变。
5. **前端**：确认 resident 会话的编辑按钮在新路径下可用；如重建失败的报错需要展示，沿用既有的协议错误通道。
6. **收尾**：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出 0；按 AGENTS.md 单文件直接跑各判据，不做无界 fan-out；写完成记录（含第 1 步读数）。

## AC

- [ ] 前置读数已取得并写进完成记录：真 claude 进程上 resident 形态的 `resume` + `resumeSessionAt` 实测，打印 `residentResumeAt=accepted sameFile=true sharedParent=true`；任一项不是该值则不动产品代码，park needs-human。
- [ ] host 驱动透传：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-process.test.ts` 退出码 0，且新增用例断言——带 `resumeAnchorId=X` 启动 resident host 时，交给 SDK 的启动选项含 `resumeSessionAt===X` 且含 `resume===provider_session_id`；带 `resumeFromScratch` 时**不含** `resume` 也不含 `resumeSessionAt`；不带这两个选项时启动选项与改前逐字相同（不回归普通 resident 启动）。
- [ ] 编辑重建（resident）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-edit-send.test.ts` 退出码 0，且新增用例在一个 `lifecycle_mode='resident'` 且 host 存活的会话上发 `chat.edit-send`，断言——旧 host 先被 `rewind` 关闭（`closeReason==='rewind'`）、关闭完成**之后**才起新 host；新 host 的启动选项带编辑目标之前最近 assistant 行的 uuid 作为 `resumeAnchorId`；会话的 app id、`provider_session_id`、`lifecycle_mode` 在重建前后逐字相同；`sessionsDb` 里没有新增会话行；`history_truncated` 帧先于重建发出。
- [ ] 同一用例的正控制：对 per-run 会话发 `chat.edit-send`，走原路径、**不**调用 `rewind`，`extraRuntimeOptions` 与改前逐字相同（防「所有会话一律走重建」）。
- [ ] 失败语义：同文件用例断言——重建过程中重拉起失败时，本次 run 以 `complete` 结束（不是永远 processing），并有一条 `EDIT_REWIND_FAILED` 协议错误；会话行未被改动。
- [ ] 读取侧不回归：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts` 退出码 0（该文件已有 `dropSupersededPromptBranches` 的用例，不得被本任务改红；仅在该文件里新增「resident 重建产生的同父双 prompt 夹具读出后只剩替换那条」用例，如需新增则声明在 Touches）。
- [ ] 假形态承重（实测红文案写进完成记录）：临时把 `handleChatEditSend` 里 resident 分支改回「直接追加、不 rewind」后，重建用例**必须变红**，还原后转绿；临时去掉 host 驱动对 `resumeSessionAt` 的映射后，透传用例**必须变红**，还原后转绿。
- [ ] 工具链：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 均退出码 0。

## DoD

真实落地：在真实服务实例（临时 `HOME` + 临时 `DATABASE_PATH`，真 claude 进程，非替身）里，对一个 `lifecycle_mode='resident'` 的会话走完整故事：(1) 发一条消息，等其回合结束；(2) 再发第二条消息并在其处理中途暂停（abort）；(3) 点编辑那条被暂停的消息，改写后发出（真实 `chat.edit-send` 帧）。读数三处写进完成记录：(a) 读库——该会话仍是同一行、`lifecycle_mode` 仍是 `resident`、会话总数未增加；(b) 读该会话 jsonl——被暂停的那条 prompt 与替换 prompt 共享同一个 `parentUuid`，且经 `GET /api/providers/sessions/:id/messages` 读出的消息序列里**只有替换那条**，被暂停的 prompt 及其处理痕迹（assistant/tool 行）都不在；(c) 向该会话再发一问「我之前说过什么」，模型的回答里**没有**被暂停那条的内容（证明进程上下文也被截断，而不只是界面藏起来）。若本环境无可用的在线模型端点，如实写明取不到 (c)，不得以替身代写；此时 (a)(b) 仍须以真实服务实例取得。

## Touches

- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/session-hosts/session-host-manager.service.ts
- server/modules/websocket/tests/chat-edit-send.test.ts
- server/modules/providers/tests/claude-resident-process.test.ts
- server/modules/providers/tests/claude-sessions.test.ts
- tasks/gap-resident-edit-send-truncates-in-place.md
