---
id: gap-ac236-resident-host-service
title: AC-236 会话宿主启停抽成可复用服务
  startResidentHost/closeResidentHost：路由只剩解析→调用→翻译，四种拒绝与既有文案逐字不变、已运行幂等、关闭回
  lease，判据 server/modules/session-hosts/tests/resident-host-service.test.ts
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-236
---
## Proposal

AC-236（GOAL-019 退出条件 7；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「会话宿主启停 service」小节）要求把内联在 `session-hosts.routes.ts` 的 `/start` 与 `/close` 处理器里的宿主启停逻辑抽成 session-hosts 模块内可复用的服务——`startResidentHost(sessionId, deps)` 与 `closeResidentHost(sessionId, deps)`——路由处理器只解析参数、调用服务、把结果翻译成既有 HTTP 响应；既有拒绝码与文案逐字不变。将来 MCP 的 `session_start` / `session_close` 直接复用这两个服务函数，而不是在路由旁再写一份。

现状（红态基线）：判据文件 `server/modules/session-hosts/tests/resident-host-service.test.ts` 不存在，判据的存在性闸以退出码 1 输出 `缺判据文件：server/modules/session-hosts/tests/resident-host-service.test.ts`；服务文件 `server/modules/session-hosts/resident-host.service.ts` 不存在。当前 `session-hosts.routes.ts`：`/:sessionId/start` 处理器（:404-536）内联 `readSession?.(...)`（:408）、`liveHostForSession(...)`（:415）、`resolveHostDriver?.(...)`（:448）、`startResidentSession(...)`（:477）、`sessionHostManager.bindSession({...})`（:505）与四条拒绝文案；`/:sessionId/close` 处理器（:538-601）内联 `liveHostForSession(...)`（:540）、`sessionHostManager.closeHost(host.hostId, 'user')`（:561）与三条拒绝文案。服务层今天不存在。

要交付：

1. **服务文件**（`server/modules/session-hosts/resident-host.service.ts`，新建）。导出 `startResidentHost` 与 `closeResidentHost`；两者签名 `(sessionId, deps)`，`deps` 至少含 `sessionHostManager`、`readSession`、`resolveHostDriver?`、`startResidentSession?`——与路由今天收到的同名缝一致，类型直接复用 `SessionLifecycleReading` / `HostDriverResolver` / `ResidentSessionStarter`（不新造同义别名）。返回值是与传输无关的可判别联合：成功携带宿主信息，拒绝携带 `{ ok: false; status: number; code: LifecycleModeErrorCode; message: string }`。把路由私有的 `liveHostForSession` 与 `errorMessage` 两个帮助函数搬进服务文件（路由此后不再需要它们）。服务文件不 import `express`、不碰 `Response`、不 `sendRefusal`——翻译是路由的事。按 `$backend-module-standards` 给每个导出写「消费方」注释（消费者：本模块路由 + 本模块判据）；**不经 barrel 导出**（见边界）。

2. **四种拒绝逐字保留（`startResidentHost`；文案从当前路由逐字抄写）**：
   - 会话不存在 → `{ status: 404, code: 'SESSION_NOT_FOUND', message: \`Session "${sessionId}" was not found.\` }`；
   - 已按其他模式运行 → `{ status: 409, code: 'LIFECYCLE_MODE_NOT_RESIDENT', message: \`Session "${sessionId}" already runs in "${running.mode}" mode; only a resident host can be started on demand.\` }`；
   - provider 没有宿主驱动 → `{ status: 409, code: 'LIFECYCLE_MODE_HOST_UNAVAILABLE', message: \`Provider "${session.provider}" mounts no host driver, so session "${sessionId}" cannot be started.\` }`；
   - 会话存储的不是常驻形态 → `{ status: 409, code: 'LIFECYCLE_MODE_NOT_RESIDENT', message: \`Session "${sessionId}" is stored as "${session.mode}"; only a resident session can be started on demand.\` }`。
   启动 seam 抛出与 `bindSession` 拒绝也保留今天的 `LIFECYCLE_MODE_HOST_UNAVAILABLE` 文案模板：`Session "${sessionId}" could not be started (${errorMessage(error)}).` 与 `Session "${sessionId}" could not be bound to a host (${bound.code}).`。`closeResidentHost` 同理逐字保留其四条：宿主非常驻 `LIFECYCLE_MODE_NOT_RESIDENT`（`Session "${sessionId}" runs in "${host.mode}" mode; only a resident host can be closed on demand.`）、会话不存在 `SESSION_NOT_FOUND`、存储非常驻 `LIFECYCLE_MODE_NOT_RESIDENT`（`... is stored as "${session.mode}"; only a resident session can be closed on demand.`）、常驻但无活宿主 `SESSION_HOST_NOT_FOUND`（`Session "${sessionId}" is resident but no live host is serving it.`）。四种拒绝的判定顺序沿用今天的「越便宜越靠前」。

