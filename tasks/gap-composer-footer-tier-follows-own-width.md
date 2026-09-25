---
id: gap-composer-footer-tier-follows-own-width
title: composer footer 的紧凑排布按 composer 自身宽度切换而不是按视口：768px + 侧栏展开时输入框只有
  445px，桌面分支叠成两行（空闲 93px、双回放 129px），移动分支在 302px 宽下都是 57px 单行
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

来源：`gap-mobile-layout-e2e-viewport-matrix` 的 22 格矩阵单跑（22/22 通过）时读出的读数。全部通过并不代表布局正确：768px 档的读数是 `footer 445/445`（无横向溢出）但 `sameRow=false stacked=true`，footer 高度空闲 **93px**、含一对回放 **129px**（两组 top 差 72px）；同一台机器上移动分支在 302px 宽的 footer 里是 **57px 单行**，1280 档（footer 866px 宽）是 77px 单行。「叠成两行」本身就是缺陷，不因它在改动前就存在而变成可接受。

根因（读源码，非推测）：`src/modules/chat/composer/ChatComposer.tsx` 第 218 行用 `useDeviceSettings().isMobile`（`window.innerWidth < 768`）决定 footer 走哪套排布（`:549`、`:550`、`:578`、`:582`、`:634`，回放行 `:520`）。视口宽度不等于 footer 的可用宽度：768 视口加展开的侧栏，输入框只有 445px。桌面分支保留完整控件组并允许 `flex-wrap`，放不下就整组换行；而同样这批控件的紧凑排布（六个主控件 + 「更多」）在 302px 已经能单行放下。先前任务 `gap-composer-footer-desktop-768-replay-overflow` 只是允许左组换行来消掉 25px 横向溢出，没有触碰这个前提。

方案：让「用紧凑排布」这一个决定同时看两个信号，任一成立就紧凑：(1) 视口 < 768（现有规则，原样保留）；(2) composer 外壳（`chat-composer-shell` 内的输入框容器）的实测宽度 < 阈值。新增一个模块内 hook（`src/modules/chat/hooks/useComposerCompactTier.ts`），用 `ResizeObserver` 量该容器，返回是否紧凑，并在容器被拖拽/侧栏开合而改宽时不重挂载地翻转。**未测量（无 `ResizeObserver`、宽度为 0，即 jsdom）时一律退回仅按视口判断**，这样现有三份以 `window.innerWidth` 作为档位信号的单测（`chatComposerResponsive`、`voiceClipPlayback`、`activityIndicatorResponsive`）读数不变，新增的只是「测得窄」这一条腿。

范围边界：仅 footer 排布与回放行两处改用新信号。Tailwind 是 3.4 且没装 container-queries 插件，源码里也没有 `@container` 用法，所以不引入它；用 ResizeObserver（`useChatSessionState.ts`、`WorkspaceHeader.tsx`、`EditorSidebar.tsx` 已在用，是仓库既有惯例）。不动 `WorkspaceHeader`/`WorkspaceTabs`（它们按视口切换是对的）、不动活动指示（`:345`、`:444` 的 `!isMobile`：桌面执行态仍是 tab 状态 + composer 的 Stop，与矩阵任务的桌面判据一致）、不动 `useSendOnEnter`/`touchOnly`（那是设备属性，不是宽度属性）。

阈值必须实测推出，不许凭感觉：在真浏览器里扫 composer 容器宽度，读出「桌面排布带一对回放仍能单行放下」的最小宽度，阈值取该读数之上并写明余量；扫描过程原样记入 Evidence。

<!-- dedup-ref -->
关联（仅供追溯，不是前置）：`gap-composer-footer-desktop-768-replay-overflow`（同一区域，处理的是回放对造成的横向溢出，机制不同）、`gap-mobile-composer-footer-single-row-more-menu`（提供了紧凑排布本身）、`gap-mobile-voice-clip-row-below-textarea`（提供了回放行）。永久回归矩阵在 `gap-mobile-layout-e2e-viewport-matrix`，那条任务依赖本条落地后再把 768 判据收紧。

## AC

