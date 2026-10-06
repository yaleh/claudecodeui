---
id: gap-voice-client-asr-fallback-and-first-load
title: 客户端识别的回退与首次加载：设备放弃后回退必须交给服务端能处理的识别器、设备放弃的原因要让用户看见，选中识别器时预加载模型并显示下载进度
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`gap-voice-client-asr-wasm-adapter` 与 `gap-voice-client-asr-same-origin-delivery`（均已 done）落了适配器、缓存、同源交付与「设备放弃则回退服务端」的路由；它们的单测只验证了「回退被触发」，没有验证「回退之后拿到文本」，也没有把下载进度接到界面。本任务是对这两个任务落地结果的缺陷修复，不重做识别、缓存与交付。

### 现场（2026-10-06 真实使用 + 本机复现，逐条可核）

1. **回退永远不可能成功（确定的缺陷）。** 用户在 `https://cloudcli.lrfz.com` 上选 `sensevoice-wasm` 后说话，界面报「The local speech engine is not available on this server…」，浏览器控制台是 `POST /api/voice/transcribe 503`，`server.log` 同时有 `voice.transcribe providerId=sensevoice-wasm outcome=fail status=503 latencyMs=0`（片段 19 884 B，约 0.6 s）。路径：`useVoiceInput.transcribeOnDevice` 得到 `route.to === 'server'` 后返回 null，`transcribeSegment` 随即走 `transcribeViaServer`，而服务端的 `/transcribe` 用**用户保存的 providerId** 选识别器（`voice.routes.ts` 里 `voiceSettingsService.getSettings(...)`），那恰好是 `sensevoice-wasm`，服务端没有该引擎，返回 `ENGINE_UNAVAILABLE`。无论设备为什么放弃（引擎不可用或某段太慢），回退都会得到同一个 503。
2. **设备为什么在 0.5–1.1 s 内就放弃，原因未定位。** 该耗时远小于 239 MB 的下载，说明失败发生在下载之前或下载一开始。已排除：服务端 `/voice-client/*` 经公网 200 / 206 正常；真实浏览器里（localhost）通过真实适配器 `routeClientAsrSegment` 在注入就绪读数时识别成功（「开饭时间早上9点至下午5点。」）；生产构建的 worker chunk（`voiceClientAsrWorker-BCtGyuk4.js`）在 localhost 能 `init` 到 `ready`；用户页面加载的是新构建（`index-CbUXrHzM.js` 含 `voice-client/model`）。**没有排除的**：真实就绪读数请求（`GET /api/voice/client-assets`，需登录，我无法代取）、页面上已受 service worker 控制时 worker 对 `/voice-client/*` 的请求、`cloudcli.lrfz.com` 经 Cloudflare 的 worker 加载。
3. **设备放弃的原因没有任何界面可见。** `voice-client-asr:fallback` 事件只发在 `window` 上，没有消费者；用户只看到服务端的 503 文案。
4. **首次下载没有进度，也没有预加载（确定的缺陷）。** worker 里 `init` 的处理调用 `engine.ensureReady()` 没有传进度回调，全仓没有任何地方发出 `{kind:'progress'}`；`useVoiceAvailable` 的注释说「由设置面板接」，但设置面板没有接。真实浏览器里首次加载实测进度回调次数为 0。下载发生在**第一段语音**上，而每段的超时下限只有 30 s，慢网下 239 MB 要 8–10 分钟，所以首次使用大概率在下载完成前就超时回退（该推断未在慢网下实测）。

### 本任务做什么

1. **回退目标必须是服务端能处理的识别器。** 设备放弃时，该片段上传服务端时必须带上一个服务端注册表里存在、且 locality 不是 `local-client` 的识别器 ID（单次请求级的覆盖，不改用户保存的设置）。回退识别器由用户设置选定；没有选定时，若服务端有可用的 `sensevoice-local` 就用它，否则**不上传**，把设备放弃的原因直接告诉用户。服务端必须拒绝请求里指定 `local-client` 类识别器的覆盖。
2. **设备放弃的原因要可见。** 回退发生时界面（至少是控制台之外的一处用户可见提示）显示放弃原因（`reason` 与 `message`），而不是只显示服务端的 503 文案；`voice-client-asr:fallback` 事件保留。
3. **定位并修复第 2 条的根因。** 先在真实使用环境读出放弃原因（见 AC 的待外部项），再对症修复；修复须有单测覆盖该原因。
4. **进度接线与预加载。** worker 把下载进度作为 `{kind:'progress'}` 发回，主线程转给订阅者；在设置里**选中该识别器时**立即发起 `init`（预加载），并在设置面板显示进度条（已下载 / 总字节 / 速度 / 剩余时间）；首次说话时模型已就绪的情况下不再触发下载。预加载失败或被取消要显示原因，且不影响其他识别器。

