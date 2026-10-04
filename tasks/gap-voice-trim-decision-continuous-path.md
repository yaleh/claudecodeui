---
id: gap-voice-trim-decision-continuous-path
title: AC-135 回归：连续路径的裁剪(gap filter)决策不读 pauseCues，read point trimDecisionFor 不可达
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-135
---
## Proposal

**现场（本轮直接现测，非台账尾）。** `node scripts/asr-trim-capability-check.mjs` 在出货树退出 **1**：

```
check declaration: ok the registration table (shared/asr/asrRegistry.ts) declares 3 row(s), read off the adapter modules
check read-point: ok src/shared/voiceTrim.ts reads the capability at trimDecisionFor
check single-source: FAIL no production file reaches trimDecisionFor — the capability is declared and never read, so 裁不裁 is still decided elsewhere (trimDecisionFor is unreachable)
reason single-source: no production file reaches trimDecisionFor — the capability is declared and never read, so 裁不裁 is still decided elsewhere (trimDecisionFor is unreachable)
$ echo $?
1
```

判据自测套件同步红：`node --test scripts/asr-trim-capability-check.test.mjs` 退出 1，12/12 用例失败，全部失败在各自的前提 `the unmutated fixture must pass`（夹具按 `SHIPPING_FILES` 从出货文件复制，而出货文件的 `single-source` 已红）。

**机制（不是「判据过期」，是消费者被删且没有接回）。** `a88f5c2a`（"voice: continuous capture — segment-then-commit is the only input path"，经 `gap-voice-single-continuous-input-path` 人 yale 2026-10-04 授权）移除了读点 `trimDecisionFor` 的唯一消费者 —— `useVoiceInput.ts` 里批处理的 `prepareUpload`，它当时读 `effectivePauseCuesDeclaration()` + `trimDecisionFor(recogniser.capability).trim`。替代它的连续路径（`voiceLiveSegmenter.ts`）从自己的常量 `DEFAULT_KEEP_GAP_SEC = 1.0` 决定是否丢弃长停顿（gap filter），hook 构造切段器（`useVoiceInput.ts:710` `new LiveSegmenter({ sampleRate, minSegmentSec })`）时**从不读能力声明**。于是「裁不裁」由客户端自己的常量决定 —— 正是本判据取假形态 (2) 逐字所说的「裁剪决策仍由客户端各自判断而不读能力」。`effectivePauseCuesDeclaration()`（`src/shared/api.ts:753`）随之成为孤儿。

**为什么这次与判据的 `expect` 不冲突。** 提案 `docs/proposals/voice-continuous-capture-vad-segmentation.md:169` 原文保留该保证：「是否裁剪仍按 provider 的 `pauseCues` 声明：切分点是新的决策，不改变已有的裁/不裁结论」；AC-135 至今仍是 GOAL-008 的退出条件，其 `criterion` 命令与探针也仍在出货树里。`gap-voice-single-continuous-input-path` 授权退役的是 AC-119/121/122（浏览器裁剪 on/off 配对判据），**没有**退役 AC-135。`voiceTrimCapabilityWiring.test.tsx` 的注释写「the capability has no say in the container any more」—— 那是这次移除**偏离**提案之处，是待纠正的陈旧断言，不是放松判据的许可。

**修（复刻仓库既有接法，不发明）。** 在连续路径把能力接回裁剪决策的唯一读取点：hook 读 `effectivePauseCuesDeclaration()`，经 `isVoiceTrimEnabled()` 与**唯一读点** `trimDecisionFor(recogniser.capability).trim` 得到「本识别器裁不裁」，据此配置切段器的 gap filter（`destructive` ⇒ 压缩长停顿＝今天的行为；`neutral`/`useful` ⇒ 保留停顿，遵从声明）。`voiceLiveSegmenter.ts` 保持纯模块、不新增能力知识，只接受一个选项。出货默认不变：未命名 provider 的部署解析到注册表第 0 行（`openai-compatible`，`destructive`）⇒ 裁；`isVoiceTrimEnabled()` 默认 `true`；`?voiceTrim=off` 仍能强制关。

