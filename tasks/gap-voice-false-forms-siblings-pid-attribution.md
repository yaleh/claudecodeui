---
id: gap-voice-false-forms-siblings-pid-attribution
title: voice false-forms 三个兄弟判据（capture-off / capture-text /
  dashscope-settings）共写 server/modules/voice/ 却不按 pid 归因：suite 并发 4 下读到邻居在途的
  __criterion-falsify-* 临时副本 ⇒ 全舰队 fan-in 假红（19 份日志 12 份），且日志引的 not ok 行是一条通过的读数
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象。** `scripts/test.sh` 默认并发 4。`server/modules/voice/tests/` 下有四个 `*.false-forms.test.ts` 判据，各自把变异临时副本 `__criterion-falsify-<mutation>-{base,mut}-<pid>.ts` 写进**同一个** `server/modules/voice/`，并在模块加载时取一次 `git status --porcelain`（`PRE_RUN_PORCELAIN`），在收尾的 case 里再取一次比较。邻居的副本在本文件启动时还活着、到本文件取样时已删掉，两次快照就不等——即使终态树是干净的。特征读数：`git.status-clean=true unchanged=false temp-copies=none`，断言文案 `this run changed the worktree's git status: (empty)`。单独跑同一文件是绿的（约 26–33s），只有 suite 红。

**波及面（2026-09-25 实测）。** 19 份 `.quay/fan-in-suite-*.log` 里 12 份红在 `voice-capture-text.false-forms.test.ts`，横跨 6 个互不相干的任务；`gap-claude-session-cgroup-scope`、`gap-session-hosts-default-wrap-four-providers`、`gap-session-filter-criterion-bounded-boot-guard`、`gap-transcript-follow-ac110-case-nav-skips-boot-guard` 因此各被 driver 连续 2–3 轮红后停进 needs-human，而它们的改动里没有一个 voice 文件。裸的两文件并发（无 suite）就能复现，所以不是 `--test-concurrency` 之类的调参能治的。

**根因就是三个尚未归因的兄弟。** 同目录另两个已经修好、可直接照抄形状：`voice-error-contract.false-forms.test.ts:72-110` 定义 `OWN_TEMP_SUFFIX`/`isTempCopy`/`isOwnTempCopy`/`snapshotDelta`，`:398-460` 的收尾 case 用它们；`voice-error-classification.false-forms.test.ts` 已把副本写进私有 `SCRATCH_DIR`。还没修的三个：

- `voice-capture-off.false-forms.test.ts`：`PRE_RUN_PORCELAIN` 在 `:74`，`leftovers`+`unchanged` 两个断言在 `:312-336`。
- `voice-capture-text.false-forms.test.ts`：`PRE_RUN_PORCELAIN` 在 `:88`，`leftovers`+`unchanged` 两个断言在 `:444-468`。
- `voice-dashscope-settings.false-forms.test.ts`：`:187-215` 的 `leftovers` 断言按 `line.includes(TEMP_PREFIX)` 过滤而不分 pid，别人的副本在它取样时活着就红。它还有**第二条独立通道**：`voice-dashscope-settings.test.ts:936` 的 `AC8 server-branch-scan` 先 `collectSourceFiles(SERVER_DIR)`（`:519`）整树遍历、再逐个 `readFile`；邻居在这个窗口里创建/删除 `__criterion-falsify-*.ts`，遍历时在、读取时不在就抛 ENOENT，`collectReadings` 按读数 catch 成 `{ok:false, value:'threw: ENOENT …'}`，文案上与真命中无法区分，表现为 `the unmutated copy must clear the whole list …; it red at AC8 server-branch-scan`。

**修法（已在 error-contract 上验证过的形状，逐个移植）。** 用 pid 后缀把 porcelain 行归到本进程：本进程自己的残留无条件红；快照差集只在**每一条**差异行都是别的 pid 的 `__criterion-falsify-*` 时才放过；任何别的差异（新增/消失/修改的非临时文件）仍然红。读数同时打印两侧差集与两侧首行，使"脏起点"不再被报成"脏终点"。dashscope 的 AC8 扫描：`collectSourceFiles` 不收 `__criterion-falsify-` 前缀的文件（这是本套件自己写的、不属于要扫的产品源码），这样遍历结果不再随邻居的临时文件抖动；真出现在非前缀产品文件里的 `'dashscope-omni'` 仍然算命中。

<!-- dedup-ref -->
**相关但机制不同。** 原先跟踪这条通道的 `gap-ac103-worktree-state-drag-and-unbudgeted-confirm` 已随其目标 AC 改为 `superseded`，其 §5 点名的这条"仍存通道"没有任何在册任务接手，本任务即接手；它与 `gap-debug-agent-load-observation-determinism`（`debug-agent-external-write` 的负载通道，已 done）是不同机制，不在本任务范围内。同样不在范围内：`scripts/test.sh` 的 `first_error()` 把通过的读数行（其文案含 "failed" 一词）当失败原因引用——那是另一个机制（归因文案），本任务只消除会触发它的假红。

