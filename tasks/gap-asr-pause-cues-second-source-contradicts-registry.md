---
id: gap-asr-pause-cues-second-source-contradicts-registry
title: 裁剪能力的第二份声明与 registry 矛盾：客户端用未注册 id `openai-compatible` 答
  `destructive`，与唯一适配器 `multimodal` 的 `useful` 相反（AC-134 回归）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-134
---
## Proposal

现场（时间线精确到秒）：AC-134 于 **2026-09-23 00:51:49** 判 `achieved`（判据 exit 0）；`488218c7`（`gap-asr-trim-capability-wiring` 的实现，标题「feat(voice): let the recogniser's declared pause capability decide 裁不裁」）于 **00:53:31** 落地；此后每一轮 goal round 对 AC-134 都判 `verdict: fail`，而它的 `status` 停在 `achieved`。`achieved` + `fail` 这个组合不会自动发出任务，GOAL-008 因此收不了口。

判词（AC-134 自己的判据 `node scripts/asr-config-resolution-check.mjs`，今天 exit 1）：

```
client-capability-table=declared-in-2-file(s)
failure=AC6: the client declares capabilities of its own in src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx, src/shared/voiceTrim.ts
verdict=fail
```

**不只是「多了一张表」，是两张表互相矛盾**：

| | 位置 | provider id | `pauseCues` | 该值意味着 |
| --- | --- | --- | --- | --- |
| registry，唯一注册的适配器 | `shared/asr/list/multimodal/multimodal.asr-provider.ts:69` | `multimodal` | `'useful'` | **不裁**（该文件注释：「pauses are punctuation cues, which is why this one is not [trimmed]」） |
| 客户端自建表 | `src/shared/voiceTrim.ts:376` | `openai-compatible` | `'destructive'` | 裁 |

而 `'openai-compatible'`（`src/shared/voiceTrim.ts:358`）**不是注册表里的任何 id**：`shared/asr/asrRegistry.ts` 的 `REGISTERED` 只有一项 `{ id: multimodalId }`，而 `id = 'multimodal'`。

读取点的实际形状（`src/modules/chat/hooks/useVoiceInput.ts:228`）：

```ts
const recogniser = pauseCuesFor(OPENAI_COMPATIBLE_PROVIDER);
if (!isVoiceTrimEnabled() || !trimDecisionFor(recogniser.pauseCues).trim) return recorded;
```

`OPENAI_COMPATIBLE_PROVIDER` 是**硬编码**的，registry 的 `resolve` / `tryResolve` 在这条路径上一次都没被调用；`pauseCuesFor` 对未声明的 id 回落到 `DEFAULT_PAUSE_CUES_PROVIDER`（同一个 `'openai-compatible'`，`:367`）⇒ 拿到 `'destructive'` ⇒ `trim: true`。于是**裁剪照旧发生，恰好与唯一那个真实适配器声明的 `useful`（不该裁）相反**。trim 任务的标题声称「capabilities 成为裁剪决策唯一来源」，实际成为唯一来源的是它自己那张表。

**为什么 trim 任务自己的判据抓不到。** `scripts/asr-trim-capability-check.mjs` 量的是「裁剪决策只有一个读取点」这一**机制**（它打印 `check read-point: ok src/shared/voiceTrim.ts reads the capability at trimDecisionFor`），不是「读到的值来自 registry」这一**不变量**。一个读取点接在一张自建表上，对前者恒绿。

<!-- dedup-ref --> 同机制去重结论：`grep -rln "pauseCues|PAUSE_CUES_DECLARATIONS|trimDecisionFor|pauseCuesFor" tasks/` 命中 3 条任务，都不是本机制。`gap-asr-trim-capability-wiring`（AC-135，done）是**制造**这次回归的那条，其边界原文写着「不改两条路径的路由与 UI（AC-129/AC-130/AC-133/AC-134）」—— 它声明不碰 AC-134，却在机制上碰了，故本条不是它的重述，而是它的回归修复。`gap-asr-second-adapter-inline-only`（AC-132，done）落的是 **provider 侧**能力声明（`shared/asr/`），本条目处理的是**客户端侧**的第二份声明与硬编码 id，方向相反。`gap-asr-health-effective-config-fail-closed`（AC-134 的现有声明者，done）交付的是健康检查的 fail-closed 行为，不是这条矛盾。本条目与上述三者只在溯源上相关。

**本案不做**：不裁判「该不该裁」这个产品决策（那是 ADR-004 二节的裁定，本条只负责让**唯一那份声明**说话）；不删 `trimDecisionFor`（它是纯映射，是合法的读取点）；不碰 `PAUSE_CAPS` 与 VAD 参数；不改上传体的字段名 / URL / 头 / 容忍度（AC-130 的字节基线仍是守卫）。

## Plan

