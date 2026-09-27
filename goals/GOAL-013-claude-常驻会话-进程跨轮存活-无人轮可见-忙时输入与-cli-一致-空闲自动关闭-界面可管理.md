---
id: GOAL-013
title: Claude 常驻会话：进程跨轮存活、无人轮可见、忙时输入与 CLI 一致、空闲自动关闭、界面可管理
status: draft
kind: goal
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令
---
## 背景

per-run 模式下每轮一个 claude 进程，CronCreate 最多触发一次、周期大于 30 分钟不触发、用户一说话就丢；ScheduleWakeup 大于 30 分钟不触发；SendMessage 的 peer 名与 socket 每个进程都变；空闲会话没有进程，不可寻址。提案 docs/proposals/claude-resident-sessions.md 给 Claude 增加常驻模式：进程在两轮之间不退出，stdin 由服务端握着，所有输入推进同一个进程。

本 goal 建立在 GOAL-012（宿主层）之上。人 yale 2026-09-25 裁定本 goal 暂不激活：忙时输入的基准（原则 6，与 Claude Code CLI 一致）与内存上限的数值要由 tasks/gap-claude-resident-phase0-experiments 的实验给出，写回 proposal 并经人确认后再定稿 AC 并激活。

## 范围

- Claude resident driver：不结束的输入队列、读取循环以 session_state_changed 切分轮次（缺失时退回 result）、task_* 事件与 Stop hook 的 session_crons / background_tasks 维护保活理由、interrupt 不杀进程、setModel/setPermissionMode 等在线重配置、关闭即 stdin EOF。
- 无人轮（cron、Monitor/后台任务回报、跨会话消息）由 manager 开 run，来源为 unattended，无连接也记录，可回放，并推送通知。
- 忙时输入与 CLI 一致：不拒绝、不在服务端排队，立即写入进程，归入 CLI 实际给出的那一轮。
- 默认 bypassPermissions 启动；无人值守时 AskUserQuestion 与 ExitPlanMode 自动拒绝并通知。
- 稳定的 SendMessage 地址（extraArgs.name）。
- 空闲关闭（24 小时，可配置；cron 保活理由最长 7 天；浏览器停留不算活动）。
- 服务停止与被杀后的关闭与启动清扫；重启后不自动恢复，下一次发送重新拉起。
- 进程层：复用并推广 tasks/gap-claude-session-cgroup-scope 的 scope 服务，给常驻进程单进程上限与 slice 总上限（数值来自实验 E7）。
- sessions 表的 lifecycle_mode 列、能力矩阵 residentFeatures、常驻的 start/close REST。
- 前端（proposal §15）：开启与知情勾选、状态标记与状态条、停止与关闭分开、无人轮呈现、Running 两组与徽标、常驻禁用 Shell、忙时直发。UI 的派工任务以 API 面冒烟的人工关卡为前置；UI e2e 用调试 agent 的常驻场景驱动。

## 非目标

- 服务重启后恢复常驻进程或其 cron。
- 把 CronCreate 持久化为 scheduled-messages。
- Codex、Cursor、OpenCode 的常驻模式。
- 新增 cloudcli 子命令。
- 依赖 Claude Code 自带的 --bg 或 daemon。

## 退出条件

- AC-161 常驻进程跨轮存活，中止不杀进程，关闭后进程退出。
- AC-162 无人轮在无浏览器时产生、建 run、可回放并通知。
- AC-163 忙时输入与 CLI 一致（基准来自实验 E2/E3 与人的确认）。
- AC-164 稳定的 SendMessage 地址可被另一会话使用并产生一轮。
- AC-165 空闲关闭：有 cron 时不在空闲超时处关闭，浏览器停留不阻止关闭。
- AC-166 服务停止或被杀后无残留，重启后显示已随重启关闭，下一次发送重新拉起。
- AC-167 超出内存上限时只有该常驻进程被杀。
- AC-168 默认 bypass，无人值守时交互式请求被自动拒绝并通知。
- AC-169 lifecycle_mode 与能力矩阵的约束，常驻的 start/close 可经 API 操作。
- AC-170 人工关卡：API 面真模型冒烟由人确认通过。
- AC-171 至 AC-175 真实浏览器里的开启知情、状态呈现、Running 分组、Shell 禁用、忙时直发与撤回。
- AC-176 常驻进程的 Remote Control 跨机器可达性被强制关闭，信任边界保持在同一 Unix 用户。
- 上述 AC 全部 achieved；或由人裁定放宽、取消其中任一条。
- 标题中的「cron 跨轮持续触发」不作为 60 秒判据：cron 最小粒度 1 分钟，连续触发要数分钟，超出判据硬超时。其读数由实验 E1 给出并记录在 proposal；目标级判据以 Monitor 驱动的无人轮（AC-162）与 cron 保活理由的记账（AC-165）承载同一不变式。

## 已知限制

- 本 goal 的 AC 在实验任务完成前均为草案；AC-163、AC-165、AC-167、AC-168、AC-175、AC-176 的判据细节依赖 E2/E3、E7、E8、E9 的结论，激活前要按结论修订。E2/E3 已测得忙时推入的消息另起一轮；E9（控制协议清单）是 2026-09-25 依据对 claude 2.1.282 二进制的静态分析追加的。
- SDK 0.3.165 的类型落后于全局 claude 2.1.282：scheduled_task_fire、side_question 等 subtype 只在 CLI 里出现。判据里的伪造流要包含一条未知 subtype，确认 driver 放过它。
- 真实 claude 二进制类判据受本机全局重装 claude 影响（SDK spawn 测试会红），归因时先看二进制 mtime。
