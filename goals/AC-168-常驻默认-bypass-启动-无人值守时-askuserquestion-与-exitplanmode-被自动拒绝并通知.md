---
id: AC-168
title: 常驻默认 bypass 启动；无人值守时三个需要人回应的入口都被自动拒绝并通知
status: draft
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-permissions.test.ts
expect: 常驻进程以 permissionMode=bypassPermissions 且
  allowDangerouslySkipPermissions=true 启动；切到其他权限模式时调用 setPermissionMode
  而不重启进程。没有浏览器连接且没有用户轮时：(1) mock 让模型调用 AskUserQuestion 与 ExitPlanMode ⇒ 在
  canUseTool 中被拒绝（E8 已证实 bypass 下仍走该回调）；(2) 伪造一次 MCP elicitation ⇒ onElicitation
  返回拒绝或取消；(3) 伪造一次 request_user_dialog ⇒
  被拒绝或取消；三种情况下拒绝信息都含无人值守说明、推送通知被调用、该轮在限定时间内结束而不挂起。有连接时三者仍走现有的请求帧流程。side_question
  的入口按 E9 读数补进本条。取假形态：只在 canUseTool 拦截 ⇒ (2) 或 (3) 的那一轮挂起到超时，必须红。命令逐字含文件路径，不用
  glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
