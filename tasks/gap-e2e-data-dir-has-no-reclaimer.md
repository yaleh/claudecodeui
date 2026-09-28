---
id: gap-e2e-data-dir-has-no-reclaimer
title: e2e 运行目录没有回收者（24h 内 1794 个 / 103G）耗尽用户配额 ⇒ 判据在启动前以 EDQUOT(errno −122)
  死、读起来像 AC-153 为假；给数据目录加有界保留（TTL + 清扫）并重测判据为绿
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-153
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-28T13:05:56Z，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `a273da48b194202a9892fa9738da037f2e36b6bf`）：`grep -rn "^goal_ac: *AC-153" tasks/*.md` → 2 命中，两条都是 `done`（`gap-voice-error-notice-browser-e2e`、`gap-ac153-ledger-red-is-host-quota`），全量 228 条 `tasks/*.md` 里没有第三条，`for f in tasks/*.md` 扫 `todo|ready|needs-human` 也**没有任何在飞认领者**。按「更早的修复没守住 ⇒ 立新条」的默认读法立案。与它**同机制**的相邻任务只有 `gap-e2e-data-dir-lands-on-a-full-root-fs`（AC-122，done：给数据目录的**选择**加余量地板，`scripts/e2e-data-dir-selection.mjs`）；那条的模块注释白纸黑字把**回收**让了出去（见下），本条认领的正是它让出的那一格，不是它的重做。

### 一、本轮的直接测量：判据死在**启动前**，不是 AC-153 的行为退化

我在同一 checkout 上直跑判据本体（不是读台账尾巴），`date -u` = `Mon Sep 28 01:05:56 PM UTC 2026`，`git rev-parse HEAD` = `a273da48b194202a9892fa9738da037f2e36b6bf`：

```
$ npx playwright test e2e/voice-error-messages.spec.ts
Error: Unknown system error -122: Unknown system error -122, open
  '/data/scratch/yale/playwright-transform-cache-1004/99/991a22c72e_c6fd304_e2edatadirselection.map'
    at Object.writeFileSync (node:fs:2482:20)
    at addToCache (…/node_modules/playwright/lib/common/index.js:162:27)
    at loadUserConfig (…/index.js:1268:52)
    ... errno: -122, syscall: 'open'
EXIT=1
```

失败点是 Playwright **加载自己的配置文件时写 transform cache**，连 `playwright.config.ts` 都没加载完 —— **一个测试用例都没开始跑**。errno −122 是 Linux 的 `EDQUOT`（**用户配额耗尽**，不是容量）。这条红与 AC-153 的浏览器行为无关。

**立案动作本身也被它打死了**：随后 `task_write` 落库时返回 `Unknown system error -122: … open '/data/home/yale/work/claudecodeui/tasks/gap-e2e-data-dir-has-no-reclaimer.md.lock'` —— 连任务文件的锁都创建不出来。为了把这条任务立起来，本轮的立案者**先手工回收了最老的 400 个运行目录**（`find -maxdepth 1 -type d -name 'quay-e2e-*' -mmin +60 | sort -n | head -400 | xargs rm -rf`）：`ls | wc -l` `1791 → 1391`、`du -sh` `103G → 88G`，之后 `task_write` 才成功。这既是本条的现场证据，也说明**只靠人工 `rm` 不是解法**（下一节 AC 要把它接成运行路径上的一次有界清扫）。

**同一条判据上一次真的跑起来时是绿的，而且此后源码一个字节没动。** `f9c996a4..HEAD` 只改了 `tasks/gap-ac153-ledger-red-is-host-quota.md` 一个文件（`git diff --name-only f9c996a4..a273da48` 就这一行）：`gap-ac153-ledger-red-is-host-quota` 的完成记录里逐字抄着判据当天的全套读数（`legs=4 passed=4 criterion-wall-ms=24906`、`coded=4 chinese=4`、`visible-after-4s=true`、`text-unchanged=true`、`closed=true`、`cleared-on-next-recording=true`、`drafts-kept=4/4 notices-shown=4/4`、`collapsed-hides-code=true`、`expanded-shows-status=true`、`expanded-shows-upstream=true`、`concat-hits=0`、`equal=true both-equal-vocab=true`，`1 passed (24.8s)`）。**判据的绿色对象没变，变的是它能不能启动。**

