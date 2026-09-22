---
id: gap-session-lastactivity-from-file-mtime
title: 会话列表「最近活动」取自 transcript 文件 mtime 而非内容里最后一条带 timestamp 的记录：真实空闲 46.5h 的会话在
  UI 上显示为约 1 小时前
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

会话列表每行显示的「最近活动」是 transcript **文件的 mtime**，不是 transcript **内容里最后一条带 timestamp 的记录**。于是任何文件系统层面的触碰（外部进程重写/恢复该文件、CLI 自身 flush 状态记录）都会把一个空闲会话显示成刚刚活跃——显示的数值忠实反映了 mtime，是 mtime 不诚实。

**立案时的实测证据（session e6065ac3）：**

- transcript 最后一条带 timestamp 的记录：`2026-09-20T07:32:16.501Z`
- 该文件 mtime：`2026-09-22 13:45:36.042845706 +0800`
- 库中 `sessions.updated_at`：`2026-09-22T05:45:36.043Z`——与 mtime 毫秒级完全相同
- 即真实空闲 46.5 小时，UI 显示约 1 小时前
- 该会话确为空闲：拥有它的 CLI 进程（pid 2830976）仍活着但 `~/.claude/sessions/2830976.json` 记 `status: "idle"`、`updatedAt` = 09-20 15:16:51；从未出现过 `claude --resume e6065ac3` 进程
- 同项目 661 个 transcript 中另有 11 个的 mtime 恰为「最后消息 + 约 1 小时」，是同一机制的较轻形态

**代码路径（全部取文件系统时间，无一处读消息时间）：**

`server/modules/providers/list/claude/claude-session-synchronizer.provider.ts:80,114` 调 `readFileTimestamps(filePath)`（`server/shared/utils.ts:1016`，`updatedAt: fileStat.mtime.toISOString()`）→ `sessionsDb.createSession(..., timestamps.updatedAt, ...)` → `sessions.updated_at` → `server/modules/projects/services/projects-with-sessions-fetch.service.ts:153`（`lastActivity`）→ `src/modules/sidebar/SidebarSessionItem.tsx:61` 与 `src/modules/sidebar/SidebarContent.tsx:251` 的 `formatCompactAge`。

**修复方向：** 在 `server/shared/utils.ts` 增加一个「按内容取最后活动时间」的助手：只读打开，读有界尾部窗口，丢弃末尾半行，反向走到最后一条能解析且带字符串 `timestamp` 的 JSON 记录；找不到返回 null。claude 同步器改用它，取不到时**回落到 mtime**（刚创建、尚无任何记录的 transcript 必须仍有时间）。codex / cursor 同步器共用 `readFileTimestamps`，本次**不改其语义**，因此只在 claude 路径接线。

**性能约束（实测，必须守住）：** 内容读取只能发生在「该文件变了 / 是新文件」的路径上，绝不能进 `findFilesRecursivelyCreatedAfter` 的目录遍历——那次遍历每次 `/api/projects` 都要跑（`projects-with-sessions-fetch.service.ts:231` → `synchronizeSessions()`）。本机语料遍历实测 1213 个 `.jsonl`（`-maxdepth 2` 口径 1181 个、826.6 MB）。实测：遍历本身 5 ms；最大 transcript（9.7 MB）尾扫 64 KB 窗口 0.30 ms、256 KB 窗口 1.15 ms。放错层是 0.3 ms × 1213 ≈ 0.36 s 每次列表请求（冷缓存还要碰 827 MB），放对层是每事件约 1 ms。

**历史行：** 已索引的行不会自动纠正——boot 扫描按 `birthtime > lastScanAt` 过滤，watcher 只在文件变化时触发。AC-3 / DoD(d) 要求把已存在的行也修正过来。

## AC

