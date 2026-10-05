---
id: gap-voice-user-identifier-index-import
title: 用户标识符索引（U 词源）：每条发出的消息自动记入、从历史会话一次性导入冷启动，只存词和次数、不存句子，可一键清空
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-correction-feedback-loop.md` 阶段 0（「从历史会话导入用户发过的标识符做 U 词源冷启动」）与 §5.2；依据 `experiments/voice-index-loop/RESULT-v3.md`、`RESULT-v6.md`：U（用户发过的词）提供找到的有害错误的绝大部分，且无需任何纠正动作。同机制去重：`grep -il 'lexicon\|词典\|用户标识符' tasks/*.md` 无同机制任务；`gap-voice-identifier-repair-module` 的候选是**项目文件树**（P 词源），本任务是**用户自己发过的词**（U 词源），来源不同。

### 目标

建一个最小的「用户标识符索引」：记录用户**发出去的消息**里出现过的标识符形 token 及次数，作为候选的第一词源。两条进入路径：①之后每条发出的消息自动记入；②**一次性**从已有的历史会话导入（冷启动，第一天就有可用的词）。**只存词、次数与时间，不存任何句子。**

### 方案

1. **表**：`voice_user_identifiers(token_lower TEXT, canonical TEXT, count INTEGER, first_seen_at INTEGER, last_seen_at INTEGER, project_key TEXT)`，`(token_lower, project_key)` 唯一；迁移走既有的 `server/modules/database/migrations.ts` 机制；仓库放 `server/modules/database/repositories/`，与现有 `user-preferences.db.ts` 同风格。
2. **形状规则**（取数前定死）：与 `experiments/voice-index-loop/sim/extract.py` 的 `is_id` **逐条一致**——长度 ≥ 2；不含 `/`、不以 `.ext` 结尾；含驼峰边界、`_`、`-`、数字，或 ≥ 2 位全大写；不收路径、文件名、URL、UUID、7–40 位十六进制哈希。
3. **只收人写的消息**：排除 quay 驱动注入的提示词、续接摘要、任务通知、命令标记、粘贴块与代码块；**排除凭据样式的消息**（`passwd|password|passphrase|token|secret|sk-…|Bearer |密码|口令|api key 后接值|authorized_keys`，与 `extract.py` 的 `SECRET` 一致）。
4. **接入点**：执行者在服务端找到「用户消息被接受 / 追加进会话」的**唯一**位置（`grep` 后在 `## Evidence` 写明位置与理由），在那里调用 `observeSentText(text, projectKey)`；找不到唯一位置就停下来在 Evidence 里说明，不得在多处各插一份。**据实在 Touches 里追加该文件**。
5. **导入**：`POST /api/voice/lexicon/import` 遍历既有会话里的用户消息（走既有的会话索引 / 同步器，不另读原始 jsonl），**幂等**（重复导入计数不翻倍：以消息 id 去重）。
6. **接口**：`GET /api/voice/lexicon?limit=` 返回按次数排序的 `{ token, count, lastSeenAt }`（不含任何句子）；`DELETE /api/voice/lexicon` 清空。路由只解析与转发，业务在服务里。
7. 遵循 `.agents/skills/backend-module-standards`：`server/modules/voice/` 下全部 TypeScript，共享类型进 `server/shared/types.ts`，测试在 `server/modules/voice/tests/`。

### 边界（不做）

不做词典管理页（阶段 2）；不做候选生成与打分；不碰语音音频；不把索引同步到任何云端。

## AC

- [ ] `npx vitest run server/modules/voice/tests/voice-lexicon.test.ts` 退出码 0，且含 `is_id` 已知答案表（≥ 16 条：`needs-human`、`AC-103`、`CloudCLI`、`GOAL-013`、`provider_models`、`MCP` 为真；`server.ts`、`a/b`、`plain`、`https://x.y`、一个 UUID、一个 40 位哈希为假），逐条与 Python 参考实现的结果一致（测试里内嵌同一张表）
- [ ] 导入：用一个**构造的**会话 fixture（含人写消息、注入提示词、凭据样式消息、粘贴块）调用导入后，索引里只有预期的 token 与次数；凭据样式消息里的哨兵 token **不在**索引里；任何句子片段**不在**数据库里（`sqlite3` 导出后 `grep` 句子哨兵无输出）
- [ ] 幂等：对同一 fixture 连续导入两次，所有 `count` 与第一次相同
- [ ] 自动记入：模拟「发出一条消息」后，其中的标识符形 token 次数加 1，非标识符形不进索引；接入点唯一（Evidence 里写明，`grep -rn "observeSentText" server | grep -v tests` 只有一处调用）
- [ ] `GET /api/voice/lexicon?limit=5` 按次数降序返回至多 5 条，响应里没有 `text` / `sentence` 字段；`DELETE /api/voice/lexicon` 后表为空（路由与服务测试）
- [ ] MCP 浏览器验证：用 playwright MCP 打开已登录的 `http://localhost:3001/`，在页面里用 `browser_evaluate` 的 `fetch('/api/voice/lexicon/import', { method: 'POST', ... })` 触发导入，再 `fetch('/api/voice/lexicon?limit=20')`，返回按次数排序的词列表（含本项目里最常用的名字）；把调用与返回的前 10 条（仅词与次数）记入 `## Evidence`
- [ ] `npm run typecheck`、`npm run lint`、`npm run build` 退出码 0

## DoD

真实落地判据：对**这台机器上真实的历史会话**做一次真实导入，得到的词表里能看到本项目最常用的标识符（如 `needs-human`、`CloudCLI`），且凭据样式的消息没有进来、数据库里没有句子。导入可重复执行而不翻倍。

L_D 该轴有读数：新增的是用户词的统计数据，由真实导入的词表给出。

L_G 该轴仍暗，理由：本任务只建索引，不含评测指标。

## Touches

- server/modules/voice/voice-lexicon.ts (new)
- server/modules/voice/voice.routes.ts
- server/modules/voice/voice.module.ts
- server/modules/voice/index.ts
- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/voice-user-identifiers.db.ts (new)
- server/shared/types.ts
- server/modules/voice/tests/voice-lexicon.test.ts (new)
- tasks/gap-voice-user-identifier-index-import.md
