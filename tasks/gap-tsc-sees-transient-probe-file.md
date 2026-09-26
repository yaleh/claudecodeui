---
id: gap-tsc-sees-transient-probe-file
title: server/tsconfig.json 的 include 扫到 voice 判据的瞬时探针：voice-dashscope-settings
  的 AC4(b) 正控制在 server/modules/voice/tmp/ 写下 __stray-shipping-probe.ts 又删掉，并发的
  voice-capture-off AC6 typecheck 收进它之后报 TS6053 ⇒ 全舰队 suite 红、两个任务连停 6/7 轮
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

**真因（两条都有，逐字）。** 2026-09-26 的两轮 fan-in，红的是同一个文件、同一条断言，只是 worktree 路径不同：

```
not ok - server/modules/voice/tests/voice-capture-off.false-forms.test.ts:
  AC6 FAIL cases=n/a :: npm run typecheck (exit=2)
  | sig: error TS6053: File
    '/data/home/yale/work/claudecodeui-worktrees/<task-worktree>/server/modules/voice/tmp/__stray-shipping-probe.ts'
    not found.
```

两轮分别落在 `gap-session-hosts-default-wrap-four-providers`（10:12）与 `gap-claude-resident-phase0-experiments`（10:15）的 worktree 里，其余 237 个文件全绿。**这两个任务连停 7 轮 / 6 轮，根因就是这一条。**

**机制（三件事凑在一起）。**

1. `server/modules/voice/tests/voice-dashscope-settings.test.ts` 的 AC4(b) 正控制会**在仓内**造一个探针：`AC4B_POSITIVE_DIR = <voice 模块目录>/tmp`（`:1120`）、`AC4B_POSITIVE_FILE = …/__stray-shipping-probe.ts`（`:1121`），`:1218` `mkdir` + 写，用例收尾 `:1235` `rm -rf AC4B_POSITIVE_DIR`。这是 AC8 扫描要求的形态（必须在 `tests/` 之外、且是 `.ts`），设计上没错。
2. `server/tsconfig.json` 的 `include` 是 `["./**/*.js", "./**/*.ts", "../shared/**/*.js", "../shared/**/*.ts"]`，`exclude` 只有 `../dist` / `../dist-server*` / `../node_modules` / `../src` —— **`server/modules/voice/tmp/**` 在 include 里**。于是这个瞬时文件会被 `tsc` 收进 program。
3. `voice-capture-off.false-forms.test.ts` 的 AC6 会跑 `npm run typecheck`（= `tsc --noEmit -p tsconfig.json && … -p server/tsconfig.json && … -p scripts/tsconfig.json`）。suite 并发 16，两个文件同时在跑：tsc 收进探针 → 探针被 `rm -rf` → **TS6053**。

**为什么以前读不出来。** `voice-capture-off` 的 AC6 原来只断言「六个子命令退出码全为 0」，失败文案是静态字符串 `a surface this task must not have moved is red`，逐条读数只进 stdout，而 runner 的 per-file 输出随 `$TMP` 删除。`gap-voice-capture-off-ac6-red-not-attributable`（已 done）把命令名、退出码与子命令输出尾部带进消息之后，**同一条红第一次就点出了 TS6053**。本条接的就是它暴露出来的真因。

**影响面。** 这不是那两个任务的 delta（它们的 `## Touches` 与该文件无交集，且各自的两个 Touches 文件在同轮 `passed=true`）；它也不只打它们：任何在 suite 里跑 `voice-capture-off` 的轮次都会随这个竞态红，是**全舰队**的。

**修法（最小且对准根因）。** 把探针目录从 `tsc` 的视野里拿掉：在 `server/tsconfig.json` 的 `exclude` 里加上 `"./modules/voice/tmp"`。理由：

- AC8 的扫描是**直接走文件系统**（`collectSourceFiles(SERVER_DIR)` 递归 `readdir`），不看 tsconfig，所以探针照旧能被扫到、正控制照旧成立；
- `tsc` 从此不再看见这个目录，瞬时文件的出现/消失不再能影响任何一次并发的类型检查；
- 改动只有一行，不碰判据语义、不碰 `voice-dashscope-settings.test.ts` 的用例。

**备选（若实现者证明 exclude 不足以覆盖）**：让探针写到另一个已被 exclude 的目录、或把 `voice-capture-off` AC6 的类型检查改成不扫全仓。**不得**的做法：删掉正控制、把 AC6 放宽成「typecheck 可以非零」、或给 AC6 加 retry —— 那会把这条判据变成不承重的。

⛔ 不改 `scripts/test.sh`。

## AC

- [ ] AC1 先拿到确定性复现（改前）：在一个 worktree 里，令探针文件存在一小段后被删，**同时**跑 `npm run typecheck`（`server/tsconfig.json` 那一支），使 `tsc` 在收进探针之后发现它已消失 → 退出码非 0 且文案含 `error TS6053` 与探针路径。把两侧命令、时序（探针创建/删除的时刻、tsc 起止）与红态原文抄进完成记录。这条读数在**未改**的树上取得，证明机制成立。
- [ ] AC2 改后同一时序不再红：同一脚本在改后的树上重跑，同一时序下 `npm run typecheck` 退出 0（且不出现 TS6053）。读数与 AC1 并排登记。
- [ ] AC3 正控制仍然成立：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-dashscope-settings.test.ts` 退出 0，且其 AC4(b) 正控制那一条读数仍为 `shipping-hits=1`（也就是说：探针仍旧被 AC8 的扫描找到，exclude 只对 `tsc` 生效，没有把判据的探测面一起拿掉）。给出该条读数原文。
- [ ] AC4 门与回归：`npm run typecheck` 退出 0（三支 tsconfig 全跑）；`npm run lint` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.false-forms.test.ts` 退出 0、`pass 4 / fail 0`，其 AC6 六条子命令读数全 `exit=0`。
- [ ] AC5 范围：`git diff --stat develop...HEAD` 只含 `server/tsconfig.json`（若实现者判定还必须动别的文件，按 Finding 的备选写明理由并只动那一处；不得动 `scripts/test.sh`、不得删任何正控制）。

## DoD

真实落地判据是**那个竞态不再能红**：AC1 在改前读到过 `TS6053`（原文登记），AC2 在同一时序下读到绿，AC3 证明判据的探测面没被一起拿掉。完成后，`voice-capture-off` 的 AC6 在 suite 里不应再因 `npm run typecheck` 非零而红——这可以在下一次 `gap-session-hosts-default-wrap-four-providers` 或 `gap-claude-resident-phase0-experiments` 的 fan-in 日志里读回来（同一行现在是点名格式 `AC6 FAIL … :: npm run typecheck (exit=…)`，有真因就必然看得见）。完成记录必须写明：本条**只修** `tsc` 看见瞬时文件这一条；`claude-sessions.test.ts` 那条 `open-a.jsonl was opened by a scan that should have skipped it` 是另一个机制（lane 负载受害者，独立跑 26/26 绿），不在本条范围。

## Touches

- server/tsconfig.json
- tasks/gap-tsc-sees-transient-probe-file.md
