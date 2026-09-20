---
id: AC-005
title: context window follows profile
status: active
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/context-window-per-profile.test.ts
expect: token 用量的 total 等于 profile.contextWindow，而非硬编码的 160000；并验证 profile
  未设时回退到 CONTEXT_WINDOW 再回退到 160000；取假形态：沿用硬读即红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.312Z
---
