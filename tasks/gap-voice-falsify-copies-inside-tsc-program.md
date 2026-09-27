---
id: gap-voice-falsify-copies-inside-tsc-program
title: voice 判据的瞬时副本仍在 tsc 的 program 里：server/tsconfig.json 的 include 是
  ./**/*.ts，而四个 false-forms 副本与 AC4(b) 的 20 次 churn 都写在 server/modules/voice/ 下
  ⇒ 并发 typecheck 删除竞态报 TS6053（已观测 5 次、挡住 2 个任务），种一个带类型错误的副本更会无需竞态地报 TS2322；site
  1 的 exclude 修法盖不到
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Finding

**这条通道已经被观测到 5 次，每次都是同一个文件、同一条子命令、同一个路径，而到目前为止无人立案。**

`server/modules/voice/tests/voice-capture-off.false-forms.test.ts` 的 AC6 会跑 `npm run typecheck`；suite 并发 16 时它红成（逐字，五次同形，只有 worktree 不同）：

```
AC6 FAIL cases=n/a :: npm run typecheck (exit=2)
| sig: error TS6053: File '<worktree>/server/modules/voice/__criterion-falsify-ac8probe-19.ts' not found.
```

点名格式是 `gap-voice-capture-off-ac6-red-not-attributable`（已 done）加的；在这之前这条红只吐一句静态文案，所以四次都读不出来。

**已知的五次实例**（`.quay/fan-in-suite-*.log`）：

| # | 时间 | 任务 | 日志 |
|---|---|---|---|
| 1 | 2026-09-26 | `gap-session-hosts-lease-driven-lifecycle` | `…lease-driven-lifecycle~wk-prod-anchor~1790424810960-d02f6c.log` |
| 2 | 2026-09-26 20:53 | `gap-session-hosts-rest-list-endpoint` | `…rest-list-endpoint~wk-prod-anchor~1790427161401-078e1c.log` |
| 3 | 2026-09-26 21:16 | `gap-session-hosts-claude-per-run-driver` | `…claude-per-run-driver~wk-prod-anchor~1790428436889-6039b5.log` |
| 4 | 2026-09-26 21:46 | `gap-debug-agent-host-driver` | `…debug-agent-host-driver~wk-prod-anchor~1790430384172-7a51c2.log` |
| 5 | 2026-09-26 | `gap-session-hosts-claude-per-run-driver`（本轮） | `…claude-per-run-driver~wk-prod-anchor~1790428823628-e49d55.log` |

其中第 3、5 次直接把这一个任务挡在 `needs-human`。**每一次的三条剔除读数都成立**：delta 里没有 `server/modules/voice/` 下的文件、该任务自己的 `## Touches` 判据在同轮 `passed=true`、同日志的 `typecheck`/`lint` 两行是**独立的绿行**（不是 AC6 那个子命令）。

**机制（与已修的 site 1 同类，但 site 1 的修法盖不到它）。**

`server/tsconfig.json` 的 `include` 是 `["./**/*.js", "./**/*.ts", …]`，相对 `server/` 解析 —— 于是**任何**在 `tsc` glob 的那一刻存在于 `server/` 之下的 `.ts` 都会进入 program。判据在跑的时候会往里写两种瞬时文件：

- **site 2（本条的主诉）**：`voice-dashscope-settings.false-forms.test.ts:1179` 的 AC4(b) 20 次 churn，逐个写又删 `server/modules/voice/__criterion-falsify-ac8probe-<i>.ts`（前缀 `:529`）。写者自己的 kept child log 直接点名它：`.quay/suite-logs/<run-id>/server__modules__voice__tests__voice-dashscope-settings.false-forms.test.ts.out:20` → `falsify/git-status-clean=false (tree was already dirty before this run): ?? server/modules/voice/__criterion-falsify-ac8probe-2.ts`。
- **site 3**：四个 `voice-*.false-forms.test.ts` 各写 `__criterion-falsify-<mut>-{base,mut}-<pid>.ts`。

两种红法都实测过（在树上种文件再跑 `tsc`）：

- **删除竞态 → TS6053**：`collect-then-read` 窗口里文件被删，`tsc` 报 `File … not found`。这是五次实例的形状（`-19` 是 `AC4B_DELAYS_MS` 的最后一档 1300ms，活得最久，所以最容易撞上）。
- **不需要竞态 → TS2322**：种一个带类型错误的 `server/modules/voice/__criterion-falsify-typeerr.ts` 就会让 typecheck `exit=2`，没有删除竞态参与。这条危害更大，而且正是「一次没清掉的 stale 副本」会产生的形状。

**为什么不能靠目录 exclude 盖住。** 已经落地的 `cfd66cea` 只把 `./modules/voice/tmp`（site 1 的探针目录）加进 `exclude`。site 2/3 的副本**必须**贴在它们复制的模块旁边（副本里的相对 import 要能解析），而那个目录装的是真源码，所以没有目录级 exclude 可用。

