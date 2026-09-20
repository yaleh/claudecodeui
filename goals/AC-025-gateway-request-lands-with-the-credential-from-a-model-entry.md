---
id: AC-025
title: gateway request lands with the credential from a model entry
status: achieved
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts
expect: 测试内起 mock Anthropic 兼容服务，建一条自定义模型（base URL 指向 mock，secret 行为 token，unset
  ANTHROPIC_API_KEY），经真实 chat.send（options.model 为该模型 id，⛔ 不携带任何 env）跑一轮，断言 mock
  收到该请求、认证头来自 secret 行、且宿主环境里的 ANTHROPIC_API_KEY 没有出现在请求里。对照组：选内置模型时请求不打到
  mock。(d) 客户端经 chat.send 的 options.env 伪造的环境被后端完全忽略（接过 AC-004 的 WebSocket
  半边）。取代 AC-002 与 AC-004（WebSocket 半边）。取假形态：模型条目今天不影响 spawn 环境，请求打不到 mock，必红。
origin: ADR-002（配置挂在 Model library 上，取代独立 launch profile
  实体）；docs/proposals/launch-profiles.md 待随之修订
activatedAt: 2026-09-20T09:16:11.906Z
statusLog:
  - at: 2026-09-20T09:57:10.158Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
supersedes:
  - AC-002
---
