---
id: gap-session-telemetry-show-ai-title
title: Session telemetry（/cost 弹窗）的 meta info 显示 Claude 生成的 ai-title 原文：服务端按会话读
  transcript，手工改名后也照常显示
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

需求（人已定案）：输入框底部有 token 用量按钮，点开是 `/cost` 弹窗（英文标题行 Session telemetry），其下半部分的 meta info 块目前只有 Provider 与 Model 两项。要在这里再显示该会话的 `ai-title`，并且**始终显示 Claude 生成的原文**，即使会话已被手工改名或名字来源是别的（手工名、首句名）也照常显示。

为什么必须读 transcript 而不是读会话名：`sessions.custom_name` 里只存优先级胜出的那一个名字；一旦会话被标为 `manual`，同步器不再扫描 transcript，`ai-title` 就不再落库，库里没有可读的地方。所以要在弹窗打开时按需去 transcript 里取。这样迁移后全部标成 `manual` 的历史会话，只要 transcript 里有 `ai-title`，也能在这里看到。

已确认的现状：
1. `/cost` 由 `server/modules/commands/commands.routes.ts` 的 `"/cost"` 处理器构建 `CostCommandData`；前端 `executeCommand` 发给 `/api/commands/execute` 的 `context` 已带 `sessionId`（`useChatComposerState.ts`），服务端 `resolveCommandModel` 已经用同一个 `context.sessionId`，所以不需要改前端请求。
2. 前端 `CommandResultModal.tsx` 的 `CostContent` 在底部卡片里用两列网格显示 Provider 与 Model，文案是硬编码英文，没有走 i18n。
3. Claude 同步器已有「逐行流式读取、找到 `ai-title` 就停」的实现（`claude-session-synchronizer.provider.ts`）；实测 `ai-title` 每个文件只写一次、最晚在第 73 行，但单行最大可达约 750KB，所以必须流式读，不能整文件读入。

方案：
1. 后端新增一个只读的取值函数：给定会话 id（App id 或 provider id 均可，先按 provider id 再按 session id 查行，与 `session-upsert-broadcast.service.ts` 一致），只对 provider 为 claude 且行里有 `jsonl_path` 的会话，流式读取该 transcript，返回属于该会话（事件的 `sessionId` 等于行的 provider 会话 id）的 `ai-title` 文本；找不到、非 Claude、会话不存在、文件缺失或不可读一律返回 null，不得抛错、不得让 `/cost` 失败。路径只取自库里的 `jsonl_path`，绝不使用客户端传来的任何路径。
2. 该函数放在 providers 模块内，经其 `index.ts` 桶导出；commands 模块只通过依赖注入拿到它（沿用 `createCommandsRouter` 已有的依赖注入方式），不得深导入 providers 内部文件。
3. `"/cost"` 处理器在结果 `data` 里增加可选字段 `aiTitle`（有值才带，null 时不带该字段）。
4. 前端 `CostCommandData`（`src/shared/types.ts`）增加可选 `aiTitle?: string`；`CostContent` 在 meta 卡片里、Provider 与 Model 之下加一个横跨两列的「AI title」项，文本可换行（`break-words`），没有 `aiTitle` 时整项不渲染（不显示 Unknown 之类占位）。
5. 已知取舍：只有 Claude 有 `ai-title`，其他 provider 不显示该项；`ai-title` 在会话第一轮结束后才出现，之前打开弹窗不显示该项；弹窗是按需打开，所以不需要实时推送；对一个没有 `ai-title` 的大 transcript，每次打开弹窗会扫描一遍全文件，只在用户点击时发生，接受。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-ai-title.test.ts` 退出码 0：用真实 jsonl 夹具与临时 sqlite 断言——(a) App 会话（`session_id` 不等于 provider id）与 CLI 会话都能取到 `ai-title`；(b) 库里 `name_source` 为 `manual` 且 `custom_name` 是另一个名字时仍返回 transcript 里的 `ai-title` 原文（本任务的核心）；(c) transcript 无 `ai-title`、provider 不是 claude、会话 id 不存在、`jsonl_path` 为空、文件不存在，都返回 null 且不抛错；(d) 夹具为「`ai-title` 在第 5 行、其后还有超过 20MB 内容」时在读到该行后即停止（以读取字节数或行数的上界证明，不得整文件读取）；(e) 事件 `sessionId` 不属于该会话的 `ai-title` 行被忽略。
- [ ] 抗假变体：把取值改成直接返回库里的 `custom_name`，上一条的 (b) 必须变红；还原后转绿。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/commands/tests/commands.test.ts` 退出码 0（在既有用例之外新增）：`/cost` 的 `context.sessionId` 指向有 `ai-title` 的会话时 `data.aiTitle` 等于该标题；取值为 null 时结果里不含 `aiTitle` 字段；取值函数抛错时 `/cost` 仍返回完整的 token 与 model 数据（不因此失败）；既有的「cost 与 status 报告同一个解析后的 model」断言不回归。
- [ ] `npx vitest run src/modules/chat/tests/costModalAiTitle.test.tsx` 退出码 0：`CostContent`（经 `CommandResultModal` 的公开入口渲染）在 `data.aiTitle` 有值时在 meta 卡片里出现标签 AI title 与该文本，并且文本渲染在 Provider 与 Model 之后；`aiTitle` 缺省或为空串时不出现该标签；抗假变体——去掉该项的渲染，测试必须变红。
- [ ] `npm run typecheck` 与 `npm run lint` 退出码均为 0（含 boundaries：commands 只经 providers 桶取值，新增前端测试只经模块 barrel 导入）。

## DoD

真实落地判据：不是仅有单测。要求用临时 `DATABASE_PATH` 与临时 `HOME` 起独立服务实例（固定 `HOST=127.0.0.1`，结束时按进程组杀），播种一个 Claude 会话，其 transcript 含一条 `ai-title`；先经 `PUT /api/providers/sessions/:sessionId` 手工改名，使库里名字与 `ai-title` 不同；然后在真实浏览器里打开该会话，点击输入框底部的 token 用量按钮，读数三处：顶部标题是手工名、弹窗 meta 卡片里 AI title 一项是 transcript 里的原文、两者不相同。再打开一个没有 `ai-title` 的会话，确认弹窗里没有该项且弹窗其余内容正常。读数写进任务 Evidence。实施时后端按 `.agents/skills/backend-module-standards/SKILL.md`、前端按 `.agents/skills/frontend-module-standards/SKILL.md` 落位。

L_D 该轴仍暗，理由：只读取值与展示，没有可独立度量的数据或文档语义读数；验收以上面的单测与真实浏览器读数为准。

## Touches

- server/modules/providers/services/session-ai-title.service.ts (new)
- server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
- server/modules/providers/index.ts
- server/modules/commands/commands.routes.ts
- server/modules/commands/commands.module.ts
- server/modules/providers/tests/session-ai-title.test.ts (new)
- server/modules/commands/tests/commands.test.ts
- src/shared/types.ts
- src/modules/chat/modals/CommandResultModal.tsx
- src/modules/chat/tests/costModalAiTitle.test.tsx (new)
- tasks/gap-session-telemetry-show-ai-title.md
