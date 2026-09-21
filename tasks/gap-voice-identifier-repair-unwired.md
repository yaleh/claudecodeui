---
id: gap-voice-identifier-repair-unwired
title: 把标识符修复接进语音转写路径：候选取自项目文件树，AC-115 由红转绿
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状：`repairIdentifiers`（`src/shared/identifierRepair.ts:239`）在生产代码里**零 import** —— 只有它自己的单测与 `experiments/voice-identifiers/` 用到。语音链路里唯一被接进去的是**度量**：`useVoiceInput.ts:219` 的 `console.debug('[voice] identifier fidelity', …)`，设计上只打印、不改写。所以 GOAL-005「范围」里那句「确定性修复落地客户端」并未落地：说错的名字不会被还原，composer 里就是识别器原文。

判据侧证据（2026-09-21 实测）：仅把 e2e 夹具从「拼写正确」改成修复前形态，AC-115 即在 `e2e/voice-identifier-repair.spec.ts:267` 红，composer 实际持有识别器原文 `please open voice.rouse.ts and fix the proxy` —— 链路里没有任何东西在改写。夹具已按此改好（播报形态 `voice.rouse.ts`，工作区真实文件 `voice.routes.ts`，取自语料里的实测形态 zh-d02）；该错拼形态**出货模块当前已能还原**，所以本任务不是在建一个修不了的例子。

方案：
1. **候选源**：新增 `src/shared/projectIdentifiers.ts`，经既有 `GET /api/file-tree/projects/:projectId/files`（`src/shared/api.ts:279`，`respectGitignore: true`）取回项目文件清单，按两种形态摊平（basename + 裸符号名，与训练语料一致），按 projectId 记忆化：一次会话只发一次请求；请求失败或清单为空则返回空数组，绝不因此打断转写。新 `src/shared/*.ts` 被前端模块引用会触发 oxlint 的 boundaries/no-unknown，须同时把它登记进 `.oxlintrc.json`。
2. **接线点**：`useVoiceInput.ts` 的 `raw → text` 边界（约 211–219 行），在 `onTranscript` 之前调用 `repairIdentifiers(text, candidates)`。候选为空时保持既有行为不变（模块自身对空候选 early-return）。
3. **候选由上层传入**：`useVoiceInput` 不去认项目 —— 项目 id 由 `ChatInterface` / `ChatComposer` 一侧提供（与 `draftScope` 同源），候选经参数进入 hook，保持 hook 的单测可驱动性。
4. **遥测**：把现有的 `console.debug('[voice] identifier fidelity', …)` 改成报 before/after 两个读数，使 AC-114 的指标成为修复自己的遥测，而不是一个旁观的读数。

<!-- dedup-ref -->
相关：`gap-identifier-repair-harness-measures-a-copy`（收敛该模块的两份实现，与本任务各自独立）；`gap-voice-clip-single-slot-playback` 是同一 composer 的录音槽，不改转写文本。

## AC

- [ ] `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` 退出码 0（即 AC-115 由红转绿）
- [ ] 候选源单测：`npx vitest run src/shared/tests/projectIdentifiers.test.ts` 退出码 0，覆盖两种形态摊平、同 projectId 只发一次请求、请求失败返回空数组、空候选不改写
- [ ] 真实路径零改写：`npx vitest run src/modules/chat/tests/voiceTranscriptRepair.test.tsx` 退出码 0，含一句不含任何标识符的普通中英文经同一链路后逐字不变，且失败信息须打印实测的前后文本
- [ ] 取假形态：把 `repairIdentifiers` 临时换成恒等函数（`return text`）后，AC-1 判据必须红（记录原始终端读数与 composer 实际持有值），随后还原并确认工作树干净
- [ ] `npm run lint` 与 `npx tsc --noEmit -p tsconfig.json` 退出码 0

## DoD

真实落地判据：必须在**真实运行的前端**上经语音按钮走一遍，不以单测代替。须给读数：(a) 假麦克风注入后 composer 的最终文本，逐字给出「识别器返回」与「composer 持有」两侧（`please open voice.rouse.ts…` → `please open voice.routes.ts…`），并确认后者的标识符与工作区真实文件名逐字一致（大小写与点号）；(b) 按 AC-4 注入恒等函数重跑，登记红读数与 composer 实际值，随后还原；(c) 零改写的真实路径读数：一句不含标识符的普通句子经同一路径后逐字不变，并打印前后文本 —— 放宽候选匹配若换来误改，这条就是它的护栏；(d) 候选源的真实接口读数：一次会话里 `/api/file-tree/…/files` 的请求次数（应为 1）与失败时的降级行为（转写照常完成，不因候选源失败而丢字）；(e) 操作记录逐步留痕。

L_D 该轴仍暗，理由：本任务是把既有确定性模块接进既有链路，不新增领域能力。
L_G 该轴仍暗，理由：同上；本任务的读数是 composer 的 before/after 文本、请求次数与零改写读数。

## Touches

- src/shared/projectIdentifiers.ts (new)
- src/shared/tests/projectIdentifiers.test.ts (new)
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/voiceTranscriptRepair.test.tsx (new)
- .oxlintrc.json
- playwright.config.ts
- e2e/voice-identifier-repair.spec.ts
- tasks/gap-voice-identifier-repair-unwired.md
