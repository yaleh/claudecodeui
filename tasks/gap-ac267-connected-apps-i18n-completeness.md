---
id: gap-ac267-connected-apps-i18n-completeness
title: AC-267 已连接的应用与 OAuth 客户端区块文案在全部 12 种语言里齐全：判据
  src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts 遍历
  locales/*/settings.json 的 glob，connectedApps + oauthClients 必需键 + 与 en 键集合完全一致
  + 正例对照，取假形态两条（删键/值=键名）必须红
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac266-connected-apps-settings-browser-ui
goal_ac: AC-267
---
## Proposal

AC-267（GOAL-021 退出条件 6 的第三半；SPEC `docs/proposals/mcp-gateway-SPEC.md`（v3.1）§483–§485「已连接的应用 / OAuth 客户端（高级）」、§511 阶段 5）要求「已连接的应用」与「OAuth 客户端（高级）」两个设置区块的文案在全部 12 种语言里齐全：缺任何一种语言的任何一个键都不能通过，也不能把键名当文案渲染出来（react-i18next 会把缺失的键按原名渲染，这正是要防的「显示成原始键名」）。判据文件路径由 AC 钉死为 `src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts`，命令 `for f in src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx vitest run src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts`。

现状（红态基线）：判据文件不存在，存在性闸以退出码 1 逐字输出 `缺判据文件：src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts`（已实测：`src/modules/settings/tests/` 无本文件）。12 个 `locales/*/settings.json` 目前都**没有** `connectedApps` 也没有 `oauthClients` 顶层键（逐语言实测 `connectedApps=false oauthClients=false`），且 `src/modules/settings/` 内当前没有任何 `connectedApps.`/`oauthClients.` 消费者——两命名空间与消费它们的组件由 AC-266 一并交付。

做法照 AC-229（`gap-ac229-access-tokens-i18n-completeness`，goal_ac: AC-229；判据 `src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts`）。本任务只拥有**完整性判据**，不拥有 UI、不拥有 locale 文案（AC-266），frontmatter 的依赖字段把它串在 AC-266 之后。

要交付：

1. 判据 `src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts`（vitest，只读文件系统；形制照 `src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts`，**不硬编码语言清单**，从 vitest 进程 cwd 解析——jsdom 下 `import.meta.url` 不是 file: URL）：

```ts
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');
const REFERENCE_LOCALE = 'en';
const REQUIRED_CONNECTED_APPS_KEYS = [
  'title', 'description',
  'list.empty', 'list.redirectHost', 'list.scopes', 'list.createdAt',
  'list.lastUsed', 'list.never', 'list.revokeButton', 'list.revokeConfirm',
] as const;
const REQUIRED_OAUTH_CLIENTS_KEYS = [
  'title', 'description', 'newButton',
  'form.namePlaceholder', 'form.redirectUrisPlaceholder', 'form.createButton', 'form.cancelButton',
  'newClient.alertTitle', 'newClient.alertMessage', 'newClient.copy', 'newClient.iveSavedIt',
  'list.empty', 'list.redirectHost', 'list.createdVia', 'list.dcr', 'list.manual',
  'list.active', 'list.disabled', 'list.disableButton', 'list.disableConfirm',
] as const;
```

> **常量基准（收窄纪律）**：上列键是 AC-266 任务体点名的应交付键集。落地时以**实际消费者**为准——`grep -rn 'connectedApps\.\|oauthClients\.' src/modules/settings/` 的真实 UI 契约即常量；若 AC-266 实际交付的键集不同（多一个少一个或改名），把常量更新为实际契约并在 `## 完成记录` 逐字写出差异（照 AC-229 的收窄注），**不**往 12 个 locale 塞没有消费者的死键。

   - 枚举：`readdirSync(LOCALES_DIR, { withFileTypes: true })` 取目录名排序，与 `globSync('*/settings.json', { cwd: LOCALES_DIR }).sort()` 两个独立枚举必须逐一相等（掉一个目录或截断的 glob 都会破），目录数 ≥ 12。
   - 读数 (a)：一个可参数化的检查器 `namespaceProblems(namespace, requiredKeys): string[]`（空数组=通过）。缺键、非字符串、空串、值等于键名本身（叶名或 `<namespace>.<path>` 全路径）各出一条原因；对 `connectedApps` 与 `oauthClients` **两个命名空间各自**对每个 locale 收 `file: namespace: reason` 到 offenders，断言 `[]`，并写下每种语言每个命名空间的扁平键数。
   - 读数 (b)：对每个 locale、**每个命名空间**分别展平为点分排序键集合，断言与 `en` 同命名空间集合**完全相等**（两侧差集皆空）；写下 en 两个键集合与每个语言对 en 的差集读数。
   - 读数 (c) 正例对照（同一次运行、同一检查器）：`namespaceProblems({}, REQUIRED_CONNECTED_APPS_KEYS)` 必须逐个报出全部必需键缺失；一个只缺 `connectedApps.list.revokeButton` 的合成 bundle 必须只报这一条；一个完整合成 bundle 返回 `[]`；`oauthClients` 同样三态；再各补一条「值=叶名」「值=全路径」「空白值」的臂。
   - 判据只读文件系统，不 import 任何 app 模块，零墙钟、零网络、零渲染。

