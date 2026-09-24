---
id: gap-voice-dashscope-criterion-boot-dep-reopt-race
title: AC-142 判据在门自己那次运行里红、本体 4/4 绿：夹具的依赖重优化在开户向导已在场时提交并 full-reload 把表单抽走（同族已在
  AC-108 修过 warmClientStartup，未回灌本 spec）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-142
---
## Proposal

**本轮的直接测量（不是台账尾巴）**

台账：AC-142 最近四次读数 `2026-09-24T14:41:49Z fail`（goal-sweep）/ `14:42:57Z fail` / `14:53:12Z pass` / `15:24:49Z fail`（goal-cli），最后一条即本轮立案依据。台账存的 reason 只留截断 stderr，所以本轮直跑了判据本体。

同一 checkout（`/data/home/yale/work/claudecodeui`，工作树无本地改动）、`git rev-parse HEAD` = `1f5c87d3c78ab28b101272c1df557b18f7da998c` 上直跑 `npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"` **4 次**：

```
exit=0 wall=18.0s  criterion-wall-ms=18027  2 passed
exit=0 wall=23.9s  criterion-wall-ms=23088  2 passed
exit=0 wall=20.0s  criterion-wall-ms=19256  2 passed
exit=0 wall=21.3s  criterion-wall-ms=20197  2 passed
```

四条读数为真：`proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=67`、`error=true draft-kept=true posts=1`、`page-said="Transcription failed: transcribe 502 (UNAUTHORIZED)"`。**红的不是判据的断言，是它自己的启动前导（`beforeAll` 里的开户向导）。**

**门自己那次运行的现场**（被它判红的正是这一次：`/data/scratch/yale/quay-e2e-kkG8Bc/`，这个目录名逐字来自台账 reason 里那条 `[BABEL] … vite-cache/deps/react-scan.js` 行）

`test-results/voice-dashscope-written-AC-b7cde--instruction-lands-verbatim/error-context.md`：

- `"beforeAll" hook timeout of 40000ms exceeded.`
- `Error: locator.fill: Target page, context or browser has been closed`，call log 停在 `- waiting for getByPlaceholder('John Doe')`
- `# Page snapshot` 是 **Create Account** 画面，`Username` 输入框**是空的**（只有 `- placeholder: Choose a username`，没有值）

`trace.zip` 的 `1-trace.trace`（playwright 自己的 call log，时间为相对 trace 起点）：

```
call@13  3228ms  navigating to "http://127.0.0.1:14519/?voiceDebug=0&voiceTrim=off"
call@15  9007ms  #username 解析为 visible        ← spec 那条 8s 启动探针**成功**了
call@17  9056ms  fill("e2euser")                 ← 用户名字段真的填进去了
call@19/21        fill("e2epassword") ×2
call@23  9156ms  click Create Account
call@23  9210ms  element was detached from the DOM, retrying
call@23 12054ms  locator 重新解析（在另一份文档上）
call@23 12140ms  click action done
call@25 12150ms  waiting for getByPlaceholder('John Doe')   ← 之后二十多秒都没解析
```

`1-trace.network`：**整场加载了两次完整文档** —— `GET /@vite/client` 与 `GET /src/main.tsx` 各在 `15:24:08.668Z` 与 `15:24:14.634Z` 出现一次；2238 条响应里状态码只有 `200×2227 / 401×8 / 304×1 / 101×2`，**没有一条 504**。同一 trace 的 console 里 `[vite] connecting...` 也只出现两次（3339ms 与 9251ms），第二次紧跟 `element was detached` 之后。

**机制（与 AC-108 是同一条，且已被那份修复验证过）**

本 run 的 client 走**私有**依赖缓存（`playwright.config.ts` 的 `VITE_CACHE_DIR` 与 `seedViteCache()`），而台账为这次运行存下的 reason 里就有 `[BABEL] … deoptimised the styling of /data/scratch/yale/quay-e2e-kkG8Bc/vite-cache/deps/react-scan.js` —— **本 run 自己的预打包是在测量窗口之内被建出来的**。Vite 在服务器已开始服务之后提交一次（重）优化时，会向已连接的客户端推 `full-reload`（`node_modules/vite/dist/client/client.mjs` 的 `case "full-reload"`），文档被整份替换。这条路径**不需要出现 504**：504 只是「模块请求正好撞上重优化」的形态，而这里页面早已渲染完。落到本判据上：reload 落在开户向导已在屏幕之后 ⇒ SPA 状态清零 ⇒ 重渲染出来的 Create Account 表单是空的 ⇒ 那次 click 提交了空表单 ⇒ `John Doe` 永不出现 ⇒ 40s hook 预算到点。spec 现有的守卫只探「表单**第一次**出现」（`appears(onboarding.locator('#username'), 8_000)` + ≤3 次 reload），它**成功了**，于是整条路一路走到 hook 超时。

