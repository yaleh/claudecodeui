---
id: gap-static-assets-compression
title: 生产形态静态资源与 SPA 入口开启 gzip 压缩（仅限 dist 静态资源，不动 API 与 WebSocket）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状：生产形态下 `server/index.ts` 用 `express.static` 提供 `dist/`（约 203-227 行），**响应不带任何 `content-encoding`**。`package.json` 依赖里没有 `compression`，`node_modules/compression` 不存在，仓库里也没有别处做压缩。后果：主 JS `dist/assets/index-*.js` 约 3,059,430 字节原样传输，构建输出显示它 gzip 后约 886 KB。

证据（2026-09-21 实测，经 zrok 隧道、浏览器冷加载）：新生产形态冷加载约 **23 秒**（22.4 / 23.0 秒，n=2），11 个请求、约 4.6 MB；同一隧道的带宽上限约 0.2–0.5 MB/s（旧 dev 会话 `af690528…` 测得 0.2–0.5，本次下载 3 MB JS 测得 0.125–0.38），所以冷加载时间 ≈ 字节数 ÷ 隧道带宽，压缩传输量是缩短冷加载最直接的杠杆。回访已是约 1.7 秒（哈希资源 `immutable` 长期缓存），不在本任务范围。

方案：
1. **依赖**：把 `compression` 加进 `package.json` 的 `dependencies`（不是 devDependencies —— `scripts/release/build-server-bundle.js` 打包时只装生产依赖），同步 `package-lock.json`。选与 Express 4 兼容的版本；若所选版本支持 brotli（`br`）就一并启用，不支持则只做 gzip，**以实际行为为准，不预设**。
2. **挂载位置是关键，也是本任务最主要的风险点**：`app.use(compression())` 必须放在**所有 `/api/*` 路由注册之后、`express.static(public)` 之前**（即 `server/index.ts` 里 `app.use('/api/voice', …)` 之后、`app.use(express.static(… 'public'))` 之前），这样只有落到静态资源与 SPA 入口（`app.get('*')` 返回的 `index.html`）的请求会被压缩。放在更前面会把 SSE、语音 TTS 音频流、文件下载等流式/已压缩响应一并卷入 —— 它们对缓冲和压缩敏感，本任务**明确不碰**。WebSocket 升级不经过 Express 中间件，不受影响，但仍要在 DoD 里实测确认。
3. **可测性**：`server/index.ts` 是启动入口，不便在单测里直接拉起。按 `.agents/skills/backend-module-standards/SKILL.md` 的模块规范，把静态资源挂载抽成一个小模块 `server/modules/static-assets/`（`static-assets.module.ts` 导出一个 `createStaticAssetsMiddleware(distDir, publicDir)` 之类的工厂，`index.ts` 为 barrel），`server/index.ts` 只调用它。抽取时**保持现有的缓存头行为逐字不变**：HTML → `no-cache, no-store, must-revalidate` 加 `Pragma`/`Expires`；`js/css/woff/woff2/ttf/eot/svg/png/jpg/jpeg/gif/ico` → `public, max-age=31536000, immutable`。若实施者选了不同的文件名，须先改本任务 Touches。
4. **压缩范围**：只压文本类（默认的 `compression` 过滤已按 `Content-Type` 判断）；保留默认的 1 KB 阈值；已压缩的 PNG/JPG/WOFF2 不重复压缩。`Vary: Accept-Encoding` 必须存在（否则缓存层可能把压缩体发给不支持的客户端）。
5. **不做**：预压缩产物（`vite-plugin-compression` 加 `express-static-gzip`）不在本任务内 —— 它省 CPU 但增加构建复杂度，等运行时压缩证明不够用再评估；dev server 的压缩不在范围内（dev 形态不受本任务影响）。

## AC

