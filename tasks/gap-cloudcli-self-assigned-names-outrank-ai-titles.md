---
id: gap-cloudcli-self-assigned-names-outrank-ai-titles
title: 会话命名权归人工与 Claude Code：CloudCLI 自赋名不得压过 AI title、不得自行赋名、且跨重启幂等
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

人 yale 2026-09-30 就会话命名定下三条原则，本条按这三条把现状量了一遍——**三条今天全部被违反**，其中规模最大的一处不在常驻，而在 quay driver 给每个 worker 传的角色名上。

**原则（逐字）**
1. 人类手工设置的名称优先级最高，然后是 AI title，然后才应使用 CloudCLI 自动生成的标题。
2. 在 Claude Code 和 CloudCLI 之间，名称应保持一致。以 Claude Code 为准：CloudCLI 要修改会话名，应使用 Claude Code 的 API/CLI 执行，执行后依然以 Claude Code 提供的名称为准。
3. 名称应当保持稳定。CloudCLI 应避免在没有人工操作要求的情况下自行给会话赋名。

**现状（全部为 2026-09-30 在本机实测的读数，不是推断）**

- **档位表与原则 1 正好相反。** 同步器的转录阶梯是 `agent-name` > `custom-title` > `ai-title`（`server/modules/providers/list/claude/claude-session-synchronizer.provider.ts:533-540`），落库的优先级表同序：`agent`=3 / `manual`=2 / `ai`=1 / 其余=0（`server/modules/database/repositories/sessions.db.ts:208` 的 `nameSourceRankSql`），读取侧是 `COALESCE(custom_name, transcript_name)`（同文件 `:158`）。而 **CloudCLI 自己给的 `--name` 恰好同时写成 `custom-title` 与 `agent-name` 两条**（实测：每次 `--name` 都成对写入），于是 CloudCLI 自赋名占的正是最高档。
- **规模：1513/1643 行的显示名是工具自赋名，只来自 35 个字符串。** 按 `created_at` 分组，`transcript_name_source='agent'` 从 2026-09-23（`022cda53`「the session title reader mirrors the CLI's own ladder」）起变成压倒性多数。当前分布：`agent` 1513、`ai` 105、`derived` 21、`manual` 4。agent 那 1513 行里出现次数最多的：`claudecodeui-selector` ×256、`claudecodeui-task-worker` ×256、`quay-task-worker` ×209、`quay-selector` ×207、`quay-pool-judge` ×196、`claudecodeui-fix-worker` ×171。来源是 driver 的角色名：`.quay/profiles.yml:43-84` 的 `claudecodeui-manager/-outer/-task-worker/-selector/-fix-worker/-pool-judge/-meta-driver`，由 driver 以 `-n <role>` 传给每个 worker 进程。
- **AI title 被压掉是可以逐条指名的。** 转录里同时有 `ai-title` 与自赋名的会话共 10 行（8 行 per-run + 2 行 resident），例如：
  - `0c7f9f5e-9955-4048-aeab-4db277758179`（app 会话 `edb5ead0`）：`ai-title` = `Archguard 架构分析`，显示名 = `archguard-架构分析-edb5ea-edb5ea`。
  - `e046a544-29b0-4911-bcf8-f20caf19dd4b`（app 会话 `cbcdc20d`）：`ai-title` = `Author/develop 分支发布到 GitHub`，显示名 = `author-develop-分支发布到-github-cbcdc2-cbcdc2`。
  另有 25 行是 `agent-name`+`ai-title` 但尚未重新同步（重同步后同样会落到 agent 档）。
