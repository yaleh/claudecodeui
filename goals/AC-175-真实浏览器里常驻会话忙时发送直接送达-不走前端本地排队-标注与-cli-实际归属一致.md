---
id: AC-175
title: 真实浏览器里常驻会话忙时发送直接送达，不走前端本地排队，出队前可撤回
status: draft
kind: criterion
goal: GOAL-013
criterion: npx playwright test e2e/resident-busy-send.spec.ts
expect: 调试 agent 场景让常驻会话处于忙（含无人轮进行中）：(1) 发送后不出现
  QueuedMessageCard，消息立即出现在记录里，标注为「将在当前回答结束后处理」（E2/E3 实测另起一轮；若 E9 读到所用 priority
  档会并入当前回答，则按实际标注）；(2) 消息尚未出队时带 [撤回]，点击后该消息从记录中移除且不产生一轮；出队后 [撤回]
  消失，显示「已开始处理」；(3) per-run 会话忙时仍出现 QueuedMessageCard。取假形态：(a) 常驻会话仍走本地排队 ⇒ (1)
  必须红；(b) 撤回只在前端隐藏 ⇒ 场景读到该消息仍产生一轮，(2) 必须红。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
