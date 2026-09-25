---
id: AC-163
title: 忙时输入与 Claude Code CLI 一致：不拒绝、不在服务端排队，进入 CLI 的输入队列并可在出队前撤回
status: draft
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-busy-input.test.ts
expect: 基线取自 tasks/gap-claude-resident-phase0-experiments：E2/E3
  已测得两种形态一致，忙时推入的用户消息另起一轮、不丢不拒；写入时用的 priority 档以 E9 读到的交互式 CLI 默认档为准（定稿前本条保持
  draft）。真实 claude 二进制 + mock 端点，mock 拖住响应以造出忙：(1) 用户轮进行中与无人轮进行中各发一次
  chat.send——都不返回 RUN_IN_PROGRESS；(2) 消息写入进程 stdin 的时刻早于当前轮结束，且带服务端分配的 uuid 与该
  priority；(3) 这条消息被记入其后另起的那一轮，不丢失；(4) 在当前轮结束前对另一条尚未出队的消息发起撤回 ⇒ 服务端调用
  cancel_async_message，该消息不产生任何一轮；对已出队的消息撤回是 no-op 且返回可辨结果。取假形态：(a)
  服务端自己排队到当前轮结束后才写入 ⇒ (2) 的写入时刻读数必须红；(b) 返回 RUN_IN_PROGRESS ⇒ 必须红；(c)
  撤回只在前端隐藏、不调用 cancel_async_message ⇒ 被撤回的消息仍产生一轮，(4) 必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
