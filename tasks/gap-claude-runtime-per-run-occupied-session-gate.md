---
id: gap-claude-runtime-per-run-occupied-session-gate
title: 非 resident 每轮运行也拒绝被 Claude Code 后台任务占用的会话：先把 claude-runtime.provider.js
  迁成 TS（行为不变的独立一步），再在 queryClaudeSDK 里加占用检查
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-occupied-session-read-only-mode
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测）。`grep -il "occupiedBy\|session-occupied\|findBackgroundSessionOwner\|SessionOccupied" tasks/*.md` → 只命中 `gap-occupied-session-read-only-mode`（本条的上游，见 `depends_on`）；`ls tasks | grep -i migrat` → 只有三个 `gap-ac-0NN-criterion-repoint-to-migrated-test`（测试判据重指，与本条的运行时迁移无关）；没有任何任务认领 `claude-runtime.provider.js` 迁 TS。上游任务只做 **resident 路径**的启动前检查（提交 `1943cf9c`）与 UI 只读；本条补的是**非 resident（per-run）每轮运行**的服务端硬拒绝，机制不同：入口是 `queryClaudeSDK`，不是 `startResidentHost`。

**问题。** 一个被 Claude Code 后台任务（`kind: "bg"`）占用的会话，`claude --resume` 会以退出码 1 退出且只在 stderr 说明，而 per-run 路径同样丢弃 stderr（`claude-runtime.provider.js` → SDK 默认 spawn，stderr `ignore`），用户只看到不透明的 `Claude Code process exited with code 1`（`server.log` 里的 `[Chat] Provider runtime "claude" failed`）。上游任务让 UI 对被占会话只读，但 UI 禁用不是服务端保证：API、已打开的旧页面、定时/排队消息都能绕过它。per-run 路径需要和 resident 路径同样的服务端检查。

**为什么先迁 TS。** 这个入口在 `server/modules/providers/list/claude/claude-runtime.provider.js`（1612 行 JS）。`.agents/skills/backend-module-standards/SKILL.md` 要求「Use TypeScript for every file inside `server/modules/`」并且「When touched JavaScript utilities belong to the work, migrate them to TypeScript」。改它就必须先迁。`server/tsconfig.json` 现为 `allowJs: true, checkJs: false`，所以这 1612 行至今从未被类型检查；迁移会第一次让 tsc 检查它。因此分两步，**两步各自独立提交，顺序固定**：

**第 1 步：纯迁移，行为不变。** `git mv claude-runtime.provider.js claude-runtime.provider.ts`，只做让 `tsc` 通过所需的类型标注（参数/返回值用已有的共享类型，如 `AnyRecord`、`ProviderRuntimeWriter`、`ProviderRuntimeContext`；确实无法推断处才用最窄的显式类型，不用 `// @ts-nocheck`、不用裸 `any` 铺满全文）。**不改任何运行时语句**：不重排、不重命名、不顺手重构、不改导出名与导出集合（`claudeRuntime`、`queryClaudeSDK`、`abortClaudeSDKSession`、`isClaudeSDKSessionActive`、`getActiveClaudeSDKSessions`、`resolveToolApproval`、`getPendingApprovalsForSession`、`reconnectSessionWriter`、`extractTokenBudget`、`extractCumulativeTokenBudget`、`mapCliOptionsToSDK` 以及文件里其余 `export`）。所有 importer 现在用 `…/claude-runtime.provider.js` 说明符，TS 下该说明符照旧解析到 `.ts`（仓库其它 TS 文件已是这个写法），所以 importer 一行不用改。

