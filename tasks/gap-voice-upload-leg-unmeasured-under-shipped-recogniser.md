---
id: gap-voice-upload-leg-unmeasured-under-shipped-recogniser
title: 上传入口那一腿量不到东西：裁剪默认翻面后 setInputFiles 提交的音频不再被解码/裁剪，读数退回全 null 占位
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-trim-default-flipped-by-unregistered-first-adapter
goal_ac: AC-120
---
## Proposal

本任务承接 AC-120（开关控制的音频文件上传入口走同一条转写链路）。**本轮的直接测量**（不是台账尾巴）：`npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` 退出 1、1.5s，红在 `e2e/voice-trim.spec.ts:840`：

```
TypeError: expect(received).toBeCloseTo(expected, precision)
Matcher error: received value must be a number
Received has value: null
  838 |       trimmedReading.inputSec,
  839 |       `the chain measured no length for this upload: ${JSON.stringify(trimmedReading)}`,
> 840 |     ).toBeCloseTo(FIXTURE_SEC, 1);
    at /data/home/yale/work/claudecodeui/e2e/voice-trim.spec.ts:840:7
```

台账同日同形（`.quay/gate-events.jsonl`）：`2026-09-23T04:38:27.972Z` pass（goal-sweep）→ `2026-09-23T05:41:07.901Z` fail（goal-sweep）、`2026-09-23T05:41:48.868Z` fail（goal-cli）。

### 为什么前一次修复没有守住

`gap-voice-file-upload-input`（done，`goal_ac: AC-120`）把这条判据做绿过（AC 记录 `statusLog`：`2026-09-21T16:24:17.298Z` `active→achieved`，`I2: criterion pass`）。它的产物今天都还在：`src/modules/chat/composer/VoiceUploadButton.tsx`、`src/shared/voiceDebug.ts`、`e2e/voice-trim.spec.ts:811` 的 AC-120 腿。本轮的红**不是**入口消失 —— 腿 1 已经拿到了 `source === 'file'` 的读数（`:836` 的断言通过），入口存在、文件也真的经 `transcribeVoice` 落到了识别器替身上。红的是**那条读数什么都没量**：`inputSec === null`。

机制四跳，逐跳可指：

1. `src/modules/chat/hooks/useVoiceInput.ts:232` `const recogniser = effectivePauseCuesDeclaration();`
2. 同文件 `:233` **第一道闸就返回**：`if (!isVoiceTrimEnabled() || recogniser === null || !trimDecisionFor(recogniser.capability).trim) return recorded;` —— 腿 1 的 URL 是 `/?voiceDebug=1&voiceTrim=on`，开关是开的，所以退出的原因是**能力答的不是 `destructive`**。
3. `src/shared/voiceTrim.ts:371` 的 `trimDecisionFor` 就是 `trim: capability === 'destructive'` → `false`。
4. `shared/asr/asrRegistry.ts:221` 的 `REGISTERED` 至今只有一行 `multimodal`（`shared/asr/list/` 下也只有 `multimodal/`），而 `shared/asr/list/multimodal/multimodal.asr-provider.ts:69` 声明 `pauseCues: 'useful'`；`effectivePauseCuesDeclaration()` 拿有效 provider 的 id 去问 registry，有效 provider 又来自 `listProviders()[0]`。

于是 `prepareUpload`（`useVoiceInput.ts:532`，`mic` 与 `file` 共用同一条路径）直接 `return recorded`，返回的是 `:130` `unmeasured(source)` 的**全 null 占位**：`inputSec/outputSec/savedSec/savedRatio` 全 null。**那条绿是陈的**：它测的是「裁剪跑起来之后这条腿的上传体就是这份文件」，而今天这条链上裁剪根本不跑。

前置（另案，已在飞）：`gap-voice-trim-default-flipped-by-unregistered-first-adapter`（ready，`goal_ac: AC-121`）把出货识别器以 `openai-compatible` / `pauseCues: 'destructive'` 登记进 registry —— 那是让裁剪重新默认运行的那一跳。**本任务不重复它**：`depends_on` 已声明，且 AC4 机械地禁止本任务改动 `shared/asr/**` 与 `src/shared/api.ts`。

<!-- dedup-ref --> 与既有任务的机制区分：本仓本轮同时被这条链扫红的是三条同因判据 —— `gap-voice-trim-default-flipped-by-unregistered-first-adapter`（ready，AC-121）管**登记缺口本身**；`gap-voice-dual-replay-absent-under-shipped-recogniser`（todo，AC-122）管**裁剪跑起来之后录音槽里两条回放并存**；本案管的是**上传入口那一腿在裁剪跑起来之后是否真的被解码、被裁剪，并给出字段齐备的读数**。三者共享同一个前提（登记恢复），但判据面不同：AC-122 读录音槽里的两份音频，本案读 `source === 'file'` 那条读数的 `inputSec/outputSec/savedSec/savedRatio` 与上传体容器。对照先前任务：`gap-voice-file-upload-input`（done，AC-120）只证明「文件能进链路」，从未证明「文件也被裁剪、且读数真的量到了它」—— 本轮量到的正是这一条缺口。

### 本任务做什么

在登记恢复、且出货默认（`?voiceDebug=1&voiceTrim=on`）下，让上传入口那一腿重新被解码与裁剪，并把这份「量得到」钉在出货路径上：