**本轮没有读到的东西（如实登记，不许写成已确证）**：trace 里没有 HMR 帧，所以这一轮**没有**直接读到那记 `full-reload` 载荷。「私有缓存被冷建 ⇒ 提交时 full-reload」是由「两次文档加载 + 私有缓存 Babel 行 + 全程零 504」推出来的**主假设**，不是读到的证据；「别的东西 reload 了文档」也没有被静态阅读排除（`grep -rn "location.reload" src/ shared/` 零命中；唯一一处 `window.location.replace` 在 `src/modules/version-upgrade/VersionUpgradeModal.tsx:51`，要用户点「立即升级」且 `IS_PLATFORM` 才走）。**AC2 的阴性对照就是确认它的那个实验**；若实验给出别的 reload 来源，完成记录里要写那一个，而不是把这条假设抄一遍。

**为什么早先的修复没挺住**

- `gap-voice-dashscope-written-browser-e2e`（done，`goal_ac: AC-142`）交付了这份 spec，但它的落地读数全是**安静机器**上的（完成记录里 `criterion-wall-ms=18279`、`2 passed`），DoD 没有一条要求「在门自己所处的并发条件下反复读到真值」。它记录在案的唯一一次红是另一回事（`src/shared/tests/voiceConfig*.test.ts` 的六格/十格契约面），启动前导这条竞态从没被量过。
- 同族的 AC-108 撞的是**同一条**竞态，`gap-transcript-follow-criterion-boot-dep-reopt-race`（done，`goal_ac: AC-108`）已经在**它自己的 spec 里**修了 —— `e2e/transcript-follow.spec.ts:1739` 的 `warmClientStartup`、`:1703` 的 `CLIENT_WARM_DEADLINE_MS = 30_000`、`:1705` 的 `OPTIMIZED_DEP_IN_TEXT`，并在 `:1729` 逐字论证了为什么预热该放 `beforeAll` 而不是 `playwright.config.ts` 的 `globalSetup`（Playwright 把每条 globalSetup 当**脚本**解析，`resolveScript()` 要一个路径且文件必须 default-export，内联预热既不合法也加载不了）。**那次修复只落在它自己的 spec 里**：`playwright.config.ts` 与基线逐字节相同（那份完成记录里有 `git diff --stat` 为证），`e2e/voice-dashscope-written.spec.ts` 从未拿到这份预热。

<!-- dedup-ref --> 同机制关联（记给出处，不是本任务声明的依赖）：`gap-transcript-follow-criterion-boot-dep-reopt-race`（done，AC-108）是这道修法的出处与本任务照抄的对象；`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page`（done，AC-121）是「有界启动守卫」的出处（`e2e/voice-trim.spec.ts:700` 起）。本任务不重复申领 AC-108 / AC-121，也不回退它们的修法，只把同一道修法补到 AC-142 自己的判据路径上。

<!-- dedup-ref --> 同文件并发面（登记，不是本任务的前置条件）：`gap-voice-error-notice-browser-e2e`（todo，AC-153）计划在它自己那次改动里把本文件 `:775`（`getByText(/Transcription failed/)`）与 `:796-798` 三条断言换成 AC-153 的新显示形态 —— 两条任务**同时**落在 `e2e/voice-dashscope-written.spec.ts` 上。本任务不认领那份显示形态变更（那是 AC-153 的范围），也不得顺手替它改；落地时先看该文件是否已被另一条改过，冲突按两条各自的 AC 逐条保留。同理，本任务落地时 AC-153 的显示改动若已进树，AC-142 的失败腿会因**文案期望值**而红，那是 AC-153 自己登记过的连带改动，不是本任务要修的东西。

**修法（夹具侧，判据断言一行不动）**

1. **把本 run 的（重）优化移出测量窗口**：照抄 `warmClientStartup` 的形状到 `e2e/voice-dashscope-written.spec.ts` 的 `beforeAll`，在 `browser.newContext()` **之前**跑完 —— html shell、`/src/main.tsx`、再从 entry 的转写里取一个**本 run 当前**的 `/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` 请求到 200。逐步有界，失败时按名字报出 url 与状态码。
2. **让开户前导对「文档在脚下被换掉」有界自报**：填完向导字段、点 Create Account **之前**复核刚填进去的值还在（文档被换掉时它们会回到空），换掉则在这条 spec 自己的预算内重走这一段；预算耗尽时抛**这条 spec 自己的错**（页面文本 + console / `requestfailed` 证据），而不是让 40s hook 或门的 60s 从外面把它杀掉。整段预算之和必须留在判据自己的墙钟预算内。

⛔ 换绿禁令（与 AC6/AC7 同源）：不得加 `retries`、不得 `test.skip` / `test.fixme`、不得用更长的等待去「压过」竞态、不得删改或放松两条腿与对照腿的任何断言、不得改宽或改窄 `-g "AC-142"` 的选择面、不得用桩或镜像替掉真实 Chromium + 真实后端、不得改 goal gate 上限。

