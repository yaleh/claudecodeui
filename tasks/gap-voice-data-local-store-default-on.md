---
id: gap-voice-data-local-store-default-on
title: 语音数据本机存储（D1）：默认开启、只存本机、设置里一键清空——记录每次语音输入的切段音频、识别文本与 token 置信度（独立于诊断用的
  VOICE_CAPTURE，不改其 fail-closed 语义）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-correction-feedback-loop.md` 已确认决策 D1（阶段 0 记录音频，默认只存本机、可一键清空）与 §6 阶段 0。同机制去重：与已完成的 `gap-voice-capture-audio-file`、`gap-voice-capture-text-payload`、`gap-voice-capture-mode-gate-off-fail-closed` 是**相关但不同的机制**——那组是**诊断捕获**（环境变量 `VOICE_CAPTURE` 开、默认关、未识别的值 fail-closed、写进进程输出行），**判据文件把「关档零文件零目录」钉死**；本任务是**用户数据存储**（默认开、用户设置控制、可清空、为纠正闭环供数据）。两者必须并存，**不得为了默认开而改 `VOICE_CAPTURE` 的语义**。

### 要交付的六件事

1. **存储位置与权限**：默认目录与数据库同级（`~/.cloudcli/voice-data/`，目录解析沿用 `voice-capture.ts` 的纯函数形状，入参显式给出）；目录 0700、文件 0600（显式 `mkdirSync(..., { mode: 0o700 })` 后再 `chmodSync`）。
2. **记录格式**：每次转写一条 `<recordId>.json` 加切段音频 `<recordId>-<segmentIndex>.wav`；记录含 `{ recordId, ts, providerId, buildId?, segments: [{ index, audioFile, text, tokens? }] }`，预留 `finalText?`、`labels?`、`flagStats?` 给后续任务（本任务不写）。记录**不含** API key、不含 Authorization、不含 provider 响应原文之外的任何东西。
3. **开关**：用户设置里新增 `voiceDataRecording`（默认 `true`），存在 `user_voice_settings.settings_json` 里；关闭后转写**不写任何文件**。
4. **一键清空**：`DELETE /api/voice/data` 删除目录下全部记录与音频，响应带删除条数，目录不存在时返回 0 而不是报错；设置页有「清空语音数据」按钮，**二次确认**后才调用。
5. **容量上限**：默认 2 GB（设置里可改），写入后超限则按时间从旧到新删到上限以内。
6. **不出本机**：本模块不发起任何网络请求；`recordId` 随 `/api/voice/transcribe` 响应返回给客户端（后续任务用它回写最终文本）。

### 已知陷阱（立案时从仓库记录得到）

`voice-capture` 的判据文件共用一个目录，新增语音相关导出会让同级 `vi.mock` 没补全的测试变红；动手前 `grep -rln "vi.mock(.*voice" src server`，把受影响的 sibling 测试列进 Touches。遵循 `.agents/skills/backend-module-standards` 与 `.agents/skills/frontend-module-standards`。

### 边界（不做）

不记录最终发送文本与标签（见 `gap-voice-send-diff-weak-labels`）；不做记录查看器；不上传任何东西；不改 `VOICE_CAPTURE`。

## AC

- [ ] 默认开：空设置的用户转写一次后，`voice-data` 目录出现一条记录与切段音频，`stat -c %a` 分别为 700（目录）、600（文件）（服务端测试，用临时目录）
- [ ] 关闭 `voiceDataRecording` 后再转写，目录下**零新文件**；同一用例里再打开则写入（成对的负对照）
- [ ] `DELETE /api/voice/data` 之后目录下无任何记录或音频，响应含删除条数；对不存在的目录返回 0 且状态码 200；设置页按钮点击后出现确认，确认前不调用接口（`npx vitest run` 对应的服务端与组件测试退出码 0）
- [ ] 容量上限：用很小的上限（如 50 KB）连续写入，写入后目录总字节 ≤ 上限且被删除的是最旧的记录（测试）
- [ ] 隔离：`npx vitest run server/modules/voice/tests/voice-capture-off.test.ts server/modules/voice/tests/voice-capture-audio.test.ts server/modules/voice/tests/voice-capture-text.test.ts server/modules/voice/tests/voice-capture-isolation.test.ts` 退出码 0（`VOICE_CAPTURE` 未设置时仍零文件零目录，语义未变）
- [ ] 不出本机：`grep -nE "fetch\(|https?\.request|axios|undici" server/modules/voice/voice-data.ts` 无输出；用带哨兵 API key 的转写后，`grep -rl <哨兵> <voice-data 目录>` 无输出
- [ ] `grep -rln "vi.mock(.*voice" src server` 列出的 sibling 测试在改动后仍通过（`npx vitest run <文件们>` 退出码 0）
- [ ] MCP 浏览器验证：用 playwright MCP 打开 `http://localhost:3001/`，设置 → 语音，看到「保存语音数据（仅存本机）」开关默认开、「清空语音数据」按钮；用 `?voiceDebug=1` 的上传入口转写一个 wav；`ls ~/.cloudcli/voice-data` 看到记录；点「清空语音数据」并确认，页面提示已清空条数，再 `ls` 目录为空；把这些读数记入 `## Evidence`
- [ ] `src/modules/i18n/locales/en/settings.json` 与 `zh-CN/settings.json` 都含新增文案键；`npm run typecheck`、`npm run lint`、`npm run build` 退出码 0

## DoD

真实落地判据：**真实的转写请求**产生**真实落盘**的记录与音频，真实的清空把它们删掉；权限、容量、隔离、不出本机都由读数证明，不是只测函数。D1 的两个承诺——默认只存本机、可一键清空——在 MCP 浏览器里端到端走过一遍。

L_D 该轴有读数：新增的是用户数据（语音记录），其权限与清空由真实目录读数给出。

L_G 该轴仍暗，理由：本任务只存储，不含评测指标。

## Touches

- server/modules/voice/voice-data.ts (new)
- server/modules/voice/voice.module.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/voice.routes.ts
- server/modules/voice/index.ts
- server/shared/types.ts
- server/modules/voice/tests/voice-data.test.ts (new)
- server/modules/voice/tests/voice-capture-off.test.ts
- src/shared/voiceConfig.ts
- src/shared/api.ts
- src/modules/settings/tabs/VoiceSettingsTab.tsx
- src/modules/settings/tests/voiceDataSettings.test.tsx (new)
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- tasks/gap-voice-data-local-store-default-on.md
