---
id: gap-canonical-checkout-node-modules-missing-compression
title: 主 checkout 的已安装依赖树缺 compression（已声明并入库）→ 后端起不来 → AC-101 真实浏览器判据整片转红
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
---
## Proposal

<!-- dedup-ref -->本任务与 tasks/gap-static-assets-compression（done）不是同一机制：那一个是**实现**静态资源压缩（DoD 读数真实、功能本身没问题）；本任务修的是它已提交的依赖在主 checkout 上**没有被安装**，以及由此造成的 AC-101 转红。也不与 tasks/gap-session-filter-real-browser-e2e（done）重复——那一个确实让 AC-101 转绿过（2026-09-20T19:22Z 起连续 11 次 pass），本任务是**回归修复**，不是重做。

### 现象（本轮直接复跑判据测得）

判据 `npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 1，且 spec 一条用例都没跑起来——playwright 的 webServer 起不来：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'compression' imported from
  /data/home/yale/work/claudecodeui/server/modules/static-assets/static-assets.module.ts
Error: Process from config.webServer was not able to start. Exit code: 1
```

### 证据

1. `package.json` 第 172 行声明 `"compression": "^1.8.2"`（生产依赖），`package-lock.json` 里有 `node_modules/compression 1.8.2` 及其传递依赖；但 `node_modules/compression` 不存在，`npm ls compression` 退出码非 0、输出 `(empty)`。**已提交的依赖树没有被装到主 checkout。**
2. `npm install --dry-run` 只报 7 个新增包（compression 加 on-headers / compressible / negotiator / ms / debug / @types/compression），说明补上它是一次纯增量、可离线（npm 缓存已命中）的安装。
3. 时间线（`.quay/gate-events.jsonl` 里 AC-101 的 goal gate）：最后一次 pass `2026-09-21T04:33:45Z`；`feat(static-assets): gzip/brotli the dist bundle and SPA entry`（8437e548）`2026-09-21T04:56:57Z` 提交、`05:07:38Z` 机械 fan-in 落 develop；第一次 fail `2026-09-21T05:33:59Z`。这段时间里没有别的 `server/index.ts` 改动。
4. 同一个缺失也让**该功能自己的测试**加载不起来：`npx tsx --tsconfig server/tsconfig.json --test server/modules/static-assets/tests/static-assets.test.ts` 得到 `ERR_MODULE_NOT_FOUND`、`fail 1 / pass 0`。所以 gap-static-assets-compression 自己的 AC#1（`npm ls compression` 退出码 0）在主 checkout 上**现在也是假的**——它当初是在 worker 的 worktree 里量的。
5. 因果已实测闭合：把 `compression@1.8.2` **只**注入到 import 点自己的解析路径（`server/modules/static-assets/node_modules/`，一个临时探针目录，测完已 `rm -rf`，主 checkout 的 node_modules 未被改动）后，同一条判据的 webServer 正常起来，**5 条用例全过、EXIT=0**。也就是说缺失的包是唯一的启动失败根因，spec 本身是健康的。

### 机制（为什么上一次的修复没有留住）

worker 在**任务 worktree**（`.quay/config.yml` 的 `worktree_root`）里跑测试。`dispatch-worktree-setup.sh` 给 worktree 的 `node_modules` 要么是指向仓根的符号链接、要么（仓根没有 node_modules 时）是 worktree 内 `npm install` 出来的真目录，而 `worktree-node-modules-check.sh` 把两种都判为 `OK`。于是**在 worktree 里 `npm install` 得到的依赖只存在于 worktree**：任务自己的 AC（`npm ls compression`）、它自己的测试、以及 fan-in 的全量套件（round 80：`pass 169 / fail 0`）**全部在 worktree 里量的，全部通过**；而**主 checkout 的 node_modules 自 2026-09-20 21:41 起没再被写过**，goal-sweep 又恰好在主 checkout 上复跑 AC 判据。依赖装在一边、判据跑在另一边——这不是实现缺陷，是**判据运行的 checkout 与依赖安装的 checkout 不同**。

