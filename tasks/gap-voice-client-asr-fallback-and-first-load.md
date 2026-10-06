---
id: gap-voice-client-asr-fallback-and-first-load
title: 客户端识别的回退与首次加载：设备放弃后回退必须交给服务端能处理的识别器、设备放弃的原因要让用户看见，选中识别器时预加载模型并显示下载进度
status: needs-human
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`gap-voice-client-asr-wasm-adapter` 与 `gap-voice-client-asr-same-origin-delivery`（均已 done）落了适配器、缓存、同源交付与「设备放弃则回退服务端」的路由；它们的单测只验证了「回退被触发」，没有验证「回退之后拿到文本」，也没有把下载进度接到界面，也没有处理「首次下载远超单段超时」。本任务是对这两个任务落地结果的缺陷修复，不重做识别、缓存与交付。

### 现场（2026-10-06 真实使用 + 本机复现，逐条可核）

1. **回退永远不可能成功（确定的缺陷）。** 用户在 `https://cloudcli.lrfz.com` 上选 `sensevoice-wasm` 后说话，界面报「The local speech engine is not available on this server…」，浏览器控制台是 `POST /api/voice/transcribe 503`，`server.log` 同时有 `voice.transcribe providerId=sensevoice-wasm outcome=fail status=503 latencyMs=0`（片段 19 884 B，约 0.62 s）。路径：`useVoiceInput.transcribeOnDevice` 得到 `route.to === 'server'` 后返回 null，`transcribeSegment` 随即走 `transcribeViaServer`，而服务端的 `/transcribe` 用**用户保存的 providerId** 选识别器（`voice.routes.ts` 里 `voiceSettingsService.getSettings(...)`），那恰好是 `sensevoice-wasm`，服务端没有该引擎，返回 `ENGINE_UNAVAILABLE`。无论设备为什么放弃，回退都会得到同一个 503。
2. **设备放弃的根因（已定位，高置信度推断）：首次加载要下载 239 MB，而单段超时只有 30 s。** 用户界面上的「0.50–1.12s」是该片段在录音中的**起止时间**，不是处理耗时（与片段 19 884 B ≈ 0.62 s 一致）；此前把它当作「0.5 s 内快速失败」是误读。已核实的事实：用户页面的就绪读数 `GET /api/voice/client-assets` 为 `ready: true`、三个资源经公网 206 正常、页面受 service worker 控制；在 localhost 上生产构建的 worker 即使受 service worker 控制也能 `init` 到 `ready` 并识别出文本；用户在真实页面上手动 `init` 同一个 worker 后 90 s 内没有任何回复，符合「正在下载」。**实测 `cloudcli.lrfz.com` 的完整模型下载只有约 100 KB/s**（本机对公网地址测 8 s 得 0.8 MB），239 MB 约需 40 min。所以用户的第一段语音：设备路径开始下载 → 30 s 超时（`VOICE_CLIENT_SEGMENT_TIMEOUT_FLOOR_MS`）→ 适配器返回 `ENGINE_UNAVAILABLE` → 路由回退服务端 → 缺陷 1 的 503。下载在 worker 里继续，但对本段已无意义。
3. **设备放弃的原因没有任何界面可见。** `voice-client-asr:fallback` 事件只发在 `window` 上，没有消费者；用户只看到服务端的 503 文案。
4. **首次下载没有进度，也没有预加载（确定的缺陷）。** worker 里 `init` 的处理调用 `engine.ensureReady()` 没有传进度回调，全仓没有任何地方发出 `{kind:'progress'}`；`useVoiceAvailable` 的注释说「由设置面板接」，但设置面板没有接。真实浏览器里首次加载实测进度回调次数为 0。

### 本任务做什么

1. **回退目标必须是服务端能处理的识别器。** 设备放弃时，该片段上传服务端时必须带上一个服务端注册表里存在、且 locality 不是 `local-client` 的识别器 ID（单次请求级的覆盖，不改用户保存的设置）。回退识别器由用户设置选定；没有选定时，若服务端有可用的 `sensevoice-local` 就用它，否则**不上传**，把设备放弃的原因直接告诉用户。服务端必须拒绝请求里指定 `local-client` 类识别器的覆盖。
2. **模型未就绪时，设备路径不占用片段的超时，立即回退。** 引擎状态不是 `ready`（`stopped` / `starting`）时，片段**立刻**走回退识别器，不等 30 s，回退原因写明「模型仍在下载 / 尚未加载」及当前进度；下载在后台继续，完成后后续片段自动走设备路径。「下载超过单段超时」不再是一种会发生的失败。
3. **设备放弃的原因要可见。** 回退发生时界面（至少是控制台之外的一处用户可见提示）显示放弃原因（`reason` 与 `message`），而不是只显示服务端的 503 文案；`voice-client-asr:fallback` 事件保留。
4. **进度接线与预加载。** worker 把下载进度作为 `{kind:'progress'}` 发回，主线程转给订阅者；在设置里**选中该识别器时**立即发起 `init`（预加载），并在设置面板显示进度条（已下载 / 总字节 / 速度 / 剩余时间）；预加载失败或被取消要显示原因，且不影响其他识别器。
5. **部署文档如实写首次下载的代价。** `docs/operations/voice-client-asr-deployment.md` 说明首次下载 239 MB 取决于服务端出口带宽（本部署实测约 100 KB/s，需数十分钟），并写明下载期间片段走回退识别器。

