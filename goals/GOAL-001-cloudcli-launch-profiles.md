---
id: GOAL-001
title: CloudCLI launch profiles
status: draft
kind: goal
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001
---
让单个 CloudCLI 实例能同时对接 Anthropic 官方服务与第三方供应商（LLM Gateway / Bedrock / Vertex），方式是引入具名的启动配置档：一份 profile 编译成一组注入环境与少量类型化覆盖项，由 Agent SDK 路径与内置终端路径共用同一个 resolveLaunchSpec 契约。范围内：profile 存储与编译层、两条启动路径接入、Settings 管理页、会话创建入口的选择与锁定、按 profile 的上下文窗口。非目标：Claude Code 账号级切换（OAuth 多账号）、codex/cursor/opencode 的 profile、toolsSettings 纳入 profile。退出条件：AC-001 至 AC-007 全部为真，即向后兼容不破、网关请求真实落地、密钥不入库、env 注入面封闭、上下文窗口随 profile、终端 resume 保真、会话 profile 锁定生效。