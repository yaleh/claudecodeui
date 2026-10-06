---
id: gap-ac254-criterion-harden-against-repo-dotenv
title: AC-254 判据在部署方 .env 钉住 MCP_ENABLED=true
  的检出里仍须产出「关」态读数：e2e/mcp-settings.spec.ts 的 disabled 臂删掉 MCP_ENABLED 后被
  server/load-env.ts 从 .env 顶回 true，(b) 红；(a) 的基址同样被 .env 的 PUBLIC_BASE_URL 顶住
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-254
---
## Proposal

<!-- dedup-ref --> 同机制溯源（本段只作溯源，不声明任何依赖边）：`grep -rn '^goal_ac: *AC-254' tasks/*.md` 只命中 `gap-ac254-mcp-settings-block-scope-checkboxes`（`status: done`）——按 `standing-violated` 的规矩它不是重复，而是「早先那次出货没有守住」的证据，故本条另立新任务并说明它为何没守住。同机制的既有先例是 `gap-voice-capture-criterion-hardened-root`（AC-148，done）：判据把某一态「能不能产出」外包给部署方的 `.env`，而 `server/load-env.ts` 会把子进程里被删掉的键从 `.env` 顶回来。`gap-ac255-mcp-settings-i18n-completeness`（`goal_ac: AC-255`）是不同机制（12 语言文案完备性）。在飞（todo/ready/needs-human）任务里没有任何一份带 `goal_ac: AC-254`。

**为什么早先那次没守住（本次立案实测，可复验）**

- 判据文件存在、实现已并入本分支：`git merge-base --is-ancestor a77afff4 HEAD` 退出 0；`e2e/mcp-settings.spec.ts` 非空；`src/modules/settings/tabs/api-settings/sections/McpGatewaySection.tsx` 存在。所以 AC 记录里写的「当前必红：判据文件不存在」已经过期——**红因换了一个**。
- 本检出直接跑判据（命令与 AC 逐字相同）：`for f in e2e/mcp-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/mcp-settings.spec.ts` → 退出 **1**。逐字失败行：

```
(b) disabled state: the page shows "not enabled" and renders no connect command
  > 287 |       await expect(status).toHaveAttribute('data-enabled', 'false');
  Error: expect(locator).toHaveAttribute(expected) failed
  Locator: getByTestId('mcp-gateway-status')
  Expected: "false"
  Received: "true"
```

- 因（一句话）：`e2e/mcp-settings.spec.ts` 的 `bootState()` 用「从子进程 env 里**删掉** `MCP_ENABLED`」来造关闭态，但 `server/index.ts:3` 是 `import './load-env.js'`，而 `server/load-env.ts` 读 `<APP_ROOT>/.env` 并在 `!process.env[key]` 为真时把该键写回 `process.env`（`:32`）。本仓根 `.env`（gitignored：`git check-ignore -v .env` → `.gitignore:19`；mtime 2026-10-06 08:27，晚于 a77afff4 的 2026-10-05 通过）现在定义 `MCP_ENABLED`、`PUBLIC_BASE_URL`、`MCP_OAUTH_ENABLED`、`TRUST_PROXY`、`MCP_DCR`、`VOICE_CAPTURE`，其中 `MCP_ENABLED=true`、`PUBLIC_BASE_URL=<非空 URL>`。于是「关闭态」服务端实际以 `MCP_ENABLED=true` 启动，settings 读点如实返回 `enabled:true`，读数 (b) 红。
- 同因还有第二处：(a) 的端点基址由 `server/modules/settings/settings.service.ts:266` 的 `gateway.publicBaseUrl() ?? origin` 决定，`publicBaseUrl()` 读 `PUBLIC_BASE_URL`；`.env` 钉住它，端点就不再是本态 origin，而 spec 第 341 行断言 `Number(new URL(endpointText).port) === booted.serverPort` —— 所以 (a) 在 (b) 修好后**同样会红**，(b) 只是先挡住。
- 出货实现是对的：`server/modules/mcp-gateway/mcp-gateway.gate.ts:37` 的 `readMcpGatewayGate` 对「未设置 / `false` / 未识别值」一律判关闭，settings 路由（`settings.routes.ts:54` → `settings.service.ts:255`）如实透传；`.env` 钉 `MCP_ENABLED=true` 时页面显示「已启用」正是应有行为。**红的是判据对部署方 `.env` 的环境耦合，不是实现。**

