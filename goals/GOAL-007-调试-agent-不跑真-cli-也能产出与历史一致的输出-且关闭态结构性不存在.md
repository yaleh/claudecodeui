---
id: GOAL-007
title: 调试 Agent：不跑真 CLI 也能产出与历史一致的输出，且关闭态结构性不存在
status: active
kind: goal
origin: ADR-003 评审通过（人 yale，2026-09-22，见 adr/ADR-003-*.md 的 Adjudication 小节，含裁决
  A–E）。立此目标前已在 worktree 分支 proto/debug-agent-spike 上做过一次热修改实测：845 行模块 + 5 个既有
  文件 89 行改动，两条摄入路径均跑通，全程无真 CLI 进程；该分支是验证工装，不作为实现基础。与
  GOAL-001/002/003/004 同形：单元测试证伪不了"产出是否经由真实链路"，只有目标级判据能抓住。
activatedAt: 2026-09-22T15:00:09.559Z
statusLog:
  - at: 2026-09-22T15:00:09.559Z
    from: draft
    to: active
    actor: yale
    reason: 人 yale 指示激活（"激活该 goal"）。此前已按 ADR-003 评审通过（见该 ADR 的 Adjudication
      小节，裁决 A–E）立此目标，六条 AC-123…128 与六条对应派工任务已立。激活时现场复测六条判据的
      criterion，全部 exit=1（红先行成立）——它们引用的 checker 与模块今天都不存在。
---
## 背景

排查 transcript 贴底/流式增量这类"输入输出形状"的问题时，今天没有可控的复现手段。能端到端产生一次真实输出的路径只有一条：拉起真 CLI 进程，让它按自己的节奏吐字——于是行什么时候出现、一次吐多少字节、中间隔多久，全都不可控、不可复现。

既有的浏览器侧替身（`e2e/transcript-follow.spec.ts` 的 `installWireDouble` / `__injectStreamFrame` / `startWireStream`）只替换了 `window.WebSocket`，注入的也只有 `stream_delta` / `stream_end`。它**完全跳过后端**：runtime、按 provider 的归一化、`seq` 与重放、`complete` 触发的 REST 重取、权限帧，都不在链路上。更关键的是，**被外部 CLI 写入、app 仅旁观的会话**（chokidar 观察 → `session_upserted` 广播 → 客户端 REST 重取整行）这条摄入路径**零 e2e 覆盖**。

一个只能在测试里被驱动的产出源，会在这些地方与真实 provider 分叉；而分叉了的调试工具，不能用来排查"实时与历史不一致"这一类缺陷——它自己就会制造这类不一致。

## 范围

让"不跑真 CLI 也能产生真实输出"成为一个**可装载场景、可推进时钟、可读自检结果**的能力，且产出必须与真实 provider 走同一条链路。范围即 ADR-003 的七条决策：

1. **两个面、一个引擎**：应用内一等公民的调试 Agent（能出现在会话列表、能被选中、能产生真实输出）+ dev-only 控制面（装载场景、推进时钟、读自检）；两面共用同一引擎与同一份场景文档，引擎实现在后端。
2. **运行期 provider id**：只加 registry 键 + 显式 id cast，**刻意不进 `LLMProvider` 联合**（联合是产品声明，进去要改约九处编译强制点外加约十处用户可见数组）。按裁决 A，UI 上必须给它**明确的显示身份**，不接受被落穿显示为 Claude。
3. **env 门控，默认关闭，且关就是结构性关**：按裁决 B 为**三面**（registry 无键、watcher 无根、路由未挂载）——capabilities 由闭集字面量天然免疫，不计入四面，也不为它增加门控耦合。
4. **必须写真实形态的 transcript**，且行→帧交给真实归一化；`complete` 触发的 REST 重取必须与实时所见一致。
5. **两条摄入路径都要能驱动**，含外部写入 → 观察者 → `session_upserted` → REST 重取这条零覆盖区。
6. **控制面走 HTTP + 既有 `authenticateToken`**，门控才是安全边界；不新增 WS 通道、不新增 CLI 脚本。
7. **禁止第二套事件词表**：调试模块只构造方言行，帧只来自 `normalizeMessage` / `createNormalizedMessage`。

判据以 AC 的 checker 读数表达，不以"模块存在"或"配置里出现了哪些行为标志"表达。

## 不做

- **不复现贴底漂移**。ADR-003 的"后续任务 7"经裁决 C 移出本范围：该缺陷今天已有两个占位者——`AC-106/108/111`（GOAL-004，均 `achieved`）与 `tasks/gap-transcript-follow-whole-row-append-drift`（`ready`，其判据已含"几何断言之外必须有内容/行数断言"与抗假变体）。再立一条即是同一缺陷的第三个工件。
- **不做多方言**。v1 只有 claude 一种方言，`dialect` 取值是闭集。
- **不给阈值**。几何/时间类数字由运行导出或写成区间。
- **不合并 `proto/debug-agent-spike`**。它是验证工装，含代码，会让 `gap-debug-agent-synthetic-provider-adr` 的"未产生任何代码"AC 与 DoD(c) 的空读数同时变假。
