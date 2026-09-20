---
id: AC-004
title: env injection surface closed
status: active
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/env-injection-closed.test.ts
expect: 白名单在写入路径与编译路径各自拒绝 PATH/NODE_OPTIONS/LD_PRELOAD 等键；且经 WebSocket 伪造的
  options.env 被后端完全忽略；取假形态：任一路径漏判或客户端 env 被采纳即红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.311Z
---