2. 12 个 locale 的 `connectedApps` 与 `oauthClients` 命名空间：由 AC-266 交付。正常路径下本任务**不重写 locale**，只核验其键集合与 en 一致。若 AC-266 未覆盖某必需键（异常路径），先在 `task_write` 把相应 locale 文件加进 `## Touches` 再补齐（避免与其并发写同一文件）。

取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：
(i) 从任一语言（例：`de/settings.json`）的 `connectedApps.list` 删掉一个键（例 `revokeButton`）⇒ (a) 与 (b) 必须红（缺键 + 与 en 集合不等）；
(ii) 把任一语言（例：`fr/settings.json`）的 `oauthClients.title` 值改成键名本身（`title` 或 `oauthClients.title`）⇒ (a) 必须红。
每条记录恢复命令与恢复后重跑绿。

<!-- dedup-ref -->
关联（非重复，mechanism 去重已核对）：`grep -rlE '^goal_ac:[[:space:]]*AC-267[[:space:]]*$' tasks/` 为空——本仓库无任何任务带 AC-267；`grep -rln 'AC-267' tasks/` 只命中 AC-264/265/266 的越界声明句（各自明确把「文案完整性判据」让给 AC-267）。`gap-ac266-connected-apps-settings-browser-ui`（goal_ac: AC-266，todo）做前端「已连接的应用 / OAuth 客户端（高级）」区块并同时补齐这 12 个 `settings.json` 的两命名空间键，其任务体写明「AC-267 拥有完整性判据、以本任务的实际键集为基、正常路径下只核验不重写」；本任务已用顶层依赖字段把它声明为前置并串在其后。AC-229（同类判据，不同命名空间 `accessTokens`/不同文件）与 AC-228 是**先例**（形制复用），不是重复。本任务只拥有 `connectedApps`/`oauthClients` 的完整性判据。

边界：不改前端组件与 UI 结构（AC-266）；不改后端任一 OAuth 机制（AC-258–AC-265）；不实现文案本体（AC-266 交付）；不写 e2e（AC-266 的浏览器判据）与服务端端到端（AC-268）。

判定纪律：判据遍历 `locales/*/settings.json` 的 glob 而不是硬编码 12 个语言名，从 vitest 进程的 cwd 解析；(a) 的必需键由判据内两份独立常量声明（非从 `en` 推导），(b) 用真实文件集合对 `en` 做集合相等，不是「我看了」；正例对照与两条取假形态证明检查器能变红，而不是恒绿的常量自证。

## AC

