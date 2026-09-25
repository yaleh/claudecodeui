---
id: AC-168
title: 常驻默认 bypass 启动；无人值守时 AskUserQuestion 与 ExitPlanMode 被自动拒绝并通知
status: draft
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-permissions.test.ts
expect: 常驻进程以 permissionMode=bypassPermissions 且
  allowDangerouslySkipPermissions=true 启动；切到其他权限模式时调用 setPermissionMode
  而不重启进程；没有浏览器连接且没有用户轮时，mock 让模型调用 AskUserQuestion 与 ExitPlanMode ⇒ 两者在
  canUseTool 中被拒绝、拒绝信息含无人值守说明、推送通知被调用，该轮在限定时间内结束而不挂起；有连接时仍走现有的权限请求帧。基于实验 E8
  的结论。取假形态：只依赖 bypass、不在 canUseTool 拦截 ⇒ 无人时该轮挂起，必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
