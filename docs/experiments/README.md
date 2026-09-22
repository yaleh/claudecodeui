# 语音链路实验记录

本目录记录语音输入链路（识别、前处理、后处理）的**实测实验**，与 `docs/proposals/` 的分工是：

- `docs/proposals/` —— 方案与决策（做什么、为什么）
- 本目录 —— 实验的过程与读数（**量到了什么**，包括没量到的）

实验记录的价值一半在结果，一半在**哪些结论被证伪、哪些假设还没被解释**。所以每份记录都必须包含「未解释 / 未验证」一节，且不得用未经测量的机制去补因果链的洞。

## 协议（新增实验必须遵守）

1. **配对比较，不跨运行比较。** 所有条件在同一批片段上跑；某个条件少返回一条就缩小配对集合，而不是和另一个集合比。每条读数旁边打印 `n`。
2. **必须有能红的负对照。** 一个永远为绿的判据没有测量任何东西。本目录的 `flat`（去掉句末标点的同一个 prompt）就是这种对照：它必须**相对 `none` 下降**，否则「prompt 的标点被镜像」这个解释不成立。
3. **被测实现必须是出货模块。** 用绝对路径 import 仓库里的实现（`src/shared/voiceTrim.ts`、`src/shared/identifierFidelity.ts`），**不得在工装里放第二份算法**。这条代价已经付过一次（AC-113 的旧判据量的是副本，与出货模块 16 条里 6 条不一致）。
4. **指标自己先自测。** 每个计数口径都要有若干已知答案的用例，包含**中文用例**。本目录的第一版蒙版正则在英文上正确、在中文上把整句删空 —— 只测英文会得到一个干净且完全错误的结论。
5. **不能拿参考文本当标点真值。** 语料脚本本身不带句末标点（`Change the timeout … to thirty seconds`），所以「标点准确率」不可计算，只能做条件间配对比较；标点**位置**是否合理靠人读配对文本判断。
6. **口径要写清楚是哪一个。** 本仓库存在两个 `identifierFidelity`（见下），数字不可跨口径比较。
7. **串行执行。** `groq.mjs` 的节流是**按进程**的（约 18.7 RPM）。两个 runner 并发会一起超过 Groq on_demand 的 20 RPM，把预算花在 429 重试上。
8. **结果落盘缓存**（`out/*-cache.json`），分析脚本从缓存重算，改口径不必重花请求。

## 已知的口径分歧（跨实验比较前必读）

| 口径 | 大小写/空格 | 同一批英文转写对的读数 |
|---|---|---|
| 工装 `tools/identifier-fidelity.mjs` | **不敏感**（`Use voice input` 算命中 `useVoiceInput`） | 77.8% (14/18) |
| 出货 `src/shared/identifierFidelity.ts` | **逐字敏感**（`Voice.service.ts` **不**算命中 `voice.service.ts`） | 33.3% (6/18) |

两者在 32 个片段里有 **8 个不一致**。`docs/proposals/voice-identifier-repair-and-temporal-compression.md` 里「英文标识符 77.8%」用的是**宽松口径**，不能与出货遥测（AC-114 打印的那个数）直接比较。本目录的表格一律用**出货口径**。

## 实验索引

| 日期 | 主题 | 文件 |
|---|---|---|
| 2026-09-22 | 标点：prompt 偏置与停顿上限 | [2026-09-22-voice-punctuation.md](./2026-09-22-voice-punctuation.md) |
| 2026-09-22 | 风格化：双向负对照（标识符逐字保留 ×「确实发生了」） | [2026-09-22-voice-style-negative-control.md](./2026-09-22-voice-style-negative-control.md) |
| 2026-09-22 | 配对质量：provider × 裁剪 × 上下文（n=8，含能红的负对照） | [2026-09-22-voice-provider-paired-quality.md](./2026-09-22-voice-provider-paired-quality.md) |

## 工装

工装在仓库外 `/data/home/yale/work/tc-verify`（按 proposal 待确认问题 6 的既有决定，语料不入库）。

