---
id: gap-session-filter-criterion-bounded-boot-guard
title: AC-101 判据的启动阶段无界：一次渲染器侧模块加载中断（net::ERR_NETWORK_CHANGED，实测 10 连发 / 5 个模块同时
  ERR_FAILED）被拖到 55s 自带看门狗 SIGKILL 记红——本族既有的有界预热+启动探针只活在三份 spec 里，未回灌到
  e2e/session-filter.spec.ts
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

来源：本轮 gap-filing 的直接测量，不是台账尾巴。AC-101 已离开 reverify 范围、台账尾部记为
CURRENTLY FALSE，本轮在立案前又直接重跑了判据本身一遍。

判据命令（不变）：`npm run test:e2e -- e2e/session-filter.spec.ts`；门限仍是 driver-anchor 下
`runAcceptance({ timeoutMs: 6e4 })` 的硬 60s。

**两次红的原始读数**（读的是失败轮的 trace，不是台账 `reason` 里那条 stderr 尾巴）：

- 轮 `quay-e2e-KrUH9q`：`t=3737 [vite] connecting/connected` → **`t=6949–6952` 一次 10 连发的
  `net::ERR_NETWORK_CHANGED`** → `t=8183 SW registered` 之后页面再无可用内容。死在 `beforeAll`
  的 onboarding：`locator.fill … waiting for locator('#username')`，记为 `Error: Channel closed`。
- 轮 `quay-e2e-psHPZt`：第一次 boot 正常（`t=5408` 连上、`t=14772` React DevTools、`t=15148` SW）。
  `t=17022` 出现第二次 `[vite] connecting` —— 即 `beforeAll` 第 171 行那次 `page.reload()` ——
  `t=17932` 应用自身的 5 个模块 URL 同时 `net::ERR_FAILED`（`Network.loadingFailed` 侧即
  `net::ERR_NETWORK_CHANGED`），`t=17952 SW registered` 之后再无可用内容；`expandProject()` 的
  `projectRow().click()` 无界等待，`t=55517` 的 `[vite] server connection lost` 是自带看门狗
  SIGKILL 掉 vite 服务的回声。

**整轮读数对照**：两次红 ≈55.4s / 55.6s —— 正是 `playwright.config.ts` 的
`RUN_CEILING_MS = 55_000`（启动阶段对应 `BOOT_CEILING_MS = 40_000`）；通过轮 35.1s / 29.7s，
round-104 recheck 23.6s。两次红都死于启动阶段，5 个用例一个都没跑到。

**已排除（都量过，不要再走一遍）**：不是冷预打包降级 —— 四次运行的 `vite-cache/deps` 文件数都是
2334，与共享缓存一致；不是磁盘（`/data` 剩 3.6T）；不是 cgroup（scope `memory.max=max`、
`oom_kill 0`）；不是 react-syntax-highlighter 请求风暴 —— 失败轮 1307 次、通过轮 1300–1775 次，
同量级；也不是 `504 Outdated Optimize Dep` + Vite 客户端 `location.reload()` 那条老路（两次红的
控制台都没有 504，也没有第二次 `[vite] connected`）。

**机制（本仓能修的那一半）**：触发源在渲染器之外 —— Chromium 的 `net::ERR_NETWORK_CHANGED` 把
应用在途的模块请求整批打断（本机存在 docker/veth 变动，是网络变更通知的真实来源），页面停在 boot
中途。本仓能修的不是触发源，而是**响应方式**：`e2e/session-filter.spec.ts` 的启动阶段既没有客户端
预热、也没有有界启动探针，于是「一次瞬时的模块加载中断」被拖成「无界等待 → 55s 看门狗 SIGKILL →
`Channel closed` → 台账记红」，而不是一次自愈的重放。

<!-- dedup-ref -->
**为什么之前的修法没兜住**：守卫家族在本仓早已成立，但只活在三份 spec 里 ——
`e2e/voice-dashscope-written.spec.ts:330 warmClientStartup` 与
`:264 / :838 STARTUP_PROBE_DEADLINE_MS / STARTUP_RELOAD_PROBE_MS`、
`e2e/transcript-follow.spec.ts:1739 warmClientStartup` 与 `:1874-1882` 的有界 reload 探针
（含 `:1867` 的 `requestfailed` 证据捕获）、以及 `e2e/voice-trim.spec.ts`。
`gap-ac101-criterion-bounded-under-gate-cap`（done）给本判据加了 `BOOT_CEILING_MS` /
`RUN_CEILING_MS` 两道**封顶**，把「整轮跑不完」变成「在 55s 被有归因地杀掉」，但没有给页面里的
无界等待一条恢复路径；`gap-transcript-follow-criterion-boot-dep-reopt-race`（done，本仓唯一提到
`ERR_NETWORK_CHANGED` 的文件）把预热+探针落在它自己那份 spec 里，没有回灌到
`e2e/session-filter.spec.ts`。于是本条判据是这一族里最后一份**只有封顶、没有守卫**的 spec。

**修法（移植既有守卫，不发明新机制）**：把家族既有的两个杠杆搬进
`e2e/session-filter.spec.ts` 的启动路径，并覆盖该 spec 真实存在的**每一次**导航 —— `beforeAll`
第 156 行 `page.goto('/')`、第 171 行 `page.reload()`，以及测试体第 227 行的 `page.reload()`
（第二次红正死在 reload 之后的 boot 上）：

