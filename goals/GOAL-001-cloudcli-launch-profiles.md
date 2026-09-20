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
让单个 CloudCLI 实例能同时对接 Anthropic 官方服务与第三方供应商（LLM Gateway / Bedrock / Vertex），方式是引入具名的启动配置档：一份 profile 编译成一组注入环境与少量类型化覆盖项，由 Agent SDK 路径与内置终端路径共用同一个 resolveLaunchSpec 契约。范围内：profile 存储与编译层、两条启动路径接入、Settings 管理页、会话创建入口的选择与锁定、按 profile 的上下文窗口，以及【能复现用户历史上的 claude code 启动方式】。非目标：Claude Code 账号级切换（OAuth 多账号）、codex/cursor/opencode 的 profile、toolsSettings 纳入 profile。

## 参照启动方式（本目标的验收基准）

用户历史上的主力启动方式是 claude-fjdac wrapper 加会话参数：ANTHROPIC_BASE_URL 指向本地网关、token 来自宿主环境、三个 DEFAULT_*_MODEL 钉为 v4.1flash、--model deepseek-v4-pro-anthropic、CLAUDE_CODE_MAX_CONTEXT_TOKENS / AUTO_COMPACT_WINDOW 917000、CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 80、DISABLE_ALTERNATE_SCREEN / DISABLE_MOUSE、--permission-mode bypassPermissions、--prompt-suggestions false。目标达成的含义是：这一整套能只经 profile 表达，并且 SDK 路径与终端路径都真的生效，而不是只存得进库。

## 退出条件

- AC-001 至 AC-007：向后兼容不破、网关请求真实落地、密钥不入库、env 注入面封闭、上下文窗口随 profile、终端 resume 保真、会话 profile 锁定生效。
- AC-008 至 AC-011：REST 可达、真实 profile 产出非空 spec、前端可选、写入路径白名单拒绝。
- AC-012：真实浏览器里端到端可用（组件级 vitest 不能替代——AC-010 是组件绿而实机三处坏的反例）。
- AC-013 至 AC-016：config.env 真正进入 spawn 环境；类型化上下文字段导出真实 CLI 变量；终端会话使用所选 profile；permissionMode 与 promptSuggestions 由 profile 驱动。
- AC-017：参照 fjdac profile 与历史启动命令逐键等价（对 AC-013..016 的合取验收）。
- AC-018：参照 profile 能完全经 UI 录入并原样回显（对编辑器完整度的实机验收）。

## 已知不等价点（如实登记，不据此放宽判据）

wrapper 同时导出 ANTHROPIC_AUTH_TOKEN 与 ANTHROPIC_API_KEY，而 profile 只有单一 authEnvVarTarget。本目标不要求补齐；由 AC-017 的测试注释登记，待人裁定是否另立 AC。

## 修订记录

2026-09-20：此前的版本写「范围内 UI 项不单列退出条件」。实机验证证明这一条放过了 i18n key 外泄、编辑器仅 name+model、会话入口缺失三处缺陷，现予撤回，UI 由 AC-012 与 AC-018 单列。
