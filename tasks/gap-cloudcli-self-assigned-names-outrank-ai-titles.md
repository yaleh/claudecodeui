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

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-name-authority.test.ts` 退出 0，且断言：转录含 `ai-title` + 一条 CloudCLI 自赋名时，库里的显示名是 **ai-title**、`name_source` 为 `ai`；**正控制**同一夹具去掉 `ai-title` 时显示名落到自赋名（证明该读数不是恒取 ai）；**假形态**把阶梯改回 `agent` 优先 ⇒ 必须红。
- [ ] 同一文件断言人工名最高：写入 `custom_name` 的会话，即使转录里同时有 `agent-name` 与 `ai-title`，显示名仍是人工名；且经真实 `renameSessionById` 后，**Claude Code 侧列出的名字**也是人工名（读回转录按 CLI 阶梯判定，或按选定出路证明 `--name` 不再压过它）。**假形态**：人工名被自赋名覆盖 ⇒ 必须红。
- [ ] 同一文件断言幂等：对同一 app 会话连续两次常驻启动（mock SDK 流），两次交给 CLI 的 `--name` **逐字相同**，且名字里 `<会话 id 前 6 位>` 只出现 **1** 次。**假形态**：恢复「拿当前显示名当入参」⇒ 第二次必须红。
- [x] 同一文件断言读回取最新：转录里按序有 3 条 `agent-name` 时读回的是**最后**一条；重启后 `GET /api/session-hosts` 投影里该绑定的 `peerName` 非空且等于本次启动名。**假形态**：读回改成取第一条 ⇒ 必须红。
- [x] 同一文件断言迁移幂等：对已有被污染行的旧库连跑两次迁移，第一次把有 `ai-title` 的行改回 `ai`、无 `ai-title` 的改成 `derived`，第二次无操作；已累加的名字不再作为种子。
- [x] 「CloudCLI 不得自行赋名」在代码里有机械落点：`buildCloudCliSessionName` 或任何 CloudCLI 自造名不得进入高于 `ai` 的档位。读数：`grep -n "nameSourceRankSql" -A3 server/modules/database/repositories/sessions.db.ts` 与新增 provenance 值的档位断言。
- [x] 人 yale 对「CloudCLI 是否可自赋名（出路 a/b/c 选哪条）」的逐字裁定存在于本任务记录中（机械读数：本文件内存在该裁定行）；该行缺席时本任务不得 done。
- [x] 既有判据逐条退出 0 且文件未改：`server/modules/providers/tests/claude-session-title-source.test.ts`、`…/claude-resident-addressable.test.ts`、`…/claude-host-per-run.test.ts`、`…/claude-background-work.test.ts`、`server/modules/session-hosts/tests/session-hosts-routes.test.ts`、`server/modules/database/tests/sessions-name-source.integration.test.ts`、`server/modules/providers/tests/session-rename-route.test.ts`、`server/modules/providers/tests/claude-session-title-corpus.test.ts`、`server/modules/providers/tests/claude-session-title-mirror.test.ts`。逐条打印命令与退出码。
- [x] `npm run typecheck` 退出 0（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三条链）且 `npm run lint` 退出 0（仅既有 warning）。
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
- server/modules/database/index.ts
- server/modules/providers/tests/claude-session-name-authority.test.ts (new)
- src/modules/chat/hooks/useChatComposerState.ts
- docs/proposals/claude-resident-sessions.md
- tasks/gap-cloudcli-self-assigned-names-outrank-ai-titles.md


## Evidence（worker 2026-09-30）

**本任务卡在人证一关（AC7）：未做实现，故 AC1–AC6、AC8–AC10 一律未勾。** AC7 要求人 yale 就出路 (a)/(b)/(c) 给出逐字裁定。截至本次派发，该裁定在任务记录、`docs/proposals/claude-resident-sessions.md` §12、`adr/`、gate-events 中均不存在（已逐处查过）。任务的 Plan 第 1 步把「先定出路并留痕」排在判据文件之前，故裁定落地前动手实现，等同于替人猜设计——故不实现。

**为什么不能直接实现（供裁定者用）：** 其一，现有 `server/modules/providers/tests/claude-session-title-mirror.test.ts` 逐字断言转录里 `agent-name`（值 `The Agent That Owns This`）→ 库内 `name_source='agent'`（rank 3），而该文件被 AC8 钉死「未改且退 0」；`claude-session-title-corpus.test.ts` 同样以 CLI 阶梯 `agentName || customTitle || aiTitle || …` 为基准。所以修法不能是「把转录里的 agent-name 一律降档」。其二，要在不碰这两条的前提下让 ai-title 压过 CloudCLI 自赋名（AC1），同步器必须能区分「CloudCLI 自己写的 agent-name」与「真正的 agent-name」；任务书未给这个判别式，且它与出路强耦合：(a) 常驻不再传 `--name`（新会话不再有自赋名，只剩历史行待迁移）；(b) `--name` 取 Claude Code 侧最高优先名（自赋名与 ai-title 同串，二者不再相争）；(c) 保留 `<slug>-<id6>` 形状（需要判别式，且直接违反原则 2，必须人裁定）。其三，AC3（名字里 id6 只出现 1 次）读起来只与 (c) 的形状相容，而 (c) 未经裁定不可实施——AC3 与 AC7 因此互相咬合。

**建议（供裁量，非实施）：** 出路 (b) 同时满足三条原则且不牺牲 AC-164 的稳定寻址——`--name` 取该会话在 Claude Code 侧的最高优先名（人工名 > ai-title），不加自造后缀；两个同名会话的区分改由 id 承担。历史污染行按「转录名等于 `<任意前缀>-<本 app 会话 id 前 6 位>`」的形状在迁移里回落到 ai（有 ai-title）或 derived（无）。若 yale 选 (a)，需连带把 AC-164 的「稳定 SendMessage 地址」产品承诺一并修订。

**裁定行（必须由人 yale 逐字写，执行者不得代写；建议格式）：** `出路裁定（yale，2026-09-30）：…`

**与出路无关、本次已核实的旁证：** `nameSourceRankSql` 为 `agent=3 / manual=2 / ai=1 / else=0`（`server/modules/database/repositories/sessions.db.ts:207-209`）；同步器阶梯 `agent > manual > ai > derived`（`claude-session-synchronizer.provider.ts:533-546`）；`buildCloudCliSessionName`（`services/sessions.service.ts:78-81`）落 `derived`，今日已低于 `ai`，即 AC6 的「档位」部分当前成立。附带症状三（`readTranscriptAgentName` 取文件里第一条，`claude-host-driver.provider.ts:1096-1129`）与出路无关，是纯缺陷，但它的判据（AC4）要求落在本任务同一份新判据文件、且被 AC8 保护的 `claude-resident-addressable.test.ts` 也读同一路径，故一并留待裁定后实现。本轮 `scripts/test.sh --for-task … --allow-thin` 因分支无 delta 判 thin、exited 0；未写 scoped-gate 缓存——人证未过时该轮按设计走 exited-not-landed，fan-in 不会被 spawn。




## 人 yale 的裁定（2026-09-30，逐字）

「优先明确 Claude Code 的机制并遵循。在会话名称这方面（尤其是 resident session），把 CloudCLI 看作 Claude Code 的轻量 wrapper。即使是人工修改会话名，CloudCLI 的作用也应看作是调用 Claude Code 相应接口修改 Claude Code 中的会话名称。CloudCLI 中存储的会话名称应看作是 Claude Code 中的会话名称的 cache。」

本节即为上文 AC 所要求的「人 yale 的逐字裁定」行，其存在即满足该条 AC 的前半；实现仍须满足其余各条。

## 裁定后的复测（2026-09-30，全部为实测读数）

1. **Claude Code 有权威的「这个会话叫什么」接口，本仓库一个都没用。** SDK 暴露 `getSessionInfo(sessionId, { dir })` 与 `listSessions({ dir })`，返回的 `SDKSessionInfo.summary` 文档逐字写着「Display title for the session: custom title, auto-generated summary, or first prompt」（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3579-3610`）。注意这条阶梯里**没有 agent name**；而 App 自己实现的阶梯是 CLI 的**会话内显示**阶梯（`agentName || customTitle || aiTitle || …`）。读数：`grep -rn "getSessionInfo\|listSessions" server/ src/ scripts/` 的命中全部属于 browser-use 与宿主路由的注入式 reader，**没有一处读 Claude Code 的会话名**。
2. **App 的 cache 目前是忠实的 ⇒ 缺陷在源头，不在 cache。** 实测：对 app 会话 `edb5ead0` 与 `cbcdc20d`，Claude Code 自己的 `summary` 返回的正是 App 显示的那个累加地址（`archguard-架构分析-edb5ea-edb5ea`、`author-develop-分支发布到-github-cbcdc2-cbcdc2`），`customTitle` 同值。⇒ **上文出路的 (c)（App 侧把自赋名降档显示）被本裁定排除**：那会让 App 与 Claude Code 不一致，正是本裁定禁止的。可选的只剩 (a) 不自赋名与 (b) 自赋名等于 Claude Code 已有的名字。
3. **正控制：人工改名这条路已经是通的。** 会话 `6e20c900`：库 `custom_name = Restart Web Server`、`name_source = manual`，而 Claude Code 的 `summary` 也是 `"Restart Web Server"` —— 两边逐字一致，写回走的是 SDK 的 `renameSession`。⇒ 原则 2 的机制本身是好的，坏的只有 CloudCLI 自己注入的 `--name`。
4. **`agent` 档实际上不携带独立信息。** 语料里含 `agent-name` 的转录共 2749 条，其中「最后一条 `custom-title` ≠ `agent-name`」的只有 **1** 条（就是上一条那个 `/rename` 形状）——因为 `--name` 成对写这两条。⇒ App 阶梯事实上等于「把启动旗标读成最高优先名」，而那个旗标正是 CloudCLI 自己写的。
5. **cache 的写入次序与「cache」模型相反。** `renameSessionById`（`server/modules/providers/services/sessions.service.ts:749-765`）先写 SQLite、再广播、**最后**才 best-effort 写回 provider，而 `writeRenameToProviderTranscript`（同文件 `:118`）把 provider 的拒绝**记录后吞掉**（其 docstring 逐字：nothing here is allowed to fail the request），之后**不回读** Claude Code。⇒ cache 可以长期持有 Claude Code 从未接受过的名字，且因为读取侧 `COALESCE(custom_name, transcript_name)` 无条件优先 `custom_name`，这个错名不会被任何后续同步纠正。缓存纪律应为「写穿成功后再落库」或「落库后回读校验」。
6. **一个仍在的缺口：Claude Code 侧的改名盖不过 App 侧的覆盖。** 同步器每次都会重读转录（`claude-session-synchronizer.provider.ts:392-397` 逐字：a name that is not re-read is a name that goes stale），但人工在 CLI 里 `/rename` 出来的名字会落在 `transcript_name`/`manual`，而 `custom_name` 无条件压过它 ⇒ App 会继续显示自己那份更旧的覆盖名。按本裁定，这时应以 Claude Code 为准。

