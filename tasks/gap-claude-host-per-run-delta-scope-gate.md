---
id: gap-claude-host-per-run-delta-scope-gate
title: claude-host-per-run 的 AC6 用「当前分支的 delta」当代理判 driver 是否被读：fan-in
  merge-develop 后 develop...HEAD 就是当前 worktree 自己的分支 delta ⇒ 任何 delta 非空且不含
  driver 的兄弟任务必红（同日两条 delta 交集为空的任务、同一句、900ms 即抛）；该断言在 owner 分支上是对的，缺的是按分支设门
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

**现象。** `server/modules/providers/tests/claude-host-per-run.test.ts` 的 `AC6`（`:575-613`）在**任何** worktree 的 suite 里、只要当前分支对 develop 的 delta 非空就断言：

    const vsDevelopText = gitMaybe(['diff', '--name-only', 'develop...HEAD']);
    const vsDevelop = vsDevelopText === null ? null : filesOf(vsDevelopText);
    …
    if (vsDevelop !== null && vsDevelop.length > 0) {
      assert.equal(vsDevelop.includes(DRIVER_PATH), true,
        `the develop delta does not mention the driver, so it is not the delta being read: ${DRIVER_PATH}`);
    }

`DRIVER_PATH = 'server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts'`。fan-in 的 `merge-develop` 之后 `develop` 是 HEAD 的祖先 ⇒ `develop...HEAD` 恰好是**当前 worktree 自己那条分支的 delta**。只有创建该 driver 的那一条分支（`task/gap-session-hosts-claude-per-run-driver`，已 done；其 worktree 与分支名都已回收）才含 `DRIVER_PATH`，**其它任何带非空 delta 的分支**都不含 ⇒ 必红。

**实测（fleet 级：两条 delta 交集为空的任务、同一时段、同一个唯一红）**

| 任务 | delta | suite 尾 | 唯一红 |
|---|---|---|---|
| `gap-voice-error-notice-browser-e2e` | 8 个文件（`e2e/` + `src/modules/chat/`） | `# tests 246 / pass 245 / fail 1`，`suite-end 2026-09-27T04:19:19Z` | `claude-host-per-run.test.ts`（890ms） |
| `gap-ac027-gateway-wait-weaker-than-assertion` | 单个文件 `e2e/model-library.spec.ts` | `# tests 245 / pass 244 / fail 1`，`suite-end 2026-09-27T04:21:56Z` | 同一文件、同一句（931ms） |

逐字文案：

    not ok - server/modules/providers/tests/claude-host-per-run.test.ts:
      AssertionError [ERR_ASSERTION]: the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts

第一条任务的 standalone 读数（工作树逐字干净）把「它读的是谁的 delta」钉死了：

    gitDiff workingTreeFiles=0 vsDevelopFiles=8 containsNeighbour=false driverExists=true driverInDelta=false

`vsDevelopFiles=8` 就是那条任务 Touches 列表里的 8 个文件 —— 它一个 `providers/**` 文件都没有。反过来，**在判据自己的任务分支上它是绿的**：`gap-session-hosts-claude-per-run-driver` 的完成记录 AC6 打印 `vsDevelopFiles=4 … driverInDelta=true`。

**为什么这是判据的缺陷，不是 fleet 的负载抖动。** 该断言对「delta 非空且不含 driver」的**每一个** worktree 都成立，900ms 内即抛（无 spawn、无超时）。自 `05db7d4a` 于 `2026-09-27T03:21:16Z` 随 owner 任务的 fan-in 落到 develop 之后，**每一条带代码 delta 的任务**的全量 suite 都会停在它上面（上面的两个任务就是它落地后的头两次全量 suite）。立案时 develop 上没有任何修复提交：`git log --all --oneline -- server/modules/providers/tests/claude-host-per-run.test.ts` 只有 `05db7d4a`（判据自身的落地提交）。

**判据本来要守的不变量是对的**：这条判据必须证明它读的是**真的 delta**、不是一棵陈旧的树（`:600-606` 的注释写明了这一点，`:588` 的 `driverInDelta` 读数行也是为此存在的）。问题只在于它用「**当前**分支的 delta」当代理，而当前分支不一定是它自己的分支。

**修法（实现者择优，并在完成记录里写明依据）。**