1. **有界客户端预热**（在任何页面之前）：对 `baseURL` 依次取 `/`、`/src/main.tsx`、以及从 entry
   文本里读出的一个本次运行当前的优化依赖 URL，直到 200；每步各自带 deadline，超时或非 200 时按
   url + status 指名抛错（照 `warmClientStartup` 的形态与语义，含「客户端接了连接却不答」也要按名字
   失败）。
2. **有界启动探针**（每次导航之后）：用短预算探「本次导航的落点已经就绪」—— 首次 boot 探
   `#username`，reload 之后探项目行；未就绪就在预算内 `page.reload()` 重放，并收集
   `page.on('requestfailed')` 与 console 证据；预算耗尽时**带页面文本 + 失败请求列表大声抛错**，
   绝不静默继续。

预热与探针留在 spec 内，不动 `playwright.config.ts`：`globalSetup` 需要一个 `e2e/*.ts` 新文件，
会触发 lint 边界（与 `gap-transcript-follow-criterion-boot-dep-reopt-race` 同一条理由）。

⛔ 不变式（与 `gap-ac101-criterion-bounded-under-gate-cap` 的 ⛔ 一脉相承）：判据命令不改；60s
门限不动；5 个用例的 `expect` 一字不动；不加 Playwright `retries`；不开
`reuseExistingServer: true`；不 stub、不 skip；不把过滤搬到客户端；不删 `keepSessionIds`。守卫只
允许**重放导航**，不允许替 5 个用例下任何结论 —— 探针探不到时必须红，而且红得可读。

取假形态：把守卫写成「探不到就当已就绪继续跑」时，5 个用例会在空白页上各自等到自己的超时
（≥120s），整轮必然越过 60s 门限记红 —— 这就是守卫没有变成静默放行的证明。

## AC

- [ ] 预热在首次导航之前真实生效：`e2e/session-filter.spec.ts` 里有 `warmClientStartup`（或其等价
      命名）的定义与调用，逐 URL 带 deadline，非 200 / 超时按 url 指名抛错。验证：该 spec 的
      typecheck `exit 0`，且 `grep -n "warmClientStartup" e2e/session-filter.spec.ts` 同时命中定义行
      与 `beforeAll` 内的调用行。
- [ ] 每一次导航都走同一个有界探针：`grep -n "page\.goto(\|page\.reload(" e2e/session-filter.spec.ts`
      的每一处行号都落在探针函数体内部，函数体外没有任何裸导航；探针耗尽预算时抛出携带页面文本与
      `requestfailed` 列表的错误。验证：上述 `grep -n` 输出逐行落界 + 该 spec typecheck `exit 0`。
- [ ] 有界失败的实测（照 `e2e/voice-dashscope-written.spec.ts:251-255` 的有界失败变体）：把探针落点
      临时指向一个不可能存在的 sentinel 后，`npm run test:e2e -- e2e/session-filter.spec.ts` 在
      **30s 内**以非零退出，且输出里带页面文本与失败请求列表；还原后该读数与还原读数一并登记。验证：
      两次运行的 `echo $?` 与 wall time。
- [ ] 判据在负载下连续绿：`npm run test:e2e -- e2e/session-filter.spec.ts` 连续 ≥5 次全部 `exit 0`，
      且每一次 wall < 55_000ms（一次都不触发自带看门狗，`Channel closed` 零次），其中至少一次与 ≥4
      份兄弟 spec 并发。验证：逐次 `echo $?` + wall time 记录。
- [ ] 判据命令、门限与断言语义未变：与 develop 的 diff 中 `package.json` 与
      `playwright.config.ts` 无 `test:e2e` / `RUN_CEILING_MS` / `BOOT_CEILING_MS` 的增删，且
      `e2e/session-filter.spec.ts` 的 diff 里删除行不含 `expect(`。验证：
      `git diff develop -- package.json playwright.config.ts` 为空，且
      `git diff develop -- e2e/session-filter.spec.ts | grep -c "^-.*expect("` 为 0。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`
（台账尾部不再是 CURRENTLY FALSE）。且这条绿不是「恰好那次没抖」—— AC4 的 ≥5 连绿（含一次 ≥4 份
兄弟 spec 并发）的逐次 wall/exit 读数写进完成记录；AC3 的有界失败读数（探不到时 <30s 红、带页面
文本与失败请求列表）以及还原后的读数一并登记。⛔ 不得用改断言 / skip / `retries` / 改判据命令换绿；
5 个用例的 `expect` 一字未改由 AC5 机械证明。完成记录里必须写明：本仓修掉的是**响应方式**（无界
等待 → 有界重放），触发源（宿主层 `net::ERR_NETWORK_CHANGED`）不在本仓可控范围内 —— 因此这条判据
的稳定性依赖守卫，而不是依赖触发源消失。

## Touches

- e2e/session-filter.spec.ts — 唯一被修改的文件：加入有界客户端预热与有界启动探针，并让
  `beforeAll` 与测试体里的每一次导航都走它
- tasks/gap-session-filter-criterion-bounded-boot-guard.md — 本任务自身（状态翻转须可归因）