- [ ] AC-1 尾部扫描助手的行为：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/transcript-last-activity.test.ts` 退出码 0，覆盖 (a) 尾部是无 timestamp 的记录（`last-prompt` / `cost-state`）时跳过并取到更早的带 timestamp 记录；(b) 最后一行是半截 JSON 时不抛异常且取到上一条；(c) 全文件无 timestamp 记录时返回 null；(d) 返回值等于记录里的时间戳字符串本身。

- [ ] AC-2 反假对照（同一 fixture 会话目录，两半读数都打印）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts` 退出码 0，且输出含 `touch: before=… after=…` 与 `append: before=… after=…` 两行——(a) 只把 transcript 的 mtime 推到当前、内容一字不改后重新同步，`sessions.updated_at` 不变；(b) 追加一条带新 timestamp 的记录后重新同步，`sessions.updated_at` 前进到该 timestamp。把实现换回 mtime 版本时 (a) 半段必须变红——这正是该判据能区分两种实现的证明。

- [ ] AC-3 真实语料读数（必须带正对照）：一段脚本对 `~/.claude/projects` 下每个 transcript 比较「库中 `updated_at`」与「内容里最后一条带 timestamp 的记录」（跳过 transcript 已不存在的行），打印 `rows=<n> controls=<m> mismatched=<k>`；要求 `controls >= 1` 且 `mismatched == 0`。正对照必须包含 mtime 明显晚于内容时间的真实样本（立案样本 e6065ac3：mtime 比最后消息晚 46.2 h，若该行已被清理则换用同类样本并写明）。`controls == 0` 时必须判失败——否则一个什么都不做的实现也能拿到 `mismatched == 0`。

- [ ] AC-4 内容读取没有进目录遍历（无需注入缝的机械判据）：一个测试在 fixture 目录建好若干 transcript 并跑一次 `synchronize()` 建立游标；随后把这些 transcript `chmod 000`（保留 birthtime 与目录可执行位），再跑一次热扫描，要求不抛异常且处理文件数为 0。若实现把内容读取放进了遍历，第二次扫描会以 EACCES 失败——这正是要钉住的失败。命令：`npx tsx --tsconfig server/tsconfig.json --test <承载该断言的测试文件>` 退出码 0。

- [ ] AC-5 门禁：`npm run lint` 退出码 0；`npm run typecheck` 退出码 0（两者在立案时均为绿）。

## DoD

(a) **判据真绿 + 抗假已证**：AC-1..AC-5 全部退出码 0；且 AC-2 的 (a) 半段在「实现换回 mtime」的变体下确实变红——把该变体的红输出与正常绿输出一并登记。只报绿不报对照不算完成。

(b) **真实对象被真的操作过**：不只有 fixture——在 canonical checkout 上对真实语料跑 AC-3，`controls >= 1` 且 `mismatched == 0`；并给出至少一条真实行修复前后的 `lastActivity` 读数（修复前 = 文件 mtime，修复后 = 内容时间）。

(c) **列表没有变慢**：给出 `/api/projects` 热路径 wall time 读数（修复前后各一次，同机同时刻同语料），并证明增量落在噪声内；AC-4 是这条的机械面。

(d) **历史行被纠正**：说明并验证已被索引的旧行如何被重新推导（不能只对「文件下次变化」生效），给出至少一条旧行的前后读数。

(e) **边界如实登记**：codex / cursor 同步器语义本次未改；若实现过程中不得不改到它们，须在完成记录里写明原因与影响面，而不是悄悄扩大改动面。

(f) **落地面**：新测试文件按仓内既有约定用 `@/shared/...` 别名走叶文件导入（参见 `server/shared/tests/slice-tail-page.test.ts` 的 `@/shared/utils.js`），以免撞上 boundaries 类 lint。

环境噪声须如实登记：本机是共享机器，fleet 常驻并发。与本机制无关的红（加载类／端口类）须写明红因并给出单独跑为绿的对照读数；不得当作本任务已完成或未完成的证据，也不得靠加重试换绿。

L_D 本任务有真实读数：`~/.claude/projects` 全语料中「库中 `updated_at` 晚于内容最后 timestamp」的行数，修复前 > 0、修复后 = 0（即 AC-3 的 `mismatched`）。读数为 0 而 `controls` 为 0 时不构成读数。
L_G 该轴仍暗，理由：本任务不新增 goal 判据，只让会话列表「最近活动」的语义与其声称的含义一致。

## Touches

- server/shared/utils.ts
- server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
- server/shared/tests/transcript-last-activity.test.ts (new)
- server/modules/providers/tests/claude-sessions.test.ts
- tasks/gap-session-lastactivity-from-file-mtime.md
