---
id: gap-npm-publish-yalehwang-cloudcli
title: 把 fork 以 @yalehwang/cloudcli 发到 npm：改包名与仓库指向、release-it 打开 npm 发布、Release
  workflow 走 NPM_TOKEN、清掉写死的旧升级命令并反转守卫
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（2026-09-30 立案时实测）：`ls tasks | grep -iE 'npm|package-name'` 无命中；前置任务 `gap-fork-github-release-pipeline`（done）刻意把 npm 发布关掉（`.release-it.json` 的 `npm.publish=false`、`release.yml` 的 `--no-npm.publish`、守卫 `scripts/release/tests/fork-release-workflows.test.mjs` 钉住），本条是它的**有意反转**，不是重复。

**目标**：把本 fork 以 `@yalehwang/cloudcli` 发到 npm（人 yale 的 npm 用户名是 `yalehwang`，人已裁定包名 `@yalehwang/cloudcli`、可执行名 `cloudcli` 不变）。`@cloudcli-ai/cloudcli` 的维护者只有 blackmammoth 与 simossiteboon（`npm view @cloudcli-ai/cloudcli maintainers`），不是我们的，不能也不该发。`npm view @yalehwang/cloudcli` 于 2026-09-30 为 E404（名字空闲）。

**现状（本轮直读）**：
1. `package.json`：`name=@cloudcli-ai/cloudcli`，`repository.url` 指上游 `siteboon/claudecodeui`，`bin.cloudcli` 指 `dist-server/server/modules/cli/cli.js`，`files` 已含 `dist/`、`dist-server/`、`server/`、`shared/`、`electron/`、`scripts/`，`prepublishOnly=npm run build`。
2. `.release-it.json`：`npm.publish=false`；`release.yml` 有 `--no-npm.publish` 与注释"不发 npm"，且已去掉 `registry-url`、`id-token`。
3. 代码里写死旧包名、会让用户的"升级"命令装到上游包：`server/modules/cli/cli.module.ts`（`npm show …version`、`npm update -g …`）、`server/modules/cli/cli.service.ts:215`（手动升级提示）、`server/modules/system/system.service.ts:36`（`npm install -g …@latest`）、`server/modules/cli/sandbox.service.ts`（提示文案）、12 个 locale 的 `src/modules/i18n/locales/*/common.json`（`npmUpgradeCommand`）；`server/modules/system/tests/system.service.test.ts:62` 逐字断言旧命令。
4. `README.md` 有 32 处 `@cloudcli-ai` 提及（`npx`/`npm install -g`），需要按包名改写并注明这是 fork。
5. `docker/` 下的 Dockerfile 与 README 装的是上游包与上游镜像 `cloudcliai/sandbox`——**不在本条范围**，保持不动。`redirect-package/`（旧名 `@siteboon/claude-code-ui` 跳转壳）同样不动。

**要建的东西（最小充分集）**：
1. `package.json`：`name` 改 `@yalehwang/cloudcli`；`repository.url`/`bugs.url`/`homepage` 改指 `yaleh/claudecodeui`（`homepage` 只在有自己的页面时才改，否则指仓库）；补 `publishConfig: {"access": "public"}`。`package-lock.json` 顶部 `name` 同步。
2. `.release-it.json`：`npm.publish=true`，`npm.publishArgs=["--access public"]`。
3. `release.yml`：用 `NPM_TOKEN` secret 走 `NODE_AUTH_TOKEN`（`setup-node` 加 `registry-url: https://registry.npmjs.org`），去掉 `--no-npm.publish` 与"不发 npm"的注释；不启用 trusted publishing（fork 未在 npm 侧配置）。
4. 上面第 3 条列的 6 处代码 + 12 个 locale 的旧包名全部换成 `@yalehwang/cloudcli`，`system.service.test.ts` 的断言同步。
5. `README.md` 的安装段改成 `npx @yalehwang/cloudcli` / `npm install -g @yalehwang/cloudcli`，并加一句"本仓库是 siteboon/claudecodeui 的 fork"。
6. 守卫 `fork-release-workflows.test.mjs` 反转对应断言：`npm.publish===true`、`name==="@yalehwang/cloudcli"`、`release.yml` 含 `NODE_AUTH_TOKEN`、且**仓库内不再有面向用户的 `@cloudcli-ai/cloudcli` 升级命令**（`docker/`、`redirect-package/`、`CHANGELOG.md` 除外，并在守卫里写明这个排除清单）。

**非目标**：不发 Docker 镜像、不动 `docker/`、`redirect-package/`、`CHANGELOG.md`；不做 Linux/macOS 桌面包；不修桌面版 `electron/serverInstaller.js` 写死上游 Local 运行时下载地址（另立任务）；不合并上游 `origin/main`。

## Plan