台账侧同形。`.quay/gate-events.jsonl` 里 AC-153 的 `gate=goal` 读数共 **1795** 条，尾巴是 **10 连 `pass`**（`2026-09-27T22:52:37Z` → `2026-09-28T11:17:15Z`）之后接两条 `fail`：

```
2026-09-28T13:03:17.810Z  goal-sweep  fail  ENOENT .env + copyfile 'database/auth.db' -> '~/.cache/quay-e2e-tmp/…/auth.db'  (Unknown system error -122)
2026-09-28T13:04:52.286Z  goal-cli    fail  mkdtemp '~/.cache/quay-e2e-tmp/quay-e2e-XXXXXX'  (Unknown system error -122)
```

两条 `fail` 的失败点是 **`copyfile` / `mkdtemp`**，都发生在判据启动**之前**；加上我自己那条（`open` transform cache）与本轮立案那条（`open … .lock`），四条落在**四个不同的路径**上，errno 都是 −122 ⇒ 这是**用户配额**整体耗尽，不是某一个目录满了。

### 二、触发源：`~/.cache/quay-e2e-tmp` 没有回收者，24 小时堆了 103G

```
$ ls ~/.cache/quay-e2e-tmp | wc -l        → 1793   （本轮立案者回收 400 个之后 1391）
$ du -sh ~/.cache/quay-e2e-tmp            → 103G   （回收后 88G）
$ find ~/.cache/quay-e2e-tmp -maxdepth 1 -type d -mtime -1 | wc -l  → 1794
$ find ~/.cache/quay-e2e-tmp -maxdepth 1 -type d -mtime +1 | wc -l  → 0
$ df -h /data                             → /dev/vdb 4.0T 717G 3.3T 18%   (容量不紧张 ⇒ df 对 EDQUOT 无读数)
$ du -sh ~/.cache/* | sort -h | tail -2   → 4.5G ac122-tmp / 103G quay-e2e-tmp   (占 ~/.cache 108G 的 95%)
```

**全部 1794 个目录的 mtime 都在最近 24 小时内**：这是纯粹无人回收的累积速率（约 100G/天），不是历史遗留。上一轮立案时（2026-09-27T21:17Z）同一目录是 **572 个 / 25G** —— 16 小时翻了两番，与「每次 e2e 跑完都把 data dir 留在原地」一致。

**没有任何回收者，而且是设计上让出去的**：`scripts/e2e-data-dir-selection.mjs` 的模块注释逐字写着

> Recycling the directories an earlier run left behind is deliberately not this module's job (a run that cannot start is the condition worth failing on; **housekeeping is a separate concern**)

而那个「separate concern」**至今不存在**：在 `scripts/*.mjs`、`e2e/*.ts`、`package.json` 的 scripts 里 grep `reclaim|retention|TTL|maxAge|rmSync|rm -rf` 对 `quay-e2e-tmp` 的删除路径，一处都没有（命中的 `rmSync` 全是各脚本自己临时目录的自清理）。`scripts/e2e-data-dir-selection.test.mjs` 的 15 个用例也没有任何一条钉住「不回收」——**加回收不会与既有不变量冲突**。

### 三、为什么更早的修复没有守住

上一轮 `gap-ac153-ledger-red-is-host-quota`（`done`）是 **verification-only**：它把判据直跑读数与「宿主启动死 ≠ 判据假」的判法入档，并在 AC6 里明确写「该根因的修复属于**另一条任务**，本条只登记、不在这里夹带」。**那条「另一条任务」从来没有被立案**（`ls tasks/ | grep -i "reclaim\|retention\|reclaimer"` 为空）。于是触发源原封不动留在这里：16 小时后同样的签名复发，而且落到了**第四个**路径上（`/data/scratch/yale/playwright-transform-cache-*`，以及 `.lock`）。只登记不修根因，台账就会一直回到红 —— 本条要断的就是这个循环。

### 四、本条的交付面

