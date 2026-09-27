---
id: gap-voice-error-classification-ac7-vitest-child-fragile
title: AC7 的 asrContractInvariants
  子进程在舰队并发下假红：voice-error-classification.false-forms.test.ts 拉起独立 vitest
  进程与套件自身并发跑同一文件互相超订，standalone 绿、舰队 6/11 次红，困住两个不相干任务
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra: {}
---
## Proposal

<!-- dedup-ref --> 立案时去重读数（2026-09-27，人 yale 指令「检查和推进」第二轮）：`grep -rln "AC7.*vitest\|npx vitest run.*asrContractInvariants\|vitest run.*asr" tasks/*.md` 只命中 6 个文件，全部是该 `AC7_COMMANDS` 列表其他条目（`voice-provider-dispatch` 等任务）的历史 Touches 提及，没有一个在治这条子进程本身的脆弱性；`grep -rn "^goal_ac: *AC-149" tasks/*.md` 只命中 `gap-voice-error-classification-and-status-table.md`（`status: done`）。没有在飞（todo/ready/needs-human）的第二条认领者，本条是新立的第一条。

**这条判据今天为什么假红（直接测量）**

`server/modules/voice/tests/voice-error-classification.false-forms.test.ts:633` 的 `AC7 the criteria, the check scripts and the repository gates still exit 0` 用例，在它的 `AC7_COMMANDS` 列表里有且仅有一条会 `spawnSync` 出一个**独立的 vitest 进程**（`:529`）：

```
label: 'src/shared/asr/tests/asrContractInvariants.test.ts'
args: ['vitest', 'run', 'src/shared/asr/tests/asrContractInvariants.test.ts']
```

- 该文件 standalone 跑（`npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts`）稳定 `exit 0`，`9 passed (9)`，4.6s——不是断言缺陷。
- 舰队并发下（scripts/test.sh 的 16-wide 文件级并发 + AC7 自己再拉起一个 vitest 子进程,其内部按 `vitest.config.ts` 又开到 8 个 worker）,同一份日志既有套件自己并发跑的 `src/shared/asr/tests/asrContractInvariants.test.ts passed=true`,又有 AC7 子进程里同一文件 `exit=1`——两次跑的是同一文件、同一时间窗口,只是分属两个互不相干的 vitest 进程。`vitest.config.ts:6-13` 的注释原文已经点名这个机制:"quay 从不只跑一个 suite……几个 ~128-way 的池子会叠在一起,Vite 的 module server 被超订,worker 中途死掉,在 reporter 层看起来和真实测试失败没有区别,而且每轮红的文件集都不一样"，并且**逐字点名了 `asrContractInvariants.test.ts` 是堆内存最重的文件**（1401MB,`:36`）。`gap-vitest-worker-heap-limit`（已 done）把单个 vitest 进程的 worker 数与堆上限都钉住了,但没有处理"AC7 自己每次都额外多开一个独立 vitest 进程"这件事本身——这是舰队并发下的乘数,不是任何一次调用自己的缺陷。
- 读数（`.quay/fan-in-suite-*.log`,2026-09-27）：6 份日志命中这一红,全部落在两个不相干的任务 `gap-voice-capture-isolation`（AC-147）与 `gap-voice-capture-secrets-three-modes`（AC-146）身上,两个任务各自的 `## Touches` 判据在同一份日志里都是 `passed=true`,红的文件都不在各自 Touches 里。两个任务各自被此红困过 3 轮（含人工重新排队后的 1 轮),说明这不是稀疏的舰队抽签,而是当前负载下**近乎必现**的形状。
- `server/modules/voice/tests/voice-*.false-forms.test.ts` 的姊妹文件里,只有本文件的 AC7 会拉起独立 vitest 子进程（`grep -c vitest` 对 `capture-off`/`capture-text`/`capture-audio`/`dashscope-settings` 四个姊妹文件均为 0）——修复面单一,只有这一处。

**为什么不是"重新派发"能解的**：按 `quay-fan-in-suite-red-is-fleet-wide-redispatch-is-the-escape` 的例外条款——已落地的兄弟判据（本条:AC-149 任务已 `done`,其 AC7 子进程调用是landed 状态)读的是一个全局事实（舰队并发下的 vitest 池超订),干净树 standalone 也会红,重新派发对这个红是无效的,要改立修复任务。两个受害任务（`gap-voice-capture-isolation`、`gap-voice-capture-secrets-three-modes`)已经各自验证过是"归因不出任何失败测试文件"并正确停止重派;人工在它们身上补的"重新排队"判断（2026-09-27 早些时候）经这次的两轮复现证明是错的——应当立修复任务而不是再排队。

**修复方向（留给实现者裁量,不预设唯一解）**：
- 让 AC7 不再为这一条单独拉起一个全新的 vitest 进程——例如复用套件自己并发跑出的同一文件结果（读同一轮 `scripts/test.sh` 的 `__PERFILE__` 账目),或把这一条判据挪到 AC7 之外、由仓库级判据（`npm run test:client` 或等价的单次 vitest 调用)覆盖,AC7 只对不产生新 vitest 进程的检查脚本/repo gate 保留子进程形式。
- 或者:给这一条命令加一把仓库级互斥锁（例如 `flock` 一个 `.quay/` 下的文件),舰队里同一时刻只允许一个 AC7 子进程真的调用 `vitest run asrContractInvariants.test.ts`,其余等待或跳过并标注为"由另一个并发调用覆盖"。
- 两条方向都要保住 AC7 "这条检查脚本真的跑过、真的退出 0"的原意,不能把红悄悄改成绿；修复后的判据必须能在舰队并发下稳定复现绿（不是靠又一次抽签)。

## DoD

- [ ] AC1：修复后,`server/modules/voice/tests/voice-error-classification.false-forms.test.ts` 的 AC7 用例在与至少 3 个并发的 `npx tsx --test` 与另一个独立 `npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts` 同时跑的复现场景下,连续 5 次 `exit 0`（此前 standalone 不能复现该红,复现场景需真的并发拉起足以触发一次历史红的资源竞争,不是纯粹加 sleep)。
- [ ] AC2：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.false-forms.test.ts` standalone 仍然 `exit 0`,AC7 仍然真的验证了 `asrContractInvariants.test.ts` 被跑过且退出 0（不能把 AC7 悄悄改成跳过或恒真)。
- [ ] AC3：类型与 lint 门（`npm run typecheck`、`npm run lint`)对本任务改动的文件 `EXIT=0`。
- [ ] AC4（负例)：还原修复（`git stash`)后,在同样的并发复现场景下该红能重新出现,证明 AC1 的复现场景不是巧合绿。

## Touches

- server/modules/voice/tests/voice-error-classification.false-forms.test.ts
- tasks/gap-voice-error-classification-ac7-vitest-child-fragile.md (new)
