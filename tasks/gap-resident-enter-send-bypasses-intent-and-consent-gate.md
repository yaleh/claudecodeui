---
id: gap-resident-enter-send-bypasses-intent-and-consent-gate
title: AC-180 Enter 键发送绕过常驻意图与知情门控：开关与勾选都开着按 Enter 落成 per-run，未勾选按 Enter 也能发出，让
  Enter 与发送按钮走同一入口
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-180
---
## Proposal

**现状读数（2026-09-29 真浏览器实测，读回的是库与进程，不是判据）。** 新建会话，打开常驻开关：
- 勾选「我了解」后按 Enter 发送，会话在库里 `lifecycle_mode` 为 `per-run`，没有 resident 宿主（会话 `00405f1d`）。改点发送按钮，同样的操作落成 `resident`，宿主 `resident` / `idle` 且有 pid（会话 `544a1447`）。
- 开关开着、未勾选，按 Enter 消息照样发出，会话为 `per-run`（会话 `095976b4`）。发送按钮此时是禁用的。

**根因。** `src/modules/chat/hooks/useChatComposerState.ts:1215` 与 `:1218` 的 Enter 处理直接调 `handleSubmit(event)`，而记录常驻意图并遵守知情门控的入口是 `src/modules/chat/composer/ChatComposer.tsx` 的 `handleComposerSubmit`（`setPendingResidentIntent` 在那里被调用）。该处注释声称「两个入口都经过这里」，与事实不符。`e2e/resident-enable-consent.spec.ts` 只按发送按钮读，所以 AC-171 读绿而这个洞一直在。

**要做的事。** 让 Enter 路径与按钮路径走同一个入口：意图在 Enter 发送时同样被记录，知情门控在 Enter 路径上同样生效（未勾选时不发送、不建会话）。修法由 worker 在读过两处代码后决定，要求是单一入口，不是把门控逻辑复制到第二处。

## Plan

1. 读 `ChatComposer.tsx` 的 `handleComposerSubmit` 与 `useChatComposerState.ts` 的 `handleKeyDown`，确定 Enter 路径接入同一入口的最小改法。
2. 写 `e2e/resident-enter-send.spec.ts`（真浏览器、真服务）：(a) 已勾选后 Enter 发送，读回 `lifecycle_mode` 为 `resident`；(b) 未勾选时 Enter，消息不发出、会话总数不变；(c) 正控制：开关关闭时 Enter 照常发送，会话为 `per-run`。红态先行：改代码前这个 spec 在 (a) 与 (b) 上必红。
3. 改代码，跑绿。
4. 取假形态：把 Enter 路径改回直接调 `handleSubmit`，(a) 必须红；去掉 Enter 路径的门控，(b) 必须红。逐字登记失败行，恢复。
5. `npm run lint` 绿；再跑 `npx playwright test e2e/resident-enable-consent.spec.ts` 确认 AC-171 不受影响。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/resident-enter-send.spec.ts` 退出 0。红态基线：改代码前退出非 0，红落在 (a) 或 (b) 的读数上（该 spec 文件还不存在时的读数是 `Error: No tests found`）。
- [x] AC2 (a) 读数：勾选后 Enter 发送，会话 `lifecycle_mode` 逐字 `resident`，且宿主列表里该会话有 `mode` 为 `resident` 的宿主。
- [x] AC3 (b) 读数：未勾选时 Enter，会话总数发送前后不变，输入框内容保留。
- [x] AC4 (c) 正控制：开关关闭时 Enter 发送，会话为 `per-run`，证明读数不是恒 `resident`。
- [x] AC5 取假形态必须红（承重）：Enter 路径直接调 `handleSubmit` ⇒ AC2 的读数红；Enter 路径不看知情门控 ⇒ AC3 的读数红。每种变异先提交再变异，跑完用 `git checkout` 恢复，登记逐字失败行。
- [x] AC6 `npx playwright test e2e/resident-enable-consent.spec.ts` 仍退出 0；`npm run lint` 退出 0；`git diff --stat` 与 Touches 逐条对齐。

## DoD

- 判据在真浏览器里跑，读回的模式是服务端事实（库与宿主列表），不是前端本地状态。
- 只有一个提交入口：Enter 路径不复制门控逻辑。
- 假形态真的跑过、真的红过，红落在对应的承重断言上。
- 前端改动遵守 `.agents/skills/frontend-module-standards/SKILL.md`。
- 只动 Touches 列出的文件。

## Touches

- tasks/gap-resident-enter-send-bypasses-intent-and-consent-gate.md
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/composer/ChatComposer.tsx`
- `e2e/resident-enter-send.spec.ts` (new)