- **原则 3 的「稳定」也没做到：自赋地址每次重启再长一段。** 常驻 driver 的 `residentPeerName()`（`server/modules/providers/list/claude/claude-host-driver.provider.ts:835-847`，调用点 `:2680`）= `slug(标题) + '-' + appSessionId.slice(0,6)`，而它的「标题」入参是前端 `chat.send` 带过来的 `sessionSummary`，取的是**该会话当前的显示名**（`src/modules/chat/hooks/useChatComposerState.ts:157-169`；会话还没有名字时退化成消息文本裁到 77 字符）。第 3 步把名字写成 `agent-name`，第 4 步又把它读成显示名 ⇒ 下一次启动再 slug 一次、再追加一段。实测累加次数：`542278` ×4、`804925` ×3、`2329027` ×2、`2018193` ×2；后缀逐字等于 app 会话 id 前 6 位（`5815bbcd…`→`-5815bb`，`edb5ead0…`→`-edb5ea`）。即 `residentPeerName` 在自己的输出上不幂等。
- **原则 3 的「不自赋名」还有第二处。** `buildCloudCliSessionName`（`server/modules/providers/services/sessions.service.ts:78-81`，调用点 `:306`）给每个 App 新建会话取首条消息前 4 个词当名字。它落在 `transcript_name` / `derived`（`createAppSession`，`sessions.db.ts:439-442`），档位最低，本身不违反原则 1；但它确实是「无人工要求自行赋名」，要不要保留由原则 3 裁量。
- **原则 2 的「改名走 Claude Code」已经做到，但结果被 `--name` 吃掉。** App 改名走 SDK 的 `renameSession`（`server/modules/providers/list/claude/claude-rename.provider.ts`），这条符合原则 2。可是该文件自己的注释逐字写着：CLI 的阶梯把 `agentName` 排在 `customTitle` 之上，所以**对任何带 `agent-name` 的会话，人工改名不会改变 Claude Code 侧显示的名字**。这条取舍是前一条任务 `gap-session-rename-writeback`（done）登记在案的；本条的 AC 要把它翻过来。
- **附带第三个症状（属于同一机制）：地址读回取的是最旧那条。** `readTranscriptAgentName`（`claude-host-driver.provider.ts:1096-1129`）返回文件里**第一条** `agent-name`，而 `startIdentityReadback` 的守卫（`:2984-3020`）拿它和本次启动名比对 ⇒ 只要重启过一次就必然不等 ⇒ 守卫按设计上报 `null`。`server.log` 里今天有 8 条 `Resident process registered a different address than it was launched with`（例：`launched: '语音输入刚发生-502-错误-请检查-d861e1-d861e1-d861e1'` vs `registered: '语音输入刚发生-502-错误-请检查-d861e1'`）。即 AC-164 承诺的「稳定 SendMessage 地址」在任何重启过的常驻会话上都是空的，UI 的「复制 SendMessage 地址」拿不到东西。

**设计张力（实现者必须正面处理，不许绕）**

在 Claude Code 的阶梯里，「地址」与「标题」是同一个槽位：任何 `--name` 都会成为该会话显示的名字。所以「CloudCLI 要一个稳定地址」与「CloudCLI 不自赋名／人工与 AI title 优先」在今天**不能同时成立**。可选的出路只有三条，本条要求实现者选一条并在 `docs/proposals/` 里写清取舍：

- (a) **不自赋名**：常驻启动不再传 `--name`。地址退回 CLI 每进程随机派生 ⇒ 放弃稳定寻址（AC-164 的产品承诺要一并修订）。
- (b) **自赋名等于 Claude Code 已有的名字**：`--name` 取该会话在 Claude Code 侧的最高优先名（人工名 > ai-title），不加自造后缀。名字稳定且一致，代价是两个同名会话的地址会撞（需要另想区分手段，例如只用 id 做区分而不用标题）。
- (c) **保留自造地址**（形如 `<slug>-<id6>`），但由 App 侧把它排在 `ai` 之下显示，并接受 App 显示名与 Claude Code 列表名不一致。这一支**直接违反原则 2**，因此必须由人 yale 逐字裁定后才可实施。

**非目标**：不改 Claude Code 自身的阶梯（读的是编译产物里的 `agentName || customTitle || aiTitle || …`，那是上游契约）；不动 `gap-session-name-source-ai-title`（done）落的 `custom_name`/`transcript_name` 两列拆分本身；不动 quay driver 的角色名机制（那是建 (a)/(b) 之后才谈得上的下游）。

## Plan

