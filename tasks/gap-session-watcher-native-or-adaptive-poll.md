---
id: gap-session-watcher-native-or-adaptive-poll
title: 会话 watcher 不再无条件 6 秒全量轮询：本地文件系统走原生事件，轮询只作降级并按文件数退避
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

人（yale）2026-09-25 裁定：不保留「无条件轮询」，可换成原生事件，或按数据量退避。本任务两者结合：原生事件优先，轮询降级，且轮询间隔随文件数退避。

现场读数（2026-09-25）：`server/modules/providers/services/sessions-watcher.service.ts:278-287` 用 `chokidar.watch(rootPath, { usePolling: true, interval: 6_000, binaryInterval: 6_000, depth: 6, ... })`，覆盖四个 provider 根目录。当前 `~/.claude/projects` 下有 21 个项目目录、2186 个文件、约 882MB 的 transcript，单个项目目录就有 1096 个条目。轮询意味着每 6 秒对所有被跟踪文件各 stat 一次，空闲 CPU 随历史无限增长；这台 128 核机器上看不出来，小机器与长期运行的场景会先撑不住。

**为什么当初用了轮询，仓库里查不到理由。** `git log -S usePolling` 只追到 `44edf94f`（大重构），源码无注释，`docs/architecture/03-conversation-handoff.md:415` 只陈述事实不解释原因。宿主 `fs.inotify.max_user_watches` 是 1048576，远不是限制。最可能的真实原因是容器/网络文件系统下原生事件不可靠（仓库有 `docker/` 目录），但**这只是推测**，实施者必须先验证或明确标注为未证。

方案：
1. 新增一个纯函数 `resolveWatcherMode`（放在 `sessions-watcher.service.ts` 内，除非被第二处使用），输入环境变量 `CLOUDCLI_WATCHER_MODE=auto|native|poll`（默认 `auto`）与探测结果，输出 chokidar 选项。`auto` 时：在被监视根目录上做一次原生 watcher 探测；能建立且没有错误就用原生事件（`usePolling: false`），否则降级为轮询并打一行说明日志。探测不得写入 `~/.claude` 等用户数据目录。
2. 轮询降级时的间隔按被跟踪文件数退避：下限保持 6000ms（即今天的行为），随文件数增长上调，有上限；具体系数由实测推出，不凭感觉。
3. 原生事件路径下，watcher 的 `error` 事件（例如 ENOSPC）必须触发降级为轮询，而不是只打日志后从此失聪。
4. 已知耦合：`server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 里复制了 watcher 的 `usePolling`/6000ms/`depth` 选项来当「观察者」，其判据（静默 >6500ms、写入与加载事件间隔 >6000ms）建立在 6 秒轮询周期上。watcher 默认改变后，这些前提要同步：轮询臂显式固定 `CLOUDCLI_WATCHER_MODE=poll`，并新增原生臂，不得删除或放宽既有断言。
5. 同步更新 `docs/architecture/03-conversation-handoff.md` 里 watcher 一段。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sessions-watcher-mode.test.ts` 退出 0：(a) `resolveWatcherMode` 的表驱动用例——`auto`/`native`/`poll` × 探测成功/失败，产出的 `usePolling` 与间隔符合预期；`native` 在探测失败时不静默降级而是报错；(b) 退避函数在文件数 0、1000、5000、50000 处单调不减，下限恰为 6000ms，上限被夹住；(c) 未知的 `CLOUDCLI_WATCHER_MODE` 取值回落到 `auto` 并打一行日志。
- [ ] 同一测试文件的真文件系统用例：在临时根目录建一个 jsonl，原生模式下 `add` 事件在 2 秒内到达；`poll` 模式下在「间隔 + 1 秒」内到达；两条都断言收到的是同一路径。
- [ ] 同一测试文件的降级用例：向原生 watcher 注入一个 `ENOSPC` 错误事件，断言 watcher 切换为轮询并且此后追加文件仍能被观察到（防止「报错后失聪」）。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 退出 0：轮询臂固定 `poll` 后既有断言全部保留，新增原生臂通过。
- [ ] `npm run typecheck` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：要有前后对照读数，不是「多了一个模式」。在同一台机器上，用一个 5000 文件的合成 `~/.claude/projects` 树（放在临时 HOME，**不得触碰真实的 `~/.claude`**），分别以 `poll`（今天的行为）与 `native` 启动真实 server 的 watcher，各空闲 60 秒，用 `/proc/<pid>/stat` 的 utime+stime 差读 CPU 时间，并读初始同步的 RSS 峰值与耗时；把两组读数、退避系数的推导写进 Evidence。CPU 读数不进 AC（它随宿主负载漂移，进 AC 会造成假红），只作 DoD 证据。另在真实语料（本机 882MB 的项目目录）上确认原生模式下会话仍被同步、`session_upserted` 仍被广播。**实施者须回答并记录**：原生事件在 Docker 挂载卷与网络文件系统上是否可靠；若无法验证，明确写「未证」并保留 `CLOUDCLI_WATCHER_MODE=poll` 作为逃生口。实施时按 `.agents/skills/backend-module-standards/SKILL.md` 的模块与 barrel 规范落位。

该轴仍暗，理由：纯服务端文件监听，没有可独立度量的 L_D/L_G 读数；验收以上面的集成用例与前后对照读数为准。

## Touches

- server/modules/providers/services/sessions-watcher.service.ts
- server/modules/providers/tests/sessions-watcher-mode.test.ts (new)
- server/modules/debug-agent/tests/debug-agent-external-write.test.ts
- docs/architecture/03-conversation-handoff.md
- tasks/gap-session-watcher-native-or-adaptive-poll.md