3. **已运行的常驻会话再次启动幂等**（`startResidentHost`）。命中活宿主且 `running.mode === 'resident'` 时直接返回 `{ ok: true, hostId: running.hostId, sessionId, mode: 'resident', pid: running.pid }`，不再调用 `startResidentSession` / `bindSession`、不拉起第二个进程。

4. **关闭回关闭原因与宿主信息，且 lease 可读**（`closeResidentHost`）。命中活常驻宿主时读取该绑定的 leases（`host.bindings.get(sessionId)?.leases ?? []`；常驻宿主由 `createBinding` 持有 `resident-policy`），调用 `sessionHostManager.closeHost(host.hostId, 'user')`，返回 `{ ok: true, hostId: host.hostId, sessionId, mode: 'resident', closeReason: 'user', leases }`。

5. **路由只剩解析→调用→翻译**（`session-hosts.routes.ts`）。`/:sessionId/start` 与 `/:sessionId/close` 处理器体：`const sessionId = routeParameter(request.params.sessionId)` → `const result = await startResidentHost(sessionId, deps)` / `const result = closeResidentHost(sessionId, deps)` → 若 `!result.ok` 则 `sendRefusal(response, result.status, result.code, result.message)`，否则 `response.json(createApiSuccessResponse({...}))`（成功体与今天逐字相同：start 为 `{ hostId, sessionId, mode, pid }`，close 为 `{ hostId, sessionId, mode, closeReason }`；服务返回的 `leases` 不进 HTTP 体，保持既有线上形状）。两个处理器体里不得再出现 `readSession?.(`、`resolveHostDriver?.(`、`startResidentSession(`、`.bindSession(`、`.closeHost(` 的任何一次调用。列表路由（`GET /`）与 `toHostView` / `toBindingView` / `toSessionHostStateView` 不动。