**第 2 步：加占用检查。** 在 `queryClaudeSDK` 里、已解析出 `providerSessionId` 之后、创建 query/spawn 之前（仍在既有的 `try` 内，这样拒绝走与其它启动失败相同的「error 帧 + 终止 complete」出口，用户读到的是下面那句话而不是 `exited with code 1`），当 `providerSessionId` 非空且本轮真的会 `resume`（`!options.resumeFromScratch`）时，调用 `findBackgroundSessionOwner`，命中就以 `ClaudeSessionOccupiedError` 的 message 作为错误内容拒绝。文案沿用上游已定的句子：`该会话正由 Claude Code 后台任务占用（job <jobId>，pid <pid>），CloudCLI 无法接管。请先执行 claude stop <jobId> 停止它后重试，或 fork 该会话。`

**共享位置。** `findBackgroundSessionOwner`、`ClaudeBackgroundSessionOwner`、`ClaudeSessionOccupiedError` 现在在 `claude-host-driver.provider.ts`。第 2 步之后它们有两个使用处（resident 驱动与 per-run 运行时），按后端规范「utility used in at least two locations 进 `server/shared/utils.ts`」「type used in two or more locations 进 `server/shared/types.ts`」，要移到 `server/shared/`，带详细 doc comment 与分组注释，并把 `claude-session-occupancy.test.ts` 的 import 指向新位置。移动本身是行为不变的搬运，与第 2 步放在同一次提交里即可，但**不得**与第 1 步的迁移混在一起。

**不在本条范围。** `cursor-runtime.provider.js`、`opencode-runtime.provider.js`、`notification-orchestrator.service.js` 及其测试也是 `server/` 里的 JS，但它们不被本条触碰，迁移另算；占用检查只对 Claude provider 有意义（注册表是 Claude CLI 的）。UI 只读由上游任务负责。

## Plan

1. 等上游 `gap-occupied-session-read-only-mode` 完成：它也改 `claude-host-driver.provider.ts` 与 `claude-session-occupancy.test.ts`（整表读数），本条要搬动其中的函数，先后顺序固定以免冲突（这正是 `depends_on` 的原因）。
2. 提交 A（迁移）：`git mv` + 最小类型标注；`npm run typecheck`、`npm run lint`、`npm run test:server` 与迁移前基线逐项一致（基线读数在迁移前先跑一遍并记录：测试总数、通过数）。导出集合前后一致用脚本机械比对（见 AC2）。
3. 提交 B（占用检查）：先写失败的测试（per-run 路径对被占会话仍会 spawn ⇒ 红），再加检查转绿；把共享定义搬进 `server/shared/`。
4. 真实读数：对一个真实 `claude --bg` 占用的会话，经临时服务实例（不重启 :3001）发一条 per-run 消息，逐字记录收到的 error 帧文案；`claude stop` 后再发一条，确认正常进入运行。

## AC

