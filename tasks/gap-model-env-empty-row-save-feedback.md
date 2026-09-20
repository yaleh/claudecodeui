---
id: gap-model-env-empty-row-save-feedback
title: Models 保存：空值 env 行不再静默丢弃——行内标出「不会保存」或阻断保存并列出被跳过的行
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-model-gateway-template-merge-toggle
---
## Proposal

判定机制（2026-09-20 拦截真实提交请求，未落库）：界面上有 6 行模板变量，实际发出的 body 只含 2 行（`ANTHROPIC_BASE_URL` value、`ANTHROPIC_API_KEY` unset）；`ANTHROPIC_AUTH_TOKEN` 与三个 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` 被静默丢掉，界面无任何提示。原因：`ModelEnvEditor.tsx:47` 的 `toRequestRows` 丢弃 value/envref 且值为空的行，`ModelLibraryPanel.tsx:154` 直接使用其结果。三个 `DEFAULT_*_MODEL` 钉住模型恰是网关参照配置的核心，模板默认产生 3 个空 value 行，问题因此尖锐。

修复（P0）：提交前校验——存在「有 key、kind 为 value/envref、值为空的新行」时，二选一并在实现里固定一种：(a) 行内显示「不会保存（值为空）」标记并在保存按钮旁汇总提示；(b) 阻断保存并列出被跳过的 key。两种都必须让用户在提交前看见哪些行不会入库。已存 secret 的行（`secretStored`，值留空表示保持原值）不属于「空值丢弃」，不得误报。

<!-- dedup-ref -->相关但不同：`gap-model-library-secret-write-only`（已 done）确立 secret 留空=保持原值的语义，本任务须保持该语义；`gap-model-gateway-template-merge-toggle` 处理模板的合并与可逆，本任务处理保存路径的反馈。

## AC

- [ ] `npx vitest run src/modules/settings/tests/modelLibrarySave.test.tsx src/modules/settings/tests/modelLibrarySettings.test.tsx` 退出码 0，新增用例：应用模板后不填值点保存，界面出现对 `ANTHROPIC_AUTH_TOKEN` 与三个 `DEFAULT_*_MODEL` 的可见提示（或保存被阻断并列出这些 key），且未静默提交缺行的 body。
- [ ] 新增用例：已存 secret 的行值留空点保存，不出现「不会保存」提示，且请求仍按原语义（保持原值）。
- [ ] 取假验证：还原为原先静默丢弃行为，上述提示用例必须变红（命令与输出写入完成记录）。
- [ ] `npm run typecheck && npx oxlint && bash scripts/test.sh` 退出码 0。

## DoD

真实落地：真实浏览器里应用网关模板、只填 base URL 后保存，用户在提交前就能看到 4 个不会入库的变量；数据库 `database/` 里不会出现「以为保存了其实缺行」的记录。测试用真实组件渲染（不是仅测 `toRequestRows` 纯函数）。

## Touches

- src/modules/chat/modals/ModelEnvEditor.tsx
- src/modules/chat/modals/ModelLibraryPanel.tsx
- src/modules/settings/tests/modelLibrarySave.test.tsx
- src/modules/settings/tests/modelLibrarySettings.test.tsx
- tasks/gap-model-env-empty-row-save-feedback.md