**本轮已现测可闭合（在 HEAD 的临时 worktree 上，非本仓改动）。** 施加 (1) `useVoiceInput.ts` 接回消费者、(2) `scripts/asr-trim-capability-check.test.mjs` 的 CONSUMER 变异字面量改指新消费者形状，两条命令同时转绿：`node scripts/asr-trim-capability-check.mjs` 退出 **0**（六条 `check ...: ok`，含 `check single-source: ok 1 production file(s) reach trimDecisionFor: src/modules/chat/hooks/useVoiceInput.ts`）；`node --test scripts/asr-trim-capability-check.test.mjs` 退出 **0**（12 passed / 0 failed）。worktree 已删除，主检出未改。

**边界（不做）。** 不改判据命令、不改 `scripts/asr-trim-capability-check.mjs`（判据脚本一字不动，不得靠改判据绕）；不在客户端重引入第二张能力声明表（AC-134 的唯一来源仍是 registry）；不改 `shared/asr/asrRegistry.ts` 的三行声明与其 evidence；不改路由与 UI；不动已退役的 `e2e/voice-trim.spec.ts` 的 AC-120 腿；不弱化 `single-source`/`decision`/`default`/`discipline` 任何一条既有检查。

<!-- dedup-ref --> 同机制去重结论：全仓声明 `goal_ac: AC-135` 的三条任务 `gap-asr-trim-capability-wiring`、`gap-asr-trim-capability-node-alias-unresolved`、`gap-asr-omni-paired-quality-record` 均已 `done`，不是重复项，而是「早先修复已失效」的证据。相邻但机制不同（同区不同机制）：`gap-asr-trim-capability-node-alias-unresolved`（done，修纯 node 别名解析）、`gap-asr-trim-capability-wiring`（done，最初把裁剪决策接到能力声明）、`gap-voice-single-continuous-input-path`（done，移除批处理裁剪路径的授权重构）。

## Plan

- **S0 不变量先行。** 记录修前读数（判据退出 1、`single-source` 红；自测套件 12/12 红于夹具前提），逐字落进 Evidence。
- **S1 接回消费者。** 在 `src/modules/chat/hooks/useVoiceInput.ts` 读 `effectivePauseCuesDeclaration()`（`@/shared/api`）与 `isVoiceTrimEnabled()`（`@/shared/voiceDebug`），经唯一读点 `trimDecisionFor(recogniser.capability).trim`（`@/shared/voiceTrim`）得出 `trim`；用它驱动切段器的 gap filter。**两处构造点都要接**：录音路径的 `new LiveSegmenter({...})` 与文件路径的 `segmentLive(...)`。
- **S2 保持切段器纯。** 若需要显式「不过滤」语义，在 `src/modules/chat/utils/voiceLiveSegmenter.ts` 增加/确认一个选项（如 `keepGapSec: Number.POSITIVE_INFINITY` 或一个显式布尔）；不得把能力知识搬进该模块。若最终不需要改这个模块，把它从 Touches 里删掉。
- **S3 取假形态与自测工装。** 把 `scripts/asr-trim-capability-check.test.mjs` 的 `CONSUMER_GATE` / `CONSUMER_GATE_WITHOUT_CAPABILITY` / `CONSUMER_IMPORT` / `CONSUMER_IMPORT_WITHOUT_CAPABILITY` 字面量改指 S1 的新消费者形状，使两条 single-source 取假用例仍精确命中（`patch()` 要求目标串恰好出现一次）；不得改窄任何断言。
- **S4 承重读数。** 补一条可红读数：有效 provider 的声明为 `destructive` 时 gap filter 运行、为非 `destructive` 时不运行；未命名 provider 的默认仍裁。落在 `src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx`（其 WAV 断言不受影响，只纠正陈旧的理由注释），或同目录新测试；若新建文件，把该路径补进 Touches。
- **S5 收尾。** 跑判据、自测套件、相邻 `asr-pause-cues-source-check.*`、`typecheck`、`lint`，以及 `e2e/voice-continuous.spec.ts`（其有效 provider 是 `dashscope-omni`，声明 `neutral`；若 gap filter 因遵从声明而关闭、某腿读数随之改变，须如实记录真读数，不得弱化判据或已退役腿之外的断言）。

## AC

