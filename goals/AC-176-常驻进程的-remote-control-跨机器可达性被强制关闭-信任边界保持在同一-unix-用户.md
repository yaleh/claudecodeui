---
id: AC-176
title: 常驻进程的 Remote Control 跨机器可达性被强制关闭，信任边界保持在同一 Unix 用户
status: draft
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts
expect: 在一个临时配置目录里，把用户 settings 设成
  remoteControlAtStartup=true、isolatePeerMachines=false，再以常驻模式启动：(1) 传给 SDK 的
  flag settings 含 remoteControlAtStartup=false 与 isolatePeerMachines=true；(2)
  宿主快照里记录的实际生效值为关闭与隔离（读法以 E9 的读数为准）；(3) 若 E9 读到 flag settings 压不过用户
  settings，则启动被拒绝，错误可辨，界面文案说明原因，且没有以 bypass 运行的进程留下。不得读写真实的
  ~/.claude/settings.json。取假形态：启动时不传这两项 flag settings ⇒ (1)(2) 读到用户 settings
  的值，必须红。命令逐字含文件路径，不用 glob。
origin: 2026-09-25 人 yale 裁定：按对 claude 2.1.282 二进制的静态分析与 sdk.d.ts 核对修订方案。用户
  settings 若开了 remoteControlAtStartup，常驻且 bypass 的进程会被桥接到 Anthropic 后端，其他机器上的
  peer 也能驱动它，信任边界超出 proposal §9 写的同一 Unix 用户
---
