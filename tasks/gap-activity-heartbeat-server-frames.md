---
id: gap-activity-heartbeat-server-frames
title: AC-182 服务端没有业务心跳帧：加每进程 bootId+rev 的 activity.heartbeat 节拍（出厂 5s/15s，重启换
  bootId，被杀即停帧）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-182
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：`grep -rn "bootId\|activity\.heartbeat\|ACTIVITY_" server --include=*.ts` 在生产代码里 0 命中；`grep -rl "goal_ac: AC-182" tasks/*.md` 与 `grep -rli "bootid" tasks/*.md` 均 0 命中（`heartbeat` 一词只在 `gap-chat-edit-send-unawaited-handler-lane-flake.md`、`gap-voice-error-classification-residue-guard-excludes-quay-state.md` 的正文里偶然出现，二者 status done，且讲的是别的东西）。GOAL-014 的另几条判据（AC-183 客户端新鲜度状态机、AC-186 回合阶段）是不同机制，本仓库也还没有归属任务。⇒「服务端业务心跳」这一机制无人认领，不是重复。

**现状读数（2026-10-01，读代码）。** 服务端唯一的“心跳”是 `server/modules/websocket/services/websocket-server.service.ts:23` 的 `attachWebSocketHeartbeat`：WS 协议级 `ping`（`intervalMs = 30_000`），浏览器 JS 看不到，因此客户端没有任何办法知道服务端是否还活着。没有 `bootId`，没有 `rev`，没有 `activity.*` 业务帧。提案 §1.1 / §4.4 / §10.3 已把这一层裁为 P0、与其余完全解耦、可独立先行。

**要做的事。** 让真实服务端在已订阅的会话上按固定节拍发出业务心跳帧 `activity.heartbeat`，每条带 `bootId` 与 `rev`（`rev` 没有变化也照发）；`bootId` 每进程生成一次（进程内稳定、重启后改变），进程被杀后不再有帧。出厂默认：心跳 5000 毫秒、判定不可达 15000 毫秒；服务端在 hello（`chat_subscribed`）或快照帧里把这两个值宣告给客户端。节拍用环境变量缩短，使判据在 60 秒闸内跑完。

## Plan

1. 红态先行：写 `server/modules/websocket/tests/activity-heartbeat.process.test.ts`（判据文件，路径由 AC 固定）。参照 `server/modules/session-hosts/tests/resident-server-restart.test.ts`：`spawn('npx', ['tsx','--tsconfig','server/tsconfig.json','server/index.ts'])`，独立 `SERVER_PORT`（probe 出的空闲端口，断言 ≠ 3001），隔离 `HOME` / `DATABASE_PATH` / `CLAUDE_CONFIG_DIR`，用 `scripts/mint-token.mjs` 铸 token，`ws` 客户端连 `/ws?token=…` 并 `chat.subscribe` 一个会话。用环境变量把节拍缩短到亚秒级。实现前该文件红（读不到任何 `activity.heartbeat`）。
2. 实现：在 `server/modules/websocket/services/activity-heartbeat.service.ts` 里加心跳服务——模块加载期生成一次 `bootId`（进程内常量）、维护 `rev`、构造 `activity.heartbeat` 帧、按节拍发送、socket 关闭即停；导出两个出厂常量（心跳 5000ms / 不可达 15000ms）以及读其环境变量覆盖（缩短节拍用）的入口。经 `server/modules/websocket/index.ts` 桶导出。
3. 在 `server/modules/websocket/services/chat-websocket.service.ts` 的 `chat.subscribe` 应答（`chat_subscribed` ack，即 hello 帧）里带上 `{ bootId, heartbeatIntervalMs, unreachableAfterMs }`，并在订阅后把心跳挂到该 socket；`rev` 取自同一份活动状态。
4. 同一判据文件里第二条用例：`import` 上面导出的两个出厂常量，断言分别为 5000 与 15000，并断言 hello 帧里宣告的字段正是这两个值。
5. 取假形态（先提交再变异，`git checkout -- <file>` 恢复，登记逐字失败行）：(i) `bootId` 每次心跳现算 ⇒ 稳定性用例必须红；(ii) 重启沿用同一 `bootId`（把 `bootId` 落盘到临时文件再读回）⇒ 重启用例必须红；(iii) 只在 `rev` 变化时才发心跳 ⇒ 节拍用例必须红。
6. `npx tsc --noEmit -p server/tsconfig.json` 与 `npm run lint` 绿。

## AC

- [ ] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/activity-heartbeat.process.test.ts` 退出 0。红态基线：实现前该文件不存在或红。
- [ ] AC2 节拍（正控制，承重）：在缩短后的 N 个节拍周期内，同一已订阅 socket 读到不少于 N-1 条 `activity.heartbeat`，每条同时含 `bootId` 与 `rev`（帧里 `rev` 不变也照发）。
- [ ] AC3 bootId 进程内稳定：同一进程内，hello 帧与全部心跳帧的 `bootId` 两两相等。
- [ ] AC4 被杀即静默：`SIGKILL` 服务端进程后，该 socket 收到 close，且此后计时窗口内读到 0 条帧（含 `activity.heartbeat`）。
- [ ] AC5 重启换 bootId：再起一个进程并订阅，其 `bootId` 与第一个进程的 `bootId` 不相等。
- [ ] AC6 出货默认值：同一文件第二条用例直接 `import` 实现导出的出厂常量并断言心跳 = 5000、判定不可达 = 15000；且服务端在 hello（`chat_subscribed`）或快照帧里把这两个值宣告给客户端（断言帧里字段等于这两个常量）。
- [ ] AC7 取假形态必须红（承重）：(i) `bootId` 每次心跳都变 ⇒ AC3 红；(ii) 重启沿用同一 `bootId` ⇒ AC5 红；(iii) 只在 `rev` 变化时才发 ⇒ AC2 红。逐条记录变异 diff、逐字失败行与恢复命令。
- [ ] AC8 静态门：`npx tsc --noEmit -p server/tsconfig.json` 与 `npm run lint` 均退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## DoD

- 判据驱动的是真实出货进程：帧由 `tsx server/index.ts` 子进程经真实 WS 连接发出，`SIGKILL` 的也是该子进程；不接受 in-process 替身，也不接受“直接调用 service 函数”当作真实服务端。
- `bootId` 在实现里只生成一次（进程内模块级常量），不是每帧现算，也不是每连接一个。
- 两个出厂数字只写在实现里一处，测试读常量而不是把 5000 / 15000 抄成字面量。
- 心跳帧与 hello 帧走 websocket 模块自己的公共面；新增服务不在模块外被深引（遵守 `.agents/skills/backend-module-standards/SKILL.md`）。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。

## Touches

- server/modules/websocket/services/activity-heartbeat.service.ts (new)
- server/modules/websocket/index.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/tests/activity-heartbeat.process.test.ts (new)
- tasks/gap-activity-heartbeat-server-frames.md
