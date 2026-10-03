---
id: gap-quay-panel-task-adr-detail-list-and-dashboard-link
title: Quay 面板补全任务/ADR 明细列表并接通 dashboard 外链
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

`gap-quay-project-status-display`(status: done)落地的 Quay 面板(`src/modules/quay/QuayPanel.tsx`)目前只画了摘要卡片(Tasks/Needs human/Done/Goals/ADRs 总数)+ 任务状态计数条 + driver 字典,用 playwright MCP 浏览器在真实运行的 CloudCLI 上实测确认:没有任何按任务/ADR 逐条展开的明细列表,和同一台机器上 `quay serve`(端口 3651)的真实 dashboard 比明显单薄——对照那条任务当时的 Plan 第 3 步("下方明细列表(任务/ADR,截断显示 + 外链到 quay serve 原生 dashboard)"),只有摘要卡片部分落地了,明细列表和外链都没做。

进一步查实:`QuayPanel.tsx:144-154` 其实已经写好了 `dashboardUrl` 这个 prop 和对应的"Dashboard →"外链渲染逻辑,但调用方 `src/modules/project-workspace/WorkspaceMain.tsx:326` 从来没有传这个值(`<QuayPanel projectId={...} view={quayView} onRefresh={refreshQuay} />`,没有 `dashboardUrl`)——外链代码路径永远走不到,面板现在没有任何办法让用户跳回真实 dashboard。

本任务之所以在 `gap-quay-project-status-display` 完成后才单独立案,是因为那条任务的 AC/DoD 当时只机械钉住了"摘要卡片计数与真实 CLI 输出一致",没有把 Plan 第 3 步里"明细列表 + 外链"那部分转成可机械检查的 AC——这是那次立案的 AC 覆盖面缺口,不是这次重新发明范围;本任务把当时漏掉的那部分重新写成可检查的 AC。

已验证可用的后端机制:`quay server status --json`(对本仓库实测过)在 `services` 数组里给出 `name: "web"` 条目的 `host`/`port`(本机实测 `172.28.0.1:3651`)以及 `liveness.alive` 布尔值——这就是计算 `dashboardUrl` 需要的信息源,且是只读命令,可以直接加进 `server/modules/quay/quay.service.ts` 现有的 `QUAY_READ_ONLY_COMMANDS` 白名单。

已知的局限(不在本任务修复范围):`quay adr list --json` 在本仓库上对真实存在的 ADR 文件返回空数组,这是 quay 自身 native provider 的既有缺陷(已经和另一个 quay 会话核实根因并反馈给其维护方),不是本任务引入的问题。本任务的 ADR 明细区块按 `adr list --json` 的真实返回值渲染即可——即便那条命令当前对本仓库返回空数组,渲染空态文案也是正确行为,不需要在这条任务里绕过或修补 quay 自身的缺陷。

## Plan

1. 后端 `server/modules/quay/quay.service.ts`:
   - 把 `server status --json` 加入 `QUAY_READ_ONLY_COMMANDS` 白名单。
   - `getQuaySnapshot` 增加一次该命令的调用,解析 `services` 数组里 `name === 'web'` 的条目;当 `liveness.alive === true` 时,把 `http://<host>:<port>/` 组成 `dashboardUrl` 字符串放进 `QuaySnapshot`(新增字段,`string | null`);拿不到或未运行时为 `null`,不视为错误、不进 `warnings`。
   - 任务/ADR 明细:在现有 `task list --json`/`adr list --json` 调用基础上,从响应里截取精简字段(id、title、status,ADR 还要 superseded-by/supersedes 关系可选)各保留最多一个固定上限(例如最近/相关的 10 条,具体截断规则由实现决定但要在 AC 里钉死条数上限与排序依据),作为 `QuaySnapshot.tasks.recent`/`adrs.recent` 两个新数组字段。
2. 前端 `src/modules/quay/QuayPanel.tsx` / `LoadedQuayPanel`:
   - 新增两个明细区块("Recent tasks"/"ADRs"),各渲染 `snapshot.tasks.recent`/`snapshot.adrs.recent` 的 id+title+status,空数组时显示"No tasks/ADRs reported"而不是留白。
   - 列表每一行不需要可点击跳转(没有单任务详情页),只做只读展示。
3. 前端 `src/modules/project-workspace/WorkspaceMain.tsx:326`:把 `useQuayStatus` 返回的 snapshot 里的 `dashboardUrl` 传给 `<QuayPanel dashboardUrl={...} />`,接通已经写好但从未被调用的外链渲染路径。
4. `src/shared/types.ts` 的 `QuaySnapshot` 类型同步新增 `dashboardUrl`/`tasks.recent`/`adrs.recent` 字段定义。

## AC

- [ ] `npm run typecheck` 退出码 0。
- [ ] 后端新增/更新的窄测试(`server/modules/quay/tests/`)退出码 0,覆盖:(a) `server status --json` 在白名单内,`isReadOnlyQuayCommand` 对其返回 true;(b) `getQuaySnapshot` 对 web 服务 `alive:true` 的 mock 响应正确组出 `dashboardUrl`,对 `alive:false` 或命令失败时 `dashboardUrl` 为 `null` 且不出现在 `warnings` 里;(c) `tasks.recent`/`adrs.recent` 按约定的条数上限截断,且顺序符合约定的排序依据。
- [ ] 前端新增/更新的窄测试(`src/modules/quay/tests/`)退出码 0,覆盖:(a) `QuayPanel` 在 `dashboardUrl` 非空时渲染出可点击的外链(`href` 等于传入值);为 `null` 时不渲染该外链;(b) `tasks.recent`/`adrs.recent` 为空数组时渲染空态文案,非空时逐行渲染 id+title+status。
- [ ] 真实数据核对:在本机对 claudecodeui 自身跑 `quay server status --json`、`quay task list --json`、`quay adr list --json` 的输出,与面板新渲染的外链 URL、任务明细行手工核对至少 5 条一致(字段级核对,记录在 DoD,不是只断言测试绿);ADR 明细行若真实返回为空数组,核对面板正确渲染空态即可。

## DoD

- 真实跑通:在本机启动 CloudCLI,打开 claudecodeui 自身项目,切到 Quay tab——面板出现指向真实 `quay serve` 实例(本机当前是 `http://172.28.0.1:3651/`)的可点击 "Dashboard" 链接,点击后能在新标签页打开真实 dashboard;面板同时展示任务明细行,行数与内容与同一时刻 `quay task list --json` 的真实输出吻合。ADR 明细区块按真实 `adr list --json` 返回值渲染(当前已知返回空数组,渲染空态文案即算通过,不要求面板绕过 quay 自身的已知缺陷)。
- 另验证 `quay serve` 未运行的场景(可以临时找一个配置了 `.quay/config.yml` 但没有 `quay serve` 进程在跑的项目):面板不显示 Dashboard 链接,也不报错或卡在 loading。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/tests/quay.service.test.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/project-workspace/WorkspaceMain.tsx
- src/shared/types.ts
- tasks/gap-quay-panel-task-adr-detail-list-and-dashboard-link.md (self-touch)
