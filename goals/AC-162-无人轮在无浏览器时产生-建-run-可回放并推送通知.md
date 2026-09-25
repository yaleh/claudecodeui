---
id: AC-162
title: 无人轮在无浏览器时产生、建 run、可回放并推送通知
status: draft
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-unattended-turn.test.ts
expect: 真实 claude 二进制 + mock 端点：mock 按脚本让模型启动 Monitor 盯一个由测试控制的文件；所有 socket
  断开后测试向该文件追加一行 ⇒ 产生一个来源为 unattended 的 run，帧由真实归一化产出、seq 递增；新连接
  chat.subscribe(lastSeq=0) 能完整重放；notifyBackgroundWorkCompleted
  被调用且带触发类型；该轮内容同时出现在 transcript 与 REST 历史里。用 Monitor 而非 cron 触发，是为了在 60
  秒内完成；cron 真实触发的读数由实验任务 E1 给出。取假形态：无人轮只靠转录同步补进会话、不开 run ⇒ 重放读数必须红。命令逐字含文件路径，不用
  glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
