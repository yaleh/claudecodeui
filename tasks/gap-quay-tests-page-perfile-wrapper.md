---
id: gap-quay-tests-page-perfile-wrapper
title: scripts/test.sh：把 server node:test + client vitest + typecheck + lint 接入
  quay tests 页（文件粒度）
status: ready
needs_human_cause: unclassified
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状：`loop.test_command` 为 `npm test`，只跑 `server/**` 的 node:test；前端 vitest（`npm run test:client`）、typecheck、lint 对 quay fan-in 不可见；项目没有 `scripts/test.sh`，quay 的 tests 页（读 `.quay/verification-round.jsonl`，由 full-suite-runner 解析 suite 日志生成）拿不到逐文件明细。

方案（不改 quay 代码，只改本项目）：新增 `scripts/test.sh` 作为 quay fan-in 入口。
1. 参数容忍：按 quay 文档的 case 块消费 `--buckets|--root|--state-dir|--runner|--log-file|--run-id`（shift 2）、`--test-concurrency=*`（shift，转给 node:test 的并发参数）、其他未知 flag 忽略；位置参数若指向不存在的文件必须报错退出，不得静默跳过。
2. 依次执行：typecheck（`npm run typecheck`）、lint（`npm run lint`）、server 测试（`tsx --test`，每个测试文件单独统计耗时与结果）、client 测试（`vitest run --reporter=json`，取每个测试文件的耗时与状态）。任一阶段失败整体退出码非零，但其余阶段仍继续跑完，以便页面展示完整结果。
3. 文件粒度输出：对 server 与 client 的每个测试文件各打印一行 `__PERFILE__ duration_ms=<ms> <相对仓库根路径> passed=<true|false> end_ms=<epoch ms>`（duration 必须 >0；路径用相对路径以便 /tests/file 链接可用）。typecheck 与 lint 各作为一条伪文件记录（如 `typecheck` / `lint`）同样输出 `__PERFILE__` 行。
4. 汇总：末尾打印合并后的 `# tests N`、`# pass N`、`# fail N`、`# cancelled N`（覆盖 server+client+typecheck+lint 各一项计数），并为失败项打印 `not ok - <文件或阶段>: <首条错误>` 行，使失败详情有内容。
5. 配置：`.quay/config.yml` 的 `loop.test_command` 改为 `bash scripts/test.sh`（保留该键，quay 用它判断写者已接入）。

## AC

- [x] `bash scripts/test.sh --buckets x --root . --state-dir .quay --runner inner --log-file /tmp/l --run-id r --test-concurrency=2` 不因这些参数报 "Could not find"（用一个只跑 --help 或极小子集的 dry 模式/环境变量验证参数消费，退出码 0 或仅因真实测试失败而非零）。
- [x] `bash scripts/test.sh nonexistent.test.ts` 以非零退出并输出 "test file not found"（不存在的位置参数是错误而非跳过）。
- [x] 完整运行日志中 `grep -c '^__PERFILE__ duration_ms=' <log>` 不小于 server 与 client 测试文件总数之和（`find server src shared -name '*.test.*' | wc -l`），且每行匹配 `^__PERFILE__ duration_ms=[0-9.]+ \S+ passed=(true|false) end_ms=[0-9]+$`。
- [x] 日志末尾含 `# tests`、`# pass`、`# fail`、`# cancelled` 四行，且 tests = pass + fail + cancelled。
- [x] 人为让一个测试失败（临时改坏一个断言）后，脚本退出码非零，日志出现对应 `not ok` 行且该文件的 `__PERFILE__` 为 `passed=false`；还原后恢复为零。
- [x] 覆盖脚本行为的测试文件（见 Touches）通过 `npm test`。
- [ ] 用 quay 的 full-suite-runner（或一次真实 fan-in）跑一轮后，`.quay/verification-round.jsonl` 最新一行含 `perFile`（数组长度与上面 PERFILE 行数一致）、`pass`/`fail`/`tests` 数值，且 `curl -s localhost:<quay serve port>/tests` 页面出现逐文件表。

## DoD

真实落地判据：在本仓库通过 quay 的机械 fan-in（或 full-suite-runner）实际跑一轮，`.quay/verification-round.jsonl` 新增一行且其 `perFile` 同时包含 server 与 client 的测试文件、计数覆盖前后端及 typecheck/lint；打开 quay 的 `/tests` 页能看到该轮的逐文件表、甘特图与失败详情（如有），并能点进 `/tests/file?path=…`。仅有脚本或测试文件存在不算完成。

## Touches

- scripts/test.sh
- .quay/config.yml
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-quay-tests-page-perfile-wrapper.md
