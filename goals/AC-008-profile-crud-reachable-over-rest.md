---
id: AC-008
title: profile CRUD reachable over REST
status: active
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/profile-rest-api.test.ts
expect: 经 REST 路由层建出一个 launch profile 并读回，profile 因此可被应用管理而非只能直写库；取假形态：模块当前没有
  launch-profiles.routes.ts，该测试今天必红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001；补立于
  GOAL-001 首次 achieved 后的范围复核
activatedAt: 2026-09-20T06:35:03.239Z
---