## AC

- [ ] **AC1 外来副本被放过（capture-off 与 capture-text 各一次）：** 工作树根下，先创建一个 pid 后缀不是本进程的未跟踪文件 `server/modules/voice/__criterion-falsify-plant-99999999.ts`，随即启动 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/<file>`，4 秒后删掉该文件；`<file>` 取 `voice-capture-off.false-forms.test.ts` 与 `voice-capture-text.false-forms.test.ts`，两次退出码都为 0，且 stdout 含 `concurrent-foreign-only=true`。同一探针在改动前的 develop 上必须读到退出码 1（把这个红读数记进完成记录，证明探针有分辨力）。
- [ ] **AC2 非临时文件的差异仍然红（负控制）：** 与 AC1 相同的时序，但植入并在 4 秒后删除的是一个**不带** `__criterion-falsify-` 前缀的未跟踪文件 `server/modules/voice/__stray-probe.ts`；capture-off 与 capture-text 两次都必须退出码非 0，红态文案含 `removed=[` 且点名该文件。
- [ ] **AC3 本进程的残留仍然红（负控制）：** 在 capture-text 的一份**临时副本**（放在 `server/modules/voice/tests/` 下、跑完删除）里把 `finally` 中的两处 `rm(basePath…)`/`rm(mutantPath…)` 去掉，跑该副本必须退出码非 0，红态文案含 `this run left its own temp copies behind`；对 capture-off 做同样的变体，结论相同。变体文件跑完已删除，`git status --porcelain` 与跑之前逐字相同。
- [ ] **AC4 dashscope 的两条通道：** (a) `voice-dashscope-settings.false-forms.test.ts` 在 AC1 的植入时序下退出码为 0，且改动前同探针读到非 0；(b) 在 `voice-dashscope-settings.test.ts` 里新增用例，循环 20 次：每次先在 `server/modules/voice/` 创建再删除一个 `__criterion-falsify-ac8probe-<n>.ts`，并发调用 `collectReadings`，断言 `AC8 server-branch-scan` 这一条 20 次全部 `ok=true` 且 `files=` 计数不随之抖动；同一用例再植入一个**不带前缀**、内容含 `'dashscope-omni'` 的非 `tests/` 产品文件，断言该读数变为 `ok=false` 且 `shipping-hits=1`（正控制，证明前缀排除没有把真命中一起吞掉），用例收尾把该文件删掉。
- [ ] **AC5 并发下三次全绿：** 在 `--test-concurrency=4` 下同时跑 `server/modules/voice/tests/*.false-forms.test.ts` 与 `voice-dashscope-settings.test.ts`，连续 3 轮，每轮退出码 0；三轮的 `falsify/leftovers` 读数逐行写进完成记录（读 `unchanged`，不读 `status-clean`）。
- [ ] **AC6 门与范围：** `npm run typecheck` 与 `npm run lint`（不是裸 `oxlint`）退出码 0；`git diff --stat develop...HEAD` 只出现在 `## Touches` 列出的文件里，且没有任何非 `tests/` 的 `server/` 文件。

## DoD

真实落地的标准不是"测试文件里多了几个函数"，而是**那条会红的通道被真正操作过**：AC1 与 AC4(a) 的植入探针在改动前的树上读到过红、改动后读到绿，两侧读数（退出码、`unchanged`/`removed`/`concurrent-foreign-only` 字段）都原样写进完成记录；AC2、AC3 两条负控制证明放过外来副本没有连带放过真差异；AC4(b) 的 20 次扰动与正控制证明扫描既稳定又没漏；AC5 三轮并发全绿。完成后，再有 fan-in 的 suite 因 `voice-capture-text`/`voice-capture-off`/`voice-dashscope-settings` 这三个文件红时，那必须是真红而不是共享目录的串扰——这是可以从此后 fan-in 日志里读回来的：`.quay/fan-in-suite-*.log` 里这三个文件的 `unchanged=false temp-copies=none` 读数不再出现。不修改任何产品源码，也不碰已经修好的 `voice-error-contract`/`voice-error-classification` 两份。

## Touches

- server/modules/voice/tests/voice-capture-off.false-forms.test.ts
- server/modules/voice/tests/voice-capture-text.false-forms.test.ts
- server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts
- server/modules/voice/tests/voice-dashscope-settings.test.ts
- tasks/gap-voice-false-forms-siblings-pid-attribution.md
