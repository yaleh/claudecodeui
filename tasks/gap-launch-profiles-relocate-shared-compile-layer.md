---
id: gap-launch-profiles-relocate-shared-compile-layer
title: 把 model library 与旧 profile 共用的编译层搬出 launch-profiles 模块（行为零变化）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on: []
---
## Proposal

背景：ADR-002 取代 ADR-001 后，「独立 launch profile 实体」的拆除前置条件（AC-027 由红转绿）已满足。但 `server/modules/launch-profiles/` 目录里混着两代代码：新机制（model library 的编译层）与旧机制（profile）。整目录删除会打断在跑的 model library，因此必须先搬家。

现状事实（已实测）：
- `server/modules/launch-profiles/model-launch-spec.service.ts:2` 从同目录 `launch-spec.service.js` 导入 `isAllowedLaunchEnvKey`、`resolveContextWindow`；`:3` 从 `launch-profiles.service.js` 导入类型 `LaunchSpecGuards`。
- `isAllowedLaunchEnvKey` 另有消费者 `server/modules/providers/services/provider-models.service.ts:2,129`（模型配置写入路径校验）。
- `resolveContextWindow` 另有消费者 `server/modules/providers/services/provider-token-usage.service.ts:9,263`，以及 `server/modules/providers/list/claude/claude-runtime.provider.js:39,442,538`。
- 上述 4 个消费者全部位于 providers 模块内 —— 这是选点依据。

方案（最小切片，行为零变化）：
1. `launch-spec.service.ts` 整体（`resolveContextWindow`、`isAllowedLaunchEnvKey`、`ALLOWED_ENV_PREFIXES`、`ALLOWED_ENV_KEYS`、`DENIED_ENV_KEYS`、`DEFAULT_CONTEXT_WINDOW`）迁到 `server/modules/providers/services/launch-spec.service.ts`。搬迁后其全部消费者都在 providers 模块内，属模块内服务文件，**不需要**新增跨模块导出（避免无消费者地扩大 providers 桶文件）。
2. `model-launch-spec.service.ts` 与其 4 个测试（`model-launch-spec.test.ts`、`model-spawn-env.test.ts`、`model-context-window.test.ts`、`model-gateway-end-to-end.test.ts`）迁到 `server/modules/providers/services/` 与 `server/modules/providers/tests/`；`resolveModelLaunchSpec`、`resolveModelContextWindowRow` 经 `server/modules/providers/index.ts` 导出。
3. `LaunchSpecGuards` 类型（当前定义在 `launch-profiles.service.ts:16`）随 `model-launch-spec.service.ts` 落到新位置，经 providers 桶文件以 `export type` 导出。旧文件 `launch-profiles.service.ts` 与迁移中的 `model-launch-spec.service.ts` 改为 `import type` 自 providers 桶文件取 —— 这是**过渡性跨模块导入**，随第 2 段拆除消失，须在代码注释里标注为过渡。
4. 更新全部消费者的导入路径；`server/modules/launch-profiles/index.ts` 桶文件相应删掉已迁走的导出（`resolveModelLaunchSpec`、`resolveModelContextWindowRow`、`isAllowedLaunchEnvKey`、`resolveContextWindow`）。
5. **不得删除任何未被搬迁的文件**；本段结束时旧 profile 功能仍须完整可用。

约束（`.agents/skills/backend-module-standards`）：跨模块导入只走 `index.ts` 桶；`server/shared/types.ts` 只允许 `import type`；本段不新建模块；`claude-runtime.provider.js` 是既有 JS 文件，其 TS 化**明确不在本任务范围内**（标准允许保留任务范围，不做无关的全仓迁移）。

<!-- dedup-ref -->与第 2 段（拆除）是不同机制：本段只搬家、不改行为、不删未搬迁文件；第 2 段才做删除。两段顺序不可交换 —— 新机制在编译期依赖旧模块，先删则断。

取假形态：迁移后若某消费者仍指向旧路径，`npm run typecheck` 必红；若搬家过程中改变了白名单或上下文窗口回退顺序，`model-*` 四个测试必红。

## AC

- [ ] `npm run typecheck` 退出码 0；旧路径引用清零：`grep -rn "launch-profiles/launch-spec.service" server/` 与 `grep -rn "launch-profiles/model-launch-spec.service" server/` 均无输出。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-launch-spec.test.ts server/modules/providers/tests/model-spawn-env.test.ts server/modules/providers/tests/model-context-window.test.ts server/modules/providers/tests/model-gateway-end-to-end.test.ts` 退出码 0。
- [ ] 旧 profile 功能未被破坏：`npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/passthrough-parity.test.ts server/modules/launch-profiles/tests/launch-spec-real-profile.test.ts server/modules/launch-profiles/tests/profile-rest-api.test.ts` 退出码 0。
- [ ] 跨模块导入合规：`resolveModelLaunchSpec` 被 `server/modules/websocket/services/shell-websocket.service.ts` 经 providers 桶文件导入（不是深导入）。
- [ ] `bash scripts/test.sh` 全量通过；且测试文件**总数不变**（本段是纯搬家，通过数是回归信号）：`find server src -name '*.test.ts' -o -name '*.test.tsx' | wc -l` 与搬迁前一致。
- [ ] `npm run lint` 退出码 0。（注意：裸 `npx oxlint` 在 pristine develop 上即退出 1，不是判据。）

## DoD

真实落地判据：不是「文件被移动了」就算完成。要求 (a) 新位置的 `resolveModelLaunchSpec` 可被跨模块经 providers 桶文件消费，(b) 旧 `launch-profiles/` 目录只剩旧机制文件（`launch-profiles.service.ts`、`session-profile-lock.ts`、`launch-profiles.routes.ts`、`launch-profiles.module.ts`、`index.ts`），(c) 全量套件与搬迁前同绿、测试文件总数不变。

L_D 该轴仍暗，理由：本段是纯结构搬迁，不改变任何可观测行为，领域轴无新增读数。
L_G 该轴仍暗，理由：同上，行为等价性由 AC-001 黄金基准与全量套件承担。

## Touches

- server/modules/providers/services/launch-spec.service.ts (new; 自 launch-profiles 迁入)
- server/modules/providers/services/model-launch-spec.service.ts (new; 自 launch-profiles 迁入)
- server/modules/providers/tests/model-launch-spec.test.ts (new; 迁入)
- server/modules/providers/tests/model-spawn-env.test.ts (new; 迁入)
- server/modules/providers/tests/model-context-window.test.ts (new; 迁入)
- server/modules/providers/tests/model-gateway-end-to-end.test.ts (new; 迁入)
- server/modules/providers/index.ts
- server/modules/providers/services/provider-models.service.ts
- server/modules/providers/services/provider-token-usage.service.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/websocket/services/shell-websocket.service.ts
- server/modules/launch-profiles/index.ts
- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/launch-spec.service.ts (deleted; 已迁出)
- server/modules/launch-profiles/model-launch-spec.service.ts (deleted; 已迁出)
- server/modules/launch-profiles/tests/model-launch-spec.test.ts (deleted; 已迁出)
- server/modules/launch-profiles/tests/model-spawn-env.test.ts (deleted; 已迁出)
- server/modules/launch-profiles/tests/model-context-window.test.ts (deleted; 已迁出)
- server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts (deleted; 已迁出)
- tasks/gap-launch-profiles-relocate-shared-compile-layer.md