给 e2e 数据目录一个有界保留（bounded retention）：**回收逻辑归属由模块注释让出的那个「separate concern」**，即一个**新模块** `scripts/e2e-data-dir-retention.mjs`（纯决策函数 + 薄清扫入口），**不改** `scripts/e2e-data-dir-selection.mjs` 的选择语义（它的注释「recycling is not this module's job」在新布局下仍然成立，因为它说的正是「不是本模块的事」，不是「没人该做」）。清扫在 **owner 路径**上挂一次（`playwright.config.ts` 里 `isDataDirOwner` 为真、即真正选目录的那次调用），并提供一个手动入口（`npm run e2e:reclaim`）供操作者与判据直接测量。

**形态约束（这几条是安全边界，不是风格）**：

- **TTL 有界且可覆盖**：只有 mtime 早于 TTL 的目录才可回收，默认 TTL **不小于 6 小时**（远长于任何一次运行），并像既有的 `QUAY_E2E_DATA_DIR_MIN_FREE_MB` 一样由环境变量覆盖 —— 是读数，不是埋在代码里的常量。
- **TTL 读不出来就不删**（fail-closed 落在「不删」一侧）：`0` / 非数 / 负值一律不回收，而不是退化成「删掉一切」。
- **前缀与排除集**：只回收父目录下匹配运行目录前缀（`quay-e2e-`）的项；**绝不**碰名字不匹配的项（别的工具的缓存就在同一父目录旁边），也**绝不**回收本次运行正在用的那一个（`QUAY_E2E_DATA_DIR` 指向的目录）。
- **best-effort、绝不致命**：清扫失败只记一行，不得让运行以非零退出（今天的红恰恰是「基础设施把判据打死」，不能换成另一个同形）。
- **不动邻居**：`~/.cache/ac122-tmp`、`/data/scratch/yale`、其他用户的目录一律不碰；只动选择器自己会创建的那一个父目录下的、超过 TTL 的运行目录。

### 五、非目标

- 不改 `scripts/e2e-data-dir-selection.mjs` 的选择语义与它的 15 个既有用例（余量地板、候选顺序、拒绝文本都不动）。
- 不改任何 e2e spec、不改应用实现、不改 `e2e/voice-error-messages.spec.ts`（本条只跑它）。
- 不改 `~/.cache/ac122-tmp` / `/data/scratch/yale` 的保留策略（各归各的任务）。
- 不把 TTL 做成「每次跑之前清空一切」：`QUAY_E2E_DATA_DIR` 显式指定的目录必须原样活着（`playwright.config.ts:57-61` 的 owner 语义），否则 worker 重评估时会把自己的数据清掉。
- 本轮立案者那次手工 `rm -rf`（400 个）**不是**本条的交付物，只是让任务文件写得进去的前置动作；本条要交付的是**运行路径上的有界清扫**，不是又一次手工删除。

## AC

