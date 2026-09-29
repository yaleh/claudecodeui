---
id: gap-resident-i18n-duplicate-key-shadows-toggle-and-notice
title: AC-171 现红：chat.json 重复顶层 resident 使 resident.toggle 与 resident.notice.*
  读不到，合并重复键并加同类检查
status: todo
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-171
---
## Proposal

**现状读数（2026-09-29 本轮直跑）。** `npx playwright test e2e/resident-enable-consent.spec.ts` 退出 1：`1 failed, 2 did not run`，失败在 `e2e/resident-enable-consent.spec.ts:345`，`strict mode violation: getByRole('switch') resolved to 2 elements`（常驻开关与 Toggle dark mode）。

**根因。** `src/modules/i18n/locales/en/chat.json` 第 2 行与第 390 行各有一个顶层 `"resident"`，`zh-CN/chat.json` 第 2 行与第 311 行同样。`JSON.parse` 对重复键只留后者，第一块的 `toggle` 与 `notice.*` 运行期读不到：界面直接显示 `resident.toggle`、`resident.notice.title/bypass/trustBoundary/acknowledge` 原始键名（真浏览器实测），spec 里 `enChat.resident.toggle` 为 `undefined`，`{ name: undefined }` 等于不限名字。其余 10 个语言只有一个 `resident` 块、本来就没有这两组键，靠 `fallbackLng: 'en'`（`src/modules/i18n/config.ts:266`）回退英文，不在本任务范围。

**判据物。** AC-171 的判据原文不变，本任务认领已有 AC，不新增 AC，不改 spec。

## Plan

1. 把 `en`、`zh-CN` 第一个 `resident` 块里的 `toggle` 与 `notice` 并入各自最后一个 `resident`，删掉第一个块，文案逐字保留。
2. 新增 `src/modules/i18n/tests/localeDuplicateKeys.test.ts`（vitest，放在功能模块自己的 `tests/`）：逐个读 `src/modules/i18n/locales/*/*.json` 原文，用不吞重复键的扫描找同一对象内的重复键；并断言 `en`、`zh-CN` 的 `resident.toggle` 与 `resident.notice.acknowledge` 解析后可读。
3. 跑取假形态与正控制，登记逐字读数。

## AC

- [ ] AC1 判据绿：`npx playwright test e2e/resident-enable-consent.spec.ts` 退出 0。红态基线本轮实测：退出 1，`Error: strict mode violation: getByRole('switch') resolved to 2 elements`，`1 failed`，`2 did not run`。
- [ ] AC2 检查文件绿：`npx vitest run src/modules/i18n/tests/localeDuplicateKeys.test.ts` 退出 0，且它对全部 12 个语言目录下所有 json 文件都做了重复键扫描（断言扫描文件数等于 `locales/*/*.json` 的实际文件数，不是固定常数）。
- [ ] AC3 取假形态必须红（承重）：(a) 在 `en/chat.json` 再造一个顶层 `resident` 块，AC2 必须退出非 0，红落在「重复键」断言上；(b) 只合并 `en`、不合并 `zh-CN`，AC2 必须退出非 0；(c) 把 `en` 的合并撤回，AC1 必须退出非 0，红落在 `:345`。每种变异跑完恢复，登记逐字失败行。
- [ ] AC4 正控制：`de/chat.json`（本来只有一个 `resident` 块）单独喂给同一扫描函数读绿，证明扫描不是恒红。
- [ ] AC5 契约面：`npm run lint` 退出 0；`git diff --stat` 与 Touches 逐条对齐。

## DoD

- 文案逐字保留，只移动位置，不改一字。
- 不改 `e2e/resident-enable-consent.spec.ts`，不改其他 10 个语言，不改前端组件。
- 扫描读的是文件原文，不是 `JSON.parse` 之后的对象（后者恰好看不见重复键）。
- 假形态真跑过、真红过，红落在承重断言上。
- 第 2 到 4 类界面缺陷（弹层关闭被盖、已常驻会话仍显示开关、状态条压消息）不在本任务，另立 AC 与任务。

## Touches

- `src/modules/i18n/locales/en/chat.json`
- `src/modules/i18n/locales/zh-CN/chat.json`
- `src/modules/i18n/tests/localeDuplicateKeys.test.ts` (new)
