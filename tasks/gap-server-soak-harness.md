---
id: gap-server-soak-harness
title: server 长期运行 soak 装置（手动触发）：会话/连接/transcript 搅动下采样 RSS、堆、fd、线程、子进程，斜率与残留超阈值即红
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-session-cgroup-scope
---
## Proposal

人（yale）2026-09-25 裁定：soak **手动触发**，不进每次 fan-in，也不进 quay 的例行任务。

背景：本项目要长期运行，但仓库里没有任何 soak、泄漏或 RSS 采样的测试（对 `e2e/ scripts/ server/` 检索过）。`docs/operations/process-isolation-and-memory-caps.md` 里「server 从未泄漏」是缺乏观测，不是已证。已知会随时间增长的输入：`~/.claude/projects` 下 2186 个文件、882MB transcript，单个 jsonl 最大 13MB；`sessions-watcher` 持续轮询；`session-conversations-search` 有 `claudeFileResultsCache`；`shell-websocket` 的 `ptySessionsMap`；`claude-runtime.provider.js` 的 `activeSessions`/`pendingToolApprovals`/`abortedSessionIds`；websocket 服务里没有发现 `bufferedAmount` 检查（只是待验证的假设：慢客户端可能造成发送缓冲无界增长）。

方案：
1. `scripts/soak.sh`（入口）加 `scripts/soak-analyze.mjs`（纯函数分析器）加 `scripts/soak-driver.mjs`（搅动器）。用法：`bash scripts/soak.sh --duration <秒> [--report <文件>]`；`package.json` 增一个 `soak` 脚本指向它。**不得**被 `scripts/test.sh`、`npm test` 或任何 quay 例行配置引用。
2. 目标：在临时 `DATABASE_PATH`、临时 `HOME`、非 3001 端口、独立 systemd unit 下启动真实 server（不得触碰 :3001，也不得读写真实 `~/.claude`）。
3. 搅动（循环执行）：会话的创建/发送/中止；websocket 客户端的正常关闭、半开连接、以及**故意不读数据的慢客户端**；向 transcript 追加行，含一个逐步长到 100MB 的大 jsonl；触发对话搜索；shell websocket 的 PTY 开关。会话来源：优先沿用 `server/modules/launch-profiles/tests/gateway-end-to-end.test.ts` 那套 mock gateway 驱动真实 claude 二进制；不可行时写一个说 stream-json 的假 claude 可执行文件。实施者选哪条要在 Evidence 里说明，真实二进制的读数优先。
4. 采样（每 5 秒）：server 主进程的 RSS 与 `VmHWM`、V8 堆（`--expose-gc` 下 `process.memoryUsage` 需经一个只读的调试出口或 `--heapsnapshot-signal`，实施者选最小侵入的一种，且不得把调试出口留在生产默认开启）、fd 数、线程数、子进程数、server 所在 cgroup 的 `memory.current`，以及 `claudecodeui-session-*` scope 数。
5. 判据（`soak-analyze.mjs`）：预热窗口之后对每个序列做线性回归，RSS/堆斜率超过阈值即红；fd 数、子进程数、session scope 数在搅动停止并冷却后必须回到基线的容差内；判词同一行带出序列名、斜率、阈值与成因。阈值由基线运行的实测推出，不凭感觉。
6. 失败时保留现场：堆快照、最后一段采样、server.log 尾部，放在 `--report` 指定位置。

## AC

- [ ] `node --test scripts/soak-analyze.test.mjs` 退出 0：分析器用合成序列断言 (a) 平稳序列判绿；(b) 线性增长序列判红且判词含序列名与斜率；(c) 「先涨后回落」的序列判绿（防止把缓存预热误判为泄漏）；(d) fd/子进程数冷却后不回基线判红；(e) 预热窗口内的增长不计入。
- [ ] `bash scripts/soak.sh --self-test` 退出 0：对一个受控目标进程（一个每秒保留一个 Buffer 的桩）跑完整采样加分析路径，断言判红，且判词点名 RSS；再对一个平稳的桩断言判绿。这是「装置真能读到泄漏」的正对照，缺它则装置无法证明自己不是无论如何都绿。
- [ ] `bash scripts/soak.sh --duration 120 --report <tmp>` 退出 0，并且报告里每个采样序列的样本数不少于 20、含 `claudecodeui-session-*` scope 数序列；搅动器的各类动作计数均大于 0（会话数、慢客户端数、追加行数、搜索次数），任一为 0 则该次判红并点名是哪一类没跑。
- [ ] `grep -nE 'soak' scripts/test.sh package.json` 的命中只有 `package.json` 里的 `soak` 脚本项；`scripts/test.sh` 与 `.quay/config.yml` 中无 `soak` 引用（手动触发的机械证明）。
- [ ] `npx tsc --noEmit -p scripts/tsconfig.json` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：装置必须真的在真实 server 上跑出读数。要求 (1) 至少一次 30 分钟以上的 `bash scripts/soak.sh --duration 1800` 完整运行，把各序列的斜率、峰值、冷却后残留、以及阈值的推导（基线来自哪次运行）写进 Evidence；(2) 如果读数发现了真实增长，**不在本任务里修**，按机制另立 gap 任务并在 Evidence 里链接；如果没发现，如实写「30 分钟内未观察到增长」并说明这不等于长期无泄漏；(3) 报告里给出对「websocket 慢客户端是否造成发送缓冲无界增长」这一假设的明确结论（证实、证伪或未能驱动，三选一并附读数）；(4) 用读到的真实 RSS/堆峰值，回填 `gap-server-unit-restart-heap-limit` 里 2048MB 堆上限默认值是否合理的结论（只写结论与建议值，不在本任务里改脚本）。soak 用的所有临时进程与 unit 在结束后必须清理干净，包括失败路径。

该轴仍暗，理由：纯服务端长期运行观测，没有可独立度量的 L_D/L_G 读数；验收以上面的分析器用例、自检正对照与 30 分钟实跑读数为准。

## Touches

- scripts/soak.sh (new)
- scripts/soak-analyze.mjs (new)
- scripts/soak-analyze.test.mjs (new)
- scripts/soak-driver.mjs (new)
- package.json
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-server-soak-harness.md
