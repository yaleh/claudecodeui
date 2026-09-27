---
id: AC-164
title: 常驻进程有稳定的 SendMessage 地址，另一个会话用复制的地址能送达并产生一轮
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-addressable.test.ts
expect: 两个常驻会话，真实 claude 二进制 + mock 端点：宿主快照里的 peerName 等于按 proposal §12
  规则生成的名字，并在进程存活期间不变；mock 按脚本让会话甲以该地址调用 SendMessage ⇒ 会话乙产生一个来源为
  unattended、触发类型为跨会话消息的 run。取假形态：不传 extraArgs.name ⇒ peerName
  与实际地址不一致，必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
activatedAt: 2026-09-27T04:57:24.557Z
statusLog:
  - at: 2026-09-27T04:57:24.557Z
    from: draft
    to: active
    actor: human:yale
    reason: 人 yale 2026-09-27 指令：判据已按 E1–E9 结论修订，转 active
  - at: 2026-09-27T11:48:59.734Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T04:57:24.557Z
---