1. **取基线**：前提落地后（`tryResolve('openai-compatible')` 非 null 且 `listProviders()[0]` 就是它），干净工作树上跑 AC-120 腿，记录它自己打印的 `[voice-upload] trimmed: file=…s uploaded=…s source=file` 读数。
2. **若已绿**：不改实现 —— 把读数与「文件腿的读数在出货默认下字段齐备」记进完成记录；本判据的守卫就是既有的 AC-120 腿本身，不新增第二实现、不加第二张表、不新增开关。
3. **若仍红**：只在 `src/modules/chat/hooks/useVoiceInput.ts` 的文件腿上修（`source === 'file'` 走 `prepareUpload` 的 decode → trim → 重编码 + 读数回报），必要时下探 `VoiceUploadButton.tsx` / `voiceDebug.ts`；**不得**在客户端重引入任何能力表（AC-134 有意删掉的那张），**不得**绕过 `transcribeVoice` 直接塞文本。
4. **取假验证承重**（见 AC3）：把入口改走旁路（不经上传）⇒ 必红在 `the chosen file never reached the recogniser`；把入口做成常显（开关关不掉）⇒ 必红在 leg 3 的 `toHaveCount(0)`。

边界（不做）：不改 `shared/asr/**` 的登记与声明、不改 `src/shared/api.ts` 的读点；不重引入客户端能力表；不削弱 `e2e/voice-trim.spec.ts` 的既有断言；不改默认交互（入口默认隐藏）；不做拖拽/批量上传与文件持久化；不引入新依赖。

## Plan

- **S0 基线**：确认前提已落地（`tryResolve('openai-compatible')` 非 null 且 `listProviders()[0]` 就是它），再 `npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` 取读数；红则记下失败行原文，绿则直接进 S2。
- **S1 修复（仅红时）**：文件腿与麦克风腿共用 `prepareUpload` 的读数组装路径；修的是「来源是 `file` 时也要走 decode → trim → 重编码，并把 `stats` 填进读数」，而不是给文件腿另开一条链。每个读数键的来源必须是 `stats`，不得出现常量。
- **S2 取假 + 复核**：两种取假形态各跑一次并记命令与原文；`git diff --name-only $(git merge-base HEAD develop)..HEAD` 复核 `shared/asr/` 与 `src/shared/api.ts` 都未被改动。

## AC

- [ ] AC1 `npx playwright test e2e/voice-trim.spec.ts -g "AC-120"` 退出 0。修前同一命令退出 1、1.5s、红在 `e2e/voice-trim.spec.ts:840`（`Received has value: null`，`trimmedReading.inputSec`）；两份读数原文都记进 DoD。
- [ ] AC2 `npx playwright test e2e/voice-trim.spec.ts`（整文件，AC-119/120/121/122 全腿）退出 0 —— 没有哪条腿被本改动弄红。
- [ ] AC3 取假变体两条，各自必须有读数：把入口改走旁路（不经上传、直接塞固定文本）⇒ AC1 退出非 0 且失败行是 `the chosen file never reached the recogniser`；把入口做成常显（`?voiceDebug=off` 下仍渲染）⇒ AC1 退出非 0 且红在 leg 3 的 `uploadEntry()`/`uploadInput()` `toHaveCount(0)`。两次退出码与失败行原文记进 DoD。
- [ ] AC4 本任务不落在登记面：`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^shared/asr/'` 输出 `0`；且 `git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^src/shared/api.ts'` 输出 `0`。
- [ ] AC5 判据未被削弱：`grep -c "the chain measured no length for this upload" e2e/voice-trim.spec.ts`、`grep -c "the chosen file never reached the recogniser" e2e/voice-trim.spec.ts`、`grep -c "input\[type=\\\"file\\\"\]" e2e/voice-trim.spec.ts` 各自输出 `1`（分别对应用户可见的失败因由、旁路取假的失败行、入口的真实选择器）。
- [ ] AC6 `npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-120 在 `.quay/gate-events.jsonl` 里的尾巴由 `2026-09-23T05:41:07.901Z` 的 fail 转回 pass。
- **真落地**：不是「入口可见」，而是**一份已知 WAV 经真实浏览器上传后，那条 `source === 'file'` 的读数真的量到了它** —— `inputSec` ≈ fixture 时长（±0.1s）、`outputSec` 与上传体重解析出的容器时长一致（±0.02s）、`savedSec/savedRatio` 非 null、`fallback === false`，上传体是 RIFF/WAVE 且严格短于 fixture，两条来源共用同一次 `transcribeVoice`。这些读数由 AC-120 腿自己在 trace 里打印（`[voice-upload] trimmed: file=…s uploaded=…s source=file`），完成记录里引用同一段原文。
- **前提如实登记**：本判据此前不可能为真（裁剪不跑 ⇒ 文件腿的读数恒为全 null 占位）。完成记录里必须写明 `gap-voice-trim-default-flipped-by-unregistered-first-adapter` 的落地提交/合并 sha；前提未落地时不得宣称本任务完成。
- **三次读数原文**（命令 + 退出码 + 失败行）：修前 AC1（本节 Proposal 已录原文）；取假（旁路入口）后的 AC1；取假（常显入口）后的 AC1。
- **L_D 该轴仍暗，理由**：本任务只让上传入口那一腿的读数重新字段齐备，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 本任务的读数是上传体的容器、时长与读数键的齐备性，不是生成质量轴读数；目标层判据由 GOAL-006 的其余判据承担。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/VoiceUploadButton.tsx
- src/shared/voiceDebug.ts
- e2e/voice-trim.spec.ts
- tasks/gap-voice-upload-leg-unmeasured-under-shipped-recogniser.md
