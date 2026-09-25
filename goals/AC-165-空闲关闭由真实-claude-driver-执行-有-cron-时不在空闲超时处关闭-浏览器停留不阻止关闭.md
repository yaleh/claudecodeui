---
id: AC-165
title: 空闲关闭由真实 Claude driver 执行：cron 保活理由按 CLI 清单对账，有 cron 时不在空闲超时处关闭，浏览器停留不阻止关闭
status: draft
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-idle.test.ts
expect: 伪造 SDK 流 + 注入时钟驱动 Claude resident driver，流中每轮结束带 Stop hook 输入：(1)
  session_crons 含一条周期 cron ⇒ 保活理由含 cron、expiresAt 为创建时加 7 天，24 小时静默时不关；(2)
  模型从未调用 CronDelete，但下一轮的 session_crons 已不含该 cron ⇒ cron 保活理由消失，此后按正常计时在 24 小时处以
  idle 关闭；(3) session_crons 一直含该 cron ⇒ 7 天过期后再计时关闭；(4) 流中没有 Stop hook 输入时退回按
  CronCreate/CronDelete 工具调用推测，保活理由标为 inferred；(5) 期间浏览器持续 chat.subscribe
  不改变关闭时刻；(6) 关闭后 GET /api/session-hosts 读到 closeReason=idle。取假形态：(a) driver 不上报
  cron 保活理由 ⇒ 24 小时处被关，(1) 必须红；(b) 只按工具调用推测、不读 session_crons ⇒ (2) 里 cron
  保活理由一直存在，必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