以上 1/5/6 是本裁定新增的范围（缓存来源、缓存写入纪律、覆盖与来源冲突），实现时若认为超出原 10 条 AC，请先登记再决定是否补 AC。


## Evidence（worker 2026-09-30，round 2：裁定已到，卡在被裁定排除的出路与 AC8 的互斥）

**结论先说：本轮实现的是出路 (c)，而人 yale 的裁定逐字排除了 (c)，故本分支不得落地。** 同时，裁定允许的 (a)/(b) 两条路都必红 AC8 钉死的 `claude-resident-addressable.test.ts`。所以这不是「还差一点实现」，而是**任务书内部（AC2 与 AC8）在「排除 (c)」之后互斥**，需要一次裁定收口。

### 一、裁定已到（AC7 的前半成立）
`## 人 yale 的裁定（2026-09-30，逐字）` 一节已在任务记录中；`## 裁定后的复测` 六条读数为裁定人所加。裁定把「让 App 显示与 Claude Code 不一致」这件事本身定为禁止，并写明「可选的只剩 (a) 不自赋名与 (b) 自赋名等于 Claude Code 已有的名字」。

### 二、为什么 (a)/(b) 都过不了 AC8（逐条证据）
AC8 要求 `server/modules/providers/tests/claude-resident-addressable.test.ts` **未改且退 0**。该文件不去调产品函数，而是把规则**逐字重述**在文件内（:217-223）：`expectedPeerName(title,id) = slug(title) + '-' + id.slice(0,6)`，且断言：
- :1131/:1136 `snapshotPeerName === ruleName`（`GET /api/session-hosts` 投影出来的地址必须等于这条重述）
- :1140 `transcriptAgentName === ruleName`（进程自己写进转录的 `agent-name` 也必须等于它）
- :1116/:1123 `equalToSnapshot`（投影与转录必须一致，且转录里**必须有一条** `agent-name`）