6. **判据 `server/modules/session-hosts/tests/resident-host-service.test.ts`**（红先行；不构造 socket、不起 HTTP 服务、不读数据库）。用一个隔离的 `createSessionHostManager()` 实例 + 假宿主驱动（`startResidentSession` 在真管理器里 `openHost({ provider, mode: 'resident', appSessionId, driver, pid: FAKE_PID })`，`startHost` 只在有 pending launch 时接受——否则抛「opened without a process」，`multiplexedHost: false`）+ 注入的 `readSession` / `resolveHostDriver` / `startResidentSession` 缝直接构造服务调用（照 `resident-ondemand-start-route.test.ts` 的 stand-in 形态，但不经 HTTP）。读数：
   (a) **存在性 + 路由薄**：`typeof startResidentHost === 'function'` 且 `typeof closeResidentHost === 'function'`；用 `readFileSync(new URL('../session-hosts.routes.ts', import.meta.url), 'utf8')` 读路由源，五类内联调用 `readSession?.(`、`resolveHostDriver?.(`、`startResidentSession(`、`.bindSession(`、`.closeHost(` 计数全为 0，同源里 `startResidentHost(` 与 `closeResidentHost(` 各 ≥1（证明路由真的调用服务）；**正例对照**：`resident-host.service.ts` 源里 `readSession`、`resolveHostDriver`、`startResidentSession(`、`.bindSession(`、`.closeHost(` 各出现 ≥1（证明 0 不是扫描器失灵）。逐条写下五组计数。
   (b) **四种拒绝逐字**：逐个构造并对 `{ ok:false, status, code, message }` 做 `assert.equal` 全等（四条文案如第 2 点）；其中「已按其他模式运行」需先在真管理器里 `openHost` 一个 per-run 活宿主（`mode: 'per-run'`, 同 appSessionId）再调用。写下四条返回值。
   (c) **幂等**：第一次 `startResidentHost` 成功（`ok:true`、`pid === FAKE_PID`）；第二次同会话返回 `ok:true` 且 `pid` 相同，驱动 `launches.length === 1` 且 `spawns() === 1`（写下两次 pid 与两项计数）。
   (d) **关闭**：对同一会话 `closeResidentHost` 返回 `ok:true`、`closeReason === 'user'`、`hostId` 与启动一致、`leases` 含且仅含 `{ kind: 'resident-policy' }`（写下整条返回值）；再逐条断言关闭的拒绝：宿主非常驻（用 per-run 活宿主）`LIFECYCLE_MODE_NOT_RESIDENT`、会话不存在 `SESSION_NOT_FOUND`、会话存储非常驻 `LIFECYCLE_MODE_NOT_RESIDENT`、常驻但无活宿主 `SESSION_HOST_NOT_FOUND`，各自 `status/code/message` 全等（写下返回值）。
   (e) 判据文件不 import `express`、不 `listen(`、不 `new WebSocket(`、不 `new WebSocketServer(`（写下用于核对的 grep 命令与空输出）；(a)-(d) 全部直接对 `resident-host.service.ts` 完成。

7. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 在路由 start 处理器里留一份内联逻辑（例如重新写入 `const session = readSession?.(sessionId)`）⇒ (a) 的禁用调用计数必须非 0 而红；
   (ii) 服务把已运行的会话当成新启动（删掉活宿主提前返回分支）⇒ (c) 必须红（第二次 `pid` 不同，或 `launches.length === 2` / `spawns() === 2`）；
   (iii) 改动任一既有拒绝文案（例如把 `was not found.` 改成 `does not exist.`）⇒ 判据命令红——(b)/(d) 的逐字 `assert.equal` 失败（既有两文件只断言 status/code，其保护不变）。
   每条记录恢复命令与恢复后重跑绿。

<!-- dedup-ref -->
边界：本任务与 GOAL-019 其它 AC 的任务相互独立。**不经 barrel 导出** `startResidentHost` / `closeResidentHost` 及其类型（GOAL-019 非目标：宿主启停服务的 barrel 导出随 GOAL-020 的消费者一起加；当前唯一消费者是同模块路由，同模块文件导入即可）；不改 `server/modules/session-hosts/tests/session-hosts-routes.test.ts` 与 `server/modules/session-hosts/tests/resident-ondemand-start-route.test.ts` 一字；不动 `GET /` 列表逻辑与三个投影帮助函数；不改 `SessionHostManager`、`chatRunRegistry`、WebSocket 协议；不实现 MCP / OAuth / 新端点；不实现 AC-230–AC-235、AC-237、AC-238 的范围。

判定纪律：路由薄是「路由源里内联调用计数为 0」的实测，且带服务文件 ≥1 的正例对照；幂等是「第二次不调用启动缝、pid 相同」的实测；关闭的 lease 从真管理器绑定读回（来源是既有 `resident-policy`，不是新造字段）；四条拒绝文案与今天逐字全等由判据 `assert.equal` 钉死；既有两判据文件不改一字仍绿。

## AC

