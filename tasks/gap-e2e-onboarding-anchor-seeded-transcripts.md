---
id: gap-e2e-onboarding-anchor-seeded-transcripts
title: e2e 登录后置锚点不得依赖空态：播种夹具使 Choose Your Project 不渲染，AC-027 判据复红（回归）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-027
---
## Proposal

GOAL-001 的 AC-027 判据命令是 `npm run test:e2e -- e2e/model-library.spec.ts`（`goals/AC-027-end-to-end-in-the-real-browser-create-a-model-pick-it-send.md:7`），今天实测为红（EXIT=1）。红因不在被测功能链上，而在 e2e 夹具的共享前提被后一次改动拆掉——所以这是一条**回归**，不是功能缺口。

为什么早先的修复没挺住（本任务存在的理由）：

- `gap-model-library-browser-e2e`（done，commit `299dded4`，21:16 本地）新建该 spec 时确实绿过（3 passed）。当时 `playwright.config.ts` 还没有任何夹具播种，fresh DB 零项目，「完成引导」后 app 渲染 `Choose Your Project` 空态——而该 spec 的登录后置断言正是等这个空态（`e2e/model-library.spec.ts:68`）。
- 之后 commit `0a648469`（21:59 本地，随 develop `bed9b754` 合入；当前 HEAD `761a0e5b`）——即已 done 的 `gap-session-filter-real-browser-e2e`——往 `playwright.config.ts` 加了 `seedSessionFilterTranscripts()`：在服务器启动前把 7 份 transcript 写进 `<dataDir>/session-filter-workspace`，交由后端 boot scan 索引。该播种对**每一次** spec 运行都生效（唯一守卫 `isDataDirOwner` 是进程级的，不是 spec 级的）。而「索引一个会话会自动注册它的项目」（`server/modules/database/repositories/sessions.db.ts:137` 调 `projectsDb.createProjectPath`）。
- 于是 fresh DB 上引导完成后必然已有至少一个项目，`Choose Your Project` 不再渲染，`e2e/model-library.spec.ts:68` 5s 超时。
- 这条知识其实已被写下：`tasks/gap-session-filter-real-browser-e2e.md:77` 明确记着「种好的工作目录在『完成引导』时已经是一个项目，`Choose Your Project` 空态不会出现」。它只被用在自己那个 spec 上，没有回灌到此前的三个 spec。

实测（2026-09-20，HEAD `761a0e5b`，本机直跑）：

```
npm run test:e2e -- e2e/model-library.spec.ts   → EXIT=1，1 failed / 2 did not run
Error: expect(locator).toBeVisible() failed
  Locator: getByText('Choose Your Project')   Timeout: 5000ms   element(s) not found
  at e2e/model-library.spec.ts:68:57
```

失败快照（`test-results/model-library-model-librar-89d48-ate-through-the-Models-page/error-context.md`）显示页面**正是真实项目视图**：侧栏列出 `session-filter-workspace 7` 与全部 7 个播种会话（role-4-task-worker … human-alpha），并有 `Settings` 按钮。

同一机制在另两个 spec 上同样成立。本次实测 `npm run test:e2e -- e2e/launch-profiles.spec.ts e2e/model-library-layout.spec.ts` → EXIT=1，3 failed / 2 passed，三处失败全是同一个 `getByText('Choose Your Project')` 超时：

- `e2e/launch-profiles.spec.ts:48`（在 `beforeAll` 内，故其后用例 0ms 全红）
- `e2e/model-library-layout.spec.ts:27` 与 `:32`（390px / 900px 红，1440px / 1920px 绿——同一竞态的时序差）

⚠️ 该红是**竞态而非稳定红**：`.quay/gate-events.jsonl` 在同一 HEAD 上 22:47 / 22:48 pass、22:49 fail。若客户端的项目拉取先于 boot scan 完成，空态会短暂渲染、断言恰落在窗口内就通过。所以「有时绿」不构成 AC-027 为真；判据必须可靠为真。

修法（最小切片）：把「登录后置」的语义从「零项目」改成「已完成引导」，锚在真实视图里必然存在的元素上：

