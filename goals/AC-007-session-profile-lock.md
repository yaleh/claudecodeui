---
id: AC-007
title: session profile lock
status: active
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/session-profile-lock.test.ts
expect: 已锁定会话传入不同 launchProfileId 时以已存值为准并回带
  profileLocked，不报错不中断；取假形态：客户端值被采纳，或请求被拒绝，两者都红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:41.313Z
---
