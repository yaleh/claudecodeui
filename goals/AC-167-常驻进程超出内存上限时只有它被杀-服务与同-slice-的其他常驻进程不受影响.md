---
id: AC-167
title: 常驻进程超出内存上限时只有它被杀，服务与同 slice 的其他常驻进程不受影响
status: draft
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/session-hosts/tests/process-containment.test.ts
expect: 经 L3 包装在同一 slice 下起两个子进程，其一分配内存超过测试用的小上限 ⇒ 它被 OOM 杀死，宿主快照为
  closeReason=exited、detail=oom；另一个与测试进程本身存活；结束后无残留 scope。没有 systemd user
  manager 时打印原因并 exit 3（未评估），不得读绿。L3 应复用 tasks/gap-claude-session-cgroup-scope 的
  claude-session-scope 服务并推广为 provider 中立，不另起一套。取假形态：包装退化为直接 spawn ⇒
  超限进程不被杀或殃及测试进程，必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
