---
id: gap-voice-dual-replay-absent-under-shipped-recogniser
title: 录音槽只剩一条回放：裁剪默认翻面后第二回放消失，登记恢复后两条必须重新并存
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-trim-default-flipped-by-unregistered-first-adapter
---
## Proposal

本任务承接 AC-122（回放同时提供原始录音与裁剪后音频两条）。**本轮的直接测量**（不是台账尾巴）：`npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 退出 1、14.2s，红在 `e2e/voice-trim.spec.ts:1129`：

```
Error: the recording slot offers no replay of the trimmed upload: the trim happened and cannot be heard
  Locator: getByRole('button', { name: 'Replay trimmed' })
  Expected: visible — Error: element(s) not found
```

台账同日同形（`.quay/gate-events.jsonl`）：`2026-09-23T04:32:38.031Z` pass → `2026-09-23T05:33:11.686Z` fail（goal-sweep）、`2026-09-23T05:34:06.113Z` fail（goal-cli）。

### 为什么前一次修复没有守住

`gap-voice-clip-dual-playback`（done，`goal_ac: AC-122`）把这条判据做绿过 —— 04:32:38Z 那次 pass 就是它。它建立的第二回放依赖「裁剪默认会跑」。随后 `0ae696cd`（"fix(voice): the trim asks the registry for 裁不裁, not a table of its own"）把裁剪决策从客户端自带表挪到能力声明，`develop` 于 05:17:13Z 快进到它。此后这条链是：

1. `src/modules/chat/hooks/useVoiceInput.ts:232` `const recogniser = effectivePauseCuesDeclaration();`
2. 同文件 `:233` **第一道闸就返回**：`if (!isVoiceTrimEnabled() || recogniser === null || !trimDecisionFor(recogniser.capability).trim) return recorded;` —— `?voiceTrim=on` 开关是开的，所以退出的原因是**能力答的不是 `destructive`**。
3. `src/shared/voiceTrim.ts:370` 的 `trimDecisionFor` 就是 `trim: capability === 'destructive'`。
4. `shared/asr/asrRegistry.ts:221` 的 `REGISTERED` 至今只有一行 `multimodal`（`shared/asr/list/` 下也只有 `multimodal/`），而 `multimodal.asr-provider.ts:69` 声明 `pauseCues: 'useful'`；`src/shared/api.ts:654` 的读点拿有效 provider 的 id 去问 registry，有效 provider 又来自 `listProviders()[0]`。

于是 `prepareUpload` 返回原始录音，`adoptTrimmedClip` 从未收到裁剪体，第二个控件因此不存在。**那条绿是陈的**：它测的是「裁剪跑起来之后两条并存」，而今天这条链上裁剪根本不跑。

前置（另案，已在飞）：`gap-voice-trim-default-flipped-by-unregistered-first-adapter`（ready，`goal_ac: AC-121`）把出货识别器以 `openai-compatible` / `pauseCues: 'destructive'` 登记进 registry —— 那是让裁剪重新默认运行的那一跳。**本任务不重复它**：`depends_on` 已声明，且 AC4 机械地禁止本任务改动 `shared/asr/**`。

<!-- dedup-ref --> 与既有任务的机制区分：`gap-voice-debug-switch`（done，开关与读数）管读数的开关；`gap-asr-trim-capability-wiring`（done，AC-135）管决策接到声明；`gap-asr-pause-cues-second-source-contradicts-registry`（done，AC-134）管读点唯一；`gap-voice-trim-default-flipped-by-unregistered-first-adapter`（ready，AC-121）管登记缺口。本案管的不是裁剪怎么决策，也不是裁剪跑不跑，而是**裁剪跑起来之后录音槽里的两条音频是否真的并存、可辨、互斥** —— 这是录音槽这一层的判据，登记恢复只是它的前提。

### 本任务做什么

在登记恢复、且**出货默认**（`?voiceTrim=on` 的一次真实录音）下，让录音槽重新同时提供两条回放，并把这份并存钉在出货路径上：

1. **取基线**：干净工作树上跑 AC-122 腿，记录它自己打印的 `[voice-replay] original=…s/…B trimmed=…s/…B` 读数。
2. **若已绿**：不改实现 —— 把读数与「两条并存在出货默认下成立」记进完成记录，本判据的守卫就是既有的 AC-122 腿本身，不新增第二实现、不加第二张表。
3. **若仍红**：修 `src/modules/chat/hooks/useVoiceInput.ts` 的两条 clip 路径 —— `original`（原始 blob 的 object URL）与 `trimmed`（裁剪后重编码的那一份，即实际上传体）同时持有、`adoptTrimmedClip` 在裁剪真跑时必被调用、`fallback === true` 时如实不造第二条；必要时下探到 `VoiceClipButton.tsx` / `ChatComposer.tsx` / `src/shared/types.ts`（四个回放键在五份 locale 里都已存在，无需新增文案键），并由单元面 `voiceClipPlayback.test.tsx` 覆盖互斥与 fallback 渲染。
4. **取假验证承重**（见 AC3）：删掉第二控件 ⇒ 必红；两条指向同一 blob ⇒ 必红。

边界（不做）：不改 `shared/asr/**` 的登记与声明、不改 `src/shared/api.ts` 的读点（那是前提任务与 AC-134 的地盘）；不重引入客户端能力表；不削弱 `e2e/voice-trim.spec.ts` 的既有断言；不改「换会话清空 / 离屏停播」语义；不让回放影响上传体（上传永远用裁剪后那份）。

## Plan

- **S0 基线**：确认前提已落地（`tryResolve('openai-compatible')` 非 null 且 `listProviders()[0]` 就是它），再 `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 取读数；红则记下失败行原文，绿则直接进 S3。
- **S1 修复（仅红时）**：两条 clip 的持有、按需建 `Audio` 元素与互斥都在 hook 的同一次状态更新里完成，UI 只读 ABI；每个控件用 `data-clip-url` 公布自己会播的那份源，供判据直接比对而不是反推。
- **S2 单元面**：`npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` 覆盖互斥（第二条开始时第一条停）与 `fallback` 下不伪造第二条。
- **S3 取假 + 复核**：两种取假形态各跑一次并记命令与原文；`git diff --name-only` 复核 `shared/asr/` 与 spec 断言都未被改动。

## AC

- [ ] AC1 `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"` 退出 0。修前同一命令退出 1、14.2s、红在 `e2e/voice-trim.spec.ts:1129`（`the recording slot offers no replay of the trimmed upload`）；两份读数原文都记进 DoD。
- [ ] AC2 `npx vitest run src/modules/chat/tests/voiceClipPlayback.test.tsx` 退出 0（互斥、两条不同源、`fallback` 不伪造第二条的单元面）。
- [ ] AC3 取假变体两条，各自必须有读数：把第二回放的渲染摘掉 ⇒ AC1 退出非 0 且失败行仍是 `the recording slot offers no replay of the trimmed upload`；把 trimmed 那条改用原始 blob 建 ⇒ AC1 退出非 0 且红在容器判据 `the trimmed replay is not the encoded WAV`。两次退出码与失败行原文记进 DoD。
- [ ] AC4 本任务不落在登记面：`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^shared/asr/'` 输出 `0`；且 `git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^src/shared/api.ts'` 输出 `0`。
- [ ] AC5 判据未被削弱：`grep -c "the trimmed replay is not the encoded WAV" e2e/voice-trim.spec.ts`、`grep -c "the recording and the trimmed audio were sounding at once" e2e/voice-trim.spec.ts`、`grep -c "the recording slot offers no replay of the trimmed upload" e2e/voice-trim.spec.ts` 各自输出 `1`。
- [ ] AC6 `npm run typecheck` 退出 0；`npm run lint` 退出 0。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，AC-122 在 `.quay/gate-events.jsonl` 里的尾巴由 `2026-09-23T05:33:11.686Z` 的 fail 转回 pass。
- **真落地**：不是「控件存在」，而是**一次真实录音后同一录音槽里两条真实音频并存且可判别** —— 两条 `data-clip-url` 不同、取回的字节容器各异（原始 `1a45dfa3` webm/opus、裁剪那条 `52494646` RIFF PCM）、裁剪那条**时长**严格更短、且任一时刻最多一条在播（以页内 `window.Audio` 注册表读未暂停元素的 src 判定，不读控件标签）。这些读数由 AC-122 腿自己在 trace 里打印（`[voice-replay] original=…/…B trimmed=…/…B`），完成记录里引用同一段原文。
- **前提如实登记**：本判据此前不可能为真（裁剪不跑 ⇒ 没有第二份音频可言）。完成记录里必须写明 `gap-voice-trim-default-flipped-by-unregistered-first-adapter` 的落地提交/合并 sha；前提未落地时不得宣称本任务完成。
- **三次读数原文**（命令 + 退出码 + 失败行）：修前 AC1；取假（摘掉第二控件）后的 AC1；取假（同一 blob）后的 AC1。
- **L_D 该轴仍暗，理由**：本任务只让录音槽里的两条派生音频并存可辨，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 本任务的读数是两条回放的存在性、容器、时长与互斥性，不是生成质量轴读数；目标层判据由 GOAL-006 的其余判据承担。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/VoiceClipButton.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/voiceClipPlayback.test.tsx
- src/shared/types.ts
- e2e/voice-trim.spec.ts
- tasks/gap-voice-dual-replay-absent-under-shipped-recogniser.md