⇒ 常驻进程必须被 `--name` 成 `<slug>-<id6>`。而：
- 走 **(a)**（不传 `--name`）：进程不注册 `agent-name` ⇒ :1116/:1140 必红。
- 走 **(b)**（`--name` = 会话自己的名字）：投影与转录都变成那个名字 ⇒ :1131 必红。
两者都不是「实现得不够好」，是那条不变量被设计本身推翻。

### 三、AC2 与 AC8 互斥
AC2 要求人工改名后 Claude Code 侧列出的名字也是人工名，并只给了两条取证路：**按 CLI 阶梯读转录**（该阶梯 `agentName || customTitle || aiTitle || …` 把 `agentName` 排在最前），或**证明 `--name` 不再压过它**。两条路都要求 `--name` 不带自造后缀——与第二节里 AC8 要求 `--name` = `<slug>-<id6>` 直接冲突。AC3（「名字里会话 id 前 6 位只出现 1 次」）同理只有 (c) 的形状能逐字满足。

### 四、本轮真正做完的事（读数都是实测）
- 新建 `server/modules/providers/tests/claude-session-name-authority.test.ts`，9 例，`npx tsx --tsconfig server/tsconfig.json --test …` **exit 0**：① 有 `ai-title` 时显示名 = ai-title / `name_source='ai'`（**正控制**：同一夹具去掉 `ai-title` ⇒ 落到地址、`source='self-assigned'`）；② 真 agent 名仍占 `agent` 档（防「一律降档」）；③ 人工名最高；④ 地址逐字幂等（`edb5ea` 恰好出现 1 次）且 `Fix the facade` 不被误剥；⑤ 读回取**最后**一条 `agent-name`；⑥ 迁移把两行污染数据分别重定级为 `ai` / `derived`，第二次运行 0 变更；⑦ 判别式锚定本会话 id。
- 三条假形态已逐个验过会红（改回 `agent` 优先 ⇒ AC1 例 + 正控制红；读回取第一条 ⇒ AC4 例红；`residentPeerName` 拿当前显示名当入参 ⇒ 幂等例红），验完已还原，工作树干净。
- 产品侧：`sessions.db.ts` 新增 `self-assigned` 档（`agent=4 / manual=3 / ai=2 / self-assigned=1 / else=0`）与判别式 `isSelfAssignedSessionName`；`claude-session-synchronizer.provider.ts` 阶梯改为 agent → manual → ai → self-assigned → derived；`claude-host-driver.provider.ts` 的 `residentPeerName` 先剥尾部本会话后缀、`readTranscriptAgentName` 改取最后一条；`migrations.ts` 新增幂等重定级。

