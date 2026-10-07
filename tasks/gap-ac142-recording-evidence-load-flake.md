---
id: gap-ac142-recording-evidence-load-flake
title: AC-142 判据在宿主并发下红在录音腿：固定 1.5s 捕获窗零帧时应用不发请求（useVoiceInput.ts:1124
  空捕获静默），15s POST 谓词超时 ⇒ 红；把录音证据改成有界可回放并让失败可分辨，不改产品行为与任何读数
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-142
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：`grep -rn "^goal_ac: *AC-142" tasks/*.md` → 3 命中，全为 `done`（`gap-voice-dashscope-written-browser-e2e`、`gap-voice-dashscope-criterion-boot-dep-reopt-race`、`gap-ac142-refusal-leg-copy-repoint`），**没有** todo/ready/needs-human 的认领者；`grep -rln "voice-dashscope-written" tasks/*.md` → 13 命中亦全为 `done`。⇒ 按本轮规则，done 的认领不是重复，是「更早的修复没守住」的证据。近机制但不同条（登记以免被当成新发现）：`gap-ac122-shared-assembly-starves-leg-budget`（done，AC-122）在本文件的姊妹 spec 上修过「宿主并发下共享阶段/腿预算被饿死」；`gap-voice-dashscope-criterion-boot-dep-reopt-race`（done）修的是启动依赖重优化竞态；`gap-ac142-refusal-leg-copy-repoint`（done）只重指了 refusal 腿的**文案期望**。本条认领的是它们都没覆盖的那一格：**录音证据本身在负载下红**。

**本轮的直接测量（不是台账尾巴）**

同一 checkout、立案时 `git rev-parse HEAD` = `fd1639000639d0657a85945ab2ba3030b9640ed2`（此后 HEAD 被 driver 的 `task_write` 提交继续推进），直跑判据本体 **3 次**：

```
npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"
exit=0   2 passed   criterion-wall-ms=21900 / 23958 / 27256   （三次同形，全绿）
```

三条读数都在：`proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=67`；`before-said-unauthorized=false after-said-unauthorized=true`；`draft-kept=true posts=1 aliyuncs-refusal=0`；三句文案 `distinct=3/3`。⇒ **criterion 现在是 TRUE**。

**红的那一次：台账最后一条 fail 是负载下的 flake，不是保证破了**

`gate-events.jsonl` 里 AC-142 的最后一条是 `verdict: fail`（`2026-10-07T08:42:29Z`，treeSha `a544a56fbc69`，即当刻 HEAD `fd163900` 的树）。但同一台账里它此前 **35 连绿**（06:44–08:24，跨多个 tree）；driver 自己 `08:40:30Z` 的 frozen recheck 也是 `AC-142 pass`（durationMs 43686、load1 45.63）；而 2 分钟前的 08:40 与 2 分钟后的 08:43 是姊妹 e2e **AC-172 红/绿对调**，三条红共享同一段 stderr 尾巴（`react-scan.js` 500KB BABEL deopt + DEP0190 弃用告警）——那是 WebServer 噪声，不是断言。⇒ 分辨力在宿主并发（load1≈45），不在判据的保证。

**红在哪（读失败运行的 trace，不是读 reason 里的 stderr 尾巴）**

