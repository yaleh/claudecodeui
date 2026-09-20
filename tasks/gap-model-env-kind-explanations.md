---
id: gap-model-env-kind-explanations
title: Models env 行：四种 kind（value/envref/secret/unset）各配一句说明，尤其 unset 是「从 spawn
  环境删除该变量」
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-model-env-empty-row-save-feedback
---
## Proposal

判定机制（2026-09-20 实测）：`unset` 行只渲染一个 key 输入框，没有任何文字说明，用户无从知道 "Unset" 的含义是「从 spawn 环境中删掉该变量」（模板中的 `ANTHROPIC_API_KEY` 即此类，用于避免继承宿主的 key）。其余 kind 同样缺少提示。

修复（P1）：每种 kind 在行内配一句简短说明（helper text 或 title/aria-describedby），至少覆盖：value=字面值、envref=引用宿主环境变量、secret=写入后只显示已设置、unset=从 spawn 环境删除该变量。文案走 i18n（`src/modules/i18n/locales/{en,de,...}/settings.json` 中既有 models 相关 namespace，若该 namespace 已存在则沿用，不新造）。

<!-- dedup-ref -->相关但不同：布局任务 `gap-model-env-editor-full-width-layout` 提供整行宽度，说明文案放在其新行布局的第二行；本任务只加说明，不动布局与模板逻辑。

## AC

- [ ] `npx vitest run src/modules/settings/tests/modelLibrarySettings.test.tsx` 退出码 0，新增用例：选择 kind=unset 时渲染包含「删除/移除该变量」语义的说明节点，且该说明与输入框通过 `aria-describedby` 关联。
- [ ] 新增用例：其余三种 kind 各自渲染对应说明，切换 kind 时说明随之改变。
- [ ] `grep -rn "unset" src/modules/i18n/locales/en/settings.json` 命中新增文案键，且 de 等已有 locale 同键存在（`npm run typecheck && npx oxlint` 退出码 0）。
- [ ] `bash scripts/test.sh` 退出码 0。

## DoD

真实落地：真实浏览器里把一行切到 unset，页面上可读到解释文字，屏幕阅读器可经 `aria-describedby` 读到；文案在 en 与 de 下均非空且不是 key 原文。仅新增 i18n 键而未渲染不算完成。

## Touches

- src/modules/chat/modals/ModelEnvEditor.tsx
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/de/settings.json
- src/modules/settings/tests/modelLibrarySettings.test.tsx
- tasks/gap-model-env-kind-explanations.md