- [ ] AC1 判据文件存在且绿：`for f in src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx vitest run src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts` 退出 0。逐字记录红态基线（改动前存在性闸退出码 1 并打印缺失文件名）。
- [ ] AC2 (a) 12 语言 `connectedApps` 与 `oauthClients` 必需键齐全：对每种语言、每个命名空间，常量里的每个键都存在、值为非空字符串、且不等于键名本身（叶名或全路径）；写下每种语言每个命名空间的扁平键数与 offenders 计数（=0）。
- [ ] AC3 (b) 键集合与 en 完全一致：每种语言的 `connectedApps` 与 `oauthClients` 展平点分键集合分别与 `en` 同命名空间集合相等（差集两侧皆空）；写下 en 两个键集合与每个语言的差集读数。
- [ ] AC4 (c) 正例对照同一次运行：`namespaceProblems({}, …)` 对两命名空间各报出全部必需键缺失；只缺一个键的合成 bundle 只报这一条；完整合成 bundle 返回 `[]`；空白/值=叶名/值=全路径三臂各一条。写下读数。
- [ ] AC5 遍历是 glob 且两枚举一致：`readdirSync` 目录名与 `globSync('*/settings.json')` 逐一相等，目录数 ≥ 12；写下两个枚举。不得出现硬编码语言清单。
- [ ] AC6 12 个 locale 的两命名空间就位：核验各 `settings.json` 的 `connectedApps`/`oauthClients` 键集合与 en 一致；若 AC-266 已交付则以其为基、缺键按边界纪律扩展 Touches 后补齐；写下实际写入的文件清单（正常路径为空）。
- [ ] AC7 取假形态两条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 删一种语言的一个键 ⇒ 含 (a) 与 (b) 的用例红；(ii) 某语言的值写成键名本身 ⇒ (a) 红。每条记录恢复命令与恢复后重跑绿。
- [ ] AC8 仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级）；判据在 `src/modules/settings/tests/`、用 `@/` 导入（不 import app 模块则无跨模块导入）；写明各命令退出码与 lint error 计数。
- [ ] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件（仅可能是 locale 文件），先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 判据文件真的存在且真跑绿：`npx vitest run src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts` 退出 0，且覆盖 (a)(b)(c)。
- 齐全性是真的对磁盘上的 locale 文件读出来的：12 个目录与 glob 两枚举一致（不硬编码语言清单），每种语言的 `connectedApps` 与 `oauthClients` 必需键齐全、值非空非键名，且两命名空间的键集合分别与 `en` 相等，读数来自真实 JSON 而不是常量自证。
- 「不能显示成原始键名」真的被机械守护：值=键名（叶名/全路径）在 (a) 被逐条拒绝，且取假形态 (ii) 先把叶名塞进某语言再红。
- 检查器能变红：同一次运行的正例对照（缺键合成 bundle 报出缺失原因）与两条取假形态（删键 ⇒ (a)(b) 红；值=键名 ⇒ (a) 红）都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 12 种语言真的都有两个区块的文案（不是只有 en）——这就是 AC-267 的机械守护；文案本体由 AC-266 交付，本任务只守护其完整性。
- 遵守 `$frontend-module-standards`（测试在 `src/modules/settings/tests/`、`@/` 导入、无 interface、只读文件系统不引入状态）与 AGENTS.md；不越界实现 AC-258–AC-266、AC-268。

## Touches

- src/modules/settings/tests/i18nConnectedAppsCompleteness.test.ts (new)（判据）
- tasks/gap-ac267-connected-apps-i18n-completeness.md

## Notes

- 常量以 AC-266 实际交付的消费者键集为准（AC-266 任务体已列应交付键集，并声明字段名以实际契约为准）；若实际不同，按实际更新常量并逐字记录差异（照 AC-229 收窄注），不改 locale 语义。
- 若 AC-266 实际把文案放在别的文件/命名空间命名下，以实际为准并更新本任务正文、判据与 `## Touches`。
- 判据是本任务的机械读数，文件即 AC-267 `criterion:` 所点名的那个；不新建第二个判据文件。
- 内存提示：`test-sh-counts-files-not-tests`、`vitest-jsdom-import-meta-url-is-not-a-file-url`（从 cwd 解析 locales 目录）、`quay-touches-must-match-actual-write-sites`、`quay-self-touch-c8-needs-own-task-file-in-touches`。
