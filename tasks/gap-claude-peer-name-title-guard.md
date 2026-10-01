---
id: gap-claude-peer-name-title-guard
title: peer 名只在会话真有标题时才交给 CLI：阶梯兜底值不得被冻进 manual 档
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

上一条任务（`gap-claude-peer-name-follows-ai-title`，已 done）让 per-run 与常驻两条路在第二轮起把会话标题交给 Claude Code，注册名因此能落成 `nameSource: auto`、可读。**机制本身是对的**（2026-10-01 在真服务器上实测：第一轮 `derived`、第二轮抓到活动进程 `nameSource: 'auto'`）。

**但它传的值取自 `getSessionInfo().summary`，而 `summary` 是 Claude Code 那条阶梯的结果，不是「有没有标题」的判据。** 文档逐字：summary = custom title / auto-generated summary / **first prompt**。当会话没有 `ai-title` 时，它返回的是**首条消息原文**。

于是实测出现这个后果（2026-10-01，:3001，新代码）：

| 会话 | 跑了几轮 | 注册表（进程存活时读） | App 侧档位 | 转录 |
|---|---|---|---|---|
| `fe72ad3a` | 2 | `nameSource: **auto**`，name = 首条消息原文 | **`manual`**（rank 3） | **没有 `ai-title`**，有 1 条 `custom-title` = 同串 |
| `a0cde8d3` | 1 | （未抓到） | `derived`（rank 0） | 同样没有 `ai-title` |

档位表（`server/modules/database/repositories/sessions.db.ts`）：`agent 4 / manual 3 / ai 2 / self-assigned 1 / else 0`。

⇒ **在没有 `ai-title` 的会话上，这一步把「可自愈的 `derived` 占位名」提升成了「冻结在 `manual` 档的首条消息」——而 `manual` 高于 `ai`。** 一旦 Claude Code 之后补上标题，它再也压不上来。这是本系列任务一直在防的那种反转，只是值从「App 自造地址」换成了「阶梯兜底值」。

**这不罕见**：最近 48 小时 CloudCLI 新建 522 个会话，**只有 18 个（3%）有 `ai-title`**（504 个没有；其中 490 个是 quay 的短 worker，名字来源 `agent`）。有标题的转录行数中位 188，没有的 92。今天自建的两个探针会话是 **0/2**。

**人 yale 2026-09-30 裁定接受的是「冻结 AI 标题」；这里冻结的是兜底值，不是一回事。**

**本任务做的**：给 `resolveClaudeSessionTitle` 加一条守卫 —— **只有在会话确实有一个真正的标题时才交出去**；`summary` 只是阶梯兜底值时一律返回 `null`（等于不传），让注册名留在 `derived` 占位、将来标题出现时仍能被采纳。

**怎么判「真正的标题」**（实现者选一条并在代码里写明理由）：
- 读转录里的 `ai-title`（App 已有读取器：`session-ai-title.service.ts` 的 `readAiTitleEntry` 与带窗口的 readers），把它当交付值 —— 值即证据，没有就是没有；
- 或：把 `summary` 与该会话的首条消息比对，相等即判为兜底值。
⚠️ 不要用 App 自己那列 `transcript_name_source` 直接当判据：它可能已被覆盖档位（`manual` / `self-assigned`）改写，且它描述的是**本 App 的读数**，不是「Claude Code 侧有没有标题」。
⚠️ 人工 `/rename` 出来的 `custom-title` 属于**真标题**，不在本条要挡的范围内（人的名字本来就该最高）。

## Plan

1. **判据先行**：新建 `server/modules/providers/tests/claude-peer-name-title-guard.test.ts`，做法照同目录既有的 `claude-peer-name-follows-ai-title.test.ts`（真 claude 二进制 + mock 端点决定标题，临时 `CLAUDE_CONFIG_DIR` / `DATABASE_PATH`）。先取红态。
2. **守卫**：`server/modules/providers/list/claude/claude-runtime.provider.js` 的 `resolveClaudeSessionTitle`（该文件是已跟踪源码）。三个调用方（`claude-per-run-host-driver.provider.ts`、`claude-runtime.provider.js` 内部、`claude-host-driver.provider.ts`）都走这一个函数，**不需要改**。
3. **留痕**：在 `docs/proposals/claude-resident-sessions.md` §12 的修订块补一句：交出去的必须是**真标题**，阶梯兜底值不交。
4. **假形态逐条验红**，验完还原；既有判据不退。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-peer-name-title-guard.test.ts` 退出 0，且断言：会话**没有** `ai-title` 时，跑满两轮之后注册表 `nameSource` **仍是 `derived`**、App 侧也仍是 `derived`，且转录里**不出现**本 App 写入的 `custom-title`。**假形态**：把阶梯兜底值（首条消息）也交出去 ⇒ 必须红。
- [ ] 同一文件**正控制**：会话**有** `ai-title` 时，第二轮之后注册表 `nameSource === "auto"` 且 `name` 逐字等于该 `ai-title`（证明守卫没有把整条路堵死）。
- [ ] 同一文件断言人工名不受影响：会话的标题来自 `/rename`（`custom-title`）时，该值仍被交出去（它是真标题）。
- [ ] 既有判据逐条退 0 且文件未改：`claude-peer-name-follows-ai-title.test.ts`、`claude-session-name-authority.test.ts`、`claude-resident-addressable.test.ts`。逐条打印命令与退出码。
- [ ] `npm run typecheck` 三条链退出 0；`npm run lint` 退出 0（仅既有 warning）。

## DoD

在真实运行的 CloudCLI（`dist-server/server/index.js`，端口 3001）上取两条腿：

1. **无标题腿**：新建一个会话（其转录里**没有 `ai-title`**），跑满两轮 ⇒ `~/.claude/sessions/<pid>.json` 的 `nameSource` 仍是 `derived`；App 行的 `transcript_name_source` 仍是 `derived`；转录里没有本 App 写入的 `custom-title`。
2. **有标题腿**：新建一个会话、等它的转录出现 `ai-title`，再跑第二轮 ⇒ `nameSource === "auto"` 且 `name` 逐字等于该 `ai-title`。

⚠️ 第二条腿依赖标题生成，而它**会 flake**（同 prompt 同 env 有时整轮没有 `ai-title`；2026-10-01 实测最近 48 小时只有 3% 的 CloudCLI 会话拿到标题）。**没出现 `ai-title` 是重跑的理由，不是改代码的理由**；判据里对 `ai-title` 的等待要做成**轮询那个行**，不是睡固定秒数。

只做到「测试绿」不算数：两条腿都要有真实会话跑过、且读数被打印出来。

## Touches

- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/services/session-ai-title.service.ts
- server/modules/providers/tests/claude-peer-name-title-guard.test.ts (new)
- docs/proposals/claude-resident-sessions.md
- tasks/gap-claude-peer-name-title-guard.md
