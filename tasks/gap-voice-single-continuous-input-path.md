---
id: gap-voice-single-continuous-input-path
title: 语音输入只保留连续路径：边说边按序提交文字、被跟踪的插入区间、停止/发送语义、空闲 2 分钟自动停止
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-live-segmenter
  - gap-voice-replay-pills-duration-only
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` 与人（yale）的裁定：**语音输入只保留连续这一种路径，用户不区分两种模式**（额外的认知负担）。用户应当感受到的是：输入被过滤干净了、识别成本降低了、可以更放心地说长话。本条把切段器（`gap-voice-live-segmenter`）和回放按钮（`gap-voice-replay-pills-duration-only`）接进真实的录音 hook。**只面向 `dashscope-omni`。**

### 现状与缺口

页面上现在仍是「一次按键 = 一段 `MediaRecorder` 录音 = 一次请求」：`useVoiceInput.ts` 在停止后解码、批处理裁剪、整段上传；流式 VAD 只在旁路跑，事件只打到 `voiceDebug` 控制台；`runSegmentPipeline` 没有任何非测试调用方。三个相关任务都标 done，是因为各自验收满足，**没有任务负责最后一步的接线**。

### 方案

手势不变：点麦克风开始、点停止（或直接点发送）结束。短输入（累计语音 < 30 s）仍然是一个请求，用户看到的流程与今天相同；话变长时文字边说边出现。

1. **只保留连续路径**：录音源改为 worklet 的 PCM，经切段器切段，段交给 `runSegmentPipeline`，每段调用现有的 `transcribeVoice`。**移除 `MediaRecorder` 与批处理的 `prepareUpload` / `trimVoiceAudio` / `isVoiceTrimEnabled` 在 hook 里的使用**。
2. **边说边按序提交**：只提交「从第一段起连续完成」的前缀。第 2 段先回来、第 1 段未完成时，第 2 段的文字不进输入框；第 1 段完成后一并按序追加。
3. **被跟踪的插入区间**：起点是开始监听时的光标位置；监听期间用户编辑其他位置，区间随之偏移，已提交的文字始终连续、按序、不被覆盖。纯函数放在新模块 `voiceInsertion.ts`。
4. **失败只用现有红色提示**：某段重试用尽后，用输入框上方已有的 `voice-error-notice` 显示一句话（含该段的起止时间），**输入框里不放任何标记**；其余段的文字不受影响。
5. **停止与发送**：点停止，冲刷当前在说的那一段、等在途请求完成后收尾；监听中点「发送」等价于「停止，等全部完成后发送一次」。
6. **空闲自动停止**：连续 `DEFAULT_IDLE_AUTOSTOP_SEC = 120` 秒没有语音则自动停止，不发请求、不报错。整个输入无语音时同样不发请求。
7. **回放槽**：停止后填 `VoiceClipSlot`：过滤后的音频（各段拼接）总是提供；原始 PCM（16 kHz Int16）总长超过 `ORIGINAL_CAP_SEC = 600` 时 `original` 为 `null`。
8. **调试覆盖项**（仅 `voiceDebug` 下读取，写进 `voiceDebug.ts` 的已知开关）：`voiceMinSegmentSec`、`voiceIdleSec`，让 e2e 用短样本验证长输入逻辑。
9. 文件上传入口（`voiceDebug` 才显示）走**同一条**管线：解码为 PCM 后喂入切段器，不再有第二条批处理路径。

### 边界（不做）

不改服务端；不改 provider 声明；不处理 Groq；不新增任何界面控件、分段条或摘要行；不改切段器与回放按钮本身（它们是前置任务的产物）。

## AC

- [ ] `npm run test:client -- src/modules/chat/utils/tests/voiceInsertion.test.ts` 退出码 0：固定种子的 ≥200 个随机编辑序列下，已提交文字始终连续、按序，用户在区间外的编辑被完整保留
- [ ] `npx playwright test e2e/voice-continuous.spec.ts` 退出码 0，且包含下列各项（假 provider 拦截 `/api/voice/transcribe`，零费用）
- [ ] 短输入：累计语音 < 30 s 的样本，请求数恰好 1，停止后输入框文字等于该请求的返回
- [ ] 长输入（`voiceMinSegmentSec` 调小）：请求数 ≥ 2；让第 1 段的返回晚于第 2 段，输入框里第 2 段的文字在第 1 段完成之前**不出现**，之后顺序正确
- [ ] 边说边出现：仍在监听时（尚未点停止），至少有一段的文字已经在输入框里
- [ ] 失败：让第 2 段始终失败，其余段的文字完整在输入框里；`voice-error-notice` 恰好出现一次；输入框文本不含任何占位或标记
- [ ] 无语音：整段静音的输入，请求数为 0，状态回到待机，没有错误提示
- [ ] 空闲自动停止：`voiceIdleSec` 调到 2，静音下约 2 s 后自行停止，请求数为 0
- [ ] 发送：监听中点发送，等全部段完成后 `onTranscript(text, true)` 恰好被调用一次，文字为全部段按序拼接
- [ ] 回放槽：停止后过滤后的按钮存在；总长超过上限时只有过滤后的按钮（用调小的 `ORIGINAL_CAP_SEC` 覆盖验证）
- [ ] 已有的语音 e2e（`voice-trim.spec.ts`、`voice-identifier-repair.spec.ts`、`voice-error-messages.spec.ts`、`voice-dashscope-written.spec.ts`）按新路径更新后全部通过，不得以删除断言的方式过关
- [ ] `grep -n "MediaRecorder\|trimVoiceAudio\|isVoiceTrimEnabled\|prepareUpload" src/modules/chat/hooks/useVoiceInput.ts | wc -l` 的结果为 0
- [ ] 取假形态（各自必须变红）：按完成顺序而非序号提交文字 → 「第 2 段不早于第 1 段出现」红；把最小段长删掉 → 「短输入请求数恰好 1」红；失败段在输入框里放占位 → 「输入框不含标记」红
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是各部件单独通过，而是**在真实页面里完整走通一次**：用 e2e 注入 `corpus/long` 的样本经真实 `AudioWorklet`，输入框里的文字按说话顺序出现、停止后回放槽里有过滤前后的两条、没有第二条上传路径残留。并且用 `corpus/long/L2-mixed` 对真实 `dashscope-omni` 做**一次**冒烟（受 `gap-voice-long-form-eval-prereg` 的 2 元预算约束，沿用其预算闸与 `pricing.json`，缺单价则冒烟必须指名原因并失败，不得降级报绿）：读到请求数、各段时长与 `usage`，拼回后的句数与真值一致。取假形态红的同时，保留一份「改前 vs 改后」的对照记录（改前：一个请求、整段时长；改后：段数、实发时长）。

L_D 该轴仍暗，理由：本任务是接线，不新增领域数据能力；读数归 `gap-voice-live-vad-readings`。

L_G 该轴仍暗，理由：质量读数归评估任务，本任务只做链路冒烟。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/utils/voiceInsertion.ts (new)
- src/modules/chat/utils/tests/voiceInsertion.test.ts (new)
- src/shared/voiceDebug.ts
- e2e/voice-continuous.spec.ts (new)
- e2e/voice-trim.spec.ts
- e2e/voice-identifier-repair.spec.ts
- e2e/voice-error-messages.spec.ts
- e2e/voice-dashscope-written.spec.ts
- tasks/gap-voice-single-continuous-input-path.md