### 修法

1. 在**判据实际运行的那个 checkout**（仓根 `/data/home/yale/work/claudecodeui`）补齐已提交的依赖树：`npm install`（或 `npm ci`）。
2. ⛔ 若改在 worktree 里装，必须先确认 `<worktree>/node_modules` 仍是指向仓根的符号链接；**在 worktree 里 `npm install` 会把该链接换成真目录**，那样装出来的依赖到不了仓根，本缺陷原样复发。稳妥做法是直接 `cd /data/home/yale/work/claudecodeui && npm install`，装完再跑一次下面的判据确认。
3. ⛔ 不得用「删掉 compression 依赖 / 去掉 static-assets 的压缩 / 把 import 改成可选」来换绿灯：那会把 gap-static-assets-compression 已完成并实测过的功能（3,061,516 字节 → gzip 886,459 字节、冷加载 11 s → 3 s）退回去。
4. 复跑判据并留输出。

### 不在本任务 AC 内、但请记入完成记录的一件事

本缺陷会复发的根因在仓外：合并进主 checkout 的动作（fan-in 的 `ff`）不会重建已安装依赖树，而主 checkout 正是判据被复跑的地方。仓内可考虑的近似防线是在 `.husky/` 的 `post-merge` 里加一条「package-lock.json 变了就跑 `npm install`」（仓根 `core.hooksPath=.husky/_`，钩子确实生效）。它**不作为本任务的 AC**：fast-forward 合并是否触发 `post-merge`、以及它会不会给每次合并都加上安装开销，都需要先单独实测；用一个未经验证的钩子当防线，会变成「机制存在」式的弱判据。请只在完成记录里如实登记这条建议与你是否试过。

## AC

- [ ] 仓根的已安装依赖树自足：在 `/data/home/yale/work/claudecodeui` 下 `node -e "require.resolve('compression')"` 退出码 0，且 `npm ls compression` 退出码 0（当前两者都非 0，输出 `(empty)`）。
- [ ] 后端在该 checkout 上真能启动：`npx tsx --tsconfig server/tsconfig.json --test server/modules/static-assets/tests/static-assets.test.ts` 退出码 0（该文件此前因同一缺失 `fail 1 / pass 0`）。
- [ ] AC-101 判据本身转绿：`npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 0，且输出显示 `5 passed`（真实 Chromium + playwright webServer 启动的真实服务与隔离数据目录）。
- [ ] 换的是依赖不是功能：`grep -c "import compression from 'compression'" server/modules/static-assets/static-assets.module.ts` 输出 1，且 `git diff --exit-code develop...HEAD -- e2e/session-filter.spec.ts` 退出码 0（spec 一字未改）。
- [ ] `npm run typecheck` 与 `npm run lint` 退出码 0（补齐依赖不引入回归）。

## DoD

真实落地判据：**在 goal-sweep 实际复跑 AC 的那个 checkout（仓根 `/data/home/yale/work/claudecodeui`）上**，`npm run test:e2e -- e2e/session-filter.spec.ts` 真绿，并把该次运行的输出（`5 passed` 那几行）记入任务的完成记录。这不是「文件存在」「脚本 exit 0」式的弱判据：判据本身就是真实浏览器驱动真实服务。取假形态：只把 `compression` 装进 worktree（或把 worktree 的符号链接换成真目录后再在其中安装）时，仓根上 `node -e "require.resolve('compression')"` 仍非 0、判据仍红——本任务必须让**仓根**自足。若在补齐 compression 之后发现还有别的启动失败项，一并记录并修复，不得只报第一个。

L_D 该轴仍暗，理由：本任务是环境/依赖树修复，不新增领域能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上；本任务的验证读数就是判据的 5 passed 与依赖解析的退出码。

## Touches

- tasks/gap-canonical-checkout-node-modules-missing-compression.md
- package.json
- package-lock.json
- e2e/session-filter.spec.ts