- [ ] AC1 判据绿：`for f in server/modules/session-hosts/tests/resident-host-service.test.ts server/modules/session-hosts/tests/session-hosts-routes.test.ts server/modules/session-hosts/tests/resident-ondemand-start-route.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/resident-host-service.test.ts server/modules/session-hosts/tests/session-hosts-routes.test.ts server/modules/session-hosts/tests/resident-ondemand-start-route.test.ts` 退出 0。红态基线逐字记录（改动前该文件不存在、存在性闸退出码 1 输出 `缺判据文件：server/modules/session-hosts/tests/resident-host-service.test.ts`）。
- [ ] AC2 (a) 服务存在且路由薄：`startResidentHost` / `closeResidentHost` 均为函数；路由源里 `readSession?.(`、`resolveHostDriver?.(`、`startResidentSession(`、`.bindSession(`、`.closeHost(` 计数全为 0，且 `startResidentHost(` / `closeResidentHost(` 各 ≥1；服务源里对应五类各 ≥1（正例对照）。写下五组（两组）计数。
- [ ] AC3 (b) 四种拒绝逐字：会话不存在 / 已按其他模式运行 / provider 无宿主驱动 / 存储非常驻，各自 `{ ok:false, status, code, message }` 与第 2 点文案 `assert.equal` 全等（写下四条返回值）。
- [ ] AC4 (c) 幂等：两次 `startResidentHost` 同一会话，第二次 `pid` 与第一次相同且 `ok:true`；驱动 `launches.length === 1`、`spawns() === 1`（写下两次 pid 与两项计数）。
- [ ] AC5 (d) 关闭回原因/宿主/lease：`closeResidentHost` 返回 `closeReason === 'user'`、`hostId` 与启动一致、`leases` 含 `{ kind: 'resident-policy' }`；关闭的四种拒绝（宿主非常驻 / 会话不存在 / 存储非常驻 / 常驻无活宿主）`status/code/message` 全等（写下返回值）。
- [ ] AC6 (e) 无 socket/HTTP：写下 grep 命令与空输出——判据文件不 import `express`、不 `listen(`、不 `new WebSocket(`、不 `new WebSocketServer(`；且 `session-hosts-routes.test.ts` 与 `resident-ondemand-start-route.test.ts` 在本任务 delta 内无改动（`git diff --stat develop...HEAD -- <两文件>` 为空）并逐字通过。
- [ ] AC7 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 路由留内联逻辑 ⇒ AC2 禁用计数非 0 而红；(ii) 服务把已运行会话当新启动 ⇒ AC4 红；(iii) 改动任一既有拒绝文案 ⇒ AC3/AC5 的逐字断言红。每条记录恢复命令与恢复后重跑绿。
- [ ] AC8 不回归与仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级，写明计数）；跨模块只经 barrel、无深导入；服务文件不新增无消费者的 barrel 导出。
- [ ] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写；列出实际改动文件清单。

## DoD

- 宿主启停逻辑真的只有一份：路由两个处理器体里对 `readSession?.(` / `resolveHostDriver?.(` / `startResidentSession(` / `.bindSession(` / `.closeHost(` 的调用实测为 0，而服务文件里这些调用实测存在（正例对照），路由只做解析→调用→翻译。
- 四种拒绝与既有文案逐字一致：判据对 `{status, code, message}` 全等断言通过；既有 `session-hosts-routes.test.ts` 与 `resident-ondemand-start-route.test.ts` 一字未改仍通过。
- 已运行的常驻会话再次启动是幂等的：返回同一个 pid，启动 seam 只被调用一次、没有第二个进程（实测计数，不是「代码看起来会提前返回」）。
- 关闭返回 `closeReason: 'user'` 与宿主信息，且该会话持有的 `resident-policy` lease 能读出（从真管理器绑定读回）。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 遵守 `$backend-module-standards`（TypeScript、导出带消费方注释、不导出无消费者符号、模块私有实现不导出）与 AGENTS.md；不越界实现其它 AC 的范围（见边界）。

## Touches

- server/modules/session-hosts/resident-host.service.ts (new)
- server/modules/session-hosts/session-hosts.routes.ts
- server/modules/session-hosts/tests/resident-host-service.test.ts (new)
- tasks/gap-ac236-resident-host-service.md
