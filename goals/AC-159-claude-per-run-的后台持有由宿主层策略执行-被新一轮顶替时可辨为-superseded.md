---
id: AC-159
title: Claude per-run 的后台持有由宿主层策略执行，被新一轮顶替时可辨为 superseded
status: active
kind: criterion
goal: GOAL-012
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-host-per-run.test.ts
expect: 伪造 SDK 流驱动 Claude per-run driver：(1) 一轮中出现 startsBackgroundWork 覆盖的工具 ⇒
  result 之后宿主处于 lingering，保活理由含对应的 background-task 或 monitor；(2) 持有期内同一会话来了新一轮 ⇒
  旧宿主 closeReason 为 superseded，新宿主为 busy；(3) 注入时钟推进 30 分钟静默 ⇒
  released，且输入流被结束；(4) 后台工作回报产生的后续 result ⇒
  released，notifyBackgroundWorkCompleted 恰被调用一次；(5)
  claude-background-work.test.ts 现有用例不改断言照常通过（由 AC-155 的逐帧比较与本条共同覆盖）。取假形态：保留阶段
  1a 的旁观包装、顶替仍在 runtime 内部完成 ⇒ (2) 读成 released 而非 superseded，必须红。命令逐字含文件路径，不用
  glob。当前必红：测试文件不存在。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-A「统一宿主层」并激活；扩展调试 agent 作宿主层对非 Claude provider
  适用性的替身；不加 cloudcli 子命令，只靠 HTTP/WS 加脚本
activatedAt: 2026-09-25T09:03:21.395Z
statusLog:
  - at: 2026-09-25T09:03:21.395Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-25T09:03:21.395Z
---
