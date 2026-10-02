---
id: gap-debug-agent-typed-turn-writes-no-user-row
title: 调试 agent：用户打字发出的回合不落 user 行，实时所见与 REST 重取分叉（AC-124 判据面漏掉该路径）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**缺陷（实测）。** 经调试 agent 的会话，用户在输入框里打字发出的回合，**永远不会写进 transcript**。transcript 里只有种子那一行 user，以及每条打字回合对应的 assistant 行。

实测读数（隔离实例，场景 `steps` 只有 `{at:0,op:'row'}` + `turn-end` + `wait`）：
- 打字 3 轮后，transcript 共 5 行：`custom-title` + 种子 `user` + **3 条 `assistant`**，**0 条**对应打字的 `user` 行。三条 assistant 的时间戳分别为 03:09:22 / 03:10:03 / 03:10:25，与三次点发送的时刻逐一对上。
- 同一时刻 `GET /api/providers/sessions/:id/messages` 返回 4 行：种子 user + 3 条 assistant。同样**没有**打字的 user 行。
- 浏览器里实时是 5 行（含我打的 3 句）；**刷新页面后只剩 2 行** —— 我打的三句话全部消失。

**机制（代码归属）。** 写 `user` 行的地方只有两处，都不是打字路径：
1. 种子行 —— `server/modules/debug-agent/debug-agent.runtime.ts:368`（`armDebugAgentScenario` 里 `role: 'user'`，文本取自 `scenario.seed.userText`）。
2. `unattended-turn` 这个场景 op —— `server/modules/debug-agent/debug-agent.host-driver.ts`（约 256 行起的宿主回合入口），文本取自场景文档的 `text` 字段。

客户端打字发出的回合没有任何 writer：它走的是 provider runtime → 宿主 → run registry，随后按场景时钟走 `row` 步产出 assistant 行，而**输入框里那段文字自始至终没有被写下来**。

**为什么既有判据没抓住。** `goals/AC-124-*.md`（已 achieved）声称「实时所见与 REST 重取逐 id 一致」，正是这一类的守卫；但它的判据命令只驱动 `server/modules/debug-agent/tests/debug-agent-frames.test.ts`，而那里面走的是 `POST /api/debug-agent/clock`（场景时钟）路径。**打字路径不在它的判据面内**，所以它一直绿。

**这为什么是缺陷而不是「设计如此」。** `debug-agent.runtime.ts:54` 的注释写着「Omitted (not `undefined`-valued) for a typed turn, so a row written by a person and a row written by the host layer differ on disk rather than only in the reader's interpretation」—— 即设计上预期**人打的行在磁盘上是存在的**，且与宿主开的回合行靠 `origin` 字段区分。今天这个预期没有实现。

**影响。** 任何用调试 agent 当 provider 替身的 e2e，只要涉及「发一条消息然后回读历史」，都会拿到一个缺了用户输入的历史；刷新即丢。

## AC

- [ ] 新增判据文件 `server/modules/debug-agent/tests/debug-agent-typed-turn.test.ts`，且**对当前实现必红**：装载一个场景、经打字路径（而非 `/clock`）发出一个含可识别文本的回合，断言 transcript 中新增一条 `role: 'user'` 且文本等于该输入的行。命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-typed-turn.test.ts`；命令必须逐字含该文件路径，**不得用 glob**（glob 无命中时 `node --test` 退出 0，会在文件不存在时假绿）。失败时输出实际 transcript 的行类型序列。
- [ ] 同一判据断言 REST 一面：`GET /api/providers/sessions/:id/messages` 返回的行 id 集合，必须覆盖该打字回合的 user 行。打印两个集合的差。
- [ ] 取假变体必须红：**frames-only**（只发帧、不写 transcript）必须让上两条同时失败。在完成记录里登记实际跑出的红。
- [ ] 不回归：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-frames.test.ts` 仍绿（AC-124 的 `/clock` 路径不许被这次改动弄红）。
- [ ] 修复后，一个真实打字回合在**刷新页面后仍然可见**：以实机读数（浏览器刷新前后行数与文本）登记在完成记录里。

## DoD

真实落地：一次**经真实链路**的打字回合，其用户文本既在 fixture 根下的 JSONL 里、也在 REST 重取里，且刷新浏览器后仍在页面上。承重性由三件事正面证明：
(a) 判据文件在没有修复时是红的（先红后绿，红要先于修复被观察到）；
(b) frames-only 取假变体确实让判据红；
(c) AC-124 既有的 `/clock` 判据仍绿 —— 即这次改动没有用「把时钟路径也弄坏」的方式换取绿。

## Touches

- server/modules/debug-agent/debug-agent.host-driver.ts
- server/modules/debug-agent/debug-agent.runtime.ts
- server/modules/debug-agent/tests/debug-agent-typed-turn.test.ts (new)
- tasks/gap-debug-agent-typed-turn-writes-no-user-row.md