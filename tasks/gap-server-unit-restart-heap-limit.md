---
id: gap-server-unit-restart-heap-limit
title: :3001 server unit 化收尾：崩溃自动拉起、V8 堆上限让泄漏变成「重启」而不是「换页拖死宿主」
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景：`scripts/serve-scoped.sh`（`ade2dfb4`）把 server 放进独立的瞬态 unit，解决了「别人的 OOM 波及 server」。但对「本项目需要长期运行」还差两块：(1) 该 unit 没有 `Restart=`，server 一旦崩溃或被 OOM 杀，就一直停着，直到有人发现；这正是 9/25 那次「server.log 戛然而止、没有崩溃行」之后只能靠人肉发现的原因。(2) server 没有 V8 堆上限，宿主 252G，真有泄漏时会一路涨到把宿主拖进换页（宿主 swap 当下已用 14.7G/16G），而不是在一个可预期的点上崩溃并被重启。

现场读数（2026-09-25）：server 进程刚启动约 224MB RSS、11 个线程、28 个 fd。**没有任何长时间读数**，「server 从未泄漏」目前是缺乏观测而非已证；上限值因此先取保守默认并可覆盖，等 soak 读数出来再收紧。

方案（只改 `scripts/serve-scoped.sh` 与文档）：
1. 给 `systemd-run` 加 `--property=Restart=on-failure`、`RestartSec=5`，并限制重启风暴（`StartLimitBurst`/`StartLimitIntervalSec`，风暴时停止重启并留下可读的失败状态，不无限循环）。正常 `stop` 不属于失败，必须不触发重启。
2. 通过 `--setenv=NODE_OPTIONS=--max-old-space-size=<MB>` 给 server 加堆上限，默认 2048，`QUAY_SERVER_HEAP_MB` 覆盖，`off` 不加。上限触发后 Node 以非零退出，由 1 拉起。要保留调用方已有的 `NODE_OPTIONS`（追加而非覆盖）。
3. `status` 子命令补充输出：重启次数（`NRestarts`）、当前 `MemoryCurrent`、`MemoryPeak`，便于一眼判断是否在悄悄重启。
4. 不给 server 加 `MemoryMax`，与文档原有立场一致：上限会让 server 成为 OOM 受害者而非旁观者。会话已由另一任务移出该 cgroup 之后，若 soak 读数显示需要，再单独加一个宽松的 `MemoryHigh`。
5. 为了让脚本可被测试，允许新增一个最小的环境变量接缝（例如 `QUAY_SERVER_CMD` 覆盖被托管命令，默认仍为 `npm run server`）；不得改变默认行为。

## AC

- [ ] `bash scripts/serve-scoped-check.sh` 退出 0：用假的 `systemd-run`（PATH 前置，记录 argv 到文件）跑 `start`，断言 argv 含 `Restart=on-failure`、`RestartSec=`、`NODE_OPTIONS=` 且其值含 `--max-old-space-size=2048`；`QUAY_SERVER_HEAP_MB=off` 时不含该参数；调用方已有 `NODE_OPTIONS=--trace-warnings` 时结果同时含两者。任何一项不满足，判词在同一行带出实际 argv。
- [ ] 同一脚本的真机段：用真实 `systemd-run --user` 起一个一次性 unit（`QUAY_SERVER_UNIT` 取带随机后缀的名字，命令为 `node -e "setInterval(()=>{},1000)"` 一类的存活桩），对其主进程 `kill -9`，15 秒内该 unit 回到 active 且 `MainPID` 已变、`NRestarts` 为 1；对另一个同样的 unit 执行 `serve-scoped.sh stop`，之后 `NRestarts` 仍为 0 且 unit 不再存在。收尾必须清理这些一次性 unit，包括失败路径。
- [ ] 同一脚本的堆上限段：以桩命令 `node -e` 不断保留对象，在真实 unit 里带默认 `NODE_OPTIONS` 运行，断言它在有限时间内以非零退出并被拉起一次（读到 `NRestarts` ≥ 1），且整个过程中该 unit 的 `MemoryPeak` 不超过堆上限的 2 倍。
- [ ] `node --test scripts/serve-scoped-check.test.mjs` 退出 0：覆盖上面各分支的判词（含「无 systemd user manager 时脚本给出明确报错而不是静默」）。
- [ ] `bash scripts/serve-scoped.sh` 无参数仍以退出码 2 打印 usage；`status` 输出含 `NRestarts`（真机段里验证）。
- [ ] `npx tsc --noEmit -p scripts/tsconfig.json` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：不是脚本多了几个 `--property`。要求在**非 3001** 端口与临时 `DATABASE_PATH` 下，用改好的 `serve-scoped.sh` 真实起一个 server unit（**不得重启 :3001**，也不得在 server 托管的会话里执行 stop/restart，见记忆条目），读到：正常提供 `/api` 响应；对其主进程 `kill -9` 后自动恢复并再次响应；把堆上限压到一个很小的值重跑，读到堆耗尽退出并被拉起；`status` 输出里的 `NRestarts`。把这三次读数写进 Evidence，并在文档 `docs/operations/process-isolation-and-memory-caps.md` 里更新「server 有意不设上限」一节：说明现在的策略是「重启 + 堆上限」而不是 cgroup 上限，以及 2048 是保守默认、待 soak 读数收紧。**没有做的事要写明**：server.log 的轮转与降噪（当前 4729 条多行的同步日志、无轮转）不在本任务内。

该轴仍暗，理由：纯运维脚本，没有可独立度量的 L_D/L_G 读数；验收以上面的脚本判据与真机读数为准。

## Touches

- scripts/serve-scoped.sh
- scripts/serve-scoped-check.sh (new)
- scripts/serve-scoped-check.test.mjs (new)
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-server-unit-restart-heap-limit.md
