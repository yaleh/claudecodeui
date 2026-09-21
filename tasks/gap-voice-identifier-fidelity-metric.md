---
id: gap-voice-identifier-fidelity-metric
title: 标识符逐字存活率指标并接入语音链路读数
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-identifier-harness-in-repo
goal_ac: AC-114
---
## Proposal

<!-- dedup-ref --> 本任务落地 GOAL-005 的标识符逐字存活率指标（AC-114）：既实现指标本身与单元测试，又把该读数接入语音链路的转写回填处，且只输出读数、不改交互。

### 现状与缺口

既有 CER 口径的 `normalize()` 删除空格与标点，于是 `voice.service.ts` 与 `voice service ts` 归一化后完全相同——本指标要证明的正是这件事：以 CER 验收语音质量会产生「指标全绿但 agent 改错文件」的假通过。实测证据：某次改动把 `Use voice.Input` 修成 `useVoiceInput`（标识符实际被修正），而 CER 报告 0.00% 变化。

### 方案

1. `src/shared/identifierFidelity.ts`：导出纯函数，对参考文本与转写文本按保留标点与大小写的口径计算标识符逐字存活率。
2. `src/shared/tests/identifierFidelity.test.ts`：三条断言——(1) 对 `('voice.service.ts', 'voice service ts')` 该指标判存活率 0；(2) 同一对文本经既有 CER 口径归一化后相同，即证明 CER 对本失效失明；(3) 经修复后同一对文本存活率回升到 1。
3. `src/modules/chat/hooks/useVoiceInput.ts`：在转写回填处只输出该读数，⛔ 不改交互、不改请求流程。

按 AGENTS.md，`src/` 适用 `$frontend-module-standards`；新测试须经模块 barrel 导入。

### 边界（不做）

不改交互（请求合并、连续录音、延迟出字一律不做）；不改 `server/modules/voice/` 的接口契约；不实现修复模块（由 AC-113 承载）。

## AC

- [ ] `npx vitest run src/shared/tests/identifierFidelity.test.ts` 退出码 0
- [ ] 断言 (1)：对 `('voice.service.ts', 'voice service ts')` 该指标判存活率 0
- [ ] 断言 (2)：同一对文本经既有 CER 口径归一化后相同（证明 CER 对本失效失明，本条同时是对该论断的回归保护）
- [ ] 断言 (3)：经修复后同一对文本存活率回升到 1
- [ ] `src/modules/chat/hooks/useVoiceInput.ts` 的转写回填处只输出该读数、不改交互
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是测试文件存在，而是三条断言在真实实现上成立，且指标真的区分得开修复前后（用 CER 代替本指标则 `voice service ts` 会被判满分，断言 (1) 必须红）。语音链路的读数必须在真实回填路径上被输出，而不是测试里的孤立调用；同时用 `git diff develop...HEAD -- src/modules/chat/hooks/useVoiceInput.ts` 证明该文件只增读数、交互行为零改动。

L_D 该轴仍暗，理由：本任务只落地一个读数指标与其接入，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是指标函数在固定文本对上的取值，不是生成质量轴读数。

## Touches

- src/shared/identifierFidelity.ts
- src/shared/tests/identifierFidelity.test.ts
- src/modules/chat/hooks/useVoiceInput.ts
- tasks/gap-voice-identifier-fidelity-metric.md
