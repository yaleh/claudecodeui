---
id: gap-debug-agent-ac10-reads-the-whole-branch-delta
title: debug-agent-host-driver 的 AC10 读整条分支 delta 判 providers/list
  是否被碰：base=develop、并集还含 git show --name-only HEAD ⇒ 任何合法范围包含
  server/modules/providers/list/ 的兄弟任务必红（AC-159 已连停 3 轮）；该断言在自己的分支上是对的，缺的是按分支设门
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Finding

**现象。** `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts:1396` 在**任何** worktree 的 suite 里断言：

```js
assert.equal(facts.providersListTouched, false, `no file under ${PROVIDERS_LIST_DIR} may be touched`);
```

`gap-session-hosts-claude-per-run-driver`（AC-159，Claude per-run 宿主 driver）因此连停 3 轮，逐字：

```
not ok - server/modules/debug-agent/tests/debug-agent-host-driver.test.ts:
  AssertionError [ERR_ASSERTION]: no file under server/modules/providers/list/ may be touched
```

**它不是那条任务的 delta。** 该任务在同一轮的 `## Touches` 判据是绿的（`claude-host-per-run.test.ts` `passed=true` 2632ms、`provider-runtime.service.test.ts` `passed=true` 1009ms）。它的 delta 是：

```
server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts | 533 +
server/modules/providers/list/claude/claude-runtime.provider.js             |  13 +-
server/modules/providers/list/claude/claude.provider.ts                     |  50 +
server/modules/providers/tests/claude-host-per-run.test.ts                  | 767 +
```

**前三行正是它的范围**（AC-159 就是「Claude per-run 的宿主 driver」），而 `PROVIDERS_LIST_DIR = 'server/modules/providers/list/'` —— 于是这条断言对它是**必红**。

**机制（这条断言读的是一个全局事实，却在别人的上下文里被求值）。** `:1020-1043`：

```js
let base = git(['rev-parse','--verify','--quiet','develop^{commit}'])   // 仓的 develop ref
const deltaFiles = git(['diff','--name-only', base])                   // 整条分支对 develop 的 delta
const headCommit = git(['show','--name-only','--format=','HEAD'])      // HEAD 那个提交带来的全部文件
const touched = new Set([...deltaFiles, ...headCommit]);
providersListTouched: [...touched].some((file) => file.startsWith(PROVIDERS_LIST_DIR)),
```

两处放大：

1. 它取的是**当前分支**对 develop 的 delta —— suite 跑在谁的 worktree 里，就按谁的 delta 判。任何一个合法范围包含 `server/modules/providers/list/` 的兄弟任务都会被它打红。
2. 它还并进 `git show --name-only HEAD` —— 在 fan-in 的树上 HEAD 常常是**合并提交**，那一步会把整个合并带来的文件集都算作「touched」，与本次改动其实无关。

**判据本来要守的不变量是对的**：debug-agent 的宿主 driver 实现**不该**需要改动任何 provider 的 runtime。问题只在于它用「分支 delta」当代理，而分支 delta 不是这条不变量。

**修法（二选一或并用，实现者择优并在完成记录里写明依据）。**

- **(a) 按分支设门，保留满强度**：只有当前分支是这条判据自己的任务分支时才求值（`git rev-parse --abbrev-ref HEAD`，期望 `task/gap-debug-agent-host-driver`）；其它分支上记为「不适用」并**打印分支名与理由**（读数行仍在，不是静默跳过）。这样在自己的分支上判据一字未松，在别人的分支上不再误伤。**fan-in 的 worktree 就在 `task/<id>` 分支上**，所以本任务自己的轮次仍然真的求值。
- **(b) 换成可移植的检查**：读本任务自己的 `tasks/gap-debug-agent-host-driver.md`（每个 worktree 里都有），要求它的 `## Touches` 里没有 `server/modules/providers/list/` 条目；或者把该目录的内容与一份记录下来的基线逐 blob 比较（只对**本任务声明过的**写点判）。

⛔ 不得把这条断言删掉或改成恒真；`(a)` 必须配 AC3 的负控制（见下），否则就是把判据变哑。

<!-- dedup-ref -->
**边界。** 与 `gap-session-scope-test-global-namespace-count`（已 done）同类但不同处：那条是**宿主全局命名空间**（systemd scope 列表），本条是**分支全局 delta**；两条都是「断言读了一个不属于它的全局事实」。修法各自独立。与 `gap-voice-falsify-copies-inside-tsc-program`（已 done）无关。

## AC

- [ ] AC1 复现（改前）：在一条 delta 触及 `server/modules/providers/list/` 的分支的 worktree 里跑该判据
      （`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-host-driver.test.ts`），
      **必须**退出非 0 且文案逐字 `no file under server/modules/providers/list/ may be touched`；把该次 `git diff --name-only develop | grep providers/list` 的输出与红态原文一并抄进完成记录。
      （现成实例：`gap-session-hosts-claude-per-run-driver` 的 worktree，日志
      `.quay/fan-in-suite-gap-session-hosts-claude-per-run-driver~wk-prod-anchor~1790477685098-*.log`。）
- [ ] AC2 改后同一棵树转绿且**说明理由**：同一 worktree 重跑同一命令 → 退出 0，且输出里有一行点明该断言**未在本分支求值**、带分支名（例如 `[AC10] providers/list touched=… evaluated=false branch=task/gap-session-hosts-claude-per-run-driver`）。读数原文登记。
- [ ] AC3 负控制（判据没被变哑）：让这条判据**在自己的分支上**真的求值并被违反 —— 例如在 `task/gap-debug-agent-host-driver` 分支的 worktree 里（或用一次把分支判定强制为真的探针）造一个位于 `server/modules/providers/list/` 的改动，跑同一命令必须退出非 0 且文案同上。读数与还原一并登记。
- [ ] AC4 门与范围：`npm run typecheck`、`npm run lint` 退出 0；`git diff --stat develop...HEAD` 只含 `## Touches` 列出的文件。
- [ ] AC5 如实登记：完成记录写明本条改的是**求值范围**，不是不变量本身；并写明它救不了的那种情形（如果将来某任务**故意**要改 `providers/list/` 而又在 debug-agent 的分支上求值，仍应红 —— 这正是 AC3 保证的）。

## DoD

真实落地判据不是「不再红」，而是**该红的时候仍然红、不该红的时候不再红**：AC1 在别人的树上读到过红（原文登记），AC2 证明同一棵树在改后转绿且输出说明了理由，AC3 证明自己的分支上违反不变量时判据**仍然红**。三条合起来才排除「把断言改哑了」这一解释。完成后，任何 delta 含 `server/modules/providers/list/` 的兄弟任务不应再被这条断言挡下 —— 这可以从此后 `fan-in-suite-*.log` 里读回来：`debug-agent-host-driver.test.ts` 的 `__PERFILE__ … passed=` 在那些轮次里应为 `true`。完成记录必须写明：本条不改变那条不变量本身，也不评价 debug-agent 的实现。

## Touches

- server/modules/debug-agent/tests/debug-agent-host-driver.test.ts
- tasks/gap-debug-agent-ac10-reads-the-whole-branch-delta.md