- [ ] 依赖登记为生产依赖：`node -e "const p=require('./package.json');process.exit(p.dependencies&&p.dependencies.compression?0:1)"` 退出码 0，且 `npm ls compression` 退出码 0。
- [ ] 压缩行为：新增 `server/modules/static-assets/tests/static-assets.test.ts`，`npx tsx --tsconfig server/tsconfig.json --test server/modules/static-assets/tests/static-assets.test.ts` 退出码 0，覆盖（在临时目录里造一个 dist，含 ≥200 KB 的 JS、一个 HTML、一个 PNG）：带 `Accept-Encoding: gzip` 请求 JS → 响应 `content-encoding` 为 `gzip`、解压后与原文件字节一致、`content-length` 明显小于原文件；不带 `Accept-Encoding` → 无 `content-encoding` 且体与原文件一致；响应带 `Vary: Accept-Encoding`；PNG 不被重复压缩。
- [ ] 缓存头逐字不变：同一测试文件断言，压缩开启后 JS 的 `Cache-Control` 仍为 `public, max-age=31536000, immutable`，HTML 仍为 `no-cache, no-store, must-revalidate` 且带 `Pragma: no-cache`、`Expires: 0`；且**取假验证**——把缓存头设置删掉后这些用例必须判红。
- [ ] SPA 入口也被压缩：同一测试文件断言，对不存在的路径（如 `/some/route`）带 `Accept-Encoding: gzip` 请求，返回的 `index.html` 有 `content-encoding: gzip` 且解压后等于 `dist/index.html`。
- [ ] 挂载位置正确（不卷入 API）：`awk '/app\.use\(.\/api\//{a=NR} /createStaticAssetsMiddleware|compression\(/{c=NR} END{exit !(a&&c&&c>a)}' server/index.ts` 退出码 0，即压缩/静态挂载的行号大于最后一个 `/api` 路由挂载的行号。
- [ ] 门：`npm run typecheck`、`npm run lint`、`npm run build:server` 退出码 0；`bash scripts/test.sh --for-task gap-static-assets-compression` 退出码 0（scoped 自测；全量套件是 fan-in 的合并闸，不是 worker 自测）。

## DoD

真实落地判据：要用**真实运行的生产形态实例**证明，不以单测代替。(a) 对运行中的服务执行 `curl -sI -H 'Accept-Encoding: gzip' http://localhost:3001/assets/index-*.js`（取 `dist/index.html` 里引用的实际文件名），响应含 `content-encoding: gzip`，且实际传输的字节数（`curl --compressed -w '%{size_download}'`）约在 900 KB 量级而不是 3,059,430；(b) 经 zrok 隧道用浏览器做一次**冷加载**（全新 context，带 `skip_zrok_interstitial: 1` 头，与 2026-09-21 的基线同法），记录耗时并与基线 **约 23 秒**对比 —— 期望明显缩短，但**不预设具体数字**，实测多少写多少；若没有明显改善，如实登记，并说明是隧道带宽之外还有别的瓶颈；(c) 真实确认没有被误伤：在同一实例上完成一次真实的聊天往返（WebSocket 正常）、语音 `/api/voice/health` 返回 200、至少一个 `/api/*` 响应**不带** `content-encoding`（证明 API 没被卷入）。三条都留操作记录。

如实登记的取舍：运行时压缩每次请求消耗少量 CPU（`compression` 不缓存压缩结果）；本机上对 3 MB JS 的单次 gzip 开销须在 DoD 记录里给出实测（例如同一文件连续请求 20 次的耗时），若显著（例如单次 >200 ms）再评估预压缩，不在本任务内预先实现。样本量：基线冷加载 n=2，压缩后的复测也应至少 n=2。

实施前须加载并遵循 `.agents/skills/backend-module-standards/SKILL.md`（本任务只改 `server/`）。

L_D 该轴仍暗，理由：本任务是传输层优化，不新增领域能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上；本任务的验证读数是 DoD 里的字节数与冷加载耗时。

## Touches

- package.json
- package-lock.json
- server/index.ts
- server/modules/static-assets/static-assets.module.ts (new)
- server/modules/static-assets/index.ts (new)
- server/modules/static-assets/tests/static-assets.test.ts (new)
- tasks/gap-static-assets-compression.md
