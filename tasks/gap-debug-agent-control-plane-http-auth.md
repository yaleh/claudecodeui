---
id: gap-debug-agent-control-plane-http-auth
title: 调试 Agent 的 dev-only 控制面：HTTP + 既有 authenticateToken，门控而非鉴权才是安全边界
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-debug-agent-engine-and-scenario-ops
  - gap-debug-agent-gate-structural-off
goal_ac: AC-128
---
## Proposal

**交付物：调试 Agent 的 dev-only 控制面——一个挂在既有鉴权中间件下的 HTTP 路由。** 据 `adr/ADR-003-可控制的调试-agent-不跑真-cli-也能产生输出.md` 决策 1 与决策 6 实现：控制面负责「**装载场景**、**推进时钟**、**读引擎自检结果**」这三类请求/应答式操作；引擎产出逻辑不在本任务内（本任务只驱动它）。

**为什么走 HTTP 而不新增 WS 通道、不新增 CLI 脚本（决策 6）。** 这三类操作没有服务端推送需求，新增一条 WS 通道意味着新增一套握手、鉴权与重连语义，收益为零。脚本则会**绕过鉴权中间件**，把控制面变成「本机任何进程都能驱动」的面；而且脚本一旦存在就会成为第二个入口，与 HTTP 面争夺「谁是控制面」。

**安全边界是门控，不是鉴权（本决策最容易读错的一句）。** `authenticateToken` 保护的是「已登录用户」；而调试 Agent 在**关闭态下对已登录用户也必须不存在**——它不该出现在任何用户的 capabilities 里，也不该有任何路由可打。鉴权回答「你是谁」，门控回答「这个东西是否存在」。二者都不能替代对方：门控开着但没有鉴权，等于把产出源交给任何能连上端口的人；有鉴权但门控只是一个布尔检查，则任何一处漏检都会把它暴露给已登录用户。

**因此本任务的两条硬约束。** (1) 路由**只在门控开启时被 attach**（关闭态不给 403、不给 401，而是**这里什么都没有**）。(2) 关态判据**不得写成「返回 404」**：本仓库 `static-assets.module.ts` 的 SPA catch-all 对任何**无扩展名**的路径渲染 `dist/index.html`，未挂载的 `/api/...` 返回 `200 text/html`；写 404 的判据在实现完全正确时也必红，且会让它的取假变体一起失效（关闭态真实现与假实现的状态码相同，红不了）。现场读数见 `adr/ADR-003-验证记录.md` 的 a。

**裁决 B 转交给本任务的一项未决。** 调试 Agent 不进 `LLMProvider` 联合，因此它在 `provider-capabilities.service.ts` 的闭集字面量里没有条目，`getProviderCapabilities('<id>')` 会返回 `undefined`。该路径**应当**回退还是显式处理，ADR 未裁决也未实测——由本任务的判据给出读数并收口。

**本任务不做**：不实现引擎；不实现门控模块本身（只消费它）；不实现外部写入路径；不改 `docs/architecture/02-realtime-stream.md`（其已被证伪的断言是否一并修正，是 ADR 留给评审的开放问题）。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务——按「控制面 / dev-only HTTP / 场景装载端点」检索无命中。相邻但机制不同的是 `gap-scripts-static-gates-and-mint-token`（脚本类静态门禁与凭据铸造），它不提供请求/应答式的场景驱动面。

## Plan

1. 路由模块独立成文件，**导出 router 而不自行 attach**；attach 的动作在有门控的那一处（服务入口）。
2. 三个动作各自成端点；「读自检结果」在无记录时给出**可辨的 404**（与控制面的「不存在」区分开：这里是「有这个东西，但这份记录没有」）。
3. 复用既有的 `authenticateToken`，与其它受保护路由**同形**——不新造鉴权路径。
4. 凭据有效但无权限（403）与凭据缺失（401）不混用。
5. 对裁决 B 转交的 `undefined` 一项：先取读数（该调用返回什么、前端拿到后会怎样），再决定回退还是显式处理，并把读数与决定写进完成记录。

## AC

- [ ] AC1 控制面判据——`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-control-plane.test.ts` 退出码 0。该用例即 `goals/AC-128`：门控开启时 (1) 三个动作各自可达，且「读自检结果」在无记录时给出**可辨的 404 而非空 200**；(2) **缺凭据返回 401**；(3) 401 与 403 不混用；门控关闭时同一路径**不以控制面的应答作答**（**不得写成 404**——理由见 Proposal）。打印每一侧的状态码与 content-type。
- [ ] AC2 抗假变体（**真跑并留输出**）：**门控关闭但仍挂载路由**。`AC1` 的命令必须因此**退出码非 0**。注意到本条变体在「判据写 404」时是**失效**的——故本 AC 必须在本任务改正判据**之后**跑，并在输出里同时给出变体前后的两次读数，证明鉴别力来自判据而非巧合。跑完还原，`git status` 干净。
- [ ] AC3 三个动作**真跑一次**并与引擎自检对上：命令装载一个场景、推进时钟、读回自检结果，断言自检块里的行数读数与产物文件的实际行数一致（即控制面读到的不是缓存的自述）。取假形态：让「读自检结果」返回引擎的自述而非产物读数时，本判据必须红。
- [ ] AC4 裁决 B 转交项取读数并收口：命令打印 `getProviderCapabilities('<id>')` 的实际返回值，以及前端/路由在该返回值下会走的分支；完成记录里写明选了回退还是显式处理及其理由。**不预设结论**——只要求读数存在且决定被写下。
- [ ] AC5 本任务未触及 Touches 之外的文件。命令：`git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都必须能对应到 Touches 内的一条；命中之外时逐行打印并以非 0 退出。

## DoD

真实落地判据（不是「路由能被 curl 到」）：**门控是这条面的存在性来源，而不是它的一道检查。** 承重性由三件事正面证明：

(a) **关闭态的读数与开启态逐字节不同**（AC1：`200 application/json` 对 `200 text/html`），且判据没有被状态码骗过；
(b) **「关掉门控但仍挂载」的变体真跑过并变红**（AC2），且改正判据前后的两次读数都在，证明红来自鉴别力；
(c) **控制面读到的是产物而不是引擎的自述**（AC3）——否则「读自检结果」这个动作本身就是假的。

另需如实登记：裁决 B 转交的 `undefined` 一项的读数与决定（AC4），以及**本任务未实测**的部分（例如未在真实浏览器里点过控制面——它是 dev-only 面，无 UI）。

L_D 该轴仍暗，理由：本任务交付的是调试/测试机制的 dev-only 控制面，不改变产品领域能力，没有可读出的产品领域读数；判定面由 AC1 的三侧读数与 AC2 的变体承担。
L_G 本目标的判据是 `goals/AC-128`（控制面在门控开启时可用、缺凭据 401，且门控而非鉴权才是安全边界），本任务的 AC1 即该判据的命令；AC2 是它的抗假变体。

## Touches

- server/modules/debug-agent/debug-agent.routes.ts (new)
- server/modules/debug-agent/index.ts
- server/modules/debug-agent/tests/debug-agent-control-plane.test.ts (new)
- server/index.ts
- tasks/gap-debug-agent-control-plane-http-auth.md