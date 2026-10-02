---
id: gap-debug-agent-message-header-falls-through-to-claude
title: 调试 agent 的消息头 provider 名落穿为 Claude（头像已是 Debug Agent，名字不是）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**缺陷（实测）。** 调试 agent 会话里，每条 assistant 消息的头部：头像已经是 Debug Agent 的烧瓶标（`LLMProviderLogo`），但紧挨着的 provider 名字显示为 **"Claude"**。

实测读数：在真实浏览器里打开一个调试 agent 会话，assistant 行的无障碍快照为 `img "Debug Agent"` 紧跟 `generic: "Claude"`；行文本读作 `Claude 来自调试 provider 的脚本化回复。`。

**机制（代码归属）。** `src/modules/chat/transcript/MessageComponent.tsx:326-337` 是一条三元落穿链：

```
message.type === 'error' ? t('messageTypes.error')
  : message.type === 'tool' ? t('messageTypes.tool')
    : (provider === 'cursor' ? t('messageTypes.cursor')
        : provider === 'codex' ? t('messageTypes.codex')
          : provider === 'opencode' ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
            : t('messageTypes.claude'))
```

`provider === 'debug'` 没有任何分支，落到最后的 `t('messageTypes.claude')`，于是显示 "Claude"。

**这是同一个缺陷的第二次出现。** AC-136（`goals/AC-136-调试-agent-在-ui-上有明确显示身份-不落穿为-claude.md`，已 achieved）修的是**同一类**落穿：它给 `src/shared/ui/LLMProviderLogo.tsx:33` 加了 `aria-label="Debug Agent"`（头像），并给 `src/modules/sidebar/utils/sidebarProjectFormatting.ts:260` 的 `PROVIDER_LABELS` 加了 `debug: 'Debug Agent'`（侧栏）。**消息头这条链不在 AC-136 的判据面内，所以漏了。**

**为什么这条比"看不见"更糟。** 「静默缺席」只是不显示；**错标是主动断言了一个错误的来源**，而 ADR-003 决策 1 立论所依赖的恰恰是"调试 agent 与真 provider 在 UI 上无从区分（因为它走同一条链路）"——一个把合成产出标成 Claude 的名字，会让读屏用户和任何读这一行的人相信这是 Claude 的真实产物。

## AC

- [ ] 新增（或扩展）判据，且**对当前实现必红**：渲染一条 `provider: 'debug'` 的 assistant 消息，断言消息头的 provider 名文本为 "Debug Agent"（而非 "Claude"）。命令：`npx vitest run <该测试文件路径>`（client 侧测试；命令必须逐字含文件路径）。失败时打印实际读到的文本。
- [ ] 正控制：同一个判据断言 `provider: 'unknown-provider-xyz'` 仍回退到 Claude。**这条是承重的**——它保证修复不是"把 fallback 删掉"或"把三元链改成恒真"，即修的是 `debug` 这一个已知身份，而不是取消未知 provider 的回退语义。取假变体：把 `debug` 分支实现成"删掉最后那个 `t('messageTypes.claude')` 回退"，必须让正控制红。
- [ ] 头像与名字一致：同一条消息上，`LLMProviderLogo` 的无障碍名与 provider 名文本指向同一个身份（读两个值并比较，不靠人工看）。
- [ ] i18n：若新增 key，必须与既有 `messageTypes.*` 同形，且在 `src/modules/i18n/locales` 下的**全部** locale 都存在（逐目录枚举，不写死语言列表）。

## DoD

真实落地：在一个**真实跑起来的调试 agent 会话**里，消息头的 provider 名读作 "Debug Agent"，且读屏读到的名字与头像一致；同时未知 provider 仍回退到 Claude。承重性：
(a) 判据先红后绿，红要先于修复被观察到；
(b) 正控制（unknown → Claude）在修复后仍绿，且删除 fallback 的取假变体会让它红；
(c) 用实机读数（浏览器里读出的文本）登记，而不是只登记单测结果。

## Touches

- src/modules/chat/transcript/MessageComponent.tsx
- src/shared/ui/LLMProviderLogo.tsx
- src/modules/sidebar/utils/sidebarProjectFormatting.ts
- src/modules/chat/tests/debug-agent-message-header-identity.test.tsx (new)
- tasks/gap-debug-agent-message-header-falls-through-to-claude.md