```bash
cd /data/home/yale/work/tc-verify

# 标点实验（读缓存，不联网）
node tools/test11-summary.mjs

# 停顿上限的成本侧（纯 DSP，不联网）
node tools/test9-caps-savings.mjs

# 新跑一个条件组合（联网，按条件数计请求）
LANG_TARGET=en LEVELS=all CONDS=raw,trimFrozen,trimMild node tools/test10-punct-run.mjs
```

| 文件 | 作用 |
|---|---|
| `tools/punct-lib.mjs` | WAV 编解码、标点口径、prompt 对、停顿表；import 出货模块 |
| `tools/test8-punctuation-prompt.mjs` | 首个 prompt 实验（英文，n=32） |
| `tools/test9-caps-savings.mjs` | 停顿上限的成本曲线（离线） |
| `tools/test10-punct-run.mjs` | 通用 runner，条件由 `CONDS` 选 |
| `tools/test11-summary.mjs` | 从缓存重算全部配对表 |

**未采纳的实验**：`LANG_TARGET` / `language` 参数。真实使用是混合语种，错误的语言判定比不判定更糟 —— 这是产品决定，不是测量结论。

### 仓库内工装（例外，逐条登记）

惯例是工装在仓库外（同上，针对的是**音频语料不入库**）。下面这一条**在仓库内**，理由逐条登记，不作为惯例的松动：

| 文件 | 作用 | 为什么在仓库内 |
|---|---|---|
| `experiments/voice-style-negative-control/run.mjs` | 风格化（`style: written`）的双向负对照：离线控制、反假变体、真实服务读数（见 [2026-09-22-voice-style-negative-control.md](./2026-09-22-voice-style-negative-control.md)） | 协议第 3 条要求被测实现是**出货模块**，仓库外的工装 `import` 不到 `src/shared/identifierFidelity.ts`；且该任务由 `## Touches` 指定了这个路径。它没有音频语料，真实读数落在被 git 忽略的 `out/` |
| `experiments/voice-provider-paired-quality/run.mjs` | provider × 裁剪 × 上下文的配对质量读数：离线重算配对表与负对照方向、七条自检变异、真实服务读数（见 [2026-09-22-voice-provider-paired-quality.md](./2026-09-22-voice-provider-paired-quality.md)） | 同上：协议第 3 条要求被测实现是**出货模块**（`src/shared/voiceTrim.ts`、`src/shared/identifierFidelity.ts`），且该任务由 `## Touches` 指定了这个路径 |

```bash
# 离线负对照 + 正面控制（无网络，确定性）
node experiments/voice-style-negative-control/run.mjs

# 真实服务读数（联网 + 凭据，串行，写 out/style-cache.json）
node experiments/voice-style-negative-control/run.mjs --live

# 只读缓存重算（无网络）
node experiments/voice-style-negative-control/run.mjs --replay

# 配对质量：离线从冻结快照重算全部读数 + 负对照方向 + 七条自检变异（不联网）
node experiments/voice-provider-paired-quality/run.mjs
```

### 仓库内**音频**（例外，逐条登记）

音频语料不入库是常态（`experiments/voice-trim/fixtures/*.wav` 是本项目里唯一既有的例外）。第二条例外登记在这里，理由与第一条同形：

| 文件 | 作用 | 为什么在仓库内 |
|---|---|---|
| `experiments/voice-provider-paired-quality/fixtures/d01..d08-o65.wav`（8 条，3.9 MB） | 配对质量实验的固定片段 | 冻结快照 `fixtures/paired.json` 里的**每个数字**（句读、CER、标识符、`savedRatio`、音频哈希）都要能在这个仓库里离线重算，而重算必须**重新解码原始音频**（对应关系检查还会用出货模块重新编码并比对 sha256）。语料全集（o65 档 16 条 × 多档）仍在仓库外，只有这 8 条固定片段进来 |

`fixtures/paired.json` 是**读数原文**不是缓存（缓存 `out/` 被 git 忽略）—— 记录里的表格全部由它离线重算，`--live` 取新读数才需要凭据。