- **(a) 按分支设门，保留满强度**：仅当 `git rev-parse --abbrev-ref HEAD` 等于 `task/gap-session-hosts-claude-per-run-driver` 时求值 `driverInDelta`；其它分支上**打印分支名与理由**、记为「不在此处求值」（读数行仍在，不是静默跳过）。fan-in 的 worktree 就在 `task/<id>` 分支上，所以需要它真的求值的那一轮仍然求值。
- **(b) 换成可移植的读法**：把「delta 是否含 DRIVER_PATH」换成对**本判据自己的任务记录**（`tasks/gap-session-hosts-claude-per-run-driver.md` 的 Touches 列表）的读取，或对 DRIVER_PATH 的 blob 与一份记录下来的基线逐 blob 比较。注意 (b) 读的是**声明**而不是树上的事实，弱于 (a)。

⛔ 不得把这条断言删掉、改成恒真或降为 print；实现必须配 AC3 的负控制，否则就是把判据变哑。同类先例 `gap-debug-agent-ac10-reads-the-whole-branch-delta`（已 done）用的就是修法 (a)，其落地提交 `b5d6c663` 已在 develop 上，读数行形如 `[AC10] … touched=… evaluated=… branch=…` —— 本条照它的形状办。

<!-- dedup-ref --> 边界：与 `gap-debug-agent-ac10-reads-the-whole-branch-delta`（已 done）同类 —— 都是「断言读了一个不属于它的全局事实（分支 delta）」；两条判据的文件、机制与不变量各自独立，互不重复。与 `gap-session-scope-test-global-namespace-count`（已 done）同类但对象不同（那条是 systemd 宿主全局命名空间）。与 `gap-voice-falsify-copies-inside-tsc-program`（已 done）无关。

## AC

- [ ] AC1 复现（改前，在别人的树上）：在一条**非 owner 分支**的 worktree 里跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts`，**必须**退出非 0 且文案逐字 `the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts`；把该次打印的 `gitDiff workingTreeFiles=… vsDevelopFiles=… driverExists=… driverInDelta=false` 那一行与红态原文一并抄进完成记录。现成实例：`gap-voice-error-notice-browser-e2e` 的 worktree（立案时仍在），或其 suite 日志 `.quay/fan-in-suite-gap-voice-error-notice-browser-e2e~wk-prod-anchor~1790482590611-a9ae5e.log`；第二实例见 `.quay/fan-in-suite-gap-ac027-gateway-wait-weaker-than-assertion~wk-prod-anchor~1790482623297-c7fc30.log`。
- [ ] AC2 改后同一棵树转绿且**说明理由**：同一 worktree、同一命令 → 退出 0，且输出里有一行点明该断言**未在此分支求值**、带分支名与理由（例如 `[AC6] driverInDelta=… evaluated=false branch=task/gap-voice-error-notice-browser-e2e`）。读数原文登记。
- [ ] AC3 负控制（判据没被变哑）：让这条断言**在 owner 分支上**真的求值并被违反 —— owner 的分支名与 worktree 已被回收，取「把分支判定强制为真」的临时探针（同目录临时副本、或一次性编辑后即还原）：在同一棵树上跑同一命令，**必须**退出非 0 且文案同上。读数原文、还原步骤与 `git status --porcelain` 干净一并登记。口径同 `gap-debug-agent-ac10-reads-the-whole-branch-delta` 的 AC3。
- [ ] AC4 门与范围：`npm run typecheck`、`npm run lint` 退出 0；对 develop 的 delta 只含 Touches 列出的文件。
- [ ] AC5 如实登记：完成记录写明本条改的是**求值范围**，不是不变量本身；并写明它救不了的情形（若将来某任务**故意**要改 `server/modules/providers/list/**` 且该判据在自己的分支上求值，读数仍应红 —— 这正是 AC3 保证的）。

## DoD

真实落地判据不是「不再红」，而是**该红的时候仍然红、不该红的时候不再红**：AC1 在别人的树上读到过红（原文登记），AC2 证明同一棵树在改后转绿且输出说明了理由，AC3 证明在 owner 分支上违反不变量时判据**仍然红**。三条合起来才排除「把断言改哑了」这一解释。完成后，任何 delta 不含该 driver 的兄弟任务不应再被这条断言挡下 —— 这可以从此后 `.quay/fan-in-suite-*.log` 里读回来：`claude-host-per-run.test.ts` 的 `__PERFILE__ … passed=` 在那些轮次里应为 `true`。完成记录必须写明：本条不改变那条不变量本身，也不评价该 driver 的实现。

## Touches

- server/modules/providers/tests/claude-host-per-run.test.ts
- tasks/gap-claude-host-per-run-delta-scope-gate.md