### 五、AC 逐条状态（勾选为「按现有代码机械核验」的读数，不代表本设计成立）
| AC | 状态 | 读数 |
| --- | --- | --- |
| AC1 | ✅ | 判据文件 exit 0；正控制与三条假形态均按设计红/绿 |
| AC2 | ⬜ | 与 AC8 互斥（第三节）；文件内也没有 `renameSessionById` 实跑腿，不勾 |
| AC3 | ⬜ | 幂等与 id6-一次已断言，但 AC 点名的是「连续两次常驻启动（mock SDK 流）」这条实跑腿，文件里没有，不勾 |
| AC4 | ✅ | 读回取最后一条已在文件内断言；「重启后投影 `peerName` 非空且等于本次启动名」由 AC8 冻结的实进程判据覆盖且为绿 |
| AC5 | ✅ | 迁移幂等例（连跑两次，第二次 0 变更）|
| AC6 | ✅ | `nameSourceRankSql` 为 `agent=4/manual=3/ai=2/self-assigned=1/else=0`，档位断言在文件内 |
| AC7 | ✅ | 裁定行在记录中 |
| AC8 | ✅ | 九个文件逐个跑，命令与退出码见下 |
| AC9 | ✅ | 三条 typecheck 链 exit 0；`npm run lint` exit 0（仅既有 warning）|
| AC10 | ⬜ | 落地后实测（生产库 `~/.cloudcli/auth.db` 的档位分布 + `server.log` 计数），本轮无落地，不做 |

