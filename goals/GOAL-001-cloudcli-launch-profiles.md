---
id: GOAL-001
title: CloudCLI launch profiles
status: active
kind: goal
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
activatedAt: 2026-09-20T03:23:55.627Z
statusLog:
  - at: 2026-09-20T03:23:55.627Z
    from: draft
    to: active
    actor: yale
    reason: 七条 AC 已立并全部实测为红（红先行），目标进入 active
  - at: 2026-09-20T06:04:57.610Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
  - at: 2026-09-20T06:35:09.467Z
    from: achieved
    to: active
    actor: yale
    reason: 范围复核：首次 achieved 时七条 AC 未覆盖 REST 路由、真实 profile 的 spec 产出与全部前端，补
      AC-008/009/010（均实测为红）后退回 active
  - at: 2026-09-20T06:54:19.444Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
  - at: 2026-09-20T07:43:42.792Z
    from: achieved
    to: active
    actor: yale
    reason: playwright 实机验证发现写入路径白名单缺失、i18n key 外泄、Profiles 编辑器仅
      name+model、会话创建入口无选择；补 AC-011/AC-012（均实测为红）后退回 active
---
让单个 CloudCLI 实例能同时对接 Anthropic 官方服务与第三方供应商（LLM Gateway / Bedrock / Vertex），方式是引入具名的启动配置档：一份 profile 编译成一组注入环境与少量类型化覆盖项，由 Agent SDK 路径与内置终端路径共用同一个 resolveLaunchSpec 契约。范围内：profile 存储与编译层、两条启动路径接入、Settings 管理页、会话创建入口的选择与锁定、按 profile 的上下文窗口。非目标：Claude Code 账号级切换（OAuth 多账号）、codex/cursor/opencode 的 profile、toolsSettings 纳入 profile。

## 退出条件
- AC-001 至 AC-007 全部为真：向后兼容不破、网关请求真实落地、密钥不入库、env 注入面封闭、上下文窗口随 profile、终端 resume 保真、会话 profile 锁定生效。
- 范围内 UI 项（Settings 管理页、会话创建入口选择）不单列退出条件，其正确性由上述 AC 的后端契约保证（若人裁定需要，另立 AC）。
