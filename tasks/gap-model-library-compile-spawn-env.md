---
id: gap-model-library-compile-spawn-env
title: model-library：按模型编译真实 spawn 环境，unset 在最终环境对象上生效（AC-024）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-model-library-secret-write-only
goal_ac: AC-024
---
## Proposal

GOAL-001 的 AC-024：发送时按 `(provider, model_id)` 查自定义模型并编译出 spawn 环境。现状：`resolveLaunchSpec` 以 profileId 为入口，模型条目今天完全不影响 spawn 环境。编译层的白名单、`config.env` 并入、上下文变量导出可复用，入口与数据来源要换。

方案（最小切片）：
1. 入口：新增按模型编译的入口（参数 provider、model id），内部读取含 secret 真值的记录；查不到（含全部内置模型）或无配置时，结果与今日 passthrough 逐字一致（AC-001 的对偶）。
2. 行语义：value 原样并入；secret 取库中值；envref 读服务进程环境，变量不存在时产出 warning 且**不静默回退到继承环境**；unset 使该键从最终 spawn 环境移除。
3. ⛔ unset 必须在两条路径的【最终环境对象】上真的生效：SDK 路径的 `sdkOptions.env`（注意 SDK 的 options.env 是替换而非叠加，见 claude-runtime.provider.js 现有注释）与终端路径的 pty env。只在 spec 里放一个标记不算完成——`ResolvedLaunchSpec` 需要能表达“移除某键”。
4. 上下文窗口：模型条目上的上下文窗口沿用现有回退顺序（条目 → CONTEXT_WINDOW → 160000），并导出 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 等（沿用 AC-014 的既有实现，不重做）。
5. 接线：chat-websocket 首次 send 已有 `options.model`，据此调用；客户端传来的 env 一律忽略（沿用既有纪律）。
6. 新增 `model-launch-spec.test.ts` 与 `model-spawn-env.test.ts`；后者以历史 claude-fjdac 启动为参照 fixture：BASE_URL、AUTH_TOKEN(secret)、三个 DEFAULT_*_MODEL、MAX_CONTEXT_TOKENS、AUTO_COMPACT_WINDOW、AUTOCOMPACT_PCT_OVERRIDE、DISABLE_ALTERNATE_SCREEN、DISABLE_MOUSE、unset ANTHROPIC_API_KEY，集合比较，凭据值只断言存在与来源。已知不等价点须在测试注释里如实登记。取假用例：去掉 unset 的移除动作时必须判红。

依据：ADR-002（配置挂在 Model library 上；密钥允许存于 config_json 但只写；unset 为显式行类型；同 model id 不跨端点；第一版含 LLM 网关模板）。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/model-launch-spec.test.ts server/modules/launch-profiles/tests/model-spawn-env.test.ts` 退出码 0（AC-024 的判据命令）。
- [ ] 测试以真实落库的模型记录驱动真实编译入口，在 SDK 路径 sdkOptions.env 与 pty env 两个最终对象上断言 unset 的键不存在、value/secret 行存在、envref 缺失时有 warning。
- [ ] 内置模型与无配置自定义模型的编译结果与今日 passthrough 逐字一致；`passthrough-parity.test.ts`、`env-injection-closed.test.ts` 仍退出码 0。
- [ ] 取假变体使该测试判红，红灯输出记录在任务证据中；`npm run typecheck` 通过。

## DoD

真实落地判据：不是仅有测试文件存在。要求聊天路径的真实 spawn 环境由所选模型的条目决定。AC-024 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-024` 能独立核验。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/launch-spec.service.ts
- server/modules/launch-profiles/index.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/websocket/services/chat-websocket.service.ts
- server/shared/types.ts
- server/modules/launch-profiles/tests/model-launch-spec.test.ts (new)
- server/modules/launch-profiles/tests/model-spawn-env.test.ts (new)
- tasks/gap-model-library-compile-spawn-env.md