### 边界（不做）

- 不改识别、缓存、校验、同源交付的行为；
- 不新增 `server/**/*.test.ts` 文件（`quay-test-script.test.ts` 钉死了数量），服务端新测试加进 `server/modules/voice/tests/` 已有文件；
- 不做多线程 / COOP-COEP；
- 不做模型的服务端自动下载。

## Plan

- **S0 回退目标。** 服务端 `/transcribe` 接受请求级的识别器覆盖并校验（必须已注册且非 `local-client`）；客户端 `transcribeViaServer` 在回退时带上回退识别器；用户设置里增加回退识别器的选择；没有可用回退目标时不上传。
- **S1 原因可见。** 回退事件的消费者，在界面显示放弃原因。
- **S2 根因。** 用户在真实页面上运行诊断，读出放弃原因，对症修复。
- **S3 进度与预加载。** worker 发 progress，主线程订阅，设置面板显示，选中识别器时调用 `init`。
- **S4 真实使用复核。** 用户在真实页面上说话：设备路径识别出文本；人为制造设备放弃，回退识别器返回文本。

## AC

- [ ] S0：单测证明设备放弃后上传的请求带有回退识别器 ID 且不是 `sensevoice-wasm`，并且拿到回退识别器返回的文本；没有可用回退目标时断言**没有任何 `/api/voice/transcribe` 请求**发出；命令 `npx vitest run src/modules/chat/tests/voiceClientAsrRouting.test.ts` 退出码 0。
- [ ] S0：服务端单测覆盖：请求指定已注册的服务端识别器 → 使用它；指定 `sensevoice-wasm`（`local-client`）→ 被拒绝；指定未注册 ID → 被拒绝；不指定 → 行为与现在一致；测试加在已有文件里，命令 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-sensevoice-health.routes.test.ts` 退出码 0，且 `git diff --name-status develop...HEAD -- 'server/**/*.test.ts'` 没有 `A` 行。
- [ ] S1：单测证明回退发生时界面可见提示包含放弃原因文本（不只是错误码）；`npx vitest run src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx src/modules/chat/tests/voiceClientAsrRouting.test.ts` 退出码 0。
- [ ] S3：单测证明 worker 在 `init` 期间发出 `progress` 消息、主线程订阅者收到的 `receivedBytes` 单调不减；选中 `sensevoice-wasm` 时调用了一次 `init`，选中其他识别器时没有；命令 `npx vitest run src/modules/chat/tests/voiceClientAsrRouting.test.ts src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx` 退出码 0。
- [ ] 全部新增与改动的 `src/` 代码满足 `frontend-module-standards`、`server/` 代码满足 `backend-module-standards`；`npm run typecheck`、`npm run lint`、`npm run build` 均退出码 0。
- [ ] S2 / S4 真实使用：在 `https://cloudcli.lrfz.com` 的真实页面上，先读出设备放弃的原因（控制台 `voice-client-asr:fallback` 事件的 `detail`），修复后用真实浏览器说话得到设备路径识别出的文本，且人为制造设备放弃时回退识别器返回文本；读数由人 yale 在真实页面取得并写进 `docs/operations/voice-client-asr-deployment.md` 的「已验证」一节，执行者不得代写（待外部）

## DoD

真实落地的标准：在真实页面上，选中 `sensevoice-wasm` 后设置面板立即显示模型下载进度并在完成后进入就绪；说话得到设备路径识别出的文本；当设备放弃时用户能看到放弃原因，并且该片段由回退识别器识别出文本，**在任何情况下都不会再出现「服务端没有 sensevoice-wasm 引擎」的 503**。只有单测、没有真实页面上的这三个读数，不算完成。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/audio/voiceClientAsrWorker.ts
- src/modules/chat/hooks/useVoiceAvailable.ts
- src/modules/settings/tabs/VoiceSettingsTab.tsx
- src/shared/voiceConfig.ts
- src/shared/api.ts
- src/shared/types.ts
- server/modules/voice/voice.routes.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-sensevoice-health.routes.test.ts
- src/modules/chat/tests/voiceClientAsrRouting.test.ts
- src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- docs/operations/voice-client-asr-deployment.md
- tasks/gap-voice-client-asr-fallback-and-first-load.md