- [ ] AC1 回收决策是**纯函数**且被单测钉住：`node --test scripts/e2e-data-dir-retention.test.mjs` 退出 0，用例各自打印自己的名字，至少覆盖 `keeps-entry-younger-than-ttl`（比 TTL 新的目录**不**进回收集）、`selects-entry-older-than-ttl`（比 TTL 旧且前缀匹配 ⇒ 进回收集）、`never-selects-non-run-dir-name`（名字不匹配的运行旁目录**永不**进回收集）、`never-selects-the-excluded-current-dir`（排除集里的目录即使超龄也不进）、`invalid-ttl-selects-nothing`（TTL 为 `0`/非数/负数 ⇒ 回收集为空，fail-closed 落在不删一侧）、`missing-parent-is-empty-not-throwing`（父目录不存在 ⇒ 空集且不抛）。完成记录里逐字抄 runner 的汇总行与 `EXIT=0`，并逐条指出通过的名字。
- [ ] AC2 清扫**真的**回收了，读数前后成对：在同一 checkout 上跑手动入口（`npm run e2e:reclaim`，退出 0），逐字给出跑动前后的 `ls ~/.cache/quay-e2e-tmp | wc -l` 与 `du -sh ~/.cache/quay-e2e-tmp` 与 `df -h /data`，以及入口自己报告的回收获数与被回收字节数；要求**回收后目录数不高于回收前的 10%**、并给出回收后的空余读数（`[e2e]` 行里的 `free-bytes=` 或 `df`）。同时给出 `date -u` 与 `git rev-parse HEAD`。
- [ ] AC3 **判据直跑为绿**：回收之后 `npx playwright test e2e/voice-error-messages.spec.ts` 退出 0；把判据自己打印的读数行**逐字**抄进完成记录，必须至少包含 `legs=4 passed=4`、`coded=4`、`chinese=4`、`visible-after-4s=true`、`text-unchanged=true`、`closed=true`、`cleared-on-next-recording=true`、`drafts-kept=4/4`、`notices-shown=4/4`、`collapsed-hides-code=true`、`expanded-shows-status=true`、`expanded-shows-upstream=true`、`concat-hits=0`、`equal=true`、`both-equal-vocab=true`，以及 `[e2e] data-dir=… free-bytes=… min-free-bytes=…` 那一行与 `EXIT=0`；同时给出跑动时刻（`date -u`）与 `git rev-parse HEAD`。⛔ 不得用组件层 jsdom 的绿替代浏览器层的绿。
- [ ] AC4 清扫的**副作用面**由夹具钉死（纯决策之外的那一半）：在一个临时父目录里造 `quay-e2e-OLD`（mtime 30 天前）、`quay-e2e-FRESH`（现在）、`notours`（mtime 30 天前，名字不匹配）三项，把 `quay-e2e-FRESH` 作为排除集，跑清扫后断言并打印：`old-run-dir-removed=true`、`fresh-dir-survives=true`、`non-run-dir-name-survives=true`、`excluded-dir-survives=true`；夹具父目录用后即删。
- [ ] AC5 既有选择器零回归：`node --test scripts/e2e-data-dir-selection.test.mjs` 退出 0（15/15），且 `npx tsc --noEmit -p tsconfig.json` 退出 0（`playwright.config.ts` 在本条 Touches 内，必须仍能通过类型检查）。两条命令的退出码与汇总行逐字入档。
- [ ] AC6 台账尾巴如实登记：landing 后读 `.quay/gate-events.jsonl` 里 AC-153 的 `gate=goal` 读数，打印总条数与尾巴 `verdict` 序列。若出现新的 `verdict=pass`，逐字抄它；若 driver 的独立复核尚未发生，**逐字写明「台账尾巴仍是 fail」**并附上 AC3 的直跑读数。⛔ 不得把它写成已通过，⛔ 不得拿 AC1/AC4 的单元绿替代浏览器层的绿。

## DoD

- 判据本体（真实浏览器 spec）在**回收过、配额已缓解**的宿主上被**真的跑过一次**，它自己打印的读数行逐字入档 —— 不是「台账里有 pass」，也不是复述 expect 的文字；并且同一次交付里给出「源码自上次为绿以来未变」的机械证据（`git diff --name-only <绿的那次 HEAD>..HEAD`）。
- 清扫被**真的跑过一次**：回收前后的目录数与字节数是同一 checkout 上的成对读数；且**一次清扫前刚创建的目录在清扫后仍然活着**（AC4 的夹具或宿主上的等价读数），证明这不是「把父目录清空」。
- 触发源是被**接线**断掉的，不是靠一次手工 `rm`：运行路径上（owner 路径）有清扫，因此累积不会静默恢复；TTL、排除集、失败不致命这三条安全边界由 AC1/AC4 的可执行读数钉住，而不是由散文保证。
- 交付物只动 Touches 列出的文件；`~/.cache/ac122-tmp`、`/data/scratch/yale`、其他用户的目录一个字节未动，`scripts/e2e-data-dir-selection.mjs` 的选择语义一个字节未改（AC5 的 15/15 即是机械证明）。

## Touches

- tasks/gap-e2e-data-dir-has-no-reclaimer.md
- scripts/e2e-data-dir-retention.mjs (new)
- scripts/e2e-data-dir-retention.test.mjs (new)
- playwright.config.ts
- package.json
