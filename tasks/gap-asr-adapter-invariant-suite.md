---
id: gap-asr-adapter-invariant-suite
title: 对 registry 参数化的离线不变量套件：五组契约不变量（请求 golden / 错误映射 / 大小分流 / 脱敏 /
  MIME）各自独立可红（无 goal_ac，实验/守卫类）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-wire-single-implementation-boundary-probe
goal_ac: " "
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`task_list` 全文检索「不变量 / registry 参数化契约测试」未命中第二条以同一机制立案的任务。相邻但机制不同的是 `gap-asr-wire-single-implementation-boundary-probe`（AC-129，落契约、registry 与第一个适配器并证明实现只有一份）与 `gap-asr-extraction-parity-baseline`（AC-130，录两跳逐字节基线）—— 两条都不写「每个 provider 都必须通过同一组与质量无关的契约测试」。本任务是 ADR-004「后续任务 4」的立案。

**现场。** 今天每个识别服务没有一组统一的契约测试：请求怎么构造、上游的 401/403/429/5xx/超时/空响应/非 JSON 各归到哪个语义码、超预算怎么分流、密钥与音频字节会不会泄漏、不在 `acceptsMime` 内的输入在哪一步被拒 —— 全靠各自实现「看起来对」。ADR-004 的 L3(b) 要求「每个 provider 必须通过同一组契约测试，与质量无关」，本任务把这条落成**对 registry 参数化、离线可跑**的套件。

**本任务做什么。** 五组不变量，每组各自成一条**独立可红**的断言：请求构造 golden（含「声明为不支持的提示参数必须**不发**，而不是发空值」）、错误映射（401/403/429/5xx/超时/空响应/非 JSON 各归到哪个语义码）、大小分流、脱敏（密钥与音频字节不出现在返回值、错误消息、日志里）、MIME（不在 `acceptsMime` 内的输入在**发出请求之前**被拒）。套件对 registry 解析出的 provider 列表逐个跑；第一版只有一个 provider 也照样跑，**provider 列表为空即红**（空读数不许绿）。

**离线。** 全部环境依赖经注入（`fetchImpl`、`baseUrl`、`apiKey`、`model`、`timeoutMs`），套件自身零网络：任何真实网络调用即红。

**边界（不做）。** 不落第二个适配器（AC-132）；不改线协议实现与线上字节（AC-129/AC-130）；不做联网真跑（ADR-004 决策 8）；不引入快照测试库（只用 golden 常量 + 注入替身）；不改两条路径的路由与 UI。

## Plan

- **S0 参数化骨架。** 读 registry 的 provider 列表，对每个 provider 跑同一组不变量；列表为空 ⇒ 非零退出。五组各自独立成一条可红断言，互不掩盖。
- **S1 五组不变量。** 请求构造 golden（逐字节等于录制常量，且 `honors.prompt=false` 时**不发** prompt 而不是发空串）；错误映射表；大小分流（`> maxInlineRequestBytes` 走 `oversize` 声明路径且不把整个音频塞进请求）；脱敏（扫描返回值 / message / 日志行）；MIME（发出请求之前拒 `UNSUPPORTED_MIME`）。
- **S2 两条取假控制。** 各成一条独立具名用例；每条先证未变异为绿、再证变异为红。
- **S3 读数。** 逐条跑 AC，stdout 落进 Evidence。

## AC

- [ ] AC1 请求构造 golden（第一组）：给定固定请求 + 注入的 `fetchImpl` 记录，断言出站 URL / 头 / 体逐字节等于录制常量，**含「声明为不支持的提示参数必须不发，而不是发空值」**。取假变体：把提示参数实现成「发空字符串」⇒ 本组必须红。
- [ ] AC2 错误映射：401/403/429/5xx/超时/空响应/非 JSON 各归到哪个语义码，逐条断言。取假变体：把某个适配器的错误映射换成「一律返回上游错误」⇒ 401/429/超时三组必须红。
- [ ] AC3 大小分流：`> maxInlineRequestBytes` 必须走 `oversize` 声明的路径，且**不得把整个音频塞进请求**。
- [ ] AC4 脱敏：密钥与音频字节**不得**出现在任何返回值、错误 message 或日志行里。
- [ ] AC5 MIME：不在 `acceptsMime` 内的输入必须在**发出请求之前**被拒绝（`UNSUPPORTED_MIME`），上游调用次数为 0。
- [ ] AC6 五组各自成一条**独立可红**的断言：单独打破任一组时只有该组红，不牵连其余四组（否则「一组红」读不出是哪一组）。
- [ ] AC7 空读数不是绿：registry 解析出 0 个 provider，或某组的读数条数为 0 ⇒ 套件必须非零退出（不许静默绿）。
- [ ] AC8 离线：套件全程零网络（注入替身记录到任何真实网络调用即红）。
- [ ] AC9 控制文件真的会被跑：`node scripts/list-script-tests.mjs` 输出含 `scripts/asr-contract-invariants-check.test.mjs`；`node --test scripts/asr-contract-invariants-check.test.mjs` 退出码 0，AC1/AC2 的两条取假变体各为一条具名用例。
- [ ] AC10 静态门：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0。

## DoD

真实落地判据：不是「多了一个测试文件」，而是**每个 provider 都被同一组、与质量无关的契约不变量覆盖，且这组不变量自身是可红的**。承重性由三件正面读数证明：

(a) 五组各自独立可红（AC6）—— 一个把五组合成一个 `expect` 的套件读不出失败在哪一组，不算落地；
(b) 两条取假变体各自能把它打红：错误映射「一律返回上游错误」使 401/429/超时三组红（AC2）；提示参数「发空字符串」使第一组红（AC1）；
(c) 空读数不是绿（AC7）：provider 列表为空、或某组读数条数为 0，都必须红 —— 空 glob 退出 0 是本仓库已经付过代价的形态。

**本任务不证明**质量（那是实验记录）与「换识别服务不改路由与 UI」（AC-132/133/134/135）；它只把契约面钉住。

L_D 该轴仍暗，理由：本任务只把契约不变量落成可红的套件，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据由 GOAL-008 的其余判据承担，本任务只承担「同一组契约不变量对每个 provider 可红」这一条。

## Touches

- shared/asr/tests/asrContractInvariants.test.ts (new)
- src/shared/asr/tests/asrContractInvariants.test.ts (new)
- scripts/asr-contract-invariants-check.mjs (new)
- scripts/asr-contract-invariants-check.test.mjs (new)
- tasks/gap-asr-adapter-invariant-suite.md
