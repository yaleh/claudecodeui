---
id: gap-launch-profiles-teardown-entity
title: 拆除旧 launch profile 实体（表/路由/Settings tab/composer 下拉/旧编译入口），AC-001 黄金基准移植到新入口
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-launch-profiles-relocate-shared-compile-layer
---
## Proposal

背景：ADR-002 结尾定的拆除条件是「在新机制经真实链路验证之后拆除」；AC-027（真实浏览器建模型→选中→发送）已 achieved，GOAL-001 正文亦已列明拆除清单与唯一例外。本段执行拆除。

**唯一例外（不可删，必须移植）**：AC-001「升级零变化黄金基准」。`goals/AC-001-passthrough-env-parity.md` 的判据命令指向 `server/modules/launch-profiles/tests/passthrough-parity.test.ts`，而该文件经旧入口 `resolveLaunchSpec(null)` 驱动 —— 它就在待删目录里。GOAL-001 明文：「唯独 AC-001 的测试必须移植而不是移除」，AC-001 自身 expect 亦带 ⚠️ 同款要求。故须先把该测试改写到新入口（未选带配置的模型时 spawn 环境与本变更前逐字一致），确认仍绿，再删目录。**它是本次拆除唯一的等价性验收面，静默丢失是本任务最大的失败模式。**

**需要判断的一处（建议移植而非删除）**：`server/modules/websocket/tests/shell-resume-launch-spec.test.ts` 经注入缝隙 `resolveLaunchSpec: () => PROFILE_SPEC` 断言终端 `--resume` 复用首启 argv/env（AC-006）。GOAL-001 说旧测试「应一并移除」，但该属性今天仍然活着：终端路径 `shell-websocket.service.ts:419` 已经在应用 `resolveModelLaunchSpec`，即「resume 复用启动规格」对自定义模型依然成立，只是源从 profile 换成了模型条目。故建议把该测试改注入 `resolveModelLaunchSpec` 缝隙并保留 —— 删掉会丢掉一个真实防线。若实现者判断不可行，须在完成记录里写明理由。

删除前须核对的一处：`launchProfileSavePreserves.test.tsx`（AC-019 的数据丢失防线）。经查 AC-026 的模型侧等价断言存在（AC-026 判据含 `modelLibrarySave.test.tsx`，expect 明文「重述 AC-019 的数据丢失防线，对象换为模型」），可安全删除。

拆除清单：

服务端 —— 删 `launch-profiles.service.ts`、`session-profile-lock.ts`、`launch-profiles.routes.ts`、`launch-profiles.module.ts`、`index.ts`（前一段完成后该目录只剩这些）；删 `server/modules/database/repositories/launch-profiles.db.ts` 与 `database/index.ts` 的三处导出；`server/index.ts` 去掉路由导入与 `/api/launch-profiles` 挂载；`sessions.db.ts` 去掉 `getSessionLaunchProfileId`/`setSessionLaunchProfileId`；`chat-websocket.service.ts` 去掉会话锁定与 `profile_locked` 帧（⚠️ 该帧在 `src/` 下无任何消费者，是死信令，故删除是纯服务端动作、不涉及协议协同）；`claude-runtime.provider.js` 去掉 `resolveLaunchSpec` 导入与 `options.launchProfileId` 调用；`shell-websocket.service.ts` 去掉 `resolveLaunchSpec` 注入缝隙与调用（其 profile 参数本已硬编码 `null`），`buildShellCommand` 相应只接模型 spec；`providers/index.ts` 两条「driven by the launch-profiles tests」注释改写为模型侧。

客户端 —— `Settings.tsx`（导入 + `activeTab === 'profiles'` 渲染）、`SettingsSidebar.tsx` 的 `{ id: 'profiles' }` 条目、`hooks/useSettingsController.ts` 的 `KNOWN_MAIN_TABS`、`src/shared/types.ts` 的 `SettingsMainTab` 联合与 `LaunchProfile` 类型；删 `tabs/launch-profiles-settings/` 三个文件；删 `LaunchProfileSelect.tsx` 并摘除 `ChatComposer.tsx`、`ChatInterface.tsx`、`useChatComposerState.ts` 中的 `launchProfileId` 状态与透传。

i18n —— 删 `mainTabs.profiles`（en/zh-CN）与 `launchProfiles.*` 块（en/zh-CN 全量、es/id/ko 部分）。⛔ 不得误删 `voiceSettings.profiles`（`en/settings.json:87`，语音预设，同名不同物）。`chat.json` 的 `launchProfile.label/default` 只是 inline `defaultValue`，零真实 key。

测试 —— 删 12 个 profile 服务端测试、3 个客户端测试、`e2e/launch-profiles.spec.ts`；移植 `passthrough-parity.test.ts`（AC-001）与（建议）`shell-resume-launch-spec.test.ts`。

仪表 —— `scripts/server-phase-concurrency-check.sh` 的 SLOPE_TABLE 里有一行出处栏指向将删的 `gateway-end-to-end.test.ts`。该脚本判据③只读第一列并发数、不读出处栏，故**不会报错**，属记录失真，须一并改；不要误以为没红就是没问题。

文档 —— `docs/proposals/launch-profiles.md` 补一句实体已拆除（其头部已有「部分被 ADR-002 取代」横幅）；ADR-002「影响」小节标注拆除已完成。

