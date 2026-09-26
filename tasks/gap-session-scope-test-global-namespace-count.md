---
id: gap-session-scope-test-global-namespace-count
title: claude-session-scope.test.ts 把 listClaudeSessionScopeUnits()
  的宿主全局计数当断言（等「恰好剩一个 scope」，10s 超时）：本机任何别的会话 scope 生产者（:3001 上的真实会话、并发 lane、DoD
  harness 起的临时 server）都会把它打红 —— 已连红两轮、挡住两个任务
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

**现象（三次观测，同一断言）。** `server/modules/providers/tests/claude-session-scope.test.ts:262` 那条用例 `a session over its cap dies alone; a live sibling is untouched` 在 `:300` 用

```js
await waitUntil(() => listClaudeSessionScopeUnits().length === 1, 10_000,
  () => `one surviving session scope, saw ${JSON.stringify(listClaudeSessionScopeUnits())}`);
```

等的是**全宿主**的 `claudecodeui-session-*` 计数等于 1。`listClaudeSessionScopeUnits()`（`server/modules/providers/services/claude-session-scope.service.ts:363`）跑的是 `systemctl --user list-units 'claudecodeui-session-*' --no-legend --plain`，即操作员视角的完整列表，注释里也自陈「Consumed by stop, sweep and the session-scope tests' emptiness assertions」。**stop/sweep 读全局是对的**（它们的职责就是发现所有孤儿）；**测试把它当精确计数是错的**。

三次实测读数：

| 观测 | 实际列表 | 泄漏来源 |
|---|---|---|
| `.quay/fan-in-suite-gap-chat-edit-send-…~1790349548241-61217f.log` | `1173991-e710433d` / `1177720-a25be588` / `264422-f8cfcacc` | 三个**不同**属主 pid：两个并发 lane 的测试进程 + 当时活着的 `server/index.ts`(264422) |
| `.quay/fan-in-suite-gap-session-hosts-default-wrap-four-providers~wk-prod-anchor~1790350562645-af8de5.log` | 一长串 `2180019-*` | 单个属主 pid 名下**很多**个 scope（`2180019` 现在已死）——一个持有很多会话的进程，例如临时 server / DoD harness |
| 2026-09-26 我在主检出直接跑该文件 | `264422-016b7e1f` 等 **7** 个 | 当时活着的 `server/index.ts`(264422)，工作树无关 |

第三条最关键：**它不需要任何并发就能红** —— 只要这台机器上有一个真实 server 托着活跃会话（本机的常态；我读的时候 `systemctl --user list-units 'claudecodeui-session-*'` 有 2 个 active，里面是真在跑的 `claude --output-format stream-json`），这个断言就永远等不到 1。

**根因。** 该用例自己造的 scope 已经带属主 pid（`buildClaudeSessionScopeUnitName(process.pid, suffix)`，`:376` / `:395` 两处创建都在用），**只有读取那一侧没有归因**：`listClaudeSessionScopeUnits()` 返回混合列表，断言却按全局计数比较。

**修法（与 `d5f7904b` 对 voice 判据的修法同形：把读数归到本进程）。** 在测试侧加一个只属于本进程的读取：

```js
const ownScopes = () => listClaudeSessionScopeUnits()
  .filter((unit) => unit.startsWith(buildClaudeSessionScopeUnitName(process.pid, '')));
```

`:300` 的等待改成「**我的** scope 里恰好剩一个」，`:367` 那条 `stopping this server's scopes leaves none, and sweep takes only orphans` 同样按本进程前缀断言（它的孤儿用例本来就自己造带假 pid 的 unit，不受影响）。**不改产品侧** `listClaudeSessionScopeUnits()` 的全局语义（stop/sweep 依赖它）。README 式的说明写在测试文件的注释里：为什么断言必须带属主前缀。

**为什么不选另外两条路。** (a) 把断言放宽成 `>= 1`：会放过「两个 scope 都活着」这种真失败，判据失去分辨力。(b) 给服务函数加 owner 过滤参数：动产品面，而所有消费方（stop/sweep）要的正是全局列表，为一个测试改产品语义不划算。

**边界。** 这不是 voice `__criterion-falsify-*` 那条串扰（`d5f7904b` 已修），也不是各任务自己的 delta：三次观测里被挡住的 `gap-session-hosts-default-wrap-four-providers` 与 `gap-chat-edit-send-unawaited-handler-lane-flake` 的 `## Touches` 都不含 `server/modules/providers/`。判据本身属于已 done 的 `gap-claude-session-cgroup-scope`，其存量通道无人接手，本任务接手。

## AC

- [ ] AC1 读数归到本进程：`grep -n 'listClaudeSessionScopeUnits' server/modules/providers/tests/claude-session-scope.test.ts` 的每一处断言读法都带本进程属主前缀（`buildClaudeSessionScopeUnitName(process.pid, …)`），没有一处再对全局计数做等值断言；给出改动前后的 `grep -n` 输出对照。
- [ ] AC2 有分辨力（本进程的失败仍然红）：在改动后的树上，把某个由本进程创建的 scope 在收尾前手动留下（例如注释掉 `finally` 里的一次 `stopClaudeSessionScopes()`，或在用例内多起一个本进程的 scope 而不停），该用例必须退出码非 0，红态文案点名**多出来的那个本进程 scope**。用后还原，读数与还原后的 md5 抄进完成记录。
- [ ] AC3 外部 scope 不再打红（正对照，逐条登记）：在树上植入一个**外部**会话 scope（`systemd-run --user --scope --unit=claudecodeui-session-99999999-foreignprobe -- sleep 30`，属主 pid 不存在），随后跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-scope.test.ts`，必须 **exit 0**；撤掉植入（`systemctl --user reset-failed` + 确认 `list-units` 里不再有该 unit）后再跑一次仍 exit 0。两次读数与 `systemctl --user list-units 'claudecodeui-session-*'` 的原文一并登记。
- [ ] AC4 其余用例不回归：该文件整体 `tests N / pass N / fail 0`、exit 0；`npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat develop...HEAD` 只含 `## Touches` 里的文件（若诊断需要动产品文件，按 AC5 处理）。
- [ ] AC5 范围纪律：改动只允许落在 `server/modules/providers/tests/claude-session-scope.test.ts`。若证明必须改产品侧（`claude-session-scope.service.ts`）才能修，**停止**，把证据写进完成记录并按机制另立 gap 任务；不得把改动伸到 Touches 之外。

## DoD

真实落地判据不是「把断言改松」：AC2 证明本进程的失败仍然红（判据没被削弱），AC3 证明外部 scope 在场时不再红（这正是三轮 fan-in 红的触发条件），两条合起来才是「读数已归因」的证据。完成记录必须写：三次观测的原始列表（含本机 :3001 上有活跃会话时的读数）、AC3 的植入命令与 `systemctl` 原文、AC2 的红态文案、还原后的 md5。收尾时本机不应留下本任务造的 scope（`systemctl --user list-units 'claudecodeui-session-*'` 与开工前一致，读数抄进记录）。

## Touches

- server/modules/providers/tests/claude-session-scope.test.ts
- tasks/gap-session-scope-test-global-namespace-count.md
