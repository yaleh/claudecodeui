---
id: gap-voice-client-asr-same-origin-delivery
title: 客户端识别的产品化交付：onnxruntime-web 随项目分发并同源提供，模型与 tokens 由部署方放进一个目录路径（不是
  URL），文档给出下载地址，去掉四个 VITE_ URL 变量
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`gap-voice-client-asr-wasm-adapter`（已 done）落了适配器、缓存与回退，但把交付面留成了**四个构建期 URL 变量**（`VITE_VOICE_CLIENT_MODEL_URL` / `_TOKENS_URL` / `_ORT_SCRIPT_URL` / `_ORT_WASM_PATHS`），缺一个整条客户端路径就不启用；本任务只改**交付与配置面**，不改识别、缓存、回退的行为。相邻任务 `gap-voice-sensevoice-server-adapter` 用 `SENSEVOICE_MODEL_DIR`（一个目录路径）定位服务端的同一份权重，本任务沿用同一种「路径而不是 URL」的约定。

### 现场（已核实的事实）

- 现在的 build 里 worker 读到的 `import.meta.env` 只有 `BASE_URL / DEV / MODE / PROD / SSR`，`.env` 里没有任何 `VITE_VOICE_CLIENT_*`，所以**客户端路径在已部署的版本里是关闭的**，选了 `sensevoice-wasm` 也只会回落服务端。
- 四个变量要求部署方自己准备并托管四个 URL，并且是**构建期**注入，改运行时环境无效。这不是可交付的形态。
- 需要的文件与大小（逐字节核对过）：`model.int8.onnx` 239 233 841 B、`tokens.txt` 315 894 B（HuggingFace `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` 仓库里按文件单独下载，`.../resolve/main/model.int8.onnx` 与 `.../resolve/main/tokens.txt`；GitHub release 的 tar.bz2 有 1.05 GB，不应让部署方为了 239 MB 去下它）；onnxruntime-web 1.30.0 的 `ort.wasm.min.mjs`（50 KB）、`ort-wasm-simd-threaded.mjs`（24 KB）、`ort-wasm-simd-threaded.wasm`（14 MB）。
- 服务端的 `SENSEVOICE_MODEL_DIR` 指向的目录里**已经有**这两个模型文件，所以多数已部署服务端的主机不需要再下载任何东西。
- 应用支持子路径部署（`docs/nginx-subpath-template.conf`），所以前端拼同源路径必须经 `import.meta.env.BASE_URL`，不能写死 `/`。
- 之前 worker 注释里写明 onnxruntime-web 「刻意不是依赖」。本任务**推翻这一决定**（人 yale 2026-10-06 裁定：运行时随项目分发），要同步改掉那段注释。

### 本任务做什么

1. **运行时随项目分发。** `package.json` 以**精确版本** `onnxruntime-web@1.30.0` 作为依赖；服务端在 `/voice-client/ort/<file>` 下同源提供上述三个文件，白名单只放这三个，文件从 `node_modules` 解析，`.wasm` 带 `application/wasm`。开发与生产同一条路径（vite dev 需要把 `/voice-client` 代理到服务端）。
2. **模型与 tokens 走一个目录路径。** 新环境变量 `VOICE_CLIENT_MODEL_DIR`（文件系统路径），未设置时**回退到 `SENSEVOICE_MODEL_DIR`**。服务端在 `/voice-client/model/<file>` 提供其中的 `model.int8.onnx` 与 `tokens.txt`（白名单只这两个名字，不允许目录穿越），支持 Range，不要求登录（与静态资源一致，模型本身是公开发布物，且不含用户数据）。
3. **可用性由服务端告知，而不是下载 239 MB 之后才发现缺文件。** 增加一个只读的就绪读数（`/api/voice` 下，走现有鉴权）：目录是否配置、两个文件是否存在、`model.int8.onnx` 字节数是否等于 239 233 841；缺哪个就说缺哪个、应放进哪个目录。`useVoiceAvailable` / 适配器的 `ENGINE_UNAVAILABLE` 原因据此给出可执行的话，例如「把 model.int8.onnx 与 tokens.txt 放进 VOICE_CLIENT_MODEL_DIR（或 SENSEVOICE_MODEL_DIR）指向的目录，下载地址见文档」。
4. **去掉四个 `VITE_VOICE_CLIENT_*` 变量。** 前端用固定的同源路径（经 `BASE_URL`），不再有构建期开关；不留旧变量的兼容分支。
5. **文档。** 新增部署说明：两个模型文件的下载地址（HuggingFace 单文件链接，附字节数与 sha256 `c71f0ce0…cd51`）、放哪个目录、`VOICE_CLIENT_MODEL_DIR` 与 `SENSEVOICE_MODEL_DIR` 的关系、必须经 HTTPS 或 localhost 访问（否则 `crypto.subtle` / Cache API 不可用）、子路径部署、`.env.example` 增加该变量。

### 边界（不做）

