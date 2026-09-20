---
id: gap-model-gateway-template-merge-toggle
title: Models 网关模板：按行合并而非替换（不抹掉已填值），且可逆（aria-pressed 开关）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-model-env-editor-full-width-layout
---
## Proposal

判定机制（2026-09-20 实测）：`ModelEnvEditor.tsx:107` 的模板应用按 key 匹配后 `filter` 掉旧行、再追加空白模板行——**替换而非合并**。实测：先填 `ANTHROPIC_BASE_URL = https://my-real-gateway.example`，再点模板，该行值变为空字符串，无确认、无撤销（数据丢失）。按钮无 `aria-pressed`、无激活态，重复点击幂等但不可逆，撤销只能逐个点 6 次垃圾桶。

修复（P0）：
1. 合并语义：模板只填「缺失的 key」与「值为空的同 key 行」，绝不改动已有非空值的行。
2. 真开关：按钮加 `aria-pressed` 与激活态；模板应用后、且被模板创建的行未被用户编辑过时，再次点击移除这些由模板创建的行（用户已编辑/已填的行保留）。
3. 若产品确需覆盖非空值，须弹确认；本任务默认不提供覆盖路径。

<!-- dedup-ref -->相关但不同：`gap-model-env-editor-full-width-layout` 处理同文件的布局，本任务处理模板行为；依赖它以串行化对 `ModelEnvEditor.tsx` 的写入，避免冲突。空值行保存丢弃另见 `gap-model-env-empty-row-save-feedback`。

## AC

- [ ] `npx vitest run src/modules/settings/tests/modelLibrarySettings.test.tsx` 退出码 0，且新增用例覆盖：先填 `ANTHROPIC_BASE_URL` 再点模板，该行值保持原值。
- [ ] 同文件新增用例：点模板后 `aria-pressed="true"`；再次点击后模板创建的行被移除、`aria-pressed="false"`；用户手填过的行在再次点击后仍保留。
- [ ] 取假验证：临时把合并改回「filter 后追加」，上述保值用例必须变红（在完成记录中写明命令与输出）。
- [ ] `npm run typecheck && npx oxlint && bash scripts/test.sh` 退出码 0。

## DoD

真实落地：真实浏览器里对已含用户值的编辑器点击模板，值不丢；连点两次模板回到点击前的行集合。测试不得只断言「预填的 key 与 kind」（现有 `modelLibrarySettings.test.tsx:110` 的弱点）。完成记录写入取假验证的红/绿输出。

## Touches

- src/modules/chat/modals/ModelEnvEditor.tsx
- src/modules/settings/tests/modelLibrarySettings.test.tsx
- tasks/gap-model-gateway-template-merge-toggle.md