1. 先改守卫使其在当前代码上**红**（新断言：包名、`npm.publish`、`NODE_AUTH_TOKEN`、无旧升级命令），登记红的断言逐字。
2. 依 Proposal 第 1–5 条改 `package.json`/`package-lock.json`、`.release-it.json`、`release.yml`、6 处代码、12 个 locale、`README.md`；同步改 `system.service.test.ts`。
3. 守卫转绿；`npx release-it --dry-run --ci --increment=patch` 在 `develop` 上确认它会走 npm 发布步骤且目标包名是 `@yalehwang/cloudcli`。
4. `npm pack --dry-run` 读 tarball 清单：含 `dist/`、`dist-server/`、`server/`、`shared/`、`electron/`、`scripts/`、`README.md`，且 `package.json` 里 `name` 是新名；打印 `unpackedSize` 供参考。
5. 取假：把 `name`、`npm.publish`、任一 locale 的 `npmUpgradeCommand` 分别改回旧值，守卫各自必须红。
6. 人 yale 授权后：创建 npm Automation 令牌，`gh secret set NPM_TOKEN -R yaleh/claudecodeui`；触发 `Release`（`increment=patch`）发出下一个版本；`npm view @yalehwang/cloudcli version` 读回。
7. 写完成记录（版本号、npm 包链接、`npx @yalehwang/cloudcli --version` 的实测输出）。

## AC

- [ ] AC1 守卫绿：`node --test scripts/release/tests/fork-release-workflows.test.mjs` 退出 **0**，并打印 `pkg.name=@yalehwang/cloudcli`、`npm.publish=true`、`auth.env=NODE_AUTH_TOKEN`、`legacy.upgradeCmds=0`。
- [ ] AC2 取假必须红（承重，逐项）：分别把 (a) `package.json` 的 `name` 改回 `@cloudcli-ai/cloudcli`、(b) `.release-it.json` 的 `npm.publish` 改回 `false`、(c) `en/common.json` 的 `npmUpgradeCommand` 改回旧包名 之后，守卫各自退出非 **0** 且红在对应断言；恢复后复绿（登记每次变异 diff、失败断言逐字、退出码）。
- [ ] AC3 升级命令全部换新：`grep -rn "@cloudcli-ai/cloudcli" server src` 命中数为 **0**；`server/modules/system/tests/system.service.test.ts` 通过其对应的 scoped 测试命令，退出 **0**（命令以任务 Touches 内的测试文件为准，`--for-task gap-npm-publish-yalehwang-cloudcli`）。
- [ ] AC4 打包清单正确：`npm pack --dry-run --json` 退出 **0**，其 `name` 为 `@yalehwang/cloudcli`，`files[].path` 含 `dist-server/server/modules/cli/cli.js`、`dist/index.html`、`README.md`，且不含 `tasks/`、`goals/`、`experiments/`、`e2e/`。
- [ ] AC5 dry-run 走 npm 且不误伤：`npx release-it --dry-run --ci --increment=patch` 退出 **0**，输出含 `npm publish` 与 `@yalehwang/cloudcli`，push 目标含 `yaleh`（不是 `origin`）。
- [ ] AC6 未越界：`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内；`docker/`、`redirect-package/`、`CHANGELOG.md`、`electron/` 字节不变。
- [ ] AC7 `npm run typecheck` 与 `npm run lint` 退出 **0**。
- [ ] AC8 人工闸（需人 yale 授权）：`gh secret list -R yaleh/claudecodeui` 含 `NPM_TOKEN`。
- [ ] AC9 真实落地：`npm view @yalehwang/cloudcli version` 打印刚发布的版本；在干净目录 `npx --yes @yalehwang/cloudcli --version` 退出 **0** 并打印同一版本；`npm view @cloudcli-ai/cloudcli version` 仍是上游值（证明没有碰上游包）。

## DoD

- `@yalehwang/cloudcli` 在 npm 上有一个由 `Release` workflow 发布出来的版本，且能被 `npx` 真正拉下来运行——不是"配置改好了"，而是流水线真被触发并发布过一次。
- 用户在应用里点"升级"、CLI 打印手动升级提示、README 的安装命令，全部指向 `@yalehwang/cloudcli`，仓库面向用户的文本里不再出现会把人引向上游包的旧命令。
- 守卫把包名、`npm.publish`、`NODE_AUTH_TOKEN`、旧命令清零四处形态钉住；取假真的跑过。
- 只动 `## Touches` 列出的文件。

## Touches

- `package.json`
- `package-lock.json`
- `.release-it.json`
- `.github/workflows/release.yml`
- `README.md`
- `server/modules/cli/cli.module.ts`
- `server/modules/cli/cli.service.ts`
- `server/modules/cli/sandbox.service.ts`
- `server/modules/system/system.service.ts`
- `server/modules/system/tests/system.service.test.ts`
- `scripts/release/tests/fork-release-workflows.test.mjs`
- `src/modules/i18n/locales/de/common.json`
- `src/modules/i18n/locales/en/common.json`
- `src/modules/i18n/locales/es/common.json`
- `src/modules/i18n/locales/fr/common.json`
- `src/modules/i18n/locales/id/common.json`
- `src/modules/i18n/locales/it/common.json`
- `src/modules/i18n/locales/ja/common.json`
- `src/modules/i18n/locales/ko/common.json`
- `src/modules/i18n/locales/ru/common.json`
- `src/modules/i18n/locales/tr/common.json`
- `src/modules/i18n/locales/zh-CN/common.json`
- `src/modules/i18n/locales/zh-TW/common.json`
- `tasks/gap-npm-publish-yalehwang-cloudcli.md`