- [ ] AC1 `node scripts/asr-trim-capability-check.mjs` 退出码 **0**，stdout 含六行 `check declaration: ok` / `check read-point: ok` / `check single-source: ok` / `check decision: ok` / `check default: ok` / `check discipline: ok`；且 `check single-source: ok` 行含 `1 production file(s) reach trimDecisionFor`。修前同一命令退出 1（`single-source: FAIL ... trimDecisionFor is unreachable`），两份读数原文入 Evidence。
- [ ] AC2 `node --test scripts/asr-trim-capability-check.test.mjs` 退出码 **0**，12/12 `pass`、`fail 0`。修前 12/12 红于夹具前提，原文入 Evidence。
- [ ] AC3 取假形态 (2) 未被改窄且真能红：在 `useVoiceInput.ts` 把裁剪决策还原为「客户端自判、不读能力」（去掉 `trimDecisionFor` 与能力读取）⇒ `check single-source: FAIL ... trimDecisionFor is unreachable`，退出 1；变异 diff、逐字失败行与还原命令（`git checkout -- src/modules/chat/hooks/useVoiceInput.ts`）入 Evidence。
- [ ] AC4 取假形态 (1) 未被改窄：`scripts/asr-trim-capability-check.test.mjs` 中 `changing the declared default to "do not trim" reds default` 与 `reordering the registry so a non-trimming recogniser is first also reds default` 两条既有用例在 AC2 的运行中通过（即「把默认改成不裁 ⇒ `default` 红」仍成立）；以 `git diff` 证明这两条用例的断言面一字未动。
- [ ] AC5 承重（gap filter 真由能力驱动，非装饰）：在 `src/modules/chat/tests/` 有一条可红读数，令有效声明为 `destructive` 时切段器压缩长停顿、为非 `destructive` 时保留停顿；取假变体（把消费方的能力读取删掉、回到硬编码常量）该读数必须红。命令 + 退出码 + 失败行入 Evidence。
- [ ] AC6 出货默认不变：`src/shared/voiceDebug.ts` 的 `isVoiceTrimEnabled()` 默认仍为 `true`；未命名 provider 的部署仍解析到注册表第 0 行（`openai-compatible`，`destructive`）⇒ 默认仍裁 —— 由 AC1 的 `check default: ok` 行逐字给出。
- [ ] AC7 相邻判据未受牵连：`node scripts/asr-pause-cues-source-check.mjs` 退出 0 且 stdout 仍含 `client-pauseCues=none` / `client-declaration-source=none`；`node --test scripts/asr-pause-cues-source-check.test.mjs` 退出 0；`npm run typecheck` 与 `npm run lint` 退出 0。
- [ ] AC8 判据脚本与已退役腿未被改动：`git diff --name-only <base>..HEAD` 不含 `scripts/asr-trim-capability-check.mjs`，也不含 `e2e/voice-trim.spec.ts`；读 `goals/AC-135-*.md` 确认其 `criterion:` 行仍是 `node scripts/asr-trim-capability-check.mjs`。

## DoD

真实落地判据：不是「多了一次能力读取」，而是**连续路径的裁剪（gap filter）决策再次以识别器的能力声明为唯一来源，且出货默认行为不变** —— driver 下一轮直接重跑 AC 记录里的 `criterion`，台账尾巴由 fail 转 pass。承重性由三组读数证明：

(a) 真树判据转绿：AC1 的六条 `ok` + 退出 0，`single-source` 行逐字点名 `useVoiceInput.ts` 是消费者；
(b) 工装跟着活：AC2 的 12/12 绿，且 AC3/AC4 两条取假形态各自仍能红 ——「消费者自行判断」⇒ `single-source` 红，「默认改成不裁」⇒ `default` 红；
(c) 承重而非装饰：AC5 的读数随有效声明翻转（`destructive` 压缩停顿、非 `destructive` 保留），去掉能力读取即红。

**本任务不证明**某个 provider 的 `pauseCues` 取值正确 —— 那由各 provider 自己的配对实验与 AC-135 的 `discipline` 检查承担；也不重新引入样本级 `trimVoiceAudio`（本任务只恢复「裁不裁 由能力唯一决定」这条机检，消费者是新架构里的 gap filter 决策）。

L_D 该轴仍暗，理由：本任务只把一条既有能力接回新架构的裁剪决策点，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担。

## Touches

- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/utils/voiceLiveSegmenter.ts
- scripts/asr-trim-capability-check.test.mjs
- src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx
- tasks/gap-voice-trim-decision-continuous-path.md