**修法（二选一，实现者择优并在完成记录里写明依据）。**

- **(a) 名字级 exclude**：在 `server/tsconfig.json` 的 `exclude` 里加 `"./**/__criterion-falsify-*"`。判据自己的 arm tsconfig **刻意设了 `exclude: []`**（它们不该继承 server 配置的意见），所以这条路不会让 arm 编译不到副本 —— **这一条必须由 AC 验证**（见 AC3）。
- **(b) 收窄 `include` 到真正的源码根**，或把副本迁到仓根的 `tmp/`（本仓已有这个正确范本：`server/modules/voice/tests/voice-error-classification.false-forms.test.ts:96` 用仓根 `tmp/`；`include` 相对 `server/` 解析，`<repo>/tmp` 不在其中）。注意别把 `server/tmp/` 当成仓根 `tmp/` —— 前者仍在 include 里。

⛔ 不变式：不改任何判据的**语义** —— AC4(b) 的 20 次 churn 与四个 false-forms 判据的副本机制都保留原样（churn 是 AC8 扫描的扰动源，删了等于把判据变成不承重）；不删断言；不动 `scripts/test.sh`；不改判据命令。

<!-- dedup-ref -->
**边界。** 这不是 `gap-tsc-sees-transient-probe-file`（已 done，`cfd66cea`）—— 那条修的是 site 1（`server/modules/voice/tmp/__stray-shipping-probe.ts`），且它的 Finding 明确把 site 2/3 划出范围、只登记为「预测但未观测」。本条接手的是已观测到 5 次的那两个 site。与 `gap-voice-capture-off-ac6-red-not-attributable`（已 done）无关：那条只让红变得可归因，本条修归因暴露出来的真因。

## AC

- [ ] AC1 先拿到两种确定的红（改前，读数照抄进完成记录）：
  (i) **删除竞态**：在树上让 `server/modules/voice/__criterion-falsify-ac8probe-probe.ts` 存在一小段后被删，**同时**跑 `tsc --noEmit -p server/tsconfig.json`，使它在收进之后发现文件已消失 → 退出非 0 且含 `error TS6053` 与那个路径。
  (ii) **无需竞态**：种一个带类型错误的同前缀文件（如 `const x: number = "not a number"`）→ 同一命令退出非 0 且含 `error TS2322`。
- [ ] AC2 改后同一对读数变绿：同一脚本在改后的树上重跑 (i) 与 (ii)，两次都退出 0，且 `tsc -p server/tsconfig.json --listFiles | grep -c '__criterion-falsify'` 为 **0**（改前该计数在种一个文件时 ≥1，把改前改后的计数并排登记）。
- [ ] AC3 判据自身的编译面没被一起拿掉（这条是本任务的负控制）：四个 `voice-*.false-forms.test.ts` 各自单独跑 `exit 0`、`fail 0`，且它们的 arm 读数仍在（至少 `voice-dashscope-settings.false-forms.test.ts` 的 AC4(b) churn 与 `voice-error-contract.false-forms.test.ts` 的 `alignment=…` 读数逐字出现）。若选了 (a)，还需证明 arm tsconfig 的 `exclude: []` 确实生效（例如给出 arm 编译仍报出副本里的错误一次的读数）。
- [ ] AC4 `voice-capture-off` 的 AC6 转绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.false-forms.test.ts` 退出 0，且它打印的六条 `AC6 exit=` 全为 0（尤其 `npm run typecheck`）。
- [ ] AC5 门与范围：`npm run typecheck`、`npm run lint` 退出 0；`git diff --stat develop...HEAD` 只含 `## Touches` 列出的文件。

## DoD

真实落地判据是**那两条红法都不再可能**：AC1 在改前两种形态各读到一次红（原文登记），AC2 证明同一对读数在改后都绿、且副本已不在 tsc 的 program 里，AC3 证明判据自己的编译面（arm）没被一起拿掉 —— 三条合起来才算「副本仍在、但不再进 typecheck」。完成记录必须写明：本条只动 `tsc` 看见什么，不改判据语义；以及一条可复查的落地证据 —— 此后任何 `fan-in-suite-*.log` 里再出现 `AC6 FAIL :: npm run typecheck` 时，其 `sig:` 里不应再是 `__criterion-falsify-*`（现在这已是点名格式，有真因必然读得出来）。五条历史实例的日志路径一并在完成记录里列出，证明落点对症。

## Touches

- server/tsconfig.json
- server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts
- server/modules/voice/tests/voice-capture-off.false-forms.test.ts
- server/modules/voice/tests/voice-capture-text.false-forms.test.ts
- server/modules/voice/tests/voice-error-contract.false-forms.test.ts
- tasks/gap-voice-falsify-copies-inside-tsc-program.md
