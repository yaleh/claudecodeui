---
id: AC-175
title: 真实浏览器里常驻会话忙时发送直接送达，不走前端本地排队，标注与 CLI 实际归属一致
status: draft
kind: criterion
goal: GOAL-013
criterion: npx playwright test e2e/resident-busy-send.spec.ts
expect: 调试 agent 场景让常驻会话处于忙（含无人轮进行中）：发送后不出现
  QueuedMessageCard，消息立即出现在记录里，标注为「已并入当前回答」或「将在当前回答结束后处理」之一，与 AC-163
  的基线一致；per-run 会话忙时仍出现 QueuedMessageCard。取假形态：常驻会话仍走本地排队 ⇒ 必须红。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
