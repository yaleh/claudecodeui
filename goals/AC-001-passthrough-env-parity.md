---
id: AC-001
title: passthrough env parity
status: active
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/passthrough-parity.test.ts
expect: 未配置任何 profile 时，resolveLaunchSpec 产出的 env
  与本变更前逐字一致；取假形态：任何一个键的新增、缺失或改值都会让该测试变红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.304Z
---
