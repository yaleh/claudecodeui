---
id: gap-voice-live-vad-readings
title: 连续语音输入的开发者读数：每次输入的前后对照（录音/实发时长、段数、强制切、首字延迟）与 voiceVad=off 的 A/B
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-single-continuous-input-path
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-continuous-capture-vad-segmentation.md` 与人（yale）的要求：**能量化观察到 VAD 前后的差异**，同时**用户界面保持简洁**。所以这些读数**只在 `voiceDebug` 下出现**（控制台与一个页面全局对象），不是用户界面：用户看到的只有两个带时长的回放按钮（见 `gap-voice-replay-pills-duration-only`）。

### 现状与缺口

连续路径接线后（`gap-voice-single-continuous-input-path`），没有任何地方回答「VAD 到底做了什么」：省了多少音频、切成几段、有没有被强制切、一句话说完后多久出字。「前」（没有 VAD 会发什么）也没有基线。

### 方案

1. 每次输入结束产出**一条**读数对象，打到 `console.debug('[voice:live]', reading)`，并写到 `window.__voiceLive`（仅 `voiceDebug` 下）供 e2e 读取。字段：
   - `recordedSec`（原始录音时长）、`sentSec`（实发总时长）、`savedRatio`；
   - `segments`（段数）、`requests`（请求数）、`forcedCuts`（强制切次数）、`longestSegmentSec`、`longestWaitSec`（语音在缓冲里等了多久才被发出）；
   - `firstTextLatencyMs`（从第一段切出到其文字进入输入框）、每段 `latencyMs`；
   - `estAudioTokens`（`sentSec × 7` 的估算，字段名带 `est` 以示估算）、`usage`（服务返回时的累计）。
   - **「前」是反事实**：`baseline` 子对象 =「没有 VAD 时会发的量」= `{ sec: recordedSec, requests: 1, estAudioTokens: recordedSec × 7 }`，每次输入自带，不需要 A/B 才有。
2. **A/B 开关** `voiceVad=off`（仅 `voiceDebug` 下读取，写进 `voiceDebug.ts` 已知开关）：不切分、不过滤，整段作为一个请求发出——即「前」。用于在 e2e 里对同一份样本做开/关两次对比。**它不是用户可见的模式。**
3. 读数的计算是纯函数，放新模块 `voiceLiveReading.ts`，输入是切段器与管线已有的度量（`SegmentTelemetry` 等），不重复计时逻辑。

### 边界（不做）

不新增任何用户可见的界面元素（没有面板、分段条、摘要行、累计统计页）；不记录或上报到服务端；不改切段规则；不显示金额（单价不在仓库里）。

## AC

- [ ] `npm run test:client -- src/modules/chat/utils/tests/voiceLiveReading.test.ts` 退出码 0：用手工构造的度量，读数各字段与手算值一致（`savedRatio`、`estAudioTokens = sentSec × 7`、`baseline.requests = 1`）
- [ ] `npx playwright test e2e/voice-live-vad-ab.spec.ts` 退出码 0（假 provider，零费用），包含下列各项
- [ ] 关闭开关时没有读数：未设 `voiceDebug`，一次完整输入后 `window.__voiceLive` 为 `undefined`，控制台无 `[voice:live]`；设 `voiceDebug` 后恰好一条
- [ ] 同一份样本（`corpus/long/L3-sparse`，经文件上传入口喂入）开 VAD 与 `voiceVad=off` 各跑一次：开时 `sentSec` 小于 `recordedSec` 且 `savedRatio ≥ 0.5`、`requests ≥ 2`；关时 `sentSec == recordedSec`、`requests == 1`、`segments == 1`
- [ ] 两次的差值被写进断言：`recordedSec` 两次相等（± 1 帧），开时 `estAudioTokens` 比关时少的比例等于 `savedRatio`（± 0.01）
- [ ] 无真停顿样本（`L4-nonstop`）：开时 `forcedCuts ≥ 1` 且 `longestSegmentSec ≤ 60`
- [ ] 短样本：累计语音 < 30 s 时 `requests == 1` 且 `forcedCuts == 0`
- [ ] 用户界面不变：开启 `voiceDebug` 与否，composer 内的控件集合（按钮数量与 `data-testid` 列表）相同，除了 `voiceDebug` 已有的上传入口
- [ ] 取假形态（各自必须变红）：把 `savedRatio` 算成实发/录音（取反）→ 数值用例红；`voiceVad=off` 仍切段 → 「关时 requests == 1」红
- [ ] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：在真实页面里对**同一份真人语音时间线样本**，开关两次读到的 `recordedSec / sentSec / requests / forcedCuts / firstTextLatencyMs` 并列成一张前后对照表，写进验收记录；表里每个数字都来自页面上的 `window.__voiceLive`，不是离线重算。样本在仓库外，缺失时必须**指名**缺失路径并失败，不得静默跳过。延迟读数在假 provider 下只反映流水线本身，**不得**据此宣称服务端延迟。不要求任何识别读数。

L_D 该轴有读数：连续输入路径上 VAD 前后的时长、段数、强制切、首字延迟对照。

L_G 该轴仍暗，理由：本任务不产出生成质量轴读数。

## Touches

- src/modules/chat/utils/voiceLiveReading.ts (new)
- src/modules/chat/utils/tests/voiceLiveReading.test.ts (new)
- src/modules/chat/hooks/useVoiceInput.ts
- src/shared/voiceDebug.ts
- e2e/voice-live-vad-ab.spec.ts (new)
- tasks/gap-voice-live-vad-readings.md