- `e2e/model-library.spec.ts:68`：`await expect(page.getByText('Choose Your Project')).toBeVisible();` 改为 `await expect(page.getByRole('button', { name: 'Settings' }).first()).toBeVisible({ timeout: 15_000 });`。失败快照已证明该按钮在真实项目视图里存在；`e2e/model-library-layout.spec.ts:17` 也早已把同一个选择器当作登录态探针（只是没在后面的断言分支里用对）。
- `e2e/launch-profiles.spec.ts:48`、`e2e/model-library-layout.spec.ts:27` 与 `:32`：同一处、同一类改法。优先级低于 AC-027 那一半，但同一机制应一并修掉，否则两个 spec 会立刻各自再立案。

⛔ 不得以任何方式削弱判据换绿：不得 stub、不得 skip、不得删除 spec 里任何真实断言（仅经 UI 建模型 / 重载后 secret 只显示「已设置」且值不出现在页面文本与 API 响应 body / composer 选中并发送后 mock 网关收到带该 token 的请求 / 无未翻译 i18n 字面量）；也不得把 `playwright.config.ts` 的播种改成按 argv 或文件名条件生效——那是遮掩，AC-101 的 `e2e/session-filter.spec.ts` 需要它在服务器启动前无条件播种。

<!-- dedup-ref -->
同机制关联（记给出处，不是本任务的前提）：`gap-session-filter-real-browser-e2e`（done）是播种的引入方，其完成记录第 77 行是这条知识的出处。本任务不回退它的播种，也不重复申领 AC-101。

## AC

- [ ] `npm run test:e2e -- e2e/model-library.spec.ts` 退出码 0（AC-027 的判据命令），且在真实 Chromium + 真实后端上一连跑两次均退出码 0——绿不是竞态撞上的。
- [ ] 同一 spec 的真实断言一条不少且为真：仅经 Settings > Agents > Claude > Models 用「LLM 网关」模板录入建模型（⛔ 无 API 直建）；重载后 secret 仅为「已设置」且其值不出现在页面文本与任何 API 响应 body；在 composer 现有模型选择器中选中它并发送后，mock 网关收到 `Authorization: Bearer <token>`（或 `x-api-key`）且 body 含该 model id；页面无未翻译 i18n 字面量。
- [ ] 抗假变体真跑并留输出：把 `e2e/model-library.spec.ts` 的登录后置锚点换成必然不存在的哨兵（如 `getByText('__no_such_anchor__')`）后，该判据命令必须变红——证明锚点确实承载「必须已进入真实 app」这一步、绿不是靠删断言换来的；同时 `git diff` 证明三条真实断言与 mock 断言一行未删。变体须还原。⚠️ 不要把「改回等 `Choose Your Project`」当作抗假变体：那是竞态，可能偶然仍绿，不可靠。
- [ ] `e2e/launch-profiles.spec.ts:48`、`e2e/model-library-layout.spec.ts:27` 与 `:32` 的同类锚点一并改为不依赖空态；`npm run test:e2e -- e2e/launch-profiles.spec.ts e2e/model-library-layout.spec.ts` 退出码 0（若仍有失败，须证明红因与本机制无关，并把红灯原文如实登记在证据里）。
- [ ] `npm run typecheck` 退出码 0。

## DoD

真实落地判据：不是「spec 文件存在」，也不是「某一次恰好绿」。要求在真实浏览器里只经 UI 走完 AC-027 全文链路，且判据命令**可重复地**退出 0（连续 ≥2 次），并留下抗假变体的红灯输出；AC-027 在驱动器下一轮经 `goal_ac: AC-027` 独立核验时由红翻绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。修的是夹具前提、不是被测功能：功能链本身未变，故不得改动 `src/` 下任何实现来换绿。

登记（避免下一轮踩同一坑）：本任务 Touches 里没有 `*.test.*` 文件（三条都是 Playwright `.spec.ts`），`scripts/test.sh --for-task` 的 scoped 门会判为 thin；请照常跑判据命令本身、`npm run typecheck` 与 `npx oxlint`，并把三条 e2e 的真实输出记入证据。

## Touches

- e2e/model-library.spec.ts
- e2e/launch-profiles.spec.ts
- e2e/model-library-layout.spec.ts
- tasks/gap-e2e-onboarding-anchor-seeded-transcripts.md
