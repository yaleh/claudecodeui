---
id: gap-session-rename-writeback
title: App 改名写回 Claude Code：经 SDK renameSession 追加 custom-title，DB 先写、磁盘 best-effort
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-title-ladder-mirror
---
## Proposal

现状：`server/modules/providers/services/sessions.service.ts` 的 `renameSessionById` 只写 SQLite 的 `custom_name` 并发一条 `session_upserted`；`server/modules/providers/provider.routes.ts` 的 `PUT /api/providers/sessions/:sessionId` 转调它。仓库里**没有任何代码把标题写进 `~/.claude`**（`history.jsonl` 只读；transcript 只被 debug-agent 的夹具根写过，而那个根结构性到不了真实 home）。唯一例外是 fork：`server/modules/providers/list/claude/claude-fork.provider.ts` 把标题交给 SDK，SDK 会写一条 `custom-title`。

后果：在终端 `claude --resume` 的列表、`searchSessionsByCustomTitle`、以及 `/resume` 的参数补全（CLI 内部是 `customTitle ?? aiTitle`）里都看不到 App 改的名，两个界面可以长期不一致。

SDK 提供了受支持的离线改名 API：

```
node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2438
/** Rename a session. Appends a custom-title entry to the session's JSONL file. */
export declare function renameSession(sessionId, title, options?): Promise<void>;
```

同族还有 `tagSession` / `deleteSession` / `forkSession`（`SessionMutationOptions`，可传 `dir` 指定项目目录）。
**不要**自己拼 JSONL 行去追加，也**不要**写 `custom-title.json` 边车——CLI 把该边车当可清理的临时文件（它出现在 CLI 的 retention cleanup 白名单里），不是契约。

已知取舍（写进实现注释，不在本任务处理）：CLI 的列表阶梯 `wze` 把 `agentName` 排在 `customTitle` 之上，所以对**有 `agent-name` 的会话**（本机语料 1172/1254），写回**不会**改变 CLI 列表里显示的标题。写回的价值在于该名字在 CLI 侧被记录、可被搜索、可出现在 `/resume` 的参数补全里。App 侧显示不受影响，因为显式覆盖列优先于转录侧列。

方案：

1. `renameSessionById` 的顺序固定为：DB 先写（`custom_name` = 显式覆盖，`name_source='manual'`）→ 发广播 → 再 best-effort 写盘。反过来（先写盘后写库）的失败模式更糟：磁盘改了、App 没改。
2. 写盘条件：行 `provider === 'claude'` 且 `jsonl_path` 非空且文件存在；`dir` 用行的 `project_path`。条件不满足时**跳过且不报错**——App 新建、尚无 transcript 的会话本来就没有文件可写。
3. 写盘失败只记日志，HTTP 仍返回 200（改名在 App 侧已经生效，不应因为磁盘问题让用户看到失败）。
4. SDK 调用按 `.agents/skills/backend-module-standards/SKILL.md` 落位：不要从 service 层深导入 providers 内部文件；若为此新增 provider 侧文件并经 barrel 暴露，把该文件补进 Touches。
5. 幂等/不抖动：写盘会让 watcher 再同步一次，读到同名 `custom-title`；断言名字不变、且不产生可见抖动。

本任务假定会话行已有 `transcript_name`（转录侧）与 `custom_name`（显式覆盖）两列——该结构由标题阶梯镜像的工作引入；若它尚未落地，先不要开始本任务。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-rename-writeback.test.ts` 退出码 0：用真实临时 `HOME`（含真实形状 transcript）+ 真实临时 sqlite + 真实路由 `PUT /api/providers/sessions/:sessionId`，断言三条互相独立——(a) transcript 末尾出现一条 `custom-title`，`customTitle` 等于新名（**正控**：改名前后各读一次该文件，行数与末尾条目必须真的变化，证明写入确实发生，而不是断言了一个本来就成立的状态）；(b) 库 `custom_name` 为新名、`name_source='manual'`；(c) 该行 `transcript_name` **不变**（证明写回不污染转录侧列）。
- [ ] 同一命令下的跳过路径：对一条 `jsonl_path` 为空、或指向不存在文件的会话改名，HTTP 仍 200、库仍更新、且**没有发生任何文件写入**（对临时 HOME 做整目录快照比对，不是只检查目标文件不存在）。
- [ ] 同文件断言幂等：对同一会话连续两次 PUT 同一名字，第二次之后库里状态与第一次后完全一致，且 transcript 里该名字的 `custom-title` 条数不增加（若实现确实每次都追加，则把该读数如实打印出来并在 Evidence 里记录为已知形态，不得静默放过）。
- [ ] 抗假变体（两条，各自只许红指定的项）：(i) 把写盘调用整段注释掉后重跑同一命令，必须**只有 (a) 与跳过路径的快照项之外的部分保持绿**，(b)(c) 保持绿——即红的只能是 (a)；还原后转绿。(ii) 把写盘改成无条件执行（去掉 `provider`/`jsonl_path` 条件）后，跳过路径用例必须变红；还原后转绿。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-rename-route.test.ts` 退出码 0（既有路由用例不回归：200 / 404 / 400 / 广播条数）。
- [ ] `npm run typecheck` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：不是仅有单测。要求在真实服务实例（临时 `DATABASE_PATH` + 临时 `HOME`，`HOST=127.0.0.1`）里，经**真实浏览器**在 UI 中给一个会话改名，然后取得三处独立读数：(1) 磁盘上该会话 transcript 末尾确实多了一条 `custom-title` 且值等于新名——直接读文件，不是读库；(2) 用 SDK 的 `listSessions`（或等价的 `getSessionInfo`）读回该会话，`customTitle` 等于新名——这是「CLI 侧真的看得见」的独立读数；(3) 库里的 `custom_name` / `transcript_name` 两列与预期一致。

再对一条 `agent-name` 存在的会话重复一次，如实记录：CLI 列表标题**未变**（`agentName` 优先），但读回的 `customTitle` 是新名。把这个差异原样写进 Evidence，不要粉饰成「已同步」。

L_D = CLI 侧读回的 `customTitle`：改名前为旧名或空，改名后等于用户输入的新名。这是从 CLI 自己的 session 元数据读出来的独立读数，不是测试通过与否。

## Touches

- server/modules/providers/services/sessions.service.ts
- server/modules/providers/provider.routes.ts
- server/modules/providers/index.ts
- server/modules/providers/tests/session-rename-writeback.test.ts (new)
- server/modules/providers/tests/session-rename-route.test.ts
- tasks/gap-session-rename-writeback.md