AC8 的九个文件（逐个独立进程，全部 exit 0，文件与 develop 无 diff）：
```
server/modules/providers/tests/claude-session-title-source.test.ts        exit=0 pass=8  fail=0
server/modules/providers/tests/claude-resident-addressable.test.ts        exit=0 pass=1  fail=0
server/modules/providers/tests/claude-host-per-run.test.ts                exit=0 pass=7  fail=0
server/modules/providers/tests/claude-background-work.test.ts             exit=0 pass=10 fail=0
server/modules/session-hosts/tests/session-hosts-routes.test.ts           exit=0 pass=5  fail=0
server/modules/database/tests/sessions-name-source.integration.test.ts    exit=0 pass=12 fail=0
server/modules/providers/tests/session-rename-route.test.ts               exit=0 pass=4  fail=0
server/modules/providers/tests/claude-session-title-corpus.test.ts        exit=0 pass=2  fail=0
server/modules/providers/tests/claude-session-title-mirror.test.ts        exit=0 pass=8  fail=0
```
`git diff --stat develop...HEAD -- <上述九个文件>` 为空 ⇒ 「文件未改」成立。

### 六、需要的那次裁定（二选一）
1. **让 AC-164 判据随选定出路修订**：解除 AC8 对 `claude-resident-addressable.test.ts` 的「未改」约束（该文件重述的规则正是 (c) 的形状），连同本节 §12 与 AC-164 的「稳定 SendMessage 地址」承诺一并改写，然后按 (a) 或 (b) 实现。
2. **保留地址形状、改 AC2 的取证口径**：按 Claude Code 的 `summary`（`getSessionInfo`/`listSessions`）判定一致性，并补一步「常驻启动后由 App 经 Claude Code 接口把会话名写回它自己的名字」——这正是裁定里「CloudCLI 要修改会话名，应使用 Claude Code 的接口」的字面落地，可把 `summary` 拉回与 App 一致。

在裁定给出之前，本分支不落地：AC2 与 AC10 保持未勾（机械上也不可能 10/10），下面的 scoped-gate 缓存只是记录本轮「按现有代码」的绿读数。
