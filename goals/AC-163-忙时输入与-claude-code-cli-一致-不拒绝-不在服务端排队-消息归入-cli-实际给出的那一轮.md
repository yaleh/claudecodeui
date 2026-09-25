---
id: AC-163
title: 忙时输入与 Claude Code CLI 一致：不拒绝、不在服务端排队，消息归入 CLI 实际给出的那一轮
status: draft
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-busy-input.test.ts
expect: 基线取自 tasks/gap-claude-resident-phase0-experiments 写回 proposal 的 E2/E3
  结论与人的确认行（定稿前本条保持 draft）。真实 claude 二进制 + mock 端点，mock
  拖住响应以造出忙：用户轮进行中与无人轮进行中各发一次 chat.send——都不返回 RUN_IN_PROGRESS；消息写入进程 stdin
  的时刻早于当前轮的 result；这条用户消息被记入的 run 与基线所说的归属一致；消息不丢失。取假形态：(a) 服务端排队到当前轮结束后才写入 ⇒
  写入时刻读数必须红；(b) 返回 RUN_IN_PROGRESS ⇒ 必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
