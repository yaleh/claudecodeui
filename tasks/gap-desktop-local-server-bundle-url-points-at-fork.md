---
id: gap-desktop-local-server-bundle-url-points-at-fork
title: 桌面版 Local 运行时的默认下载地址写死上游 siteboon：fork 发布的桌面包选 Local 模式会 404，改指 yaleh 并重发
  v1.38.1 桌面包
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Finding

<!-- dedup-ref --> 机制去重读数（2026-09-30 立案时实测）：`ls tasks | grep -iE 'desktop|local-server|bundle'` 无命中；相邻的 `gap-fork-github-release-pipeline`（done）只让 fork 的 Release/Desktop Release 能跑通并产出 Local 运行时资产，没有碰桌面版**下载**这些资产的地址；本条是它漏掉的另一半。

**现象**：本 fork 的桌面版（`v1.38.0` 已发布 `cloudcli-desktop-1.38.0-win-x64.exe`）在用户选 "Local CloudCLI" 时，会去**上游**仓库下载 Local 运行时，而不是本 fork。

**证据（本轮直读）**：
1. `electron/serverInstaller.js:17`：`const DEFAULT_BUNDLE_BASE_URL = 'https://github.com/siteboon/claudecodeui/releases/download';`，`:37` 的 `bundleBaseUrl = process.env.CLOUDCLI_SERVER_BUNDLE_URL || DEFAULT_BUNDLE_BASE_URL` 是唯一的覆盖口，需要用户自己设环境变量，普通用户不会设。
2. `getBundleUrl()`（`:65-`）拼出 `${bundleBaseUrl}/${bundleReleaseTag}/cloudcli-local-server-${version}-${platform}-${arch}.tar.gz`。`desktop-release.yml` 把 `electron/server-bundle-config.json` 写成 `{"releaseTag":"cloudcli-local-server-<tag>"}`，所以 fork 的 `v1.38.0` exe 会请求 `https://github.com/siteboon/claudecodeui/releases/download/cloudcli-local-server-v1.38.0/cloudcli-local-server-1.38.0-win-x64-x64.tar.gz`——上游没有这个 tag ⇒ 404，Local 模式起不来。
3. fork 侧的资产是存在的：`gh release view cloudcli-local-server-v1.38.0 -R yaleh/claudecodeui` 有 `cloudcli-local-server-1.38.0-win-x64.tar.gz(.sha256)`。即数据在 fork，地址却指上游。
4. 仓库里另有 3 处引用该机制：`electron/localServer.js`、`.github/workflows/desktop-release.yml`、`desktop-windows-branch-build.yml`、`desktop-macos-branch-build.yml`——workflow 侧只写 `server-bundle-config.json`，不含仓库地址。

**根因**：默认下载地址是上游仓库的字面量，fork 化时没有跟着改。

**要建的东西（最小充分集）**：把默认下载基址改为 `https://github.com/yaleh/claudecodeui/releases/download`，`CLOUDCLI_SERVER_BUNDLE_URL` 环境变量覆盖口保持不变；新增一个测试钉住"默认地址指向 fork、不含 `siteboon`"与"环境变量仍可覆盖"；然后重发桌面版，让已发布的桌面包用上新地址。

**非目标**：不改 `build-server-bundle.js`；不改上游的任何东西；不引入构建期注入仓库名的新机制（字面量改一处即可，改坏由测试兜住）；不新增 macOS/Linux 桌面包。

## AC

- [ ] AC1 默认地址指向 fork：`node --test scripts/release/tests/server-installer-bundle-url.test.mjs` 退出 **0**，并打印 `bundle.default.host=github.com/yaleh/claudecodeui`、`bundle.default.upstream_refs=0`、`bundle.env_override=honored`；`grep -c siteboon electron/serverInstaller.js` 为 **0**。
- [ ] AC2 取假必须红：把 `DEFAULT_BUNDLE_BASE_URL` 改回 `siteboon/claudecodeui` 后上面的测试退出非 **0**，红在 `bundle.default.upstream_refs` 那条断言；把 `CLOUDCLI_SERVER_BUNDLE_URL` 覆盖分支拿掉后同样红在 `env_override` 断言；恢复后复绿（登记变异 diff、失败断言逐字、退出码）。
- [ ] AC3 URL 形状不变：测试对 `new ServerInstaller({version:'1.38.1', platform:'win32', arch:'x64', bundleReleaseTag:'cloudcli-local-server-v1.38.1'}).getBundleUrl()` 断言其等于 `https://github.com/yaleh/claudecodeui/releases/download/cloudcli-local-server-v1.38.1/cloudcli-local-server-1.38.1-win-x64.tar.gz`（只换了仓库段，文件名与 tag 段与现状逐字一致）。
- [ ] AC4 未越界：`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内；`scripts/release/build-server-bundle.js` 与三份 workflow 字节不变。
- [ ] AC5 `npm run typecheck` 与 `npm run lint` 退出 **0**。
- [ ] AC6 真实落地（合入 `develop` 并推送 `yaleh` 之后）：触发 `Desktop Release`（`gh workflow run desktop-release.yml -R yaleh/claudecodeui --ref develop -f tag=v1.38.1`）成功；`gh release view v1.38.1 -R yaleh/claudecodeui --json assets` 含 `cloudcli-desktop-1.38.1-win-x64.exe` 与 `SHASUMS256-windows.txt`；`curl -sIL -o /dev/null -w '%{http_code}' https://github.com/yaleh/claudecodeui/releases/download/cloudcli-local-server-v1.38.1/cloudcli-local-server-1.38.1-win-x64.tar.gz` 打印 **200**。

## DoD

- fork 发布的桌面版在选 "Local CloudCLI" 时，请求的是 fork 自己的 `cloudcli-local-server-<tag>` prerelease，且该 URL 真实返回 200——不是"常量改了"，而是 `v1.38.1` 桌面包和它对应的运行时资产都已发布并可下载。
- 测试把"默认地址不含上游仓库"与"环境变量覆盖口仍在"两条同时钉住；取假真的跑过。
- 只动 `## Touches` 列出的文件。

## Touches

- `electron/serverInstaller.js`
- `scripts/release/tests/server-installer-bundle-url.test.mjs` (new)
- `tasks/gap-desktop-local-server-bundle-url-points-at-fork.md`