失败运行目录 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-t9jQne/`（本地 16:42，gate 事件所指那次）。`test-results/voice-dashscope-written-AC-1a870--leaves-the-draft-untouched/` 的 `error-context.md` 与 `trace.zip`：

- 断言：`Error: the recording never reached the proxy stand-in` / `Expected: 1 / Received: 0` / `Timeout 15000ms exceeded while waiting on the predicate`，落在 **refusal 腿**（`spec:1048`，poll 在 `spec:1074-1077`）。
- 动作序列（`1-trace.trace`）：draft 填入 → health poll 过 → `Voice input` 可见 → **click 成功** → `Stop recording` **两次都可见**（确定起录了）→ `wait-for-timeout 1500` → **click stop 成功** → 之后 `the recording never reached the proxy stand-in` 重试 19 次全 0。
- 网络（`3-trace.network`，refusal 腿的 page@7923caaa）：只有 **1 次** document load（`?voiceTrim=off&voiceDebug=1`，08:42:10.652Z，**无 reload**），`GET /api/voice/capture` 200 @12.707Z（起录），此后到 28.541Z 只有 `/api/session-hosts`、`/api/providers/sessions/running` 的轮询 —— **整条腿一次 `/api/voice/transcribe` 都没有**。同一次运行里唯一那条 transcribe POST 是 **written 腿**的（page@594232bd，200 @10.577Z）。

**机制（产品侧的既有行为 × 判据的定时面）**

应用在「录到了零音频」时**故意不发请求、也不报错**：`src/modules/chat/hooks/useVoiceInput.ts:1124` 的 no-VAD 收尾路径只在 `session.wholeChunks.length > 0` 时把整段录音入队；`stopCapture` 随 `pending === 0` 静默 `finalizeSession`，其注释原文即「a stop with nothing buffered sends no request and reports no error」（`:1232-1233`）。空转静停守卫 `DEFAULT_IDLE_AUTOSTOP_SEC = 120`（`:120`）远大于一次 1.5s 捕获，故**不是**它触发的。`setState('recording')`（`:1238`）是在 `engine.start` 兑现后才设的，所以「`Stop recording` 可见」只证明引擎起了，不证明**出过帧**。⇒ 这一格红 =「固定 1.5s 捕获窗在负载下零帧」×「应用对空捕获静默」。判据的 `recordOnce`（`CAPTURE_MS = 1_500`，`spec:167` / `spec:755-764`）把「一次定长捕获必出音频」当保证，而它不是。

**为什么更早的修复没守住**

`gap-ac142-refusal-leg-copy-repoint`（done）只把 refusal 腿的**文案期望**从旧拼接句重指到按 code 选出的句子，**没有碰这条腿的定时面**（定长捕获窗 + 15s POST 谓词）；本轮红的是后者，是另一个机制。同族 `gap-ac122-shared-assembly-starves-leg-budget`（done）已在其姊妹 spec 上确立了「宿主并发下共享阶段/腿预算被饿死时要有界、失败点要响亮」的修法，本条把同一把尺子用到录音证据上。

**修复的不变式（判据物，不指定实现）**

1. 录音证据**有界、可回放**：不再把「一次定长捕获」当保证 —— 录一次；若在单次观察窗内没看到 POST，就**重录一次**（全新的一次捕获），累计到**由该腿自身预算派生的截止时刻**为止；不得把整个腿的时间烧在一次捕获上，也不得让重放把计数抬过 1（成功那次仍须恰好 1 个 POST）。
2. 每次尝试都**打印读数**：尝试序号、每次观察到的 `proxyPosts.length`、当次是否起录（`Stop recording` 是否出现）；成功那次的 POST 仍必须**恰好为 1**（按尝试重置/限定该腿的计数，或在产生 POST 的那次尝试上断言）。
3. 穷尽后**响亮失败且可分辨**：失败消息同时打印（a）累计 POST 数、（b）页面文本、（c）**录音器是否起录**（`Stop recording` 是否出现过）——使一次零帧捕获读作「起来了、没上传」，而不是裸的 15s 超时让「零帧」与「应用丢了到手的录音」同形。
4. **读数一个字不动**：written 腿仍打印 `proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=<n>`；refusal 腿仍打印 `before-said-unauthorized=false after-said-unauthorized=true`、`draft-kept=true posts=1 aliyuncs-refusal=0`、`copy[UNAUTHORIZED]`/`copy[NO_SPEECH_DETECTED]`/`copy[unknown]` 三句 `distinct=3/3`；`aliyuncs` 账本仍为 0，页面仍「逐字等于出货目录里那句」。
5. **⛔ 不改产品行为**：`useVoiceInput.ts:1124` 的「空捕获不发请求」保持一字不动；不改 12 个 `locales/*/chat.json`；不改 `e2e/voice-trim.spec.ts` 的诊断数组；不改 `spec:92-105` 的替身-真实差异登记。

## AC

- [ ] AC1 判据入口：`npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"` 退出码 0，两条腿都 passed，同次运行打印 `criterion-wall-ms=<n>` 且 < 45000（门是 60 秒硬上限、不可调）。立案基线（三次直跑全绿）：`exit=0 / 2 passed / criterion-wall-ms=21900、23958、27256`；红态基线：refusal 腿 `exit=1 / Received: 0 / Timeout 15000ms exceeded`（spec:1048）。
- [ ] AC2 有界可回放：录音证据步不再等同于「一次定长捕获」—— 完成后打印一行 `record-attempts=<k> per-attempt-posts=[…] deadline-ms=<n>`，且该步的耗时上限由本腿预算派生并在完成记录里给出推导；穷尽前若某次尝试产生 POST 则就此停手。
- [ ] AC3 可分辨的响亮失败：把「捕获零帧」机械复现（见 AC5-ii）时，失败消息同时打印累计 `proxyPosts`、页面文本、以及录音器是否起录的读数 —— 三者都要在完成记录里逐字登记。
- [ ] AC4 读数未改窄：同一次 `-g` 运行里 written 腿打印 `proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=<n>`；refusal 腿打印 `before-said-unauthorized=false after-said-unauthorized=true` 与 `draft-kept=true posts=1 aliyuncs-refusal=0`，且 `copy[...]` 三句 `distinct=3/3`；`grep -n "Transcription failed" e2e/voice-dashscope-written.spec.ts` 仍 0 命中。
- [ ] AC5 取假形态逐条实测并登记实测退出码与红态文案：(i) 前端忽略 proxy-only 而直连（把 provider 的 transport 当 direct 用）⇒ 判据必须红（AC 记录自带的假形态）；(ii) 造出「捕获零帧」（例如把 `CAPTURE_MS` 临时压到 1ms，使引擎来不及出帧）⇒ refusal 腿必须在 **AC3 的可分辨失败读数**上红，而不是裸超时；(iii) 失败时清空草稿 ⇒ refusal 腿的 `draft-kept` 必须红。任一读绿须说明是哪一杠杆吸收的，不得静默换过、不得手改 tick。
- [ ] AC6 契约面不被改窄：`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json` 三套）与 `npm run lint` 退出 0；`npx playwright test e2e/voice-dashscope-written.spec.ts` 整文件（三条腿，含对照腿）退出 0。
- [ ] AC7 如实登记：完成记录写明「只动判据的录音证据步；`src/modules/chat/hooks/useVoiceInput.ts:1124` 的『空捕获不发请求』一字未改」，登记失败运行目录（`quay-e2e-t9jQne`）、trace 里 refusal 腿零 transcribe 的读法、以及 `load1≈45` 的并发背景；并登记判据仍把 `/api/voice/transcribe` 与 aliyuncs 拦在浏览器侧（ADR-004 决策 8，真实冒烟归人工）。

## DoD

判据在落地后的树上按原命令重跑：退出码 0、两条腿 passed、`criterion-wall-ms` 打印且 < 45000，并附 AC2 的 `record-attempts` 行与 AC4 的四类读数打印；AC5 三条假形态的实测退出码与红态文案（含 AC5-ii 的**可分辨失败消息原文**）写进完成记录；`npm run typecheck` 与 `npm run lint` 退出 0；改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐，多出一个文件即为未 forcing 的越界）；完成记录随 AC tick 的那次 `task_write` 一并追加。

## Touches

- e2e/voice-dashscope-written.spec.ts
- tasks/gap-ac142-recording-evidence-load-flake.md
