---
id: gap-debug-agent-gate-structural-off
title: 调试 Agent 的 env 门控：关闭即结构性不存在（registry 无键 / watcher 无根 / 路由未挂载三面），且 fail-closed
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-123
---
## Proposal

**交付物：调试 Agent 的 env 门控，以及「关闭即结构性不存在」这条性质的实现与判据。** 据 `adr/ADR-003-可控制的调试-agent-不跑真-cli-也能产生输出.md` 决策 3（并经评审**裁决 B** 收窄）实现：门控变量（如 `DEBUG_AGENT`）默认关闭；关闭时**不是「接口返回 403」，而是「这个东西不存在」**，且该性质在**三面**上同时成立。

**三面**（裁决 B 把原文的「四面」降为三面，理由见下）：

1. **registry 里没有键**——任何按 id 解析的路径拿到的是「未知 provider」，**与拼错一个 id 无从区分**；
2. **watcher 没有根**——fixture 根不在观察路径集合里，因而不会有任何 `session_upserted` 因为场景推进而广播出去；
3. **路由未挂载**——路由器根本没被 attach，所以没有任何请求能落到控制面的处理函数上。

**裁决 B 删掉的那一面及其理由。** 原文把「capabilities 没有条目」列为第四面，并说「四个面各自独立地读门控」。实测不成立：`PROVIDER_CAPABILITIES` 是 `Record<LLMProvider, ProviderCapabilities>` 的**闭集字面量**，不随 registry 增长——所以「关闭态没有条目」**恒真**，开着也没有。按本 ADR 自己的标准（判据若在假实现下仍绿，它测的就不是它声称要测的东西）那是假判据。**裁定：不计入四面，也不为了这一面去增加门控耦合。**

**「未挂载」不等于 404（承重的一条事实）。** `static-assets.module.ts` 的 SPA catch-all 对**任何无扩展名的路径**渲染 `dist/index.html`，而它挂在所有 `/api/*` 之后——因此一个未挂载的 `/api/...` 路径返回的是 **`200 text/html`**（前端壳），既不是 404 也不是 403；只有**带扩展名**的路径才 404。所以第 3 面**不得落成状态码断言**；本任务的判据用「该路径**不以控制面的应答作答**」。现场读数见 `adr/ADR-003-验证记录.md` 的 a。

**fail-closed 是承重的。** 变量缺失、取值不认识、或开了但没有 fixture 根，一律按**关闭**处理，且必须打印判定原因。门控在**进程启动时**求值，因此判据必须在**两个独立子进程**里各取一次读数（ESM 模块一旦求值就不能在同一进程内重来）。

**本任务不做**：不实现控制面路由本身（另有任务，本任务只保证它在关闭态不被挂载）；不实现词表守卫；不做 fixture 的清理顺序。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务——按「门控 / 结构性关闭 / env gate / fail-closed」检索无命中。相邻但机制不同的是 `gap-model-library-*` 系列的开关类任务（那是配置项读写，不是「不存在」语义）。

## Plan

1. 门控模块独立成文件，**是唯一读门控变量的地方**；三个消费点（registry、watcher、服务入口的路由挂载）都从它取结论，不各自解析 env。
2. registry 侧：键的注册在门控开启时才发生——关闭时那张表里**根本没有这一项**。
3. watcher 侧：观察路径集合由门控决定；fixture 根与既有四个根**重复时不重复观察**（两个 watcher 盯同一目录会让每个事件翻倍）。
4. 路由侧：在服务入口按门控决定是否 `app.use(...)`；关闭时**不 attach**。
5. 判据必须起两个子进程（关闭态 / 开启态各一），并在输出里打印每次判定的原因。

## AC

- [ ] AC1 三面判据——`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-gate.test.ts` 退出码 0。该用例即 `goals/AC-123`：关闭态逐一断言 (1) registry 无键且解析失败**与拼错一个 id 逐字相同**；(2) fixture 根不在观察路径集合里且该目录不被创建；(3) 控制面路径**不以控制面的应答作答**（**不得断言 404**——见 Proposal 与 ADR 的 a）；开启态对照三面都存在；并断言 fail-closed（取值不认识、或开了但没有根，一律按关闭且打印原因）。打印三面的实际读数。
- [ ] AC2 抗假变体（**真跑并留输出**）：**只关掉其中一面**——例如保留 registry 键但摘掉路由。`AC1` 的命令必须因此**退出码非 0**，且红因指明是哪一面漏了。跑完还原，`git status` 干净，并贴两次输出。这一条是「三面各自独立读门控」这个代价的正面覆盖。
- [ ] AC3 判据自身不得被 404 骗过：对关闭态的同一个控制面路径，命令**同时**打印无扩展名与带扩展名两种写法各自的状态码与 content-type，使「200 text/html」与「404」的差别在输出里可见。取假形态：把第 3 面写成「关闭时返回 404」后，本判据在**实现完全正确**的前提下也必须红——若它仍绿，说明该面根本没被断言。
- [ ] AC4 门控只有一个读点：命令断言除门控模块本身外，`server/` 下没有第二处直接读该 env 变量的位置（逐行打印命中）。取假形态：某个消费点自己解析 env 而绕过门控模块时，本判据必须红。
- [ ] AC5 本任务未触及 Touches 之外的文件。命令：`git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都必须能对应到 Touches 内的一条；命中之外时逐行打印并以非 0 退出。

## DoD

真实落地判据（不是「有个 if 判断了 env」）：**关闭态的「不存在」是结构性的，而不是某个检查返回了 false。** 承重性由三件事正面证明：

(a) **三面各自被独立断言过**（AC1），而不是断言了一个布尔值；
(b) **「只关掉一面」的变体真跑过并变红**（AC2）——这直接证明三面是三条独立的路径，而不是同一处判断的三个投影；
(c) **第 3 面的判据没有退化成状态码断言**（AC3），即它没有被本仓库的 SPA catch-all 骗过——现场实测过：未挂载的 `/api/...` 返回 `200 text/html`。

另需如实登记：`capabilities` 那一面**不在**本任务的三面内（裁决 B）。它的开启态行为——既然该 provider 不进联合，`getProviderCapabilities('<id>')` 会拿到 `undefined`——**本任务不实测、不裁决**，留给控制面任务的判据。

L_D 该轴仍暗，理由：本任务交付的是调试/测试机制的门控，不改变产品领域能力，没有可读出的产品领域读数；判定面由 AC1 的三面读数与 AC2 的变体承担。
L_G 本目标的判据是 `goals/AC-123`（门控关闭时三面都不存在，且「只关掉其中一面」的变体必须红），本任务的 AC1 即该判据的命令；AC2 是它的抗假变体。

## Touches

- server/modules/debug-agent/debug-agent.gate.ts (new)
- server/modules/debug-agent/tests/debug-agent-gate.test.ts (new)
- server/modules/providers/provider.registry.ts
- server/modules/providers/services/sessions-watcher.service.ts
- server/index.ts
- tasks/gap-debug-agent-gate-structural-off.md