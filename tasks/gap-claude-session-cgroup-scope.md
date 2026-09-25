---
id: gap-claude-session-cgroup-scope
title: 每个 Claude 会话进自己的 systemd scope 并带内存上限：失控的 claude/MCP 只杀该会话，不再拖垮 server
  所在的 cgroup
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

人（yale）2026-09-25 已批准：允许改动 provider 的 spawn 路径，用 `systemd-run --user --scope` 包装 claude；无 systemd user manager 的环境必须降级为今天的行为。

背景（2026-09-25 现场实测）：`claudecodeui-server.service` 这个 unit 里，server 自身只有约 224MB RSS，而每个 Claude 会话子树（claude 主进程加 pdf、playwright 等 MCP，外加 `npm exec` 包装进程）约 1GB，整个 unit 当时 1.35GB。server 与所有会话在同一个 cgroup 内，`memory.max = max`，所以任何一个失控的 Claude 会话或 MCP 触发的 OOM，会由内核按 unit 收走，server 一并陪葬。这是 cgroup 隔离（`ade2dfb4`）之后下一个会发生的事故形态：那次只把「测试」与「server」分开了，没有把「会话」与「server」分开。

方案：
1. 新增 `server/modules/providers/services/claude-session-scope.service.ts`，导出一个工厂，返回 SDK 的 `spawnClaudeCodeProcess` 钩子（见 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 `SpawnOptions`/`SpawnedProcess`）。钩子把命令改写成 `systemd-run --user --scope --quiet --unit=claudecodeui-session-<serverPid>-<随机> -p MemoryMax=<cap> -p MemorySwapMax=0 -- <command> <args>` 后用 `child_process.spawn` 启动，cwd、env、signal 原样透传。`systemd-run --scope` 会在同一 PID 上 exec 目标命令，所以 stdio 与退出语义不变（`scripts/with-memory-cap.sh` 已依赖这一点）。
2. 首次使用时探测一次并缓存：真实地在一个带上限的 scope 里跑一次 `true`（`systemd-run` 失败与命令失败无法靠退出码区分，探测必须是真实执行）。探测不通过时工厂返回 `undefined`，**不设置** `spawnClaudeCodeProcess`，行为与今天逐字节相同，并只打一行说明日志。
3. 上限：`CLAUDE_SESSION_MEMORY_MAX`，默认 8G（实测空闲会话子树约 1.1GB，取 7 倍以上余量；实施者用真实会话重测并写明），`off` 表示不包装。
4. 接线只在 `server/modules/providers/list/claude/claude-runtime.provider.js` 的 `mapCliOptionsToSDK`（约 220-320 行）加一处。新逻辑全部放在上面的 TS 文件里；不要往该 `.js` 里堆逻辑。
5. **必须处理的后果：scope 不在 server 的 unit cgroup 里。** 今天 `serve-scoped.sh stop` 靠 cgroup 收掉所有会话子进程；改用 scope 后它们不会被一起收掉，SIGTERM 的 `shutdownRuntimeServices`（`server/index.ts` 约 389 行）目前也不中止会话。所以要 (a) 在 `shutdownRuntimeServices` 里停掉本 server 拥有的所有 `claudecodeui-session-<serverPid>-*` scope，(b) 启动时清扫「属主 server PID 已不存在」的孤儿 scope（server 被 SIGKILL 时 (a) 不会执行），(c) 记录在案：server 重启不再顺带杀死其托管的会话。
6. 会话进程被 cgroup 上限 OOM 杀死时，SDK 侧看到的只是进程退出；用与 `scripts/test.sh` 相同的办法（`journalctl --user -u <unit>.scope | grep 'OOM killer'`）查一次，命中就打一行 console.error 点名「该会话被内存上限 <cap> 杀死」。journal 不可读时静默，属已知缺口。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-scope.test.ts` 退出 0，其中在本机**真实**使用 `systemd-run --user --scope` 的用例不得被跳过（用例内先断言探测为真，探测为假则该用例判红而不是 skip，避免在本机静默变空）：(a) 一个吃内存超过 `MemoryMax=64M` 的子进程只被它自己的 scope 杀死，同时活着的兄弟进程不受影响；(b) 钩子生成的 argv 含 `--scope`、`-p MemoryMax=`、`-p MemorySwapMax=0` 与 `claudecodeui-session-` 前缀的 unit 名；(c) cwd、env、signal 透传（abort signal 触发后子进程退出）。
- [ ] 同一测试文件的降级用例：以一个假的 `systemd-run`（PATH 前置，恒失败）跑探测，工厂返回 `undefined`，且 `mapCliOptionsToSDK` 返回的选项里**没有** `spawnClaudeCodeProcess` 键；`CLAUDE_SESSION_MEMORY_MAX=off` 同样如此。
- [ ] 同一测试文件的生命周期用例：起 3 个会话 scope，调用新导出的停止函数后 `systemctl --user list-units 'claudecodeui-session-*'` 为空；再造两个属主 PID 已不存在的孤儿 scope（unit 名里编码一个已死 PID），清扫函数只停掉孤儿、不动属主仍存活的 scope。
- [ ] 同一测试文件的 OOM 归因用例：被上限杀死的 scope 触发一条点名上限值的日志；被正常退出的 scope 不触发。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts` 与 `server/modules/providers/tests/claude-background-work.test.ts` 退出 0（既有 runtime 用例不回归）。
- [ ] `npm run typecheck` 与 `npm run lint` 退出码均为 0（含 boundaries：新文件只经模块 barrel 被外部消费；若 `server/index.ts` 需要停止/清扫函数，则通过 `server/modules/providers/index.ts` 导出）。

## DoD

真实落地判据，不是「有一个钩子」：用真实 claude 二进制与真实 SDK 在本机跑一次端到端。(1) 用临时 `DATABASE_PATH`、非 3001 端口启动一个真实 server（**不得重启 :3001**，见记忆中「会话是服务子进程」一条），经真实 WebSocket 发起一个真实会话，读到 `systemctl --user list-units 'claudecodeui-session-*'` 里出现对应 scope、`memory.max` 等于配置值、`cat /sys/fs/cgroup/.../cgroup.procs` 含 claude 及其 MCP 子进程；(2) 在该会话内让某个子进程失控吃内存（或对该 scope 设一个很低的上限重跑），读到该会话被杀、**server 进程与另一个并行会话都存活**、并出现点名上限的日志；(3) 对该 server 分别 SIGTERM 与 SIGKILL，读到前者立即无残留 scope、后者在下次启动的清扫后无残留；(4) 把 (1)-(3) 的关键读数写进 Evidence。AC 全绿但没有这次端到端操作不算完成。文档 `docs/operations/process-isolation-and-memory-caps.md` 增补「会话 scope」一节，并把其中「server 无上限」的表述与新的边界对齐。实施时按 `.agents/skills/backend-module-standards/SKILL.md` 的模块与 barrel 规范落位。

该轴仍暗，理由：纯服务端进程管理，没有可独立度量的 L_D/L_G 读数；验收以上面的集成用例与端到端运行读数为准。

## Touches

- server/modules/providers/services/claude-session-scope.service.ts (new)
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/index.ts
- server/index.ts
- server/modules/providers/tests/claude-session-scope.test.ts (new)
- server/modules/providers/tests/claude-runtime-frame-forwarding.test.ts
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-claude-session-cgroup-scope.md
