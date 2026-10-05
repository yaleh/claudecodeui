---
id: gap-voice-sensevoice-server-adapter
title: 服务端 SenseVoice 适配器：把打补丁的 sherpa-onnx 作为 sensevoice-local 识别器接进 ASR
  缝，输出文本与逐 token 置信度和时间（子进程 worker、构建产物固定、健康检查）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-asr-token-confidence-contract
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on`）：`grep -il 'sensevoice\|sherpa' tasks/*.md` 无命中；契约部分归 `gap-voice-asr-token-confidence-contract`，本任务只做适配器与运行时。来源：`docs/proposals/voice-correction-feedback-loop.md` §5.9「引擎实现」、阶段 0；依据 `experiments/voice-index-loop/RESULT-v5.md`、`RESULT-v6.md`、补丁与构建脚本 `experiments/voice-index-loop/sherpa-patch/`。

### 目标

在 ASR 缝里加第四个识别器 `sensevoice-local`：服务端在本机运行**打了补丁的 sherpa-onnx 1.13.8** 的 SenseVoice-Small（int8），对上传的片段返回 `{ text, tokens[{ text, confidence, startMs }], meta.buildId }`（契约见 `gap-voice-asr-token-confidence-contract`）。已测读数：实时因子 p50 0.019；对本地 CPU 无 GPU。

### 方案（本文是提案，执行者可在记录理由后调整，但不得放宽 AC）

1. **运行时 = 子进程 worker，不是 Node 原生绑定**：`scripts/sensevoice/worker.py` 经 stdin / stdout 的 JSON 行协议收「音频字节（base64）与格式」、回 `{ text, tokens, buildId }`；`server/modules/voice/` 里的 TypeScript 管理器负责启动、并发上限（默认 2）、单次超时、崩溃后重启与排队。Node 绑定（`sherpa-onnx-node`）是否能带上补丁**没有验证**，列为后续备选。
2. **构建产物固定**：`scripts/sensevoice/manifest.json` 记录模型文件 sha256、补丁文件 sha256、期望的 `buildId`；管理器启动时校验，不一致就把引擎标为不可用（原因是同一段音频在不同构建产物上文本与置信度会略有不同，见提案 §5.9）。
3. **配置只在组装处读一次**（沿用 `voice.module.ts` 的「环境变量只在组合根读取」约定）：`SENSEVOICE_MODEL_DIR`、`SENSEVOICE_PYTHON`；缺失或校验失败 ⇒ `GET /api/voice/health` 报稳定错误码 `ENGINE_UNAVAILABLE` 并带可行动的说明，**不得**静默回退到别的识别器。
4. **不需要 API key**：设置页选中 `sensevoice-local` 时不显示密钥字段；provider 选择沿用现有的 `providerId` 机制与 fail-closed 规则。
5. 实现遵循 `.agents/skills/backend-module-standards`（`server/modules/voice/` 下全部 TypeScript、路由只解析与转发、测试放 `server/modules/voice/tests/`）与 `.agents/skills/frontend-module-standards`（设置页）。

### 边界（不做）

不做客户端（浏览器 / 手机）路径（见 `gap-voice-client-asr-feasibility-probe`）；不做任何 UI 上的置信度展示；不改 Omni 等现有识别器；不把模型权重或构建产物放进仓库（只放补丁、脚本与 manifest）。

## AC

- [ ] `npx vitest run server/modules/voice/tests/voice-sensevoice-adapter.test.ts` 退出码 0：用假 worker 接缝覆盖 ①正常返回映射成 `AsrSuccess`（含 `tokens`、`meta.buildId`）②worker 超时 ③worker 崩溃后重启并成功处理下一条 ④并发超过上限时排队而不是并发执行 ⑤manifest 校验失败 ⇒ `ENGINE_UNAVAILABLE`
- [ ] 真实运行时：`SENSEVOICE_MODEL_DIR=/data/home/yale/work/sv-probe/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 SENSEVOICE_PYTHON=<打补丁构建的 python> npx vitest run server/modules/voice/tests/voice-sensevoice-real.test.ts` 退出码 0：对 ≥ 3 个 wav fixture，`tokens` 非空、每个 `confidence` ∈ (0, 1]、`meta.buildId` 与 manifest 一致、实时因子 ≤ 0.2；对同一片段的文本与补丁引擎的记录（`tc-verify/corpus/voice-index-loop/sv2/sv.jsonl`）逐字相同（≥ 5 个片段）
- [ ] `GET /api/voice/health`：选中 `sensevoice-local` 且引擎可用时返回运行时状态与 `buildId`；模型目录缺失时返回稳定错误码 `ENGINE_UNAVAILABLE`（路由测试，沿用既有的 `voice-error-contract` 判据形状）
- [ ] 注册表检查：`node scripts/asr-capability-check.mjs`、`node scripts/asr-contract-invariants-check.mjs`、`node scripts/asr-health-provider-check.mjs` 退出码 0（第四个适配器不能让既有的「第二适配器检查」等红）
- [ ] 设置页：`npx vitest run src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx` 退出码 0，且新增用例断言选中 `sensevoice-local` 时不渲染密钥字段、可保存；`src/modules/i18n/locales/en/settings.json` 与 `zh-CN/settings.json` 含新增文案键
- [ ] MCP 浏览器验证：用 playwright MCP 打开 `http://localhost:3001/`，设置 → 语音 → 选择 `sensevoice-local` 并保存；在 `?voiceDebug=1` 的上传入口上传一个 wav fixture，输入框得到识别文本；把页面上的文本与 `GET /api/voice/health` 的 `buildId` 记入 `## Evidence`
- [ ] `npm run typecheck`、`npm run lint`、`npm run build` 退出码 0

## DoD

真实落地判据：**真实的打补丁 sherpa-onnx 与真实模型**经子进程 worker 处理真实 wav，并在 MCP 浏览器里通过上传入口走完「设置选中 → 上传 → 输入框出文本」；与补丁引擎的离线记录逐字相同证明部署的构建产物就是实验用的那一份。缺模型 / 缺 Python 时的失败是可行动的稳定错误码，不是崩溃。

L_D 该轴仍暗，理由：本任务只接入识别器，不新增领域数据能力。

L_G 该轴有读数：同一批片段上适配器输出与补丁引擎记录的逐字一致率，与实时因子，由真实运行时测试给出。

## Touches

- shared/asr/list/index.ts
- shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.ts (new)
- server/modules/voice/sensevoice-worker.ts (new)
- server/modules/voice/voice.module.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/voice.routes.ts
- server/modules/voice/tests/voice-sensevoice-adapter.test.ts (new)
- server/modules/voice/tests/voice-sensevoice-real.test.ts (new)
- scripts/sensevoice/worker.py (new)
- scripts/sensevoice/manifest.json (new)
- scripts/sensevoice/README.md (new)
- src/modules/settings/tabs/VoiceSettingsTab.tsx
- src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx
- src/shared/voiceConfig.ts
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- tasks/gap-voice-sensevoice-server-adapter.md
