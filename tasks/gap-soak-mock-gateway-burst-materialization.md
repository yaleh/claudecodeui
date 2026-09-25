---
id: gap-soak-mock-gateway-burst-materialization
title: soak 装置上限：mock gateway 物化 burst，`--burst-mb` 一超 ~48MiB 就自己 OOM，慢客户端假设无法在有效量级上驱动
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景：`gap-server-soak-harness<!-- dedup-ref:inline -->` 交付的 soak 装置要回答「websocket 慢客户端是否造成服务端发送缓冲无界增长」。装置的两臂已跑通：`--slow-client-drains` 对照臂读到 `slowClientDrainedBytes=103,460,364`（48MiB 载荷被真实推送）——正对照成立；但两臂的 120s 峰值 RSS 是 4348.63MiB（不读）对 4727.91MiB（读走），差 379MiB，**远大于被测量级 48MiB**，且在 48MiB 上 raw RSS/heap 背板已因 churn 判红。即：在可驱动量级上只能得到「证伪」，得不到「证实」。

机制（成因，已定位）：`scripts/soak-driver.mjs` 的 `runMockGateway` 先把整个 burst **物化**成事件数组（每个 4KiB delta 一个 JS 字符串）再一次写出。`--burst-mb 512` 时 gateway 自己先 `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`（4095MiB），server 随即 `ECONNREFUSED`，只起了 27 个会话，该臂读数作废（`slow-hyp.log`）。因此装置自身上限 ≈ 48MiB，而慢客户端假设要判定「无界」必须让被测载荷超过 churn（≳512MiB）。

方案（只改 soak 装置，不动服务端）：
1. `runMockGateway` 改为**流式生成** burst：固定头部事件照旧，delta 事件逐块写并对 `res.write()` 的背压 `await once(res,'drain')`，使 gateway 的内存占用与 `--burst-mb` 无关。事件形状（SDK 读取的 SSE 形态）必须与现在逐字节一致。
2. 重跑两臂（`bash scripts/soak.sh --duration 120 --burst-mb 512 --report …` 与同一命令加 `--slow-client-drains`），在载荷 > churn 的量级上读差。
3. 文档 `docs/operations/process-isolation-and-memory-caps.md` 的「The slow-client hypothesis: a pair of runs, and where the instrument stops」一节按新上界改写：把「装置上限 ~48MiB / 未能驱动」换成新读数与新结论。

## AC

- [ ] `bash scripts/soak.sh --duration 120 --burst-mb 512 --report <tmp>` 退出码 ≠ 2（0 或 1 都算过），`<workdir>/mock.log` 不含 `Reached heap limit` 与 `out of memory`，报告里 `actions.sessionsCreated ≥ 200` 且驱动窗口样本 `n ≥ 20`。
- [ ] 同一命令加 `--slow-client-drains`：报告里 `actions.slowClientDrainedBytes ≥ 268435456`（512MiB 的一半）。当前装置在 512MiB 上根本走不到这一步（gateway 先死、会话数不够），所以这条断言本身就是「装置上限已解除」的机械证据。
- [ ] 两臂的 peak RSS / peak heapUsed / live-set 读数以 `--report` 形式落盘并写进 Evidence，并给出下列二选一的明确判定：(a) 差 ≥ 512MiB ⇒ 证实驻留；(b) 差 < 512MiB 且在 ≥3 次重复下方向一致 ⇒ 在该量级上仍为证伪。**判定与全部读数一起写出，不得只写结论。**
- [ ] `node --test scripts/soak-analyze.test.mjs`、`bash scripts/soak.sh --self-test`、`npx tsc --noEmit -p scripts/tsconfig.json`、`npm run lint` 四项退出码均为 0。
- [ ] 文档 `docs/operations/process-isolation-and-memory-caps.md` 中该节的「装置上限 ~48MiB」与「未能驱动」措辞已按新读数改写，且给出新的可驱动上界读数。

## DoD

- 至少一次 `--burst-mb 256` 与一次 `--burst-mb 512` 的真实运行（真实 server + mock gateway），两次 gateway 都全存活；把 **gateway 自身的峰值 RSS**（`/proc/<gateway pid>` 采样）与 server 两臂的峰值一并写进 Evidence——「流式化后 gateway 峰值与 burst 大小无关」是本任务的核心读数。
- 明确给出假设的三态结论之一（证实 / 证伪 / 未能驱动）并附读数；若仍未能驱动，写明新的上界与成因。
- 收尾清理所有一次性 unit 与进程（含失败路径）：`systemctl --user list-units 'claudecodeui-session-*'` 无本机残留、无 soak unit、无 mock-gateway 进程。
- 该轴仍暗，理由：装置与读数的可测性属观测/运维工作，没有可独立度量的 L_D/L_G 读数。

## Touches

- scripts/soak-driver.mjs
- scripts/soak-analyze.mjs
- scripts/soak-analyze.test.mjs
- scripts/soak.sh
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-soak-mock-gateway-burst-materialization.md

## Evidence

（尚未执行：本条为 `gap-server-soak-harness` 的 DoD-3 派生的装置上限 gap。）