---
id: AC-139
title: 服务端代理按 provider 分派到适配器，OpenAI-compatible 路径线上字节不变
status: draft
kind: criterion
goal: GOAL-009
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/voice/tests/voice-provider-dispatch.test.ts && node
  scripts/asr-extraction-parity-check.mjs
expect: 代理路径对 providerId 为 dashscope-omni 的请求调用该适配器（替身记录到 chat/completions 请求），对
  openai-compatible 仍发出与基线逐字节一致的 multipart 请求并保持原有的宽松解析；AsrErrorCode 到 HTTP
  状态码的映射逐项断言；既有的抽取一致性基线保持绿。取假形态：代理路径仍写死 multipart ⇒ dashscope-omni 用例必须红。
origin: docs/proposals/voice-dashscope-omni-written-instruction.md（2026-09-24 人
  yale 裁定：E 组提示词定型；key 由用户提供；书面指令进 composer；本轮不改输入体验）
---