1. **先定出路并留痕**：(a)/(b)/(c) 三选一，写进 `docs/proposals/claude-resident-sessions.md` 的 §12（该节今天逐字承诺「稳定的 peer 名」），并把人 yale 的裁定逐字登记进本任务记录（见 AC 的最后一条）。
2. **判据文件先行**：新建 `server/modules/providers/tests/claude-session-name-authority.test.ts`，做法照既有 `server/modules/providers/tests/claude-session-title-source.test.ts`（真实 jsonl 夹具 + 真实临时 sqlite 跑真实同步器）。先取红态，再动产品代码。
3. **档位表与阶梯**：把「CloudCLI 自赋」从 `agent` 档里分出来（新增 provenance 值，如 `self-assigned`，写在 `server/modules/database/schema.ts` 与 `server/modules/database/migrations.ts`，迁移须幂等），`nameSourceRankSql` 与 `extractSessionTitle` 的阶梯同步改为 人工 > ai > 自赋 > derived。
4. **幂等**：`residentPeerName` 的入参不得是它上一次的输出——按选定的出路 (a)/(b)/(c) 处理。
5. **读回取最新**：`readTranscriptAgentName` 返回最后一条 `agent-name`；守卫在重启后仍能拿到本次启动名，`GET /api/session-hosts` 的 `peerName` 非空。
6. **清理既有残留**：库里已被自赋名污染的行要在迁移里重新落到 `ai`（有 ai-title 的）或 `derived`（没有的）；已累加的名字不得作为下次重算的种子。
7. **假形态与反回归**：两条假形态（见 AC）必须红；既有判据逐条不退。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-name-authority.test.ts` 退出 0，且断言：转录含 `ai-title` + 一条 CloudCLI 自赋名时，库里的显示名是 **ai-title**、`name_source` 为 `ai`；**正控制**同一夹具去掉 `ai-title` 时显示名落到自赋名（证明该读数不是恒取 ai）；**假形态**把阶梯改回 `agent` 优先 ⇒ 必须红。
- [ ] 同一文件断言人工名最高：写入 `custom_name` 的会话，即使转录里同时有 `agent-name` 与 `ai-title`，显示名仍是人工名；且经真实 `renameSessionById` 后，**Claude Code 侧列出的名字**也是人工名（读回转录按 CLI 阶梯判定，或按选定出路证明 `--name` 不再压过它）。**假形态**：人工名被自赋名覆盖 ⇒ 必须红。
- [ ] 同一文件断言幂等：对同一 app 会话连续两次常驻启动（mock SDK 流），两次交给 CLI 的 `--name` **逐字相同**，且名字里 `<会话 id 前 6 位>` 只出现 **1** 次。**假形态**：恢复「拿当前显示名当入参」⇒ 第二次必须红。
- [ ] 同一文件断言读回取最新：转录里按序有 3 条 `agent-name` 时读回的是**最后**一条；重启后 `GET /api/session-hosts` 投影里该绑定的 `peerName` 非空且等于本次启动名。**假形态**：读回改成取第一条 ⇒ 必须红。
- [ ] 同一文件断言迁移幂等：对已有被污染行的旧库连跑两次迁移，第一次把有 `ai-title` 的行改回 `ai`、无 `ai-title` 的改成 `derived`，第二次无操作；已累加的名字不再作为种子。
- [ ] 「CloudCLI 不得自行赋名」在代码里有机械落点：`buildCloudCliSessionName` 或任何 CloudCLI 自造名不得进入高于 `ai` 的档位。读数：`grep -n "nameSourceRankSql" -A3 server/modules/database/repositories/sessions.db.ts` 与新增 provenance 值的档位断言。
- [ ] 人 yale 对「CloudCLI 是否可自赋名（出路 a/b/c 选哪条）」的逐字裁定存在于本任务记录中（机械读数：本文件内存在该裁定行）；该行缺席时本任务不得 done。
- [ ] 既有判据逐条退出 0 且文件未改：`server/modules/providers/tests/claude-session-title-source.test.ts`、`…/claude-resident-addressable.test.ts`、`…/claude-host-per-run.test.ts`、`…/claude-background-work.test.ts`、`server/modules/session-hosts/tests/session-hosts-routes.test.ts`、`server/modules/database/tests/sessions-name-source.integration.test.ts`、`server/modules/providers/tests/session-rename-route.test.ts`、`server/modules/providers/tests/claude-session-title-corpus.test.ts`、`server/modules/providers/tests/claude-session-title-mirror.test.ts`。逐条打印命令与退出码。
- [ ] `npm run typecheck` 退出 0（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三条链）且 `npm run lint` 退出 0（仅既有 warning）。
- [ ] 落地后实测复查：`sqlite3 ~/.cloudcli/auth.db "select transcript_name_source, count(*) from sessions group by 1"` 里 `agent` 档不再是 1513 这一量级（自赋名已分档），且 `grep -c "registered a different address" server.log` 在新启动的常驻会话上不再增长。

## DoD

在真实运行的 CloudCLI（`dist-server/server/index.js`，端口 3001）上，一个会话从「新建 → 被常驻启动 → 人在 App 里改名 → 关进程 → 重新启动」走完一遍，逐点读数为：侧栏与聊天头的显示名始终是人工名（改名后）或 AI title（未改名时），**不是** `<slug>-<id6>`；Claude Code 侧（`claude --resume` 列表 / peer 注册名）看到的是同一个名字；重启前后 `GET /api/session-hosts` 的 `peerName` 逐字相同且非空；`~/.claude/projects/**/<session>.jsonl` 里同一进程生命周期内只注册一个地址，重启后不出现重复后缀。只做到「测试绿」不算数：必须有一个真实会话被这样操作过，且四条读数都被打印出来。

## Touches

- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
- server/modules/providers/list/claude/claude-rename.provider.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/database/repositories/sessions.db.ts
- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/providers/tests/claude-session-name-authority.test.ts (new)
- src/modules/chat/hooks/useChatComposerState.ts
- docs/proposals/claude-resident-sessions.md
- tasks/gap-cloudcli-self-assigned-names-outrank-ai-titles.md