取假形态：若只删代码而未移植 AC-001，`ls server/modules/providers/tests/passthrough-parity.test.ts` 报 not found 且仓内无同名测试 —— 这必须判红（黄金基准消失），而不是当作「测试随功能一起没了很正常」。

## AC

- [ ] AC-001 已移植且仍绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/passthrough-parity.test.ts` 退出码 0，且该文件断言的是**新入口**（未选带配置的模型时 spawn 环境与 `{...process.env}` 逐字一致），文件内不再出现 `resolveLaunchSpec`。
- [ ] `grep -rn "resolveLaunchSpec\b" server/ src/` 无输出（旧入口彻底消失）。
- [ ] `grep -rni "launchProfile\|launch_profile\|launch-profiles" server/ src/ e2e/` 无输出（旧实体引用清零）。
- [ ] `grep -n "voiceSettings" src/modules/i18n/locales/en/settings.json` 仍有输出（确认未误删同名不同物的语音预设）。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-gateway-end-to-end.test.ts server/modules/providers/tests/model-spawn-env.test.ts` 退出码 0（新机制在拆除后仍工作）。
- [ ] `bash scripts/test.sh --for-task gap-launch-profiles-teardown-entity` 退出码 0（scoped 自测；**全量套件是 fan-in 的合并闸，不是 worker 的自测**）；`npm run typecheck`、`npm run lint` 退出码 0。
- [ ] 每个被删的测试文件都在完成记录里逐个登记，并注明其对应 AC 已 superseded；`shell-resume-launch-spec` 的处置（移植或删除）附理由。未登记即视为漏项。

## DoD

真实落地判据：不是「文件被删了」就算完成。要求 (a) AC-001 黄金基准在**新入口**上真实跑通 —— 这是拆除唯一的等价性证明；(b) 旧 profile 入口、REST、Settings tab、composer 下拉在仓库里引用清零；(c) 新机制（model library）在拆除后 scoped 自测全绿；(d) 每一个被删测试都有归属说明，且 `shell-resume-launch-spec` 的处置附理由。

L_D 该轴仍暗，理由：本段是删除与移植，不新增领域能力；等价性读数由 AC-001 提供。
L_G 该轴仍暗，理由：同上。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts (deleted)
- server/modules/launch-profiles/session-profile-lock.ts (deleted)
- server/modules/launch-profiles/launch-profiles.routes.ts (deleted)
- server/modules/launch-profiles/launch-profiles.module.ts (deleted)
- server/modules/launch-profiles/index.ts (deleted)
- server/modules/launch-profiles/tests/passthrough-parity.test.ts (deleted; 移植到 providers)
- server/modules/launch-profiles/tests/launch-spec-real-profile.test.ts (deleted)
- server/modules/launch-profiles/tests/profile-rest-api.test.ts (deleted)
- server/modules/launch-profiles/tests/profile-partial-update.test.ts (deleted)
- server/modules/launch-profiles/tests/session-profile-lock.test.ts (deleted)
- server/modules/launch-profiles/tests/secret-never-persisted.test.ts (deleted)
- server/modules/launch-profiles/tests/config-env-compiled.test.ts (deleted)
- server/modules/launch-profiles/tests/context-window-env-export.test.ts (deleted)
- server/modules/launch-profiles/tests/context-window-per-profile.test.ts (deleted)
- server/modules/launch-profiles/tests/env-allowlist-write-path.test.ts (deleted)
- server/modules/launch-profiles/tests/env-injection-closed.test.ts (deleted)
- server/modules/launch-profiles/tests/gateway-end-to-end.test.ts (deleted)
- server/modules/providers/tests/passthrough-parity.test.ts (new; AC-001 移植到新入口)
- server/modules/database/repositories/launch-profiles.db.ts (deleted)
- server/modules/database/repositories/sessions.db.ts
- server/modules/database/index.ts
- server/index.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/services/shell-websocket.service.ts
- server/modules/websocket/tests/shell-resume-launch-spec.test.ts
- server/modules/providers/index.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- src/modules/settings/Settings.tsx
- src/modules/settings/SettingsSidebar.tsx
- src/modules/settings/hooks/useSettingsController.ts
- src/modules/settings/tabs/launch-profiles-settings/LaunchProfilesSettingsTab.tsx (deleted)
- src/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles.ts (deleted)
- src/modules/settings/tests/launchProfileSettings.test.tsx (deleted)
- src/modules/settings/tests/launchProfileSavePreserves.test.tsx (deleted)
- src/modules/chat/composer/LaunchProfileSelect.tsx (deleted)
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/hooks/useChatComposerState.ts
- src/modules/chat/tests/launchProfileSessionEntry.test.tsx (deleted)
- src/shared/types.ts
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/i18n/locales/es/settings.json
- src/modules/i18n/locales/id/settings.json
- src/modules/i18n/locales/ko/settings.json
- e2e/launch-profiles.spec.ts (deleted)
- scripts/server-phase-concurrency-check.sh
- docs/proposals/launch-profiles.md
- adr/ADR-002-配置挂在-model-library-上-取代独立-launch-profile-实体.md
- tasks/gap-launch-profiles-teardown-entity.md