**交付**

1. `e2e/mcp-settings.spec.ts` 的 `bootState()`：把「靠**缺失**造状态」改成「靠**显式赋值**造状态」。`server/load-env.ts:32` 的 `!process.env[key]` 保证显式值优先于 `.env`，缺失才会被顶回。
   - 关闭态：显式 `MCP_ENABLED='false'`（`readMcpGatewayGate('false')` → 关闭；这是 AC 所述「关」的合法配置），**不要**删键。
   - 开启态：显式 `MCP_ENABLED='true'`（已有）。
   - 两态都显式钉 `PUBLIC_BASE_URL='http://127.0.0.1:<本态 serverPort>'`（`serverPort` 在 `bootState` 开头已分配），**不要**删键，让 (a) 的基址由判据决定而不由 `.env` 决定；spec 第 338–341 行「基址是本态 server origin」的注释据此仍成立。
   - 通则：凡是读数依赖某键「未设置」的，一律改成显式赋值——缺失不是开关，会被 `.env` 顶回。
   - 在 `bootState()` 顶部加注释，指名 `server/load-env.ts` 的 `.env` backfill，说明为何用显式值而非删除（同 [[criterion-must-harden-its-own-root-not-read-the-deployers-dotenv]]）。
2. 加一条便宜的护栏，让将来 `.env` 变动可见而非静默翻面：spec 启动时读出本仓根 `.env` 中定义的键名并记进日志（如 `dotenv-keys=<...>`），并对读数依赖的键断言已显式钉住。
3. **不改出货源码**（`server/`、`src/`、`shared/` 零改动）；**不改部署方 `.env`**（判据只读它，绝不写它）。
4. 红先行与取假形态：(i) 写 scope 默认勾选 ⇒ (d) 红；(ii) 关闭态仍渲染接入命令 ⇒ (b) 红；(iii) 命令内嵌真实令牌 ⇒ (c) 红——三条**必须仍然红**，证明硬化没有把判据变宽。

## AC

- [ ] AC1 为什么早先没守住：逐字写下 `grep -rn '^goal_ac: *AC-254' tasks/*.md`（只命中 done 的那份）、`git merge-base --is-ancestor a77afff4 HEAD; echo $?`（0），以及本次红态命令的完整输出（含 `Expected: "false"` / `Received: "true"`）。
- [ ] AC2 因可复验：贴出 `grep -n 'MCP_ENABLED\|PUBLIC_BASE_URL' .env`、`git check-ignore -v .env`、`server/index.ts` 的 `import './load-env.js'` 行、`server/load-env.ts:26,32` 的读/写行、`settings.service.ts:266` 的 `publicBaseUrl() ?? origin` 行；读者据此能解释 backfill。
- [ ] AC3 判据在**本检出**（`.env` 钉着 `MCP_ENABLED=true` 与非空 `PUBLIC_BASE_URL`）退出 0：`npx playwright test e2e/mcp-settings.spec.ts` 退出 0，写下 tests/passed/failed 与两态 env 的逐字值（关闭态 `MCP_ENABLED=false`、开启态 `MCP_ENABLED=true`；两态各自的 `PUBLIC_BASE_URL`），以及 (a) 读出的端点与 (b) 读出的状态文案。
- [ ] AC4 硬化是承重的（可证伪）：把关闭态的显式 `MCP_ENABLED='false'` 改回「删键」并重跑，在本检出的 `.env`（`MCP_ENABLED=true`）下 (b) 立刻回到 `Received: "true"`；改回显式值即回绿。逐字记录两次读数与恢复命令。
- [ ] AC5 硬化没有把判据变宽：三条取假形态仍各自只红一条被指名的读数——(i) 写 scope 默认勾选 ⇒ (d) 红；(ii) 关闭态仍渲染接入命令 ⇒ (b) 红；(iii) 命令内嵌真实令牌 ⇒ (c) 红。逐条记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿。
- [ ] AC6 稳定性：连续跑判据 2 次都退出 0（写下两次 tests/passed/failed）；若出现 `net::ERR_NETWORK_CHANGED` 或空白页一类非确定性失败，如实记录并给出修法（如对文档加载做一次有界重试 / 等待 app shell 的可加载路径），不得靠放宽读数掩盖。
- [ ] AC7 不回归与仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`e2e/access-tokens-settings.spec.ts`（AC-228）不改一字仍通过。
- [ ] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐；`git diff --stat develop HEAD -- server/ src/ shared/` 输出为空（出货源码零改动），把该输出原样打印。