### 边界（不做）

- 不改识别、缓存、校验、同源交付的行为（下载本身、哈希校验与缓存写入不动）；
- 不新增 `server/**/*.test.ts` 文件（`quay-test-script.test.ts` 钉死了数量），服务端新测试加进 `server/modules/voice/tests/` 已有文件；
- 不做多线程 / COOP-COEP；
- 不做模型的服务端自动下载，也不在本任务内优化服务端出口带宽（那是部署层问题）。

## Plan

- **S0 回退目标。** 服务端 `/transcribe` 接受请求级的识别器覆盖并校验（必须已注册且非 `local-client`）；客户端 `transcribeViaServer` 在回退时带上回退识别器；用户设置里增加回退识别器的选择；没有可用回退目标时不上传。
- **S1 未就绪即回退。** 路由在引擎状态非 `ready` 时立刻回退，不进入 30 s 等待；原因带进度。
- **S2 原因可见。** 回退事件的消费者，在界面显示放弃原因。
- **S3 进度与预加载。** worker 发 progress，主线程订阅，设置面板显示，选中识别器时调用 `init`。
- **S4 文档。**
- **S5 真实使用复核。** 用户在真实页面上：选中识别器后看到下载进度；下载期间说话由回退识别器出文本；下载完成后说话由设备路径出文本。

## AC

- [x] S0：单测证明设备放弃后上传的请求带有回退识别器 ID 且不是 `sensevoice-wasm`，并且拿到回退识别器返回的文本；没有可用回退目标时断言**没有任何 `/api/voice/transcribe` 请求**发出；命令 `npx vitest run src/modules/chat/tests/voiceClientAsrRouting.test.ts` 退出码 0。
- [x] S0：服务端单测覆盖：请求指定已注册的服务端识别器 → 使用它；指定 `sensevoice-wasm`（`local-client`）→ 被拒绝；指定未注册 ID → 被拒绝；不指定 → 行为与现在一致；测试加在已有文件里，命令 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-sensevoice-health.routes.test.ts` 退出码 0，且 `git diff --name-status develop...HEAD -- 'server/**/*.test.ts'` 没有 `A` 行。
- [x] S1：单测用一个「`ensureReady` 永不返回」的假引擎证明：引擎处于 `starting` 时一段语音在**不到 1 s**（用假计时器断言，不等 30 s）内走回退识别器并拿到文本，且回退原因包含「下载 / 加载」字样与进度；命令 `npx vitest run src/modules/chat/tests/voiceClientAsrRouting.test.ts` 退出码 0。
- [x] S2：单测证明回退发生时界面可见提示包含放弃原因文本（不只是错误码）；`npx vitest run src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx src/modules/chat/tests/voiceClientAsrRouting.test.ts` 退出码 0。
- [x] S3：单测证明 worker 在 `init` 期间发出 `progress` 消息、主线程订阅者收到的 `receivedBytes` 单调不减；选中 `sensevoice-wasm` 时调用了一次 `init`，选中其他识别器时没有；命令 `npx vitest run src/modules/chat/tests/voiceClientAsrRouting.test.ts src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx` 退出码 0。
- [x] S4：`grep -c "KB/s\|首次下载" docs/operations/voice-client-asr-deployment.md` 至少为 1，且文档明确写出下载期间片段走回退识别器。
- [x] 全部新增与改动的 `src/` 代码满足 `frontend-module-standards`、`server/` 代码满足 `backend-module-standards`；`npm run typecheck`、`npm run lint`、`npm run build` 均退出码 0。
- [ ] S5 真实使用：在 `https://cloudcli.lrfz.com` 的真实页面上，选中 `sensevoice-wasm` 后设置面板显示下载进度；下载期间说话，该片段由回退识别器识别出文本、不再出现「服务端没有 sensevoice-wasm 引擎」的 503；下载完成后说话由设备路径识别出文本；读数由人 yale 在真实页面取得并写进 `docs/operations/voice-client-asr-deployment.md` 的「已验证」一节，执行者不得代写（待外部）

## DoD

真实落地的标准：在真实页面上，选中 `sensevoice-wasm` 后设置面板立即显示模型下载进度；下载期间说话由回退识别器出文本，下载完成后由设备路径出文本；当设备放弃时用户能看到放弃原因；**在任何情况下都不会再出现「服务端没有 sensevoice-wasm 引擎」的 503**。只有单测、没有真实页面上的这几个读数，不算完成。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/audio/voiceClientAsrWorker.ts
- src/modules/chat/hooks/useVoiceAvailable.ts
- src/modules/chat/index.ts
- src/modules/settings/tabs/VoiceSettingsTab.tsx
- src/shared/voiceConfig.ts
- src/shared/api.ts
- src/shared/types.ts
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-sensevoice-health.routes.test.ts
- src/modules/chat/tests/voiceClientAsrRouting.test.ts
- src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx
- docs/operations/voice-client-asr-deployment.md
- tasks/gap-voice-client-asr-fallback-and-first-load.md