- [ ] `npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx` 退出 0，用假的 `ResizeObserver` 驱动测得宽度，覆盖：(a) 视口 1280 + 测得 445 ⇒ 紧凑结构（「更多」入口存在，Commands/Token/Schedule 不在 footer 内，含 `clipSlot` 时回放行在 footer 之前）；(b) 视口 1280 + 测得 866 ⇒ 宽结构原样（三个控件内联，回放在 footer 内）；(c) 视口 767 + 测得 900 ⇒ 仍紧凑（视口规则不被测得宽度覆盖）；(d) 阈值两侧各一格：阈值 −1 紧凑、阈值 宽（阈值常量由 hook 文件导出，测试与实现读同一个值）；(e) 未测量（不安装 `ResizeObserver`，以及宽度为 0）⇒ 与仅按视口时的结构逐字相同；(f) 挂载后触发假观察器改宽，档位在不重挂载的前提下翻转，且翻回去同样成立。
- [ ] 抗假变体（每个只能让对应的格变红，还原后全绿）：① hook 忽略测得宽度、只返回视口规则 ⇒ (a) 变红，(b)(c) 仍绿；② hook 忽略视口、只看测得宽度 ⇒ (c) 变红，(a)(b) 仍绿；③ 把 `ResizeObserver` 回调里的 setState 去掉 ⇒ (f) 变红。变体只在探针里做，还原用 `git checkout`，`git diff` 之后只剩本任务声明的写点。
- [ ] 既有三份以视口作为档位信号的单测不回归：`npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx src/modules/chat/tests/voiceClipPlayback.test.tsx src/modules/chat/tests/activityIndicatorResponsive.test.tsx` 退出 0，且这三个文件在本任务里不需要改断言（只在确需时追加用例，不改既有读数）。
- [ ] 范围未外溢：`git diff --stat` 相对本任务基线不含 `WorkspaceHeader.tsx`、`WorkspaceTabs.tsx`、`ChatMessagesPane.tsx`、`useSendOnEnter.ts`、`useDeviceSettings.ts`；`ChatComposer.tsx` 里 `:345`/`:444` 的活动指示分支仍读 `isMobile`。
- [ ] 全量前端检查：`npm run test:client`、`npm run build:client`、`npm run typecheck`、`npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 预先非 0，不作判据）。

## DoD

真实落地判据：不是「单测过了」。jsdom 不排版，这条任务的结论只能在真浏览器里读到。要求用一次性的 Playwright 探针（不提交；沿用既有 layout probe 的 viewport 与看门狗写法，`TMPDIR` 指到 `/data` 上的目录避免写满根盘），在 768×900（侧栏展开，容器约 445px）、1024×768、1280×720 三个视口，空闲/单条回放/双条回放三个状态下读：footer `scrollWidth`/`clientWidth`、两个主控组的 top/bottom（是否同一行）、footer 高度、header 高度，并把读数表原样写进 Evidence。达标线：768 侧栏展开档空闲与含回放对都是**单行**（同一行为真、无横向溢出、footer 高度与移动档同量级），不是「不溢出就行」；1280 档 header 57px、footer 77px 单行与改动前逐字段相同（改动前的读数在基线树上现读，不抄本任务里的数字）。阈值来自容器宽度扫描（例如 445、520、600、680、760、866 各读一次，找到桌面排布带一对回放仍单行的最小宽度），扫描表与所选阈值、余量一并记录。另读一次实拖：在 1280 视口里把侧栏拖窄/合上，footer 排布在不重挂载的前提下翻转，两侧各读一次。

如实标注边界：视口来自 Chromium 的 viewport 模拟，不是真机；PWA safe-area 在 headless 里不生效；侧栏开合用的是应用自己的控件，宽度读数是该控件实际造成的容器宽度。

前端模块规范：实施前读 `.agents/skills/frontend-module-standards/SKILL.md`；新 hook 放 `src/modules/chat/hooks/`，导出处写明消费方，用 `type` 不用 `interface`，应用内导入一律 `@/...`，新测试文件按 boundaries 规则经模块 barrel 引入被测对象（否则 `npm run lint` 会红）。

L_D 该轴仍暗，理由：纯前端布局判据，验收读数是真浏览器的边界框读数与单测结构读数，没有独立的领域数据度量。

L_G 该轴仍暗，理由：同上；本任务的验证读数就是 DoD 里的边界框读数表与三个抗假变体的变红读数。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/hooks/useComposerCompactTier.ts (new)
- src/modules/chat/tests/composerCompactTier.test.tsx (new)
- tasks/gap-composer-footer-tier-follows-own-width.md