- **S0 先让不变量可红（判据在前）。** 在 AC-134 既有判据的消费面之外加一条独立读数：把「裁剪决策读到的 `pauseCues` 必须等于 registry 对**当前生效 provider id** 的声明」写成可执行断言，取假形态为「客户端表与 registry 不一致」⇒ 必红。今天这条必然红（`destructive` ≠ `useful`），它把「机制绿、不变量红」变成机械可见。
- **S1 收敛来源。** `src/shared/voiceTrim.ts` 删除承担「声明」职责的部分（`PAUSE_CUES_DECLARATIONS` / `pauseCuesFor` / `OPENAI_COMPATIBLE_PROVIDER` / `DEFAULT_PAUSE_CUES_PROVIDER`），保留 `PauseCues` 类型与 `trimDecisionFor(pauseCues)` 纯映射；调用侧改为向 registry 要值。
- **S2 解开硬编码 id。** `useVoiceInput.ts` 的 `pauseCuesFor(OPENAI_COMPATIBLE_PROVIDER)` 换成「按当前生效 provider id 向 registry 取值」；provider id 从既有的用户配置读取路径来（与 AC-134 的 `configured-field-present=yes` 同一来源），未注册 id 按 fail-closed 处理而不是回落默认行。
- **S3 读数。** 逐条跑 AC，stdout 落进 Evidence；并如实登记行为变化（若结论是「不再裁」，AC-130 的字节基线**不受影响**，因为基线量的是字段名 / URL / 头 / 容忍度，不是时长）。

## AC

- [ ] AC1 主读：`node scripts/asr-config-resolution-check.mjs` 退出码 0，且 stdout 的 `client-capability-table` 读数必须打印且不再是 `declared-in-2-file(s)`。
- [ ] AC2 不变量读数是新的且当前必红：新判据 `node scripts/asr-pause-cues-source-check.mjs` 在**未修**的树上退出码非零，判词指名「客户端声明的 `pauseCues` 与 registry 对当前 provider 的声明不一致」，并逐字打印两个值（形如 `client=destructive registry=useful provider=...`）。
- [ ] AC3 不变量判据的取假形态：临时工装里只把 `src/shared/voiceTrim.ts` 的表值改成 `'useful'`（其余不动）⇒ 同一命令退出码 0；改成与 registry 不同的第二个值 ⇒ 非零。每条**先对未变异的同一工装断言退出 0**，再变异，并断言变异命中数 `=== 1`（命中 0 处即该用例红）。
- [ ] AC4 硬编码 id 消失且可红：命令断言 `src/modules/chat/hooks/useVoiceInput.ts` 不再出现字面量 `OPENAI_COMPATIBLE_PROVIDER`，且裁剪门的 provider id 来自配置读取路径；取假形态为「把该字面量写回」⇒ 必红。
- [ ] AC5 唯一性：`grep -rn "pauseCues\s*:" src/` 去重后命中文件数为 0（能力的**声明**只在 `shared/asr/` 侧）；同一命令断言 `grep -rn "pauseCues" shared/asr/` 仍非空（证明没有把能力本身一起删掉）。
- [ ] AC6 既有语音读数不变：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts`、`npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx` 各自退出码 0。
- [ ] AC7 AC-130 的守卫不被本任务打穿：`node scripts/asr-extraction-parity-check.mjs` 退出码 0，四组 `equal`。
- [ ] AC8 静态门：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0。
- [ ] AC9 行为变化如实登记：命令打印**修改前 / 后**同一段中文与英文样本的裁剪判定与上传体时长；若结论是「不再裁剪」，须在 Evidence 里逐字记录该差值，并把「这是 ADR-004 二节实测结论的期望方向」与「这属于人已裁定的产品决策」两件事分开写。

## DoD

真实落地判据不是「`voiceTrim.ts` 里的表被删了」，而是**裁剪决策读到的能力值来自 registry 对当前生效 provider 的声明**，且这件事机械可红：

(a) **不变量有独立读数且当前是红的** —— AC2 在未修的树上必红，AC3 的两支控制分别把它打绿 / 打红（只有「值恰好等于 registry」才绿，不是「把表挪个位置」就绿）；
(b) **硬编码 id 真的没了** —— AC4 断言 `useVoiceInput.ts` 里不再有那个字面量，且取假形态可红；
(c) **能力的声明只剩一份，且在 provider 侧** —— AC5 的 `src/` 扫描为 0、`shared/asr/` 扫描非 0；
(d) **没有把守卫一起打穿** —— AC7 的 AC-130 字节基线仍逐组 `equal`。

**本任务不裁「该不该裁」**：若收敛后 `multimodal` 的 `useful` 生效 ⇒ 不再裁剪 ⇒ 这是行为变更，必须由 ADR-004 二节的裁定背书，本任务只如实登记（AC9），不自行选择方向。若人判定 `openai-compatible` 确为另一个待注册的识别器、其 `pauseCues` 确为 `destructive`，则本条的正确形态是**把它注册进 registry 并在那里声明**，而不是保留客户端表 —— 两条路都不允许「客户端自己声明」。

L_D 该轴仍暗，理由：本任务只把一份已存在的领域能力收敛到唯一声明处，不新增领域数据能力，也没有可读出的领域读数。

L_G 该轴仍暗，理由：本任务量的是「裁剪决策的值来自 registry」这一守卫，不产出目标层读数 —— GOAL-008 的目标层（换识别服务不改路由与 UI）由其余判据承担。

## Touches

- src/shared/voiceTrim.ts
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/tests/voiceTrimCapabilityWiring.test.tsx
- src/shared/api.ts
- shared/asr/asrRegistry.ts
- scripts/asr-pause-cues-source-check.mjs (new)
- scripts/asr-pause-cues-source-check.test.mjs (new)
- tasks/gap-asr-pause-cues-second-source-contradicts-registry.md
