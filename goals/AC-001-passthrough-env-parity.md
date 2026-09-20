---
id: AC-001
title: passthrough env parity
status: achieved
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/passthrough-parity.test.ts
expect: 未选择带配置的自定义模型时（内置模型，或无配置的自定义模型），resolveLaunchSpec 产出的 env
  与本变更前逐字一致——这是“已有安装升级后行为零变化”的黄金基准；取假形态：任何一个键的新增、缺失或改值都会让该测试变红。⚠️ 该测试目前经旧入口
  resolveLaunchSpec(null) 驱动，拆除旧实体时须【移植到新入口】而不是删除或放宽。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.304Z
statusLog:
  - at: 2026-09-20T04:09:59.033Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