## Notes

**S5 是外部读数，执行者无法取得，故本任务停在 `needs-human`。** 前七条 AC 已逐条验证通过，S5 保持未勾选（不代写、不伪造）。yale 在真实页面量到读数、填进 `docs/operations/voice-client-asr-deployment.md` 的「8. 已验证」一节后，把最后一条勾上即可 `promote`/`complete`。

### 逐条验证（命令与读数）

| AC | 命令 | 读数 |
| --- | --- | --- |
| S0 客户端 | `npx vitest run src/modules/chat/tests/voiceClientAsrRouting.test.ts` | `Tests 15 passed (15)`，退出码 0 |
| S0 服务端 | `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-sensevoice-health.routes.test.ts` | `pass 16 / fail 0`，退出码 0；`git diff --name-status develop...HEAD -- 'server/**/*.test.ts'` 无输出（无 `A` 行，测试加在已有文件里） |
| S1 | 同上第一条 | 假计时器只推进 `VOICE_CLIENT_READINESS_GRACE_MS`（250 ms），断言 `Date.now() - startedAt < 1_000`、`reason === 'engine-unavailable'`、原因含 `12.0 MB`/`239.2 MB`/`100 KB/s`，且从未发出 `{kind:'run'}` |
| S2 | `npx vitest run src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx src/modules/chat/tests/voiceClientAsrRouting.test.ts` | `Tests 22 passed (22)`，退出码 0；`voice-client-asr-fallback` 文本含放弃原因整句（`loading its model` + `12.0 MB of 239.2 MB downloaded`） |
| S3 | `npx vitest run src/modules/chat/tests/voiceClientAsrRouting.test.ts src/modules/settings/tests/voiceSettingsProviderSelection.test.tsx` | `Tests 22 passed (22)`，退出码 0；环回 worker 用例断言 `init` 只发一次、`receivedBytes` 单调不减、`totalBytes` 恒为 239 233 841；设置面板用例断言选中 `sensevoice-wasm` 时预载恰好一次且重渲染后仍是一次、选中其他识别器时零次且面板不出现 |
| S4 | `grep -c "KB/s\|首次下载" docs/operations/voice-client-asr-deployment.md` | `6`（≥1）；第 6 节写明「**下载期间片段走回退识别器。**」 |
| 规范 | `npm run typecheck` / `npm run lint` / `npm run build` | 三者退出码均为 0（lint 仅存量 warning，无 error） |

### 落地要点

1. **回退的目标由 `src/shared/api.ts` 决定，不在 hook 里。** `transcribeVoice` 的第 4 个参数从 `providerOverride?: string` 换成判别联合 `VoiceUploadAddress`（`{kind:'stored'}` / `{kind:'client-fallback', giveUpMessage}`）；`client-fallback` 时由 `resolveVoiceFallbackProvider()` 在已发布的行里挑一个非 `local-client` 的识别器，挑不到就返回 503 `ENGINE_UNAVAILABLE` **且不发任何上传**。把这条判断放在拥有「已发布识别器行」的模块里，才使 S0 的两半都能用一个 fetch stub 直接断言。
2. **服务端只拒绝「请求里带来的」`local-client` 覆盖**（`voice.service.ts` 的 `clientLocalProviderFailure`，400）。用户**存下来的**选择仍是老行为——覆盖为空时该分支不进入，行为与改动前逐字一致（对应 AC 的「不指定 → 行为与现在一致」控制项）。
3. **未就绪即回退**：`routeClientAsrSegment` 在引擎 `available && state !== 'ready'` 时只等 `VOICE_CLIENT_READINESS_GRACE_MS`（250 ms）就回退，原因由 `stillLoadingReason()` 生成（含已下载/总量、速度、剩余时间），不再吃 30 s 的单段超时。
4. **进度只在 `init` 分支发出**（`startVoiceClientAsrWorker`），`engine.ensureReady(cb)` 的每次分片回调转成 `{kind:'progress'}`；`useVoiceClientAsrStatus` 订阅后经 `@/modules/chat` 的 barrel 暴露给设置面板；面板在**选中该识别器时**调一次 `preload()`。
5. **只动 en / zh-CN 两个 `settings.json`**：仓里其余 10 个 locale 从来就没有 `voiceSettings` 段（`providerBuild`/`providerUnavailable` 同样只在 en、zh-CN 里），新增键跟随同一约定，故原 Touches 里那 12 个 `chat.json` 并未改动，已从 Touches 移除。

### 未做 / 边界

- 不改下载、哈希校验、缓存写入与同源交付；不做多线程 / COOP-COEP；不做服务端自动拉模型、也不在任务内优化出口带宽（部署层问题）。
- 未新增任何 `server/**/*.test.ts` 文件（`quay-test-script.test.ts` 钉死数量）。