## AC

- [ ] AC1 判据在**门自己所处的条件下**连跑 ≥10 次全部退出码 0：同一次窗口内另有一条 e2e lane 对同一 checkout 在跑（这正是产出那次红的条件），逐次登记 `exit=… wall=…`、spec 自报的 `criterion-wall-ms=`、`[e2e] server=… client=…` 行与 `git rev-parse HEAD`，10 行原文进完成记录。
- [ ] AC2 **阴性对照（预热关掉 + 冷优化 ⇒ 必须红）**：把预热临时改成空操作，并把本 run 的预打包强制冷建（`optimizeDeps.force` 或等价手段），判据必须非 0，且失败形态落在**启动前导**（`#username` 或 `John Doe` 不在本次文档上出现），并附运行时那条 `[BABEL] … <本 run dataDir>/vite-cache/deps/…` 行作为「本 run 真的冷了」的读数；退出码与失败原文登记，之后全部还原。
- [ ] AC3 **阳性对照（预热恢复 + 仍冷优化 ⇒ 必须绿）**：只恢复预热（优化仍强制冷），判据必须退出码 0。AC2 与 AC3 一起证明预热是承重的；之后 `git diff --stat` 证明 `playwright.config.ts` 与 `vite.config.js` 相对基线无差异。
- [ ] AC4 前导**有界自报**：把启动探针指向一个必然不存在的哨兵选择器，该次运行必须在 ≤30s 内以**这条 spec 自己的错误**结束，错误里含页面文本与 console / `requestfailed` 证据；不得表现为 `"beforeAll" hook timeout`，也不得让 runner 撑到门的 60s 才被杀。探针还原后判据复绿（给退出码）。
- [ ] AC5 判据未被削弱、选择面未变：`grep -c "^test('AC-142" e2e/voice-dashscope-written.spec.ts` = 2，`grep -n "AC-142" e2e/voice-dashscope-written.spec.ts` 的全部命中都落在这两行标题上；`git diff` 证明两条腿的断言与对照腿逐字节未改；`retries` / `test.skip` / `test.fixme` 零新增。
- [ ] AC6 判据自己的抗假变体仍红（防「用更长的等待换绿」）：(i) 让前端忽略 proxy-only、直连工作空间主机 ⇒ 书面腿退出码非 0；(ii) 让失败腿清空草稿 ⇒ 失败腿退出码非 0。两条都留输出并还原。
- [ ] AC7 `npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json` 三套）退出 0；`npm run lint` 退出 0（error 行 0）。
- [ ] AC8 改动面收在夹具里：最终 `git diff --stat` 只有 `e2e/voice-dashscope-written.spec.ts`（外加本任务自己的 `tasks/gap-voice-dashscope-criterion-boot-dep-reopt-race.md`）；`playwright.config.ts` 逐字节等于基线。若确有必要动夹具之外的文件，必须在完成记录里登记那处改动并给出它对应的 AC 编号，不得无登记越界。

## DoD

- **账本翻正并在随后多轮保持**：driver 下一轮直接重跑 AC 记录里的 `criterion`（`npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"`），AC-142 的尾巴由 `2026-09-24T15:24:49Z` 的 fail 翻成 pass，且后续各轮不再被并发偶发打红。
- **真落地（不是更长的等待、也不是重试）**：本 run 的依赖（重）优化在**任何页面存在之前**就已提交（预热），且页面若真在向导中途被抽走，这条 spec 会**用自己的话**在预算内报错退出（前导守卫）；由 AC2/AC3 的负正对照与 AC4 的有界失败原文证明。四条腿的断言与对照腿一行未改（AC5/AC6）。
- **读数原文**：AC1 的 10 行 `exit=… wall=…`（含并发 lane 在场的证据）；AC2 的退出码 + 启动前导失败原文 + 本 run 冷缓存 Babel 行；AC3 的退出码与 `git diff --stat`；AC4 的失败错误全文（含页面文本与 console 证据）；AC6 两条变体的退出码。
- **前提与未确证项如实登记**：本轮**没有**读到那记 `full-reload` 的 HMR 帧，机制是推断（见 Proposal 末节）；若 AC2 的实验给出别的 reload 来源，完成记录必须写那一个，且不得写成「已确证是依赖重优化」。同样要写明门那次红**不是** `gap-voice-dashscope-written-browser-e2e` 的断言回归（本轮 4/4 直跑全绿、读数逐条为真），也不是 AC-153 的显示形态连带改动（那一条尚未落地）。
- **L_D 该轴仍暗，理由**：本任务只改 e2e 判据的启动前导与它的失败信息，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：读数是退出码、墙钟与页面文本，不是生成质量轴读数；书面化质量仍按 GOAL-009 的非目标只以实验记录形式存在。

## Touches

- e2e/voice-dashscope-written.spec.ts
- tasks/gap-voice-dashscope-criterion-boot-dep-reopt-race.md