- 不改识别、缓存、回退、适配器注册的行为（它们已有单测）；
- 不把模型放进仓库或 npm 包；
- 不做模型的服务端自动下载；
- 不做多线程 / COOP-COEP；
- 不新增 `server/**/*.test.ts` 文件（`server/shared/tests/quay-test-script.test.ts` 钉死了该数量）：服务端新测试加进 `server/modules/voice/tests/` 里**已有**的测试文件。

## Plan

- **S0 服务端资源路由与就绪读数。** 服务内解析目录与文件白名单，路由只解析输入、调服务、回响应；覆盖「未配置目录」「回退到 SENSEVOICE_MODEL_DIR」「文件缺失」「字节数不符」「目录穿越被拒」「Range 请求」。
- **S1 运行时同源提供。** 依赖加入并锁定；三个文件的白名单路由；vite dev 代理。
- **S2 前端改用固定路径。** 删除四个 env 常量与「全有或全无」的读取逻辑，改为 `BASE_URL` 前缀的固定路径；原因文案改成指向目录与文档；更新 worker 里「onnxruntime-web 刻意不是依赖」的注释与相关单测。
- **S3 文档与 `.env.example`。**
- **S4 真实部署验证。** 在 `cloudcli.lrfz.com` 对应的服务上不设任何 `VITE_` 变量，仅靠目录路径，在真实浏览器里走完首次下载 → 缓存 → 重开零下载 → 识别。

## AC

- [ ] S0：服务端路由与就绪读数的单测通过，并覆盖未配置、回退到 `SENSEVOICE_MODEL_DIR`、文件缺失、字节数不符、目录穿越（`../`、编码后的 `%2e%2e`）被拒、Range 请求返回 206 六种情形；测试加在 `server/modules/voice/tests/` 已有文件里，命令 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-sensevoice-health.routes.test.ts` 退出码 0，且 `git diff --name-status develop...HEAD -- 'server/**/*.test.ts'` 里没有 `A`（新增）行。
- [ ] S1：`package.json` 里 `onnxruntime-web` 为精确版本 `1.30.0`（无 `^` / `~`），`npm ls onnxruntime-web` 显示 1.30.0；对运行中的服务 `curl -sI` 三个白名单文件均 200，`.wasm` 的 `Content-Type` 为 `application/wasm`，白名单外的文件名返回 404。
- [ ] S2：`grep -rn "VITE_VOICE_CLIENT" src shared server docs .env.example` 无命中；`npx vitest run src/modules/chat/tests/voiceClientAsrRouting.test.ts` 退出码 0；`BASE_URL` 为 `/sub/` 时前端拼出的路径带该前缀（单测覆盖）。
- [ ] S2：目录未配置或文件缺失时，适配器返回 `ENGINE_UNAVAILABLE`，原因文案同时包含目录变量名与文档路径，且**没有发起任何对 `/voice-client/model/` 的下载请求**（单测断言 `fetch` 调用次数为 0）。
- [ ] S3：新增的部署文档包含两个模型文件的完整下载链接、字节数、sha256、目录变量与 HTTPS 要求；`grep -c "resolve/main/model.int8.onnx" <文档>` 至少为 1，`.env.example` 含 `VOICE_CLIENT_MODEL_DIR`。
- [ ] `npm run typecheck`、`npm run lint`、`npm run build` 均退出码 0。
- [ ] S4 真实部署：在不设任何 `VITE_VOICE_CLIENT_*` 的 build 上，仅配置目录路径，用真实浏览器打开 HTTPS 页面完成首次下载、重新打开后模型请求数为 0、识别出文本；读数写进 `docs/experiments/2026-10-06-voice-client-asr-probe.md`，该条由人 yale 在真实部署上取得，执行者不得代写（待外部）

## DoD

真实落地的标准：一台**只照部署文档操作**的主机（装依赖、把两个模型文件放进文档指定的目录、设一个目录变量或沿用 `SENSEVOICE_MODEL_DIR`、构建并启动）就能让浏览器端识别可用，期间**不需要自己托管任何 URL、不需要设置任何 `VITE_` 变量**；并在真实浏览器里经 HTTPS 看到「首次下载有进度 → 校验 → 缓存 → 重开零下载 → 识别上屏」。只有单测、没有按文档从零部署一次的读数，不算完成。

## Touches

- package.json
- package-lock.json
- vite.config.ts
- .env.example
- server/index.ts
- server/modules/voice/voice.routes.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/index.ts
- server/modules/voice/tests/voice-sensevoice-health.routes.test.ts
- src/modules/chat/audio/voiceClientAsrWorker.ts
- src/modules/chat/hooks/useVoiceAvailable.ts
- src/modules/chat/tests/voiceClientAsrRouting.test.ts
- docs/operations/voice-client-asr-deployment.md (new)
- docs/experiments/2026-10-06-voice-client-asr-probe.md
- tasks/gap-voice-client-asr-same-origin-delivery.md