## DoD

真实落地判据：不是「spec 多了两行」，而是**部署方把 `MCP_ENABLED=true` 与非空 `PUBLIC_BASE_URL` 钉在仓根 `.env` 里的检出**中，`npx playwright test e2e/mcp-settings.spec.ts` 仍在真实 Chromium、真实后端、临时数据目录下**同时**取到「开」与「关」两态读数：(a) 开启态显示端点 URL（形如 `<基址>/mcp`，端口等于本态 server 端口）与「已启用」；(b) 关闭态显示「未启用」且页面不含接入命令。关闭态的 `data-enabled="false"` 由判据**自己显式钉的 `MCP_ENABLED=false`** 产生，不由 `.env` 决定。承重性由读数证明：

(a) **修前必红、修后必绿，且红的正是 backfill**：在本检出里把关闭态的显式 `'false'` 改回「删键」，(b) 立刻回到 `Received: "true"`（AC4 的可证伪臂，即本条立案时实测到的原状）；改回显式值即回绿。
(b) **硬化没把判据变宽**：三条取假形态仍各自只红一条被指名的读数（AC5），说明「能跑了」不是靠放宽读数换来的。
(c) **读数两态都真**：AC3 的两态 env 逐字打印，关闭态 `MCP_ENABLED="false"`、开启态 `"true"`，两态各自的端点/状态读数都取自真实 DOM。

**必须如实登记**：本条修的**不是出货实现**。反事实——`readMcpGatewayGate` 对未设置/`false`/未识别一律关闭，settings 路由如实透传，`.env` 钉 `true` 时页面显示「已启用」是应有行为——出货没有失效；失效的是**判据对部署方 `.env` 的环境耦合**（同 [[criterion-must-harden-its-own-root-not-read-the-deployers-dotenv]]、[[gap-voice-capture-criterion-hardened-root]] 一族：门按锚点的 environ 与检出跑判据，任何把裁决建在环境上的读数都会在别人手上翻面）。本条的硬化是「显式钉住读数依赖的键」，而不是像 AC-148 那样造一份删掉 `.env` 的硬链接副本——因为本条两态都是**显式值**（开=true / 关=false），不依赖「未设置」语义；若将来读数需要「未设置」那一半，须升级为 AC-148 的副本隔离。

**已知不等价点**：`PUBLIC_BASE_URL` 钉成本态 origin 后，(a) 的基址读数由判据决定；若真实部署想让设置页显示公网基址，那是 `PUBLIC_BASE_URL` 在部署侧被设成公网地址的行为，本条不覆盖。spec 仍为两态各起一份真实服务端 + Vite，成本不变。

## Touches

- e2e/mcp-settings.spec.ts
- tasks/gap-ac254-criterion-harden-against-repo-dotenv.md
