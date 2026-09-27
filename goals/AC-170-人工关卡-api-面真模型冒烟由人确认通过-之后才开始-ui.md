---
id: AC-170
title: 人工关卡：API 面真模型冒烟由人确认通过，之后才开始 UI
status: draft
kind: criterion
goal: GOAL-013
criterion: grep -q '^冒烟验收：通过' docs/proposals/claude-resident-sessions-smoke.md
  || { echo 'smoke record docs/proposals/claude-resident-sessions-smoke.md
  missing or not accepted by a human (need a line starting with 冒烟验收：通过)' >&2;
  exit 1; }
expect: 用真实模型、只经 HTTP/WS 加脚本（不加 cloudcli 子命令）走完：创建常驻会话 → 连续 3 轮 → 触发一个无人轮 → 关闭 →
  重启服务后读到已随重启关闭 → 再次发送重新拉起；读数写进
  docs/proposals/claude-resident-sessions-smoke.md。该文件中以「冒烟验收：通过」开头的一行只能由人 yale
  写入，执行者不得代写。UI 相关 AC（AC-171 至 AC-175）的派工任务以本条对应的任务为前置。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