- [ ] AC1 迁移提交是纯迁移：`git log --diff-filter=R --name-status` 显示存在一次提交把 `server/modules/providers/list/claude/claude-runtime.provider.js` 重命名为 `.ts`（`R`），且该提交里 `git diff -M --stat <该提交>^ <该提交>` 只含这个重命名文件与（如确需）`server/shared/types.ts` 的类型补充；该提交不含任何 `claude-host-driver.provider.ts` 或 `server/shared/utils.ts` 的改动。
- [ ] AC2 导出集合不变：对迁移提交前后的该文件，分别用 `node --experimental-strip-types`/`tsx` 动态 import 并取 `Object.keys(module).sort()`，两份列表逐字相同（`diff` 退出 0），`console.log` 出导出个数。
- [ ] AC3 迁移不改运行时语句：对迁移提交前后的文件各自剥离类型（`tsc --target esnext --module esnext --removeComments false` 的 JS 输出，或 `esbuild --loader:.ts=ts` 输出）后与原 JS 经同样格式化比对，差异只允许是类型标注引起的行；差异计数打印出来，并在迁移提交说明里逐字贴出。如机械比对不可行，退一步：迁移前后 `npm run test:server` 的总数与通过数逐项相同（打印两份读数）。
- [ ] AC4 静态门：`npm run typecheck` 与 `npm run lint` 退出 0；`grep -rn "@ts-nocheck\|@ts-ignore" server/modules/providers/list/claude/claude-runtime.provider.ts` → 0 命中；`find server/modules -name "claude-runtime.provider.js"` → 空。
- [ ] AC5 占用检查生效（承重）：新增测试 `server/modules/providers/tests/claude-per-run-occupied-session.test.ts`（新建）用临时 `CLAUDE_CONFIG_DIR` 写入一条 `kind:"bg"`、活 pid、sessionId 相同的注册表行，驱动真实 `queryClaudeSDK`（SDK `query` 以假替身注入，计数其被调用次数）：命中时 `writer` 收到的 error 帧文案含 `claude stop <jobId>` 与 `fork`、随后一个终止 complete 帧、替身 `query` **调用 0 次**；该测试在 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-per-run-occupied-session.test.ts` 下退出 0。
- [ ] AC6 不命中的对照成对：同一测试文件里，把注册表行改成 `kind:"interactive"` / 他会话 sessionId / 已死 pid / 缺失 `providerSessionId`（全新会话）/ `resumeFromScratch: true` 这五种之一，替身 `query` 都**被调用 1 次**且无占用错误帧——证明检查不是「一律拒绝」。
- [ ] AC7 取假形态必须红：（a）检查放在 `try` 之外使拒绝变成未处理的 rejection 而不是 error 帧；（b）只在 resident 驱动里检查、per-run 里不检查；（c）检查放在 query 创建之后（spawn 已发生）——三条变异各自让 AC5 对应断言逐字红；登记变异 diff、逐字失败行与 `git checkout --` 恢复命令，恢复后 `git status` 干净。
- [ ] AC8 共享位置合规：`grep -n "export function findBackgroundSessionOwner\|export type ClaudeBackgroundSessionOwner\|class ClaudeSessionOccupiedError" server/shared/utils.ts server/shared/types.ts` 各命中 1 处且带 doc comment；`grep -rn "findBackgroundSessionOwner" server --include=*.ts` 中，除 `server/shared/utils.ts` 的定义外，resident 驱动与 per-run 运行时是仅有的两个使用处；`claude-session-occupancy.test.ts` 仍绿。
- [ ] AC9 范围限定：`git diff --name-status develop...HEAD` 只出现在 Touches 列出的文件里（新增文件用 ASCII `(new)`）。

## DoD

- 真实对象走过真实机制：用一个真实的 `claude --bg` 后台任务占住一个已同步进列表的、**per-run** 模式的会话；在 :3001 之外的临时服务实例上（不重启 :3001）经真实的 websocket chat 路径发一条消息，逐字记录收到的 error 帧（应含该 job 的 `claude stop <jobId>`），并确认没有新的 `claude` 子进程被 spawn（对比发送前后同会话 `ps`）；再 `claude stop <jobId>`，同一会话再发一条消息，正常开始一轮。临时实例与后台任务事后清理。
- 迁移与行为变更是**两个独立提交**，`git log --oneline` 里迁移提交在前；迁移提交的说明里贴出 AC2/AC3 的比对读数。
- 遵守 `.agents/skills/backend-module-standards/SKILL.md`：文件在 `server/modules/providers/` 内保持 TS、跨模块只经 barrel、共享定义进 `server/shared/{types,utils}.ts` 并带 doc comment 与分组注释、每个导出带「谁消费它」注释。
- 结果覆盖 per-run 与 resident 两条服务端路径：两处用的是同一个 `findBackgroundSessionOwner` 与同一句文案，没有第二份判定逻辑。

## Touches

- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/list/claude/claude-runtime.provider.ts (new)
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/shared/utils.ts
- server/shared/types.ts
- server/modules/providers/tests/claude-session-occupancy.test.ts
- server/modules/providers/tests/claude-per-run-occupied-session.test.ts (new)
- tasks/gap-claude-runtime-per-run-occupied-session-gate.md
