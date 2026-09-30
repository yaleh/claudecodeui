# Changelog

All notable changes to CloudCLI UI will be documented in this file.


## [1.38.1](https://github.com/yaleh/claudecodeui/compare/v1.38.0...v1.38.1) (2026-09-30)

### New Features

* **release:** publish the fork as @yalehwang/cloudcli on npm ([e433af3](https://github.com/yaleh/claudecodeui/commit/e433af35fc8f8728ec6fe35d2c738f95e604c366))

### Bug Fixes

* **e2e:** drive the Enter criterion off the switch, not the retired consent tick ([b154753](https://github.com/yaleh/claudecodeui/commit/b1547537cfe55feda78ae260a121e2955ab26f7b))

### CI/CD

* drop Discord release notification (upstream webhook, not configured on fork) ([e3bdfa4](https://github.com/yaleh/claudecodeui/commit/e3bdfa48e18fd095d120893099c2a7d7bb3cdeb2))
* **release:** pass GITHUB_TOKEN to npm ci so @vscode/ripgrep's download is not rate-limited ([98cd614](https://github.com/yaleh/claudecodeui/commit/98cd6141239bfe8bb3baf63c3389aa2729a4ecd6))

### Tests

* **e2e:** anchor the AC-109 detach window at the gesture's own input moment ([d2f4445](https://github.com/yaleh/claudecodeui/commit/d2f44458fac40e32ed70954c891d570eac5f28c8))
* **e2e:** bound the resident-running-view startup path ([e963c86](https://github.com/yaleh/claudecodeui/commit/e963c8674b94d67b35c7103026a09d69e3596dca))
* **e2e:** cut the AC-109 window's frames at the gesture's own input moment ([ef6e511](https://github.com/yaleh/claudecodeui/commit/ef6e511177bf7410dbcde405f9754c3233ff7100))

## [1.38.0](https://github.com/yaleh/claudecodeui/compare/v1.37.3...v1.38.0) (2026-09-29)

### New Features

* add Playwright MCP directory to .gitignore ([5c11f44](https://github.com/yaleh/claudecodeui/commit/5c11f4483d7c2815de90180570eec120739277d9))
* **asr:** land the inline-only multimodal adapter as the second recogniser (AC-132) ([9a36a1c](https://github.com/yaleh/claudecodeui/commit/9a36a1c52c7adebdde7d818565c8621c8ede1195))
* **chat:** a resident status bar, its marks, and the turns nobody typed ([c10b834](https://github.com/yaleh/claudecodeui/commit/c10b8342fa6e63443484be2bf67f51a6a99df746))
* **chat:** decide the composer footer's tier from the box's own width ([cb15da7](https://github.com/yaleh/claudecodeui/commit/cb15da76cd713b93aa8d577938a6fd26194fc457))
* **chat:** disclose the resident-mode tradeoff before it is enabled ([e51569b](https://github.com/yaleh/claudecodeui/commit/e51569b12de0b74ed7e8c9870fe5f7c2e0055752))
* **chat:** draw the running turn inline below md ([b24128b](https://github.com/yaleh/claudecodeui/commit/b24128b5306d74f443235c131714bf4998a853c0))
* **chat:** identifier fidelity metric + voice fill-back reading (AC-114) ([a56e1a3](https://github.com/yaleh/claudecodeui/commit/a56e1a346a16046747ced38c1f9b7d0c9ef18041))
* **chat:** prototype a touch-scoped send key for the composer ([bb787bc](https://github.com/yaleh/claudecodeui/commit/bb787bcd8890577b6017629e0ff1cba56491d648))
* **chat:** render workspace image paths in markdown ([#1307](https://github.com/yaleh/claudecodeui/issues/1307)) ([4b98d2e](https://github.com/yaleh/claudecodeui/commit/4b98d2eaec077470b737790b32e896051c5ff5ba))
* **chat:** route a busy resident session's send to the process instead of the local queue ([df558ec](https://github.com/yaleh/claudecodeui/commit/df558ecc674d95457bd99fea1cd870bf0694b518))
* **chat:** say a compaction out loud, as one row with its summary folded in ([#1295](https://github.com/yaleh/claudecodeui/issues/1295)) ([d450ed8](https://github.com/yaleh/claudecodeui/commit/d450ed8521e71d731265021c75980656ab20c185)), closes [#1292](https://github.com/yaleh/claudecodeui/issues/1292)
* **chat:** scope the composer send key to the device's input capabilities ([7d842d4](https://github.com/yaleh/claudecodeui/commit/7d842d4cac6d935afa076e996bb3890def6fab0f))
* **chat:** 权限模式随发送落库，客户端不再持久化 ([5b61e03](https://github.com/yaleh/claudecodeui/commit/5b61e03ea63f85e921a3be828302fe4be7198d80))
* **claude-resident:** intercept the three human-facing permission entries ([4db6cae](https://github.com/yaleh/claudecodeui/commit/4db6caefadd926cb2abe409fa078af2b2457a7cd))
* **claude-resident:** reconcile held-work reasons from the Stop hook and the stream ([e64c0e3](https://github.com/yaleh/claudecodeui/commit/e64c0e3d4fc95143b887394184e4d6fcb021e71d))
* **claude-resident:** refuse a bypass launch when user settings enable Remote Control ([b5f2575](https://github.com/yaleh/claudecodeui/commit/b5f2575141c5023f4ab23092476474f62b2ab4f7))
* **claude:** busy input joins the CLI's own queue and stays withdrawable until it starts (AC-163) ([35e9401](https://github.com/yaleh/claudecodeui/commit/35e94019560239cd8ca73cb64e97df593dfbab14))
* **claude:** resident host driver — one CLI across turns (AC-161) ([8436c6f](https://github.com/yaleh/claudecodeui/commit/8436c6ff59c9dc2e0024a772bc05970f05dbd798))
* **cost:** show the session's Claude-generated ai-title in the /cost modal ([ad95447](https://github.com/yaleh/claudecodeui/commit/ad954473e35aeb36b5dde6f010d3e763be1f6eb1))
* **debug-agent:** an output engine that writes the transcript it forwards ([c05f4fd](https://github.com/yaleh/claudecodeui/commit/c05f4fd481cb616076f089387399de9f19d3ad35))
* **debug-agent:** drive resident host states, turn origins and the run seam ([003c009](https://github.com/yaleh/claudecodeui/commit/003c0090a6a189eaa649aeb4343773597d664e3a))
* **debug-agent:** gate the debug agent so "off" means structurally absent ([4b14dd8](https://github.com/yaleh/claudecodeui/commit/4b14dd8f556bae78fa1df17addce4bd9719a1ab3))
* **debug-agent:** hold resident debug sessions on a multiplexed host ([ecca928](https://github.com/yaleh/claudecodeui/commit/ecca9280e7d94e5043cbe4b72ea9829cf60a8035))
* **debug-agent:** seed a scenario's lifecycle mode and keep the host writer across turns ([5d9d1a1](https://github.com/yaleh/claudecodeui/commit/5d9d1a1c951f2340b79fa1d16b49db01679b46fc))
* **e2e:** Playwright toolchain + launch-profiles real-browser spec; profile create/edit UI with baseUrl/auth/contextWindow ([d882915](https://github.com/yaleh/claudecodeui/commit/d882915db2a37ea0740afb8e7b5d2ef1dbdcf8c5))
* **goals:** 激活 GOAL-007，并把激活记录改成实测的 ([a204fff](https://github.com/yaleh/claudecodeui/commit/a204fffd093a556e5d5369648bcc69c4c19e109d))
* **goals:** 立 GOAL-007 调试 Agent + 六条红先行判据（据 ADR-003 评审通过） ([acc1430](https://github.com/yaleh/claudecodeui/commit/acc1430ea3018dae190c1c7422cc809c2d49ad48))
* **i18n:** add Indonesian language support ([#1328](https://github.com/yaleh/claudecodeui/issues/1328)) ([b8e572b](https://github.com/yaleh/claudecodeui/commit/b8e572bdf919752aa17b521a2784341b7665beca))
* **launch-profiles:** Profiles settings tab + composer profile select sends launchProfileId (AC-010) ([803c71d](https://github.com/yaleh/claudecodeui/commit/803c71dcfc57f2fb7bbce656196e4894d048ec2b))
* **models:** explain every env row kind, including unset ([fe19d09](https://github.com/yaleh/claudecodeui/commit/fe19d098f8808fe2a55ef36934bac7de8f8e41bc))
* **plugins:** recommend GLM Usage plugin ([#1323](https://github.com/yaleh/claudecodeui/issues/1323)) ([f05ba1f](https://github.com/yaleh/claudecodeui/commit/f05ba1fd6c6fc8cd0da180cee079fec66531a9bf))
* **projects:** per-project session name filter (backend) ([507d405](https://github.com/yaleh/claudecodeui/commit/507d4059089eb855587b8f3b67217b615e4835eb))
* **providers:** cap each Claude session in its own systemd scope ([4e25271](https://github.com/yaleh/claudecodeui/commit/4e25271d331add7c73b5131ed112624804efc0df))
* **providers:** give a resident process a stable SendMessage address ([11b3370](https://github.com/yaleh/claudecodeui/commit/11b3370031426badaa9fc84b08d4ec6d42c94685))
* **providers:** make a resident process's unattended turn a run ([3fd1ecb](https://github.com/yaleh/claudecodeui/commit/3fd1ecb0a8a45e4ef50b4bb5105d40308bbb1e69))
* **providers:** pick the session watcher's mechanism per root, and back off when polling ([a07e7ae](https://github.com/yaleh/claudecodeui/commit/a07e7ae3d5cb3dee0f2ced98e8ee6f3346d4a8d3))
* **quay:** scripts/test.sh emits per-file results for the quay tests page ([e776459](https://github.com/yaleh/claudecodeui/commit/e776459ed370e0b5e79c2678f74ab489e7bce292))
* **resident-experiments:** 控制协议清单 E9 取数并定稿 proposal ([7d37fd6](https://github.com/yaleh/claudecodeui/commit/7d37fd6864675d9ef07528cd9afb2a9331f0e11d))
* **resident-smoke:** land AC-170 API-面真模型冒烟脚本、护栏判据与人证记录 ([e7ab6a4](https://github.com/yaleh/claudecodeui/commit/e7ab6a42c40533e61d92dc76a8a5c4d56e04af70))
* **resident:** collapse the status bar's per-kind lease chips into one count ([917916c](https://github.com/yaleh/claudecodeui/commit/917916c262ceb2870406c89ffe6436322afe43d9))
* **resident:** move the enable switch under the model card and retire the consent gate ([6814265](https://github.com/yaleh/claudecodeui/commit/6814265d9fd8ffd80f4be673b7baf848af19f609))
* **scripts:** add suite-concurrency-check.sh — AC-103 的并发判据读数 ([64e46f0](https://github.com/yaleh/claudecodeui/commit/64e46f0d264729f29129d4c4e7281ac9f24a0919))
* **scripts:** gate scripts/ with strict TS and run its tests ([e320cd0](https://github.com/yaleh/claudecodeui/commit/e320cd0d0e47ccda0b244618b9bac90333fb2c7a))
* **scripts:** restart the :3001 server unit on failure and cap its V8 heap ([66755b7](https://github.com/yaleh/claudecodeui/commit/66755b75c47368813e698c0673650f2e22e1306b))
* **scripts:** 新增 suite-scope-check 守卫（活跃任务的自测作用域），并在 test.sh 前置调用 ([ce34887](https://github.com/yaleh/claudecodeui/commit/ce3488765a88ce4ce3da2bdada04ca9baabb1416))
* **scripts:** 给 test.sh 加 max-runtime / silence 两条活性看门狗，阈值由实测推出 ([0fded85](https://github.com/yaleh/claudecodeui/commit/0fded8597fdff632dbe0eb5c68a383154fde94e8))
* **server:** resident caps from config, and an OOM fact a host can read ([5cbe85d](https://github.com/yaleh/claudecodeui/commit/5cbe85d652f376f40d464f29e89ad85a2c940f55))
* **session-hosts:** bind sessions 1:N, refuse a second binding, supersede before start ([5ea8711](https://github.com/yaleh/claudecodeui/commit/5ea8711d347120c67f14910fb5cc38c87cac5485))
* **session-hosts:** drive Claude per-run hosts from the session-host layer ([05db7d4](https://github.com/yaleh/claudecodeui/commit/05db7d4ad86d8bf7b6cbf1336075cc70b7f0172e))
* **session-hosts:** drive host lifecycle from leases, with two policies ([b071ac9](https://github.com/yaleh/claudecodeui/commit/b071ac94827ba63eb694fdb4f59de6de710fc659))
* **session-hosts:** lifecycle-mode preference write path and host start/close API ([30ce434](https://github.com/yaleh/claudecodeui/commit/30ce434096a9e79738e4022b029deed86c4f4764))
* **session-hosts:** make the resident idle ceiling configurable (AC-181) ([4a3cf0b](https://github.com/yaleh/claudecodeui/commit/4a3cf0b927e6ebdac82223405de41a6f95bba513))
* **session-hosts:** report dropped resident sessions and sweep restart residue ([0e14412](https://github.com/yaleh/claudecodeui/commit/0e14412d0f4adc320392ad0156092b9986a35d05))
* **session-hosts:** serve the host listing over GET /api/session-hosts ([ac0feb8](https://github.com/yaleh/claudecodeui/commit/ac0feb861ebd5623aa91cc19e6ce64bbfe4ea517))
* **session-title:** show the live session name on every display surface ([6fd914b](https://github.com/yaleh/claudecodeui/commit/6fd914be8269fe7acfad69181e349123a89fa303))
* **sessions:** track where a session name came from and honour ai-title ([9a80839](https://github.com/yaleh/claudecodeui/commit/9a808394eda7e83e6ffa8ac46610cb3dfa7c31e5))
* **settings:** close settings modal with escape and backdrop click ([#1164](https://github.com/yaleh/claudecodeui/issues/1164)) ([3ed3be5](https://github.com/yaleh/claudecodeui/commit/3ed3be5aa047b17ed1f6e591cfd3692eda2f1160))
* **sidebar:** a draggable splitter for the sidebar width ([293eb56](https://github.com/yaleh/claudecodeui/commit/293eb56bfefd50b41cc043c6797dc780a4e4b7e7))
* **sidebar:** group forked sessions by lineage and mark branches ([ed1df4d](https://github.com/yaleh/claudecodeui/commit/ed1df4d1b3e351bcbf578b2e6698bb761ab75404))
* **sidebar:** pin expanded project header while sessions scroll ([#1312](https://github.com/yaleh/claudecodeui/issues/1312)) ([b028e0d](https://github.com/yaleh/claudecodeui/commit/b028e0d886c059e6c4c21137e8dbe05068c8877f))
* **sidebar:** project session-name filter UI (hidden bar, rules editor, keepSessionIds, filtered mark) ([f24c041](https://github.com/yaleh/claudecodeui/commit/f24c0412c7fb625e3c2978431b985ba132a1fdb2))
* **sidebar:** resizable sidebar width (prototype, verified in a browser) ([6827804](https://github.com/yaleh/claudecodeui/commit/68278044d1783d833ad042413d463bcad6c2419b))
* **sidebar:** split running view into turns in flight and held-open residents ([8357e62](https://github.com/yaleh/claudecodeui/commit/8357e627341877949207a083d4d258bb66e9585f))
* **static-assets:** gzip/brotli the dist bundle and SPA entry ([8437e54](https://github.com/yaleh/claudecodeui/commit/8437e54870e7fd4d864148f001fef3ad45cc06e5))
* **voice:** an audio-file entry into the transcription chain, behind a debug switch ([57e044f](https://github.com/yaleh/claudecodeui/commit/57e044fff7415569233df4ac32ccb1be60b3dac6))
* **voice:** answer health from the user's effective config, refuse unknown provider ids ([187d98d](https://github.com/yaleh/claudecodeui/commit/187d98d2461740cf533b6bea7258c5f3be20093e))
* **voice:** dispatch the proxy path to the selected provider's adapter ([fd910f7](https://github.com/yaleh/claudecodeui/commit/fd910f7daa2d8b57b14a0fbc243566265a161963))
* **voice:** isolate a capture failure from the transcription (AC-147) ([f35f2a9](https://github.com/yaleh/claudecodeui/commit/f35f2a9f43d6a13581312f1e3609b500b64259a2))
* **voice:** let the recogniser's declared pause capability decide 裁不裁 ([488218c](https://github.com/yaleh/claudecodeui/commit/488218c7182e6b54024864709f042fbd32fef70d))
* **voice:** pure DSP silence trim module for voice input ([c537d60](https://github.com/yaleh/claudecodeui/commit/c537d60042cb8457b76b7105baa8e85c8e74e2d1))
* **voice:** register the shipped recogniser as the first adapter ([9c80995](https://github.com/yaleh/claudecodeui/commit/9c8099522385718670f7631d6ab64726733ab781))
* **voice:** store the per-user voice settings on the server ([c16be88](https://github.com/yaleh/claudecodeui/commit/c16be882e771f039646cc916369fa06381bf3c71))
* **workspace:** close the Shell tab for resident sessions ([387d684](https://github.com/yaleh/claudecodeui/commit/387d68424cc17d91775688158a1438f4938a7fa4))

### Bug Fixes

* allow zrok subdomains in dev, guard SW cache against transient failures ([eafd765](https://github.com/yaleh/claudecodeui/commit/eafd7659f24b3a03a9a97a6ea036c555f6f092bd))
* **asr:** align the multimodal adapter with the real Gemini wire ([9a81fb5](https://github.com/yaleh/claudecodeui/commit/9a81fb5c84afd2e1ea9b1ad300b683e22f0d5c03))
* **asr:** 补 AC-132/AC-133 判据的薄委托入口（capability / mime-allowlist） ([3c9de66](https://github.com/yaleh/claudecodeui/commit/3c9de663dcef54d5f557dadfb5d89991778da914))
* **chat:** a small gesture owns the transcript, by direction not distance ([90393b9](https://github.com/yaleh/claudecodeui/commit/90393b988706f3760c9af4cda5bcd0dbd31ef38b))
* **chat:** collapse a persisted echo that meets the row still streaming it ([6a5901a](https://github.com/yaleh/claudecodeui/commit/6a5901a70495e0ba167c7716d9a77fc2c5d9ba7e))
* **chat:** detach the transcript follow on an up scroll key, at the key ([185b886](https://github.com/yaleh/claudecodeui/commit/185b88660ff3ebffb33543a286828ca908da770f))
* **chat:** Enter that confirms an IME candidate must not send on Safari ([#1332](https://github.com/yaleh/claudecodeui/issues/1332)) ([fd424f3](https://github.com/yaleh/claudecodeui/commit/fd424f3fcd739371daeb6b173167e61f95270670))
* **chat:** fold a background session's stream deltas into one row ([411d903](https://github.com/yaleh/claudecodeui/commit/411d903ee09cda1c14ae2f18238af38d6ebc168e))
* **chat:** hide the resident switch once a session is already resident ([f8382b7](https://github.com/yaleh/claudecodeui/commit/f8382b783e9b0d84795eccea288d21e19607d6d0))
* **chat:** keep the resident status bar out of the transcript's scroll box ([e0a601b](https://github.com/yaleh/claudecodeui/commit/e0a601b82648dd419f4c388e714925b5d3929f61))
* **chat:** make in-chat file references land where they point ([#1256](https://github.com/yaleh/claudecodeui/issues/1256)) ([580be52](https://github.com/yaleh/claudecodeui/commit/580be52dacd3538f1b0ec6fee56aa02d793cd21a))
* **chat:** portal the resident popover out of the transcript clip (AC-177) ([7b0e553](https://github.com/yaleh/claudecodeui/commit/7b0e553d1fd55a204f38f70e26799eb8182073d6))
* **claude-resident:** name the websocket leaf so the root stops closing an eval cycle ([8b6e7d9](https://github.com/yaleh/claudecodeui/commit/8b6e7d98da6dc9732e4b66dd0d3044edcf641490))
* **claude:** hold the CLI open for backgrounded agents and workflows ([#1291](https://github.com/yaleh/claudecodeui/issues/1291)) ([208c715](https://github.com/yaleh/claudecodeui/commit/208c71560278f7f9607847c0595803a683de2864)), closes [#1113](https://github.com/yaleh/claudecodeui/issues/1113) [#1268](https://github.com/yaleh/claudecodeui/issues/1268)
* **claude:** identify a resident round by its conversation, not its model name ([6a4957b](https://github.com/yaleh/claudecodeui/commit/6a4957b508aa4f35bd225aeefe1d622d8a538906))
* **claude:** show session titles instead of prompts in the sidebar ([#1258](https://github.com/yaleh/claudecodeui/issues/1258)) ([7704a90](https://github.com/yaleh/claudecodeui/commit/7704a90523ec6fb9514b2d251db1b18046517f2e))
* **codex:** restore user prompts from canonical typed rollout rows ([#1277](https://github.com/yaleh/claudecodeui/issues/1277)) ([5ce8ed4](https://github.com/yaleh/claudecodeui/commit/5ce8ed4537eb71397885a8a180e1d5090aa3bc2d))
* **codex:** support image-only prompts ([#1346](https://github.com/yaleh/claudecodeui/issues/1346)) ([a6d50c8](https://github.com/yaleh/claudecodeui/commit/a6d50c84ca5f16872c4166fc4772af2dc8687e6b))
* **composer:** 桌面档位允许工具组自身换行，768 双回放不再横向溢出 ([74edd76](https://github.com/yaleh/claudecodeui/commit/74edd76677183decb66f43bf854ea1964e46dcad))
* **composer:** 触摸设备不再显示发送键提示行，任何宽度都不显示 ([c954770](https://github.com/yaleh/claudecodeui/commit/c954770e18f1282a2c3871adabe50bd36a9bab49))
* **criteria:** 两条 ASR 判据重指到 registry 架构，解开 GOAL-008 的达成死锁 ([beba8cc](https://github.com/yaleh/claudecodeui/commit/beba8ccdad192cbd64400063eb40edf2eabd9c6e))
* **debug-agent:** scope the AC10 providers/list assertion to its own branch ([b5d6c66](https://github.com/yaleh/claudecodeui/commit/b5d6c6632fe9d9fb7135b1e035380bcb4d987c14))
* derive session last activity from transcript content, not file mtime ([e7534bc](https://github.com/yaleh/claudecodeui/commit/e7534bcc71f48c2a9d26c4924f95a91e4daae782))
* **e2e:** bound the criterion run itself and make a crossed ceiling name its stage ([5fb9888](https://github.com/yaleh/claudecodeui/commit/5fb9888d9908b964ab8f971c01e3e160bb6e764b))
* **e2e:** drop the dead node:os imports that red the repo lint stage ([b429a07](https://github.com/yaleh/claudecodeui/commit/b429a07551ed2124bb67eb9657dc14e759cabbfd))
* **e2e:** give each run its own scratch root, prepared under a budget ([092857e](https://github.com/yaleh/claudecodeui/commit/092857e26fe9ae274535fe3546a69ccabd853d04))
* **e2e:** reclaim the run directories an earlier run left behind ([18c69a1](https://github.com/yaleh/claudecodeui/commit/18c69a1b1670ee6be8b9b3567ee6a304b9edb7e8))
* **e2e:** scope the session-filter editor entry to the project under test ([25dac48](https://github.com/yaleh/claudecodeui/commit/25dac48ed928aecf9455e57cf5dae1066235c5d9))
* **e2e:** 每个 run 用自己的 Vite dep cache，切断共享 node_modules/.vite 的重预构建作废 ([a7b4d41](https://github.com/yaleh/claudecodeui/commit/a7b4d411d26a3ce37b1c7ed56d84af85a3fea605))
* **goals:** AC-103 expect 要求冷路径在 60000ms 硬上限内判绿 ([1d9ec1d](https://github.com/yaleh/claudecodeui/commit/1d9ec1dc06e4408ce59b1b9619f39a40bbb9bec8))
* **goals:** 修 AC-126 frontmatter 的 ASCII 冒号致 YAML 解析失败 ([e17fc0d](https://github.com/yaleh/claudecodeui/commit/e17fc0dad9b54466e6e41fa46c9af748e7692ba9))
* **i18n:** merge duplicate top-level resident keys in en/zh-CN chat.json ([0f42f2b](https://github.com/yaleh/claudecodeui/commit/0f42f2b72281ffd9397a523ff089e92639bd9868))
* **i18n:** 补齐 7 个 locale 缺失的 input.queue.*（排队消息 6 键） ([7418671](https://github.com/yaleh/claudecodeui/commit/7418671643f22a942372f6e8d577ba6f81677ee4))
* **launch-profiles:** import provider and websocket helpers through module barrels ([fa6e459](https://github.com/yaleh/claudecodeui/commit/fa6e459784761de4d2d90ad8da9d8ac3fbb2e84a))
* **launch-profiles:** import websocket helpers through the module barrel ([37ea91c](https://github.com/yaleh/claudecodeui/commit/37ea91c82a0f8aef6e0b133cddf5eddeeae70745))
* **launch-profiles:** import websocket helpers through the module barrel ([461ed77](https://github.com/yaleh/claudecodeui/commit/461ed77fad5f9cbf760d6455ba61a354e1248624))
* **launch-profiles:** untrack accidentally committed node_modules symlink ([fa17a8f](https://github.com/yaleh/claudecodeui/commit/fa17a8f83a00b61d7b8e1b0b1f947cdf2ef523c9))
* **models:** gateway template merges rows and is a reversible aria-pressed toggle ([4fd2917](https://github.com/yaleh/claudecodeui/commit/4fd291774ce4d08fa98d464cda8561a96d9417ce))
* **opencode:** compose the provider prefix into session model ids ([#1333](https://github.com/yaleh/claudecodeui/issues/1333)) ([544baff](https://github.com/yaleh/claudecodeui/commit/544baffe3c02106abb443f5c5f0b2b3d2bdc7b6b))
* **opencode:** hide child sessions ([#1344](https://github.com/yaleh/claudecodeui/issues/1344)) ([ed3f0bf](https://github.com/yaleh/claudecodeui/commit/ed3f0bfc0a45ee0b3aaddfd04de241c29335ff42))
* **project-workspace:** keep the selected session's title in step with session_upserted ([6e5b6da](https://github.com/yaleh/claudecodeui/commit/6e5b6daae139599377bf18ca160e9a5fdd9b9849))
* **projects:** route session-filter test imports through module barrels ([1266d45](https://github.com/yaleh/claudecodeui/commit/1266d45ec90f5a4ae0ba538b8f04d0f46e858b0f))
* **providers:** export createProviderTokenUsageService via the module barrel ([59832bf](https://github.com/yaleh/claudecodeui/commit/59832bf1352a4296cdd12bea2dd267c628d3dd8d))
* **providers:** finish the address contract at the type boundary ([84b60df](https://github.com/yaleh/claudecodeui/commit/84b60df6caba2a044abf69a89c0626f3b68dbe77))
* **providers:** scope AC6's driver-in-delta assertion to its own branch ([d320ac5](https://github.com/yaleh/claudecodeui/commit/d320ac5b32682b51d6bb0f4ce74544bc6e6cff31))
* **providers:** strip ANSI escapes from OpenCode and Cursor stderr ([#1303](https://github.com/yaleh/claudecodeui/issues/1303)) ([f362080](https://github.com/yaleh/claudecodeui/commit/f36208036efd5aef8dbfd92d3f0db18986f45530))
* **quay:** point worker-default at the claude-fjdac gateway launcher ([79b4f52](https://github.com/yaleh/claudecodeui/commit/79b4f52c84e7af34b80981ae72db0d69b6349c61))
* **quay:** test.sh handles --for-task/--allow-thin/--static-checks-doc from the scoped gate ([b167e28](https://github.com/yaleh/claudecodeui/commit/b167e2897a5d22c82e959ed99748208023ed18c8))
* **resident-experiments:** 补齐 resident-experiment.mjs 的 6 处 tsc 错误 ([94bff35](https://github.com/yaleh/claudecodeui/commit/94bff35449e65059782e37fc8a7206d32c41776e))
* route Enter through the composer's single submit entry ([75f1630](https://github.com/yaleh/claudecodeui/commit/75f1630246094d67dc2a6d26960c3c28a2f14302))
* **scripts:** attribute every test.sh failure as infra or assert ([3fe400c](https://github.com/yaleh/claudecodeui/commit/3fe400c1bdc7eb89cd852c44cbd4a7f8919e4a73))
* **scripts:** normalise the client assertion tally before testing it ([be80f1e](https://github.com/yaleh/claudecodeui/commit/be80f1ee13c26d6863fe66aa6e22744e49232095))
* **scripts:** type scripts/resident-smoke.mjs(+test) so npm run typecheck is green again ([a05471a](https://github.com/yaleh/claudecodeui/commit/a05471a9bd258459fc87d081ffbb8d26a206cce3))
* **server/providers:** widen sessions-watcher-mode's poll-window slack under fleet load ([b0073b9](https://github.com/yaleh/claudecodeui/commit/b0073b99760d1f9d47611c0a421851640ceda4bf))
* **server/tsconfig:** exclude __criterion-falsify-* from the tsc program ([7e6d074](https://github.com/yaleh/claudecodeui/commit/7e6d0744d2fec4f10c7cf1f54e559c9f66f2d02d))
* **server/tsconfig:** exclude ./modules/voice/tmp from the tsc program ([cfd66ce](https://github.com/yaleh/claudecodeui/commit/cfd66cea64c0f04263131155a8c66a15040dc3ce))
* **server:** keep throwaway servers and host-wide tests off the operator's scopes ([49c2047](https://github.com/yaleh/claudecodeui/commit/49c204786082c1b499aeecabf12822cd382e28b9))
* **sessions:** keep the recent-sessions payload test in step with lineage ([74f5fc1](https://github.com/yaleh/claudecodeui/commit/74f5fc1fab73c493189913d1dcae98759c0fc62d))
* **settings:** empty env rows are reported before a model save drops them ([5dc4a34](https://github.com/yaleh/claudecodeui/commit/5dc4a34b146239c2cf603da61cb2a10db1f69752))
* **shared/ui:** close the late-arm window in ActionMenu's viewport dismissal ([ac1cd4c](https://github.com/yaleh/claudecodeui/commit/ac1cd4c883d5a41f19631106f11075187ab776fb))
* **sidebar-tests:** stub useResidentProviders in the two capability-module mocks ([9aa412f](https://github.com/yaleh/claudecodeui/commit/9aa412f842bcfea94a6344c32db858e03f520b8a))
* **sidebar:** arm ActionMenu viewport dismissal on the next frame ([35cd475](https://github.com/yaleh/claudecodeui/commit/35cd475c9a72d70af1349020b35b788c89fbff37))
* **sidebar:** let Running collapse project groups ([#1166](https://github.com/yaleh/claudecodeui/issues/1166)) ([7090a5d](https://github.com/yaleh/claudecodeui/commit/7090a5dbfdee7f0fae5fb17232300148c1963b94))
* **sidebar:** route cross-module import through project-workspace barrel ([cd48d11](https://github.com/yaleh/claudecodeui/commit/cd48d1165d6b1fa081799fa6aa2ab39546ba5ca0))
* **suite:** keep the per-file child logs when a run is red or aborted ([45884ca](https://github.com/yaleh/claudecodeui/commit/45884caaadc3c7994287f998245377efb33c718d))
* **test:** cap the vitest client worker pool adaptively ([e0ed491](https://github.com/yaleh/claudecodeui/commit/e0ed4913d084808897e10de3304c15c3348fea60))
* **tests:** move the resetModules cold compile out of the case budget ([73cecff](https://github.com/yaleh/claudecodeui/commit/73cecffb5ac177a109fd7cad8ecd84a0d080714c))
* **tests:** scope the timeout-margin criterion to its invariant, not the mechanism ([9dba1f9](https://github.com/yaleh/claudecodeui/commit/9dba1f9e1e131e809fd0323c222b70a7a10e24c2))
* **tests:** size hookTimeout from the measurement, report it in the criterion ([7b2d3f9](https://github.com/yaleh/claudecodeui/commit/7b2d3f9f9df23611e12e776cbef4cd4d7b322635))
* **tests:** 服务端阶段的并发改为上限夹取（上限 16，由实测坡度表推出） ([71bedc3](https://github.com/yaleh/claudecodeui/commit/71bedc31da4f295816da39fcf5f3d58f7b415c02))
* **transcript:** attribute scroll intent to its input source, not to the offset's delta ([16c1678](https://github.com/yaleh/claudecodeui/commit/16c16783c8a5659e6139b1d75023d7d5f88c8774))
* upstream electron build bug ([5e73a49](https://github.com/yaleh/claudecodeui/commit/5e73a49b89b4f13766fc2e22723297a36e7dcef2))
* **voice-trim:** let a harness import the shipping tree, not one named file ([f53524d](https://github.com/yaleh/claudecodeui/commit/f53524d433ff19674dda1a743a2993c7a983550f))
* **voice-trim:** scope the uniqueness scan to the harness, not to one file ([28daa7e](https://github.com/yaleh/claudecodeui/commit/28daa7e3723e8eab1b25707c09244c396b40d5a4))
* **voice:** a provider with its own model field ignores the shared x-voice-stt-model header ([87a2554](https://github.com/yaleh/claudecodeui/commit/87a2554622f690399b3b233c9726d7783c00ca66))
* **voice:** AC7 enumerates the asr contract spec instead of running a second vitest ([ed5da1f](https://github.com/yaleh/claudecodeui/commit/ed5da1f1bc33798a689410d6851c8d0e64f90847))
* **voice:** dashscope-omni resolves an unset model to its own default; repair AC-137/138 entry order ([406b0c9](https://github.com/yaleh/claudecodeui/commit/406b0c9d014a2542fbff5373b21794c2a4a910a0))
* **voice:** exempt quay's own runtime state from the AC-152 residue guard ([ecab901](https://github.com/yaleh/claudecodeui/commit/ecab9014fb8d44e667edc50af23c758c54b95527))
* **voice:** isolate capture failures at the call site, not in the capture module ([ee1b5fb](https://github.com/yaleh/claudecodeui/commit/ee1b5fbca0bf3dd850c5a95518115ac4ef3fff61))
* **voice:** proxy-only 闸的兄弟判据输入改白名单内主机；host-bearers 收窄为出货源 ([9161b88](https://github.com/yaleh/claudecodeui/commit/9161b888e9071b552e85efd0350af21f3fd5a2b1))
* **voice:** the trim asks the registry for 裁不裁, not a table of its own ([0ae696c](https://github.com/yaleh/claudecodeui/commit/0ae696cdd1bcff53a6e677b851c6ab4c15202ae8))
* **voice:** 让 AC6 的红点名失败子命令、退出码与它自己说的那句话 ([1fe9714](https://github.com/yaleh/claudecodeui/commit/1fe9714dc9a013671a1582a7b0f1624e61811573))
* **workspace:** stop showing the resident Shell notice as a persistent banner ([3b50a13](https://github.com/yaleh/claudecodeui/commit/3b50a13b4d7715987b62513e77e702d9855e1cc3))

### Performance

* cap the transcript tail window at 512 KiB and widen by the delta ([c4c843d](https://github.com/yaleh/claudecodeui/commit/c4c843dda531a71845eace18ccab07d48e76ac99))

### Refactoring

* **launch-profiles:** 拆除旧实体，AC-001 黄金基准移植到新入口 ([b34a662](https://github.com/yaleh/claudecodeui/commit/b34a662e8ee2563037b6e7d2e8ce04eb9a8c2a66))
* **launch-profiles:** 清数据库残留结构，并收拾 GOAL-001 记录 ([3ff33d4](https://github.com/yaleh/claudecodeui/commit/3ff33d42897d5dc1aae1ed85a12a4ec4032f4342))
* **providers:** keep the shared compile layer reachable without closing the eval cycle ([a76f151](https://github.com/yaleh/claudecodeui/commit/a76f151cb5a51306a7b51ad67697175d038d2f87))
* **providers:** relocate the shared launch-spec compile layer out of launch-profiles ([1d76cac](https://github.com/yaleh/claudecodeui/commit/1d76cac64afc41321cbf6e250dc194b75f800b90))
* **voice:** name the direct path's transcript parse ([a87ba53](https://github.com/yaleh/claudecodeui/commit/a87ba539d15989d9743e252dfc19accac8d66c6c))
* **voice:** one implementation of the transcription wire protocol ([9e7ee00](https://github.com/yaleh/claudecodeui/commit/9e7ee000c30f04c1fc91d9a0d56ca7a14417ddea))

### Documentation

* add Gemini voice input proposal ([a867913](https://github.com/yaleh/claudecodeui/commit/a86791343d661aad95cbb6f10a572d7bd1ad1697))
* add launch profile proposal ([6c900ce](https://github.com/yaleh/claudecodeui/commit/6c900cec2da4c376e064d34b827b6dc609bce7c1))
* **adr-003:** 现场验证记录拆成独立文件（评审裁决 E） ([691c83f](https://github.com/yaleh/claudecodeui/commit/691c83f6992a750a96933a2e9b3f2b2c52b65b92))
* **adr-003:** 评审通过（附 A–E 裁决）落到 canonical checkout ([dec53e4](https://github.com/yaleh/claudecodeui/commit/dec53e4ab53aa2bbb1dde6173d982f26df9f09ba))
* **adr:** ADR-003 可控制的调试 Agent —— 不跑真 CLI 也能产生输出 ([1e6df28](https://github.com/yaleh/claudecodeui/commit/1e6df28cd9d4489655b5d6b00f4601223fd6032d))
* **adr:** 记入七条开放问题的裁定，并记下决策 9 的已执行 ([62aea1b](https://github.com/yaleh/claudecodeui/commit/62aea1bf58e44b3f09cf454019ab1dfd344a1a0c))
* **adr:** 记入总判定「通过」，并保留两项不由通过消除的事项 ([9f86bca](https://github.com/yaleh/claudecodeui/commit/9f86bca32a7a012af92456e123a789bf37eb0751))
* **adr:** 语音识别 provider 缝的决策记录 第二版（评审修订） ([483b2c5](https://github.com/yaleh/claudecodeui/commit/483b2c5fb80c94adc0da2b1d15a7f20071443b7b))
* **adr:** 语音识别 provider 缝的决策记录（ADR-004） ([dc568d2](https://github.com/yaleh/claudecodeui/commit/dc568d240d805ca65a7a541a2ff02109c9820dbe))
* correct the scoped-gate reading — it starts and passes ([a1fea4e](https://github.com/yaleh/claudecodeui/commit/a1fea4e388930a3897d36f674d0f0dd99bc573e3))
* **experiments:** a1 本地会话记录中口述目标与上下文竞争者的基础比例 ([9ccb4aa](https://github.com/yaleh/claudecodeui/commit/9ccb4aad884f985ec6a0c4c28bc369d6c3f317c4))
* **experiments:** a2 结果修正更正说明的排版 ([4e04667](https://github.com/yaleh/claudecodeui/commit/4e04667dc30adebf5ea04e3164b57d14cff203b4))
* **experiments:** a2 结果写明超时次数与离线重算的音频依赖 ([ca5291c](https://github.com/yaleh/claudecodeui/commit/ca5291caa156ab9e4301b726bddcfd553983a9ed))
* **experiments:** a2 结果更正与现有 goal-010 的命名冲突 ([d0c5f48](https://github.com/yaleh/claudecodeui/commit/d0c5f486eb90b839d9563508fc18dacf4178f9e1))
* **experiments:** a2 结果未通过预注册规则，不进入 goal-010 ([a73c5c0](https://github.com/yaleh/claudecodeui/commit/a73c5c0d0e2d597202305664e55740fca0ac570e))
* **experiments:** a2 结果补上去掉 c1、c7 的敏感性检查读数 ([9675753](https://github.com/yaleh/claudecodeui/commit/967575327afb79b13b5d0f66d3044bdb6189d56c))
* **experiments:** a2 补充条件使用上下文的离线模拟，结论不变 ([346c1a1](https://github.com/yaleh/claudecodeui/commit/346c1a1350ea24ac00f807f88e01a8b1c2458d84))
* **experiments:** a2 语义核验，规则一致率 93.8%，结论更强 ([1280271](https://github.com/yaleh/claudecodeui/commit/1280271e72597d498c9447ed111cd016e4c09e92))
* **experiments:** a2 预注册判定规则与冻结的真实会话上下文 ([5f4b7a9](https://github.com/yaleh/claudecodeui/commit/5f4b7a90250d4549cc2f02f579ad9860d7ac1ebd))
* **experiments:** 保存 qwen3.8-omni-flash 书面化实验的原始读数与脚本 ([a298761](https://github.com/yaleh/claudecodeui/commit/a298761eed43b62e9b835bd1451a44f50677b904))
* **experiments:** 扩展集 5 条 webm 音频入库并登记理由 ([9f5910c](https://github.com/yaleh/claudecodeui/commit/9f5910cd13cf6d353b5ed698de822394ef5958fb))
* **experiments:** 语音链路实验记录入库（实验协议 + 标点实验） ([0faa2e0](https://github.com/yaleh/claudecodeui/commit/0faa2e0781930fe8999f3772456142a698c3c617))
* **goals:** add exit-conditions section to GOAL-001 ([e5117b7](https://github.com/yaleh/claudecodeui/commit/e5117b7577bdc82cf0aa4d225b6deab19bf6dd04))
* mark launch profile proposal as partially superseded by ADR-002 ([42809eb](https://github.com/yaleh/claudecodeui/commit/42809eb39d50bd2535b721c192ddff714c152b0e))
* **ops:** measure the heap ceiling's channel boundary and record why the incident replay is unfaithful ([cef20f4](https://github.com/yaleh/claudecodeui/commit/cef20f4061d2e5268fab59d961e7c1c7f70d0e37))
* proposal for pre-ASR silence trimming (GOAL-006), and split P2 in the old one ([20a3a9c](https://github.com/yaleh/claudecodeui/commit/20a3a9c00cf6d02dbfa5f5dfb84ec91bf8b4f5eb))
* proposal for unified session lifecycle and Claude resident sessions ([e88175c](https://github.com/yaleh/claudecodeui/commit/e88175cf76223034204b07317702af7ecf7c7763))
* **proposals:** record the measured cross-session arrival shape ([2600a9d](https://github.com/yaleh/claudecodeui/commit/2600a9d2ae5977ba2ffc2b765039e90d69fb4d08))
* **proposals:** 语音输入接入 DashScope Qwen3.8-Omni-Flash，口述直接产出书面化指令 ([8207f6d](https://github.com/yaleh/claudecodeui/commit/8207f6d23f799fcb7557c7036b8f0e31fe367e71))
* **proposal:** use control-protocol events for turns, leases and busy input; isolate remote control ([41bd6ab](https://github.com/yaleh/claudecodeui/commit/41bd6abf8155e26a03c962a4977ffbdf756c8a45))
* **resident-experiments:** 记录 E2/E3 基准的人工确认行（AC4） ([4438319](https://github.com/yaleh/claudecodeui/commit/4438319545e4ff654568159b60da0d61787d026e))
* resolve open questions in launch profile proposal ([7da6f45](https://github.com/yaleh/claudecodeui/commit/7da6f45c39027c19593dd97f1753d9e8da480264))
* **voice:** proposal for actionable speech-recognition error messages (GOAL-011) ([9fe6309](https://github.com/yaleh/claudecodeui/commit/9fe6309f71f4604d0940428c010630bbaf9ae64d))
* **voice:** proposal for server-side capture of speech-recognition attempts (GOAL-010) ([51f5cb5](https://github.com/yaleh/claudecodeui/commit/51f5cb5515f485f0595324ce5f61d16e8eb093ee))
* 语音识别 provider 缝 proposal 第二版（与 ADR 第二版对齐） ([566a445](https://github.com/yaleh/claudecodeui/commit/566a445e5200f2d7dd56b9b60b2d37af60e039ea))
* 语音识别 provider 缝 proposal（设计细节与实施顺序） ([caa3b62](https://github.com/yaleh/claudecodeui/commit/caa3b62b6e85520b17d75922106c4e7c6165facc))
* 语音输入标识符修复与时间轴压缩 proposal ([57b957f](https://github.com/yaleh/claudecodeui/commit/57b957f770a9d327426161741d43b3bd60b13731))

### Maintenance

* **adr:** 删除误建的 ADR-999 存根 ([f47561d](https://github.com/yaleh/claudecodeui/commit/f47561dade8fd494940247266188a115faf15362))
* **e2e:** tighten the resident-ui-layout gate comment to one line ([f1cf6d7](https://github.com/yaleh/claudecodeui/commit/f1cf6d71325667e99dd2442fc13ba8c897ab06f9))
* **lint:** ignore the voice criteria's transient scratch files ([5eb18a9](https://github.com/yaleh/claudecodeui/commit/5eb18a913d8ad0d57b519d6fe6c36e7a14232aff))
* **ops:** isolate tests and the :3001 server in their own cgroups ([ade2dfb](https://github.com/yaleh/claudecodeui/commit/ade2dfb42c7044cf8432b935c9c4ccca24e83948))
* **ops:** put the quay fleet under one shared memory ceiling ([8e49b82](https://github.com/yaleh/claudecodeui/commit/8e49b82bd837b42bf145243c06eacbf7f0575ee6))
* **quay:** supply plugin/scripts/runner-static-gate.ts so fan-in can classify its delta ([f7604c6](https://github.com/yaleh/claudecodeui/commit/f7604c68af98cc2bf90e6415660e88e736abef01))
* **quay:** track tasks/ and quay config; drop legacy tasks/ ignore ([4aacbef](https://github.com/yaleh/claudecodeui/commit/4aacbef1d0368c4c54b4035589cb216424c8a1d9))
* **scripts:** make server-phase-concurrency-check.sh executable (scripts/*.sh 约定 100755) ([362c9c0](https://github.com/yaleh/claudecodeui/commit/362c9c06241e5cb1daeb6a02b17e36d1edffdcf2))
* **scripts:** retire suite-concurrency-check.sh with AC-103 ([f974268](https://github.com/yaleh/claudecodeui/commit/f9742680a9c3b9f02aa8d8f7918de12acf5e50c3))
* **tasks:** carry the ABI-written AC tick onto the task branch ([30439b5](https://github.com/yaleh/claudecodeui/commit/30439b5bc58190420422ea7ec4adaeea03f5d942))
* **tasks:** gap-e2e-data-dir-has-no-reclaimer 勾选入任务分支 ([83a8132](https://github.com/yaleh/claudecodeui/commit/83a81326d23d81399a39efc7a804dde1be883d07))
* **tasks:** record AC-169 satisfied via task_write ([501c0f9](https://github.com/yaleh/claudecodeui/commit/501c0f920ed8c5fac614e29f57d889bf1414020e))
* **tasks:** record the load-induced false red in the round's notes ([fc476a6](https://github.com/yaleh/claudecodeui/commit/fc476a6804e939a383ba2b65c88bff878691fedb))
* **tasks:** space the Touches annotation so the scoped gate resolves the criterion ([8e2d794](https://github.com/yaleh/claudecodeui/commit/8e2d794215aba57a23b8f27951d12b00f1797f30))
* **tasks:** sync the ABI-written body into the worktree copy ([d76b9f6](https://github.com/yaleh/claudecodeui/commit/d76b9f62c735031541f551f3bdef46ed20b8000d))
* **tasks:** 立案 gap-launch-profiles-env-injection-closed-test（GOAL-001 AC-004 结构性缺口） ([f9aff6d](https://github.com/yaleh/claudecodeui/commit/f9aff6d7925908604f6f76915afe4af770729832))
* untrack accidentally committed node_modules symlink ([1289220](https://github.com/yaleh/claudecodeui/commit/1289220b86397aa0b774ae71f5a5e54815bca8b3))

### CI/CD

* **release:** fork release pipeline to yaleh — GitHub Release + Windows + local-server only ([5abf677](https://github.com/yaleh/claudecodeui/commit/5abf677dc63ed661524fd429774e53f77a4a8ddc))

### Tests

* **chat-edit-send:** await the turn instead of sleeping 30ms through it ([54e83c2](https://github.com/yaleh/claudecodeui/commit/54e83c23fc3bdf2e6b5c7c86a4659e48da4f8763))
* **chat:** read the running turn's stop entries across the composer and the pane ([8bc3226](https://github.com/yaleh/claudecodeui/commit/8bc3226129c6f6f6b67a96daa20d12d85dc6c709))
* **claude-resident:** criterion for the idle ceiling and its held work ([624a536](https://github.com/yaleh/claudecodeui/commit/624a536ca0b151a4354a121551b45dd91f8471cb))
* **claude-resident:** narrow the cron deadline before stepping the clock ([7deac21](https://github.com/yaleh/claudecodeui/commit/7deac216a7208d627f9a252023481219aecdf751))
* **claude-resident:** print the tokens the criteria name ([e44916e](https://github.com/yaleh/claudecodeui/commit/e44916e52a7a278e4a0da2cb98c3c993126f0181))
* **claude-resident:** read loop liveness directly in the unread-subtype leg ([1abc0c6](https://github.com/yaleh/claudecodeui/commit/1abc0c6458fa4027d2e25d86bcc895ce4741b42d))
* **composer:** 钉住触摸提示行省下的 20px，并记下改动前的对照读数 ([90f696d](https://github.com/yaleh/claudecodeui/commit/90f696d9cf1d274c78f5e7cdb143b91be8683860))
* **debug-agent:** cover the external-write path end to end ([e22e6ad](https://github.com/yaleh/claudecodeui/commit/e22e6ad44b53d3eec51052737086d574023864a5))
* **debug-agent:** make the closed arm carry the root it must not use ([f04e44b](https://github.com/yaleh/claudecodeui/commit/f04e44b6a5ab6a1587b662d3bca0db100747fae6))
* **debug-agent:** read the load event's readiness from the observer itself ([e356215](https://github.com/yaleh/claudecodeui/commit/e3562158acd46a50b983230f7d522e20ebbcaa63))
* **debug-agent:** the display-identity criterion AC-136 is judged by ([325a89f](https://github.com/yaleh/claudecodeui/commit/325a89f9d3a5adb568c203a624a4037bf4e1cfb4))
* **debug-agent:** the fixture-home isolation criterion AC-127 is judged by ([c8bb1ed](https://github.com/yaleh/claudecodeui/commit/c8bb1ed22819a9e754e2bf1abfac00697e03b140))
* **debug-agent:** 短窗口试次并入臂内终态等待，收掉最重文件的叠死等 ([a78b6db](https://github.com/yaleh/claudecodeui/commit/a78b6db9a026bd6c134d436def81ad8a9f3fbb2b))
* **e2e:** anchor post-onboarding waits on the app shell, not the empty state ([eb128a0](https://github.com/yaleh/claudecodeui/commit/eb128a0e92dc46030db35cbf9489e7fda3db72ba))
* **e2e:** anchor the env-kind spec on the main UI, not the project empty state ([a71596f](https://github.com/yaleh/claudecodeui/commit/a71596f784a2e31e939e582ccdab656f299dd87a))
* **e2e:** bound session-filter's startup path with the family's warm-up and navigation probe ([069c663](https://github.com/yaleh/claudecodeui/commit/069c663daf2cf940032179b30f66e43b78833088))
* **e2e:** make the close-reachability spec independent of the consent notice ([d678f36](https://github.com/yaleh/claudecodeui/commit/d678f368daaae93775031692c71b6af18182960f))
* **e2e:** pay the AC-115 preamble's client startup before the page, and bound it ([9274519](https://github.com/yaleh/claudecodeui/commit/927451937da70d53fa530d302b9c438c525f0da1))
* **e2e:** real-browser spec for the session name filter ([0a64846](https://github.com/yaleh/claudecodeui/commit/0a6484699f39fbc7acd23cbe71a22f3edcf2f56c))
* **e2e:** state plainly what the close-reachability reading no longer proves ([97bceba](https://github.com/yaleh/claudecodeui/commit/97bceba0295a68422ec24ec7be760f30520c711c))
* **e2e:** the resident busy-send criterion, and the debug-agent gate it needs ([21a9586](https://github.com/yaleh/claudecodeui/commit/21a95867bd2f881cd3045e8bbd8d3ff93bce70c3))
* gate the oom-cap hog tests behind RUN_OOM_CAP_TESTS=1 ([f5bd7d7](https://github.com/yaleh/claudecodeui/commit/f5bd7d752144c0b5cfe48351e0e9ca4a04e74d87))
* give AC-176's out-of-harness fake arms their own migrated database ([66d0271](https://github.com/yaleh/claudecodeui/commit/66d0271d5ef1a455b09150cc756efc54f66287a1))
* harden two fleet-concurrency flakes (voice AC8 probe, model-gateway teardown) ([5accfa1](https://github.com/yaleh/claudecodeui/commit/5accfa1a7390fe71511f6cab066b3c66cf2e6a3b))
* **launch-profiles:** fix event typing ([c96494e](https://github.com/yaleh/claudecodeui/commit/c96494eb3d9f4756fe9e2b32316cf82d3bb1b067))
* **launch-profiles:** model-library gateway end-to-end (AC-025) ([ede1b40](https://github.com/yaleh/claudecodeui/commit/ede1b4095e2321aa4afaa763f8cee38e193624d8))
* **projects:** real-data criterion for the session name filter ([95112dc](https://github.com/yaleh/claudecodeui/commit/95112dc0068e9cc5e0bc2c62e356519f79e9a1e0))
* **projects:** take the real-data filter criterion off this machine's clock ([196c249](https://github.com/yaleh/claudecodeui/commit/196c249572c484c413fa384ae8059b846bf75bd9))
* **providers:** AC-001 golden-baseline provenance banner on passthrough-parity ([f8d5152](https://github.com/yaleh/claudecodeui/commit/f8d5152bffb5da08df14f71b7bd0637f8974a92f))
* **providers:** attribute session-scope reads to this process ([421b66d](https://github.com/yaleh/claudecodeui/commit/421b66dd82200c881bf2028feb2e92ee51febcf5))
* **providers:** bound the unattended-turn criterion's waits below its budget ([a330009](https://github.com/yaleh/claudecodeui/commit/a3300094f0965c35c669cc6de907927b9c4698f7))
* **providers:** measure a resident session's address end to end ([b7fa4d0](https://github.com/yaleh/claudecodeui/commit/b7fa4d0edd4b18c4e01aca1d8e1f6975e788aa33))
* **providers:** pin the AC-028 provenance header on the context-window criterion file ([deacbf2](https://github.com/yaleh/claudecodeui/commit/deacbf214caa2a1d8d3533dd3a1eb2677b5b417d))
* **providers:** re-cover the compile-path allowlist re-validation on both final spawn envs ([37f1fcf](https://github.com/yaleh/claudecodeui/commit/37f1fcf02c16964a14a994ff0b6436627b30caa1))
* **providers:** 为 AC-025 网关端到端判据补溯源注释 ([f6d883b](https://github.com/yaleh/claudecodeui/commit/f6d883b0042198b4c2de46b60487136e4f3fa9a3))
* resident-server-restart cleanup stops only its own servers' scopes ([5d208d6](https://github.com/yaleh/claudecodeui/commit/5d208d63f8cfddc15d05885732fb38b38467b340))
* **resident-status-bar:** the clock as printed, and the count that must fall ([271eccc](https://github.com/yaleh/claudecodeui/commit/271eccc521c3f6ab2457ae0265d8087e28c475f7))
* retry the SIGKILL-then-reboot legs when a foreign boot reaped the orphan ([f2cd622](https://github.com/yaleh/claudecodeui/commit/f2cd622181c01f34f201e8e9b9f5772d2292ea44))
* seed the voice fixture before the repair, not after it ([d688294](https://github.com/yaleh/claudecodeui/commit/d688294cce304d0e81b963465031123449b61a28))
* **server:** read the over-limit reap before any control, and pin the literal slice ([adf651d](https://github.com/yaleh/claudecodeui/commit/adf651de4f0a59aac2f94cb5d5249b1d57d4fb74))
* **session-hosts:** assert the binding cardinality before its proxies ([384954b](https://github.com/yaleh/claudecodeui/commit/384954beee69427992591ac9c4e21df721af4c0e))
* **session-hosts:** declare peerName in the listing's binding contract ([8b1b02b](https://github.com/yaleh/claudecodeui/commit/8b1b02b213312b83077a334b9a94db04b6d5b9bc))
* **session-hosts:** name the frame that actually went missing ([7cc6c66](https://github.com/yaleh/claudecodeui/commit/7cc6c6633aa680c0dbf76c505a13328ce2f4b81f))
* **session-hosts:** per-run frame parity criterion for AC-155 ([d16f4a3](https://github.com/yaleh/claudecodeui/commit/d16f4a3c672d7a177af58ecb11ef38796453f915))
* **transcript-follow:** 整行追加的跟住判据（夹具 + 单测） ([bc66462](https://github.com/yaleh/claudecodeui/commit/bc664621f5c2bf223519c0e7a32e600843713c3b))
* **transcript:** name the AC-111 instruments as the criterion names them ([302fd36](https://github.com/yaleh/claudecodeui/commit/302fd3651f4d6260ca549e9a51c9f93dda21469b))
* **transcript:** print the AC-111 readings from the run itself ([795bf0e](https://github.com/yaleh/claudecodeui/commit/795bf0ec6cb6041c67389162f79b2c95a552965c))
* **voice:** drive the four fake shapes the parity criterion must go red on ([5cd753b](https://github.com/yaleh/claudecodeui/commit/5cd753b714d2bbd3d2dbb7ac8924a3bb4502adff))
* **voice:** judge the real service process's stdout for the capture line (AC-148) ([145aa1b](https://github.com/yaleh/claudecodeui/commit/145aa1b59ce9e7641ee63e9b533377441161d6c9))
* **voice:** list the seam in the two module doubles that drive the mic ([2506f8d](https://github.com/yaleh/claudecodeui/commit/2506f8d3a5d4f69ed648419c32da403a9a2ed58d))
* **voice:** name a commit the baseline can be reproduced from ([c4ca434](https://github.com/yaleh/claudecodeui/commit/c4ca434f5fd220131d5c7a42919f1db82a6f5dc2))
* **voice:** read the four parity groups off the shipped code ([f28578e](https://github.com/yaleh/claudecodeui/commit/f28578ecefbe278cedd0f1242872d9509b648380))
* **voice:** record the pre-extraction parity baseline ([8bff677](https://github.com/yaleh/claudecodeui/commit/8bff677398d1670f632e0ceee62a90e1e519aa9e))
* **voice:** spell the module type as the repo does ([8dbe90b](https://github.com/yaleh/claudecodeui/commit/8dbe90b3b025a188857bc5f983e93f3cd5fce985))
* **voice:** the three capture modes, and the four secrets that must not survive them ([c471f1a](https://github.com/yaleh/claudecodeui/commit/c471f1a65e9d99e1df35e69f8ccec5afe02138d8))
* **voice:** the two mic doubles follow the seam the trim now reads ([c828520](https://github.com/yaleh/claudecodeui/commit/c828520c7e0ceb19ebed5bad375b29cc288d8047))

## [1.37.3](https://github.com/siteboon/claudecodeui/compare/v1.37.2...v1.37.3) (2026-09-08)

### New Features

* **chat:** recall sent messages with arrow keys in the composer ([#1238](https://github.com/siteboon/claudecodeui/issues/1238)) ([8f9a2e4](https://github.com/siteboon/claudecodeui/commit/8f9a2e43859821e9c41e4d90b8d16707f47927de))
* **chat:** unify provider workflows and improve transcript performance ([#1206](https://github.com/siteboon/claudecodeui/issues/1206)) ([99ea052](https://github.com/siteboon/claudecodeui/commit/99ea05259554c166fccab9e20dcf902f435fa54d))
* **codex:** expose GPT-6 Astra model ([#1289](https://github.com/siteboon/claudecodeui/issues/1289)) ([4e1190c](https://github.com/siteboon/claudecodeui/commit/4e1190ccec899aebeac898409e5cbd32e0cde647))
* **i18n:** connect remaining hardcoded UI strings to translations ([#1192](https://github.com/siteboon/claudecodeui/issues/1192)) ([5af0990](https://github.com/siteboon/claudecodeui/commit/5af0990386953e00b71c72d326e25b874d30a800))
* **sidebar:** draw a Conversations row the way a Projects row is drawn ([#1157](https://github.com/siteboon/claudecodeui/issues/1157)) ([7015ffc](https://github.com/siteboon/claudecodeui/commit/7015ffc8447b2de228f3d942585d29f4a9aeb955)), closes [#1206](https://github.com/siteboon/claudecodeui/issues/1206)

### Bug Fixes

* **agent:** read the model catalog's own shape, not a wrapper ([#1159](https://github.com/siteboon/claudecodeui/issues/1159)) ([25ddd76](https://github.com/siteboon/claudecodeui/commit/25ddd76820b5147a46d5b08d53f5d1f31e14d35a))
* **chat:** keep an option label containing ", " as one answer ([#1249](https://github.com/siteboon/claudecodeui/issues/1249)) ([61af329](https://github.com/siteboon/claudecodeui/commit/61af3295441581ecc7be70579af95fc046931a68))
* **claude:** ignore <synthetic> model placeholder when resolving session model ([#1207](https://github.com/siteboon/claudecodeui/issues/1207)) ([7b52e3c](https://github.com/siteboon/claudecodeui/commit/7b52e3ce1c8f0069f3f501bf56ad73b55f9bc7da))
* **editor:** syntax highlighting for .mts, .cts, .mjs and .cjs ([#1223](https://github.com/siteboon/claudecodeui/issues/1223)) ([aa2755b](https://github.com/siteboon/claudecodeui/commit/aa2755b852965b27e764f42120062966f9916502))
* **i18n:** add missing delete-dialog archive keys to all locales ([#1162](https://github.com/siteboon/claudecodeui/issues/1162)) ([1c61dc3](https://github.com/siteboon/claudecodeui/commit/1c61dc302ed556b5455255e6e1726eb2ab12e853))
* npm release it and README ([d27062e](https://github.com/siteboon/claudecodeui/commit/d27062ed2927d048195b88fa5bf54dc520bba49c))
* npm release-it and README ([125a293](https://github.com/siteboon/claudecodeui/commit/125a293f2a9315e1e60cc8805fa4d007fee7f7d7))
* **opencode:** list OpenCode Go models with reasoning variants ([#1265](https://github.com/siteboon/claudecodeui/issues/1265)) ([b7320c9](https://github.com/siteboon/claudecodeui/commit/b7320c91d197ef64d505312797cd5f7b21f5d705)), closes [#840](https://github.com/siteboon/claudecodeui/issues/840)
* **release:** expose npm publish failures ([#1271](https://github.com/siteboon/claudecodeui/issues/1271)) ([46973fc](https://github.com/siteboon/claudecodeui/commit/46973fc962e63ed31983689e50fe75f921745cda))
* **scheduled-messages:** interrupt a busy run instead of failing to send ([#1239](https://github.com/siteboon/claudecodeui/issues/1239)) ([c1be241](https://github.com/siteboon/claudecodeui/commit/c1be241bc41586478f3d15f4dc6a5a6399d40aa1))
* **sessions:** keep an archived session archived across a rescan ([#1220](https://github.com/siteboon/claudecodeui/issues/1220)) ([bfe7c49](https://github.com/siteboon/claudecodeui/commit/bfe7c495792b21f027f057f555c39e2edb24d095))
* **skills:** a plugin that ships commands keeps its skills too ([#1274](https://github.com/siteboon/claudecodeui/issues/1274)) ([b6083e0](https://github.com/siteboon/claudecodeui/commit/b6083e0bc84ea5d8063191a057c52b0f4b0088c9)), closes [#1273](https://github.com/siteboon/claudecodeui/issues/1273)

## [1.37.2](https://github.com/siteboon/claudecodeui/compare/v1.37.1...v1.37.2) (2026-08-18)

### Bug Fixes

* improve chat view and resolve bandwidth issue ([#1153](https://github.com/siteboon/claudecodeui/issues/1153)) ([0a2ad34](https://github.com/siteboon/claudecodeui/commit/0a2ad34365b7f01dcd01b87fe3f856844c0dc531))
* introduce fallback for update build failures ([0d51774](https://github.com/siteboon/claudecodeui/commit/0d5177491215c1c2a53ad23a30f7deec8de2e1af))

## [1.37.1](https://github.com/siteboon/claudecodeui/compare/v1.37.0...v1.37.1) (2026-08-13)

### New Features

* add provider session ID copy actions ([#1040](https://github.com/siteboon/claudecodeui/issues/1040)) ([428b105](https://github.com/siteboon/claudecodeui/commit/428b1052be3bb28611d2ef3fcd29cec5a9ca1397))
* **i18n:** add complete Spanish (es) translation ([#1090](https://github.com/siteboon/claudecodeui/issues/1090)) ([5fa87dd](https://github.com/siteboon/claudecodeui/commit/5fa87ddaf7c1c06c33c34f48a462743aa3877edf))
* **i18n:** complete Korean (ko) translation ([#997](https://github.com/siteboon/claudecodeui/issues/997)) ([59472c0](https://github.com/siteboon/claudecodeui/commit/59472c075eb2f28a48df9d9eff659ad823d31bd2))
* **plugins:** recommend Codex Usage plugin ([#1114](https://github.com/siteboon/claudecodeui/issues/1114)) ([ca92373](https://github.com/siteboon/claudecodeui/commit/ca92373dfead92f7f777093e72e9a118a97ff97a))
* **sidebar:** add recent conversation feed ([#1041](https://github.com/siteboon/claudecodeui/issues/1041)) ([015e892](https://github.com/siteboon/claudecodeui/commit/015e892c75e29b1771399691dbca3c8b466fa0b1))

### Bug Fixes

* **claude:** remove dead CLAUDE_CODE_STREAM_CLOSE_TIMEOUT workaround ([#1115](https://github.com/siteboon/claudecodeui/issues/1115)) ([ef3f798](https://github.com/siteboon/claudecodeui/commit/ef3f7980db15c89761c3a1aad8b608fff33789ad))
* don't recurse into system directories when building file trees ([#1074](https://github.com/siteboon/claudecodeui/issues/1074)) ([753a8c0](https://github.com/siteboon/claudecodeui/commit/753a8c0422685bafd4e878c44726f727357a3fb5))
* resolve @/ path aliases so the server test suite can load ([#1084](https://github.com/siteboon/claudecodeui/issues/1084)) ([74d3f8f](https://github.com/siteboon/claudecodeui/commit/74d3f8ffff6f315d2f2ceb240512aeb2d8b40464))
* **search:** match Claude transcripts by provider_session_id ([#1078](https://github.com/siteboon/claudecodeui/issues/1078)) ([9507694](https://github.com/siteboon/claudecodeui/commit/95076941533dc14f04d83917e1e7c04229e664c1))
* tolerate client clock skew before treating an auth token as expired ([#1085](https://github.com/siteboon/claudecodeui/issues/1085)) ([f0dca2d](https://github.com/siteboon/claudecodeui/commit/f0dca2d5e79c225f599e697bf9b55e839b152b78))
* update stale Sonnet 4.6 labels to Sonnet 5 in the Claude model picker ([#1036](https://github.com/siteboon/claudecodeui/issues/1036)) ([c2408f0](https://github.com/siteboon/claudecodeui/commit/c2408f0fc331fb267fdc9def954e55f71d019302))

## [1.37.0](https://github.com/siteboon/claudecodeui/compare/v1.36.3...v1.37.0) (2026-07-29)

### New Features

* numerous bugfixes and features ([#1037](https://github.com/siteboon/claudecodeui/issues/1037)) ([06e7ee9](https://github.com/siteboon/claudecodeui/commit/06e7ee9fb8c6afd1066566e8dc0e2c0c853a4990))

### Bug Fixes

* check CLAUDE_CODE_OAUTH_TOKEN in checkCredentials() ([#979](https://github.com/siteboon/claudecodeui/issues/979)) ([75ff8a5](https://github.com/siteboon/claudecodeui/commit/75ff8a5dcd0d63dced4c662bbf9433d7515d09da))

## [1.36.3](https://github.com/siteboon/claudecodeui/compare/v1.36.2...v1.36.3) (2026-07-15)

### Bug Fixes

* codex subagents should not appear in the sidebar ([283b558](https://github.com/siteboon/claudecodeui/commit/283b5586d2a6704d93ab7d0627ee947f8fef9809))
* remove node_env from electron ([f2a95d6](https://github.com/siteboon/claudecodeui/commit/f2a95d64982c3372abfb9ff144244c2383476bd3))

### Maintenance

* refresh better-sqlite3 lock ([#1027](https://github.com/siteboon/claudecodeui/issues/1027)) ([31645e3](https://github.com/siteboon/claudecodeui/commit/31645e3fdc63857d9970eae8abef8ecbc5122796))

## [1.36.2](https://github.com/siteboon/claudecodeui/compare/v1.36.1...v1.36.2) (2026-07-14)

### Bug Fixes

* bump @openai/codex-sdk to ^0.144.0 to support newer Codex models ([#1001](https://github.com/siteboon/claudecodeui/issues/1001)) ([038d960](https://github.com/siteboon/claudecodeui/commit/038d960c75b547f111751a39f28689ac66fca76d))
* harden docker cloudcli install ([123d244](https://github.com/siteboon/claudecodeui/commit/123d244a5143c3954d2f1c54240a5e683ca74a4e))
* validate X-Refreshed-Token before storing it as the auth token ([#971](https://github.com/siteboon/claudecodeui/issues/971)) ([5884573](https://github.com/siteboon/claudecodeui/commit/5884573a6975f53381759a28280afd9c8bb332c4))

## [1.36.1](https://github.com/siteboon/claudecodeui/compare/v1.36.0...v1.36.1) (2026-07-08)

### New Features

* **redesign:** skills and MCP action controls in settings ([#942](https://github.com/siteboon/claudecodeui/issues/942)) ([41e0d30](https://github.com/siteboon/claudecodeui/commit/41e0d309e06edda14abc6912ade5c2f9d4a90984))

## [](https://github.com/siteboon/claudecodeui/compare/v1.35.1...vnull) (2026-07-03)

### New Features

* add Claude and Codex effort controls ([#943](https://github.com/siteboon/claudecodeui/issues/943)) ([d272922](https://github.com/siteboon/claudecodeui/commit/d272922d87e4ee74bf8b0fdeac83b2c1e77973f3))

## [1.35.1](https://github.com/siteboon/claudecodeui/compare/v1.35.0...v1.35.1) (2026-07-01)

### Bug Fixes

* preview video on new tab ([#933](https://github.com/siteboon/claudecodeui/issues/933)) ([2ebe64f](https://github.com/siteboon/claudecodeui/commit/2ebe64f21874f45f6c8747310be874ae7342c61c))
* remove obsolete semantic helper release jobs ([1e16f1f](https://github.com/siteboon/claudecodeui/commit/1e16f1f0854e347aa333434638d64f2b167d9a9d))
* resolve mobile shell issues ([#923](https://github.com/siteboon/claudecodeui/issues/923)) ([b6cf333](https://github.com/siteboon/claudecodeui/commit/b6cf33308da996f8169580a4b5b74e3c5f38e447))

### Maintenance

* remove computer use ([6761f31](https://github.com/siteboon/claudecodeui/commit/6761f31a56fe82d82c7e0c079b4891e7d5a81817))

## [1.35.0](https://github.com/siteboon/claudecodeui/compare/v1.34.0...v1.35.0) (2026-06-29)

### New Features

* add Electron desktop app ([97c9b67](https://github.com/siteboon/claudecodeui/commit/97c9b67bfc2d803560cd1559a4e79eea9731c7b5))
* **chat:** derive activity indicator from per-session state and unify provider lifecycle events ([afc717e](https://github.com/siteboon/claudecodeui/commit/afc717e69e67f53173c30d2230722236f9180d39))
* **chat:** unify session gateway with stable IDs and a single WS protocol ([f5eac2e](https://github.com/siteboon/claudecodeui/commit/f5eac2ec12c8575bf80202fafe807d9e04720105))
* **i18n:** add French (fr) locale ([#878](https://github.com/siteboon/claudecodeui/issues/878)) ([f319d2c](https://github.com/siteboon/claudecodeui/commit/f319d2cf8d61452deaf6adf345494dd3e6898284))
* play sound for pending tool requests ([#918](https://github.com/siteboon/claudecodeui/issues/918)) ([c947eaa](https://github.com/siteboon/claudecodeui/commit/c947eaaee5fbc959563efb917f4ec7c88847dd6b))
* render changelog as markdown in version upgrade modal ([6a53c31](https://github.com/siteboon/claudecodeui/commit/6a53c31e907fffa79320997c27f99660c946b4a6))
* **sidebar:** improve running session state tracking ([591b18e](https://github.com/siteboon/claudecodeui/commit/591b18e9e343fda23affe100a53911f76aaa8f57))
* **skills:** add provider skill management ([#909](https://github.com/siteboon/claudecodeui/issues/909)) ([c5fe127](https://github.com/siteboon/claudecodeui/commit/c5fe127958d830eee19d008d8634c0e7d77fe1b9))
* **version:** warn when the server was updated but not restarted ([#898](https://github.com/siteboon/claudecodeui/issues/898)) ([f6326c8](https://github.com/siteboon/claudecodeui/commit/f6326c8082dfbe8a65dcdb836d3e71c635594c26))

### Bug Fixes

* changes provider logos to svg for fast load ([7bed675](https://github.com/siteboon/claudecodeui/commit/7bed675ad5fd1ecf7912d1a04afe9db5b1032823))
* **chat:** prevent chat interface crash on malformed AskUserQuestion payload ([#920](https://github.com/siteboon/claudecodeui/issues/920)) ([ed4ae31](https://github.com/siteboon/claudecodeui/commit/ed4ae3114aafc1d4ecb0b621eaf9d3b26dbca5b1))
* **chat:** prevent normalizeInlineCodeFences from breaking adjacent fenced code blocks ([#903](https://github.com/siteboon/claudecodeui/issues/903)) ([4712431](https://github.com/siteboon/claudecodeui/commit/4712431be81718dfb559ef43d7d7d5315bf4e01a))
* **chat:** sort messages appropriately ([123ae31](https://github.com/siteboon/claudecodeui/commit/123ae310207fe5969c3b313f62b9dee27e5d7489))
* **claude-sync:** skip subagent transcripts to prevent main session corruption ([#854](https://github.com/siteboon/claudecodeui/issues/854)) ([a12ca8e](https://github.com/siteboon/claudecodeui/commit/a12ca8eed373ef56cd37fbdd097845eaab34dee9))
* correct notification session id ([881e72d](https://github.com/siteboon/claudecodeui/commit/881e72d4a00ec9c1a5e1ae4799bffa900f27c1f8))
* create one unified function for frontend session processing ([677d330](https://github.com/siteboon/claudecodeui/commit/677d330981ef29a856f09e62b9f69bac0fa580d4))
* **i18n:** add missing sidebar message keys to all locales ([#896](https://github.com/siteboon/claudecodeui/issues/896)) ([7ca3556](https://github.com/siteboon/claudecodeui/commit/7ca355651f0a805965bc27af3d75def626c5fb96))
* keep running-session polling active ([39b0473](https://github.com/siteboon/claudecodeui/commit/39b0473e38201c29ff1e5388946452d2eed44527))
* normalize project session payloads ([d0adddb](https://github.com/siteboon/claudecodeui/commit/d0adddbbdafecfd5713a8ac5b95c87a8f7fc54f8))
* **opencode:** bind watcher sessions to app rows early ([5b9adbb](https://github.com/siteboon/claudecodeui/commit/5b9adbbdee8561439a27ad90744388225823427b))
* **opencode:** pass workspace dir explicitly ([416a737](https://github.com/siteboon/claudecodeui/commit/416a737d76e654d2fc649206c2b921a7db150775))
* recover pending permission requests ([56b2e14](https://github.com/siteboon/claudecodeui/commit/56b2e1405967c50301d0c773567349763edc8560))
* remove provider specific token usage calculator ([2abb456](https://github.com/siteboon/claudecodeui/commit/2abb45636b5e1109733cfa58c8ab92fd4c812165))
* resolve session provider on backend reads ([9fb2d91](https://github.com/siteboon/claudecodeui/commit/9fb2d91b26bef9579337d953a29718802c466fed))
* **sessions:** canonicalize sidebar ids and timestamps ([3bbb42c](https://github.com/siteboon/claudecodeui/commit/3bbb42c23324c3cbb5587f2bcab09b1dc23086a8))
* **shell:** prioritize user npm binaries ([#913](https://github.com/siteboon/claudecodeui/issues/913)) ([4a503b1](https://github.com/siteboon/claudecodeui/commit/4a503b1dc87ff58821670c8bfb1d8a8c1dab2bcf))
* **shell:** use correct session id ([89f0524](https://github.com/siteboon/claudecodeui/commit/89f05247eddec4fe53bd1616c6a5563e3ae2427a))
* **sidebar:** align session status controls across layouts ([1b336e9](https://github.com/siteboon/claudecodeui/commit/1b336e9aa9d2cccf0676d852815d9ba613ac04d2))
* upgrade gemini logo ([9cb2afd](https://github.com/siteboon/claudecodeui/commit/9cb2afd67eb25a4f869b88abcf86f7748b2b6d71))
* voice tts format settings ([#919](https://github.com/siteboon/claudecodeui/issues/919)) ([591e8e7](https://github.com/siteboon/claudecodeui/commit/591e8e7642589b0584f9b29b46b881aaab54624e))

### Documentation

* update available plugin readmes ([f549bd9](https://github.com/siteboon/claudecodeui/commit/f549bd99e7106362a27cf4ccee6e9d434b8b5363))
* update session activity guard comment ([e23e6af](https://github.com/siteboon/claudecodeui/commit/e23e6af06a44cc4b016df5778984602d49e52629))

### Maintenance

* add github issues board plugin ([21b0f14](https://github.com/siteboon/claudecodeui/commit/21b0f14e7a86f257c65484742c43b9f85152b32c))
* add more plugins list ([bc34085](https://github.com/siteboon/claudecodeui/commit/bc34085af9912da8d8592881a5845cff84a53f7d))
* move tests to appropriate folder ([d7a38a5](https://github.com/siteboon/claudecodeui/commit/d7a38a567a5e9039935353a886310b3c32b25a79))
* move tests to appropriate folder ([c6c153e](https://github.com/siteboon/claudecodeui/commit/c6c153e7f2a60572b08d687b59f010b4ad4f5d72))
* remove a log ([00e526b](https://github.com/siteboon/claudecodeui/commit/00e526b6e90ee0baf09ebf48873bc10824ab80ba))
* remove unused modelConstants from the project ([92de0ed](https://github.com/siteboon/claudecodeui/commit/92de0ed6137bf4571056deb3b930cc9fd22e2a08))
* upgrade gemini models ([3d94821](https://github.com/siteboon/claudecodeui/commit/3d948217ef3084e764171ebc5dda55f663150b2c))

## [](https://github.com/siteboon/claudecodeui/compare/v1.33.3...vnull) (2026-06-09)

### New Features

* adding Fable 5 in claude code ([ce327b6](https://github.com/siteboon/claudecodeui/commit/ce327b6fa9329aa3e9a3a1da7225ca01d3b06ac5))

## [1.33.3](https://github.com/siteboon/claudecodeui/compare/v1.33.2...v1.33.3) (2026-06-09)

### New Features

* add file tree upload progress ([c235b05](https://github.com/siteboon/claudecodeui/commit/c235b05e1d3b626667dba4043b685512e3cd3d5d))
* signal when chat runs complete ([d70dc07](https://github.com/siteboon/claudecodeui/commit/d70dc077bfbbfcf2ff4fa5514fabf7b4485861fa))

### Bug Fixes

* address notification review feedback ([602e6ad](https://github.com/siteboon/claudecodeui/commit/602e6ad4acba612a7ea66fb3bc7485054f5675ee))
* align prism plugin name and id with manifest.json ([ca8fd0e](https://github.com/siteboon/claudecodeui/commit/ca8fd0ee235b6a3210157bd0d9af83024d4a2248))
* **chat:** re-anchor initial scroll across lazy content reflow ([33a4e72](https://github.com/siteboon/claudecodeui/commit/33a4e72ca4f84df60aadfc4ff3f3467d6f5ae948))
* keep editor toolbar in view on long unwrapped lines ([beae8c6](https://github.com/siteboon/claudecodeui/commit/beae8c6513daa7518b9de40d8bfde3bf08e7bc87))
* **sandbox:** prevent server SIGHUP on sbx exec exit ([#792](https://github.com/siteboon/claudecodeui/issues/792)) ([f4a1614](https://github.com/siteboon/claudecodeui/commit/f4a1614a0a4ab4b65e8368d5e4221f015cb7555d)), closes [#791](https://github.com/siteboon/claudecodeui/issues/791)
* slash command suggestions trigger at any / in input, not only at start ([#843](https://github.com/siteboon/claudecodeui/issues/843)) ([f7c0024](https://github.com/siteboon/claudecodeui/commit/f7c0024fe15057ad049c71e15e88adb482a4497f))
* update naming convention ([3cd8995](https://github.com/siteboon/claudecodeui/commit/3cd89956ba06f0fc3e17d349b0c50baab4012658))

### Maintenance

* add prism plugin ([01dbe2a](https://github.com/siteboon/claudecodeui/commit/01dbe2a8bfcb3b265995f01f905b218d5f576f7b))

## [1.33.2](https://github.com/siteboon/claudecodeui/compare/v1.33.1...v1.33.2) (2026-06-08)

### New Features

* **chat:** open cost modal from token usage ([f238050](https://github.com/siteboon/claudecodeui/commit/f238050b85c3b99a702a8635059735e1a3b3a4f4))
* **i18n:** add Traditional Chinese (zh-TW) locale ([#773](https://github.com/siteboon/claudecodeui/issues/773)) ([c21a9f4](https://github.com/siteboon/claudecodeui/commit/c21a9f45610eb1eeb650d8e6cf8650e798f77f6f))

### Bug Fixes

* do not show model description in chat view ([d638a89](https://github.com/siteboon/claudecodeui/commit/d638a8982c7f75b08fc7f65f01d6d54989c790d1))
* include Claude cache tokens in usage ([ed9cdf0](https://github.com/siteboon/claudecodeui/commit/ed9cdf01145fa0d063580bb76d30cfa7ee67af86))

## [1.33.1](https://github.com/siteboon/claudecodeui/compare/v1.33.0...v1.33.1) (2026-06-05)

### New Features

* **chat:** auto-detect text direction for RTL languages ([#729](https://github.com/siteboon/claudecodeui/issues/729)) ([fa9eaf5](https://github.com/siteboon/claudecodeui/commit/fa9eaf5573a6f870a19fb62ab430ffd87c466582))

### Bug Fixes

* file tree concurrency ([#828](https://github.com/siteboon/claudecodeui/issues/828)) ([ebb0e59](https://github.com/siteboon/claudecodeui/commit/ebb0e59e8023c0a8040d168a5adffb7102e80561))
* load claude models directly from provider ([cdcac18](https://github.com/siteboon/claudecodeui/commit/cdcac182d458a24908777568979c8e756f94428c))
* plugin svg icon sanitization ([#817](https://github.com/siteboon/claudecodeui/issues/817)) ([d9e9df1](https://github.com/siteboon/claudecodeui/commit/d9e9df183f462c88c3b60975eb8254faa9168717))
* recognize claude auth token env ([#818](https://github.com/siteboon/claudecodeui/issues/818)) ([43c33d5](https://github.com/siteboon/claudecodeui/commit/43c33d5cb1b41835dfe3bccd450c5a9c2441509b))
* redact websocket auth token in logs ([#827](https://github.com/siteboon/claudecodeui/issues/827)) ([14ddbc7](https://github.com/siteboon/claudecodeui/commit/14ddbc7c57a01da9fb65fd87d8588532b11833fa))
* remove thinking mode ([#835](https://github.com/siteboon/claudecodeui/issues/835)) ([2149b87](https://github.com/siteboon/claudecodeui/commit/2149b8776b7ebfec0eace413f4fc527ccb2324c0))
* **shell:** disconnect and restart buttons ([#831](https://github.com/siteboon/claudecodeui/issues/831)) ([ef2fd48](https://github.com/siteboon/claudecodeui/commit/ef2fd48b46452d4b9e2bf1f5e3c30fafe19f27f2))
* show Claude tool result errors ([bb8db58](https://github.com/siteboon/claudecodeui/commit/bb8db5815c2d20ee4fbfa02d14c886a56ef352e0))
* **vite:** proxy /plugin-ws WebSocket requests to the backend in dev ([#757](https://github.com/siteboon/claudecodeui/issues/757)) ([96b16b4](https://github.com/siteboon/claudecodeui/commit/96b16b42e4f807d04ec743a5a4117a37a3f5e0d9))
* **websocket:** add 30s server-side heartbeat to prevent proxy idle disconnects ([#770](https://github.com/siteboon/claudecodeui/issues/770)) ([2edfef2](https://github.com/siteboon/claudecodeui/commit/2edfef2e3f4271c29ae8670df9dd382a9eef7c3c)), closes [#769](https://github.com/siteboon/claudecodeui/issues/769)
* **websocket:** reset unmountedRef on each effect re-run so token refresh reconnects ([#721](https://github.com/siteboon/claudecodeui/issues/721)) ([f082cdc](https://github.com/siteboon/claudecodeui/commit/f082cdc63bd0de90f8b3da1df6071e91ab545831))

### Documentation

* add nginx subpath deployment template ([#820](https://github.com/siteboon/claudecodeui/issues/820)) ([3ec76b5](https://github.com/siteboon/claudecodeui/commit/3ec76b5bb15a13cec41056f4c9b9c425195022fa))

### Maintenance

* update Claude fallback models ([94785bf](https://github.com/siteboon/claudecodeui/commit/94785bfa579d1f39a2bee0f9dd0f09fd0243bc79))
* update package-lock.json ([c90b341](https://github.com/siteboon/claudecodeui/commit/c90b34108e86a3effdb5c6979ea7b1692d2b9da0))

## [](https://github.com/siteboon/claudecodeui/compare/v1.32.0...vnull) (2026-06-01)

### New Features

* add opencode support ([#762](https://github.com/siteboon/claudecodeui/issues/762)) ([374e9de](https://github.com/siteboon/claudecodeui/commit/374e9de71934c41ce2c19c796e35a19234b240ec))
* **sidebar:** tooltip for the active-session indicator dot ([#782](https://github.com/siteboon/claudecodeui/issues/782)) ([27e509a](https://github.com/siteboon/claudecodeui/commit/27e509a9b8bb25c35ae0abbda44c536e15c332c8))

### Bug Fixes

* **chat:** prevent double send on mobile by removing redundant submit handlers ([#719](https://github.com/siteboon/claudecodeui/issues/719)) ([dbc41dc](https://github.com/siteboon/claudecodeui/commit/dbc41dc91dbf1fb54f92f5536d64646b4e924f31))
* preserve WebSocket frame type in plugin proxy ([#594](https://github.com/siteboon/claudecodeui/issues/594)) ([36b860e](https://github.com/siteboon/claudecodeui/commit/36b860e322454df62ebf5309018590b596e6b913)), closes [CoderLuii/HolyClaude#11](https://github.com/CoderLuii/HolyClaude/issues/11)
* refine token usage reporting ([#807](https://github.com/siteboon/claudecodeui/issues/807)) ([38bf21d](https://github.com/siteboon/claudecodeui/commit/38bf21ddf554ed28676d86b5221c25adf6f07afd))
* refresh Claude auth status after login flow ([#617](https://github.com/siteboon/claudecodeui/issues/617)) ([1e125f3](https://github.com/siteboon/claudecodeui/commit/1e125f3db5248399cd50dc3d40b1f8f44cf7ccb6))
* **sidebar:** keep session rename input visible while editing ([#781](https://github.com/siteboon/claudecodeui/issues/781)) ([951f587](https://github.com/siteboon/claudecodeui/commit/951f58751c152fbbb3f8b3ce3c814c06c061de18))

### Styling

* fix project star button location by replacing folder icon ([#793](https://github.com/siteboon/claudecodeui/issues/793)) ([295bad9](https://github.com/siteboon/claudecodeui/commit/295bad9c006b669878cbf52940794f29f7370178))

## [1.32.0](https://github.com/siteboon/claudecodeui/compare/v1.31.5...v1.32.0) (2026-05-13)

### Bug Fixes

* add clarification on auto mode ([392c73b](https://github.com/siteboon/claudecodeui/commit/392c73b6933600ea8a589c5d4eff5f7b830f99c5))
* enhance regex to correctly parse wrapper file paths for claude.exe ([#741](https://github.com/siteboon/claudecodeui/issues/741)) ([beb0a50](https://github.com/siteboon/claudecodeui/commit/beb0a50413beddfb16f6b49103e1b6b80567cb90))

## [1.31.5](https://github.com/siteboon/claudecodeui/compare/v1.31.4...v1.31.5) (2026-04-30)

### New Features

* add auto mode to claude code ([3f71d49](https://github.com/siteboon/claudecodeui/commit/3f71d4932b05dfedcdf816e2a3d7d0cd69c4f566))

## [1.31.4](https://github.com/siteboon/claudecodeui/compare/v1.31.3...v1.31.4) (2026-04-30)

### Bug Fixes

* bump codex sdk to latest version ([658421c](https://github.com/siteboon/claudecodeui/commit/658421c1c44ec4eb58b69ec7b1844a9fba11a3f3))

## [1.31.3](https://github.com/siteboon/claudecodeui/compare/v1.31.2...v1.31.3) (2026-04-30)

## [1.31.2](https://github.com/siteboon/claudecodeui/compare/v1.31.0...v1.31.2) (2026-04-30)

### Bug Fixes

* migrations for new sqlite schema ([0753c04](https://github.com/siteboon/claudecodeui/commit/0753c047837dab17b86ae4453027e30b465870f8))

## [1.31.0](https://github.com/siteboon/claudecodeui/compare/v1.30.0...v1.31.0) (2026-04-30)

### Bug Fixes

* **/status:** use CLAUDE_MODELS.DEFAULT instead of stale 'claude-sonnet-4.5' fallback ([#723](https://github.com/siteboon/claudecodeui/issues/723)) ([b4a39c7](https://github.com/siteboon/claudecodeui/commit/b4a39c729710a6294c62eb742e99e05f3e3914e9))

## [1.30.0](https://github.com/siteboon/claudecodeui/compare/v1.29.5...v1.30.0) (2026-04-21)

### New Features

* **i18n:** add Italian language support ([#677](https://github.com/siteboon/claudecodeui/issues/677)) ([86b6545](https://github.com/siteboon/claudecodeui/commit/86b6545c3505475ac2de0cec75cc8f86ab22aceb))
* **i18n:** add Turkish (tr) language support ([#678](https://github.com/siteboon/claudecodeui/issues/678)) ([89b754d](https://github.com/siteboon/claudecodeui/commit/89b754d186b68f3df8aa439a2d535644406066f0)), closes [#384](https://github.com/siteboon/claudecodeui/issues/384) [#514](https://github.com/siteboon/claudecodeui/issues/514) [#525](https://github.com/siteboon/claudecodeui/issues/525) [#534](https://github.com/siteboon/claudecodeui/issues/534)
* introduce opus 4.7 ([#682](https://github.com/siteboon/claudecodeui/issues/682)) ([c5e55ad](https://github.com/siteboon/claudecodeui/commit/c5e55adc89d0316675f90a927aa40d115958ae9f))

### Bug Fixes

* iOS scrolling main chat area ([3969135](https://github.com/siteboon/claudecodeui/commit/3969135bd427fbf48f29bb3dbfedb47791ca78dc))
* migrate PlanDisplay raw params from native details to Collapsible primitive ([fc3504e](https://github.com/siteboon/claudecodeui/commit/fc3504eaed8ca7ed9214838d148ea385b8352c31))
* precise Claude SDK denial message detection in deriveToolStatus ([09dcea0](https://github.com/siteboon/claudecodeui/commit/09dcea05fbc8c208d931aa1f08618f0e8087392f))
* reduce size of permission mode button tap target and provider selector on  mobile ([457ca0d](https://github.com/siteboon/claudecodeui/commit/457ca0daabcaa8397f4375ee8aa2671336b648ff))
* small mobile respnosive fixes ([25820ed](https://github.com/siteboon/claudecodeui/commit/25820ed995c1b813b1f9ed073097b08eb1d902ec))
* small mobile respnosive fixes ([c471b5d](https://github.com/siteboon/claudecodeui/commit/c471b5d3fa6ce1968adb4cf87a15ac0e18febd20))

### Refactoring

* add primitives, plan mode display, and new session model selector ([7763e60](https://github.com/siteboon/claudecodeui/commit/7763e60fb32e34742058c055c57664a503a34d1d))
* chat composer new design ([5758bee](https://github.com/siteboon/claudecodeui/commit/5758bee8a038ed50073dba882108617959dda82c))
* queue primitive, tool status badges, and tool display cleanup ([ec0ff97](https://github.com/siteboon/claudecodeui/commit/ec0ff974cba213a1100b2a071b8ba533e812fe82))

### Maintenance

* add docker sandbox action ([fa5a238](https://github.com/siteboon/claudecodeui/commit/fa5a23897c086bcacf1cf5d926c650f98a0f2222))

## [1.29.5](https://github.com/siteboon/claudecodeui/compare/v1.29.4...v1.29.5) (2026-04-16)

### Bug Fixes

* update node-pty to latest version ([6a13e17](https://github.com/siteboon/claudecodeui/commit/6a13e1773b145049ade512aa6e5cac21c2e5c4de))

## [1.29.4](https://github.com/siteboon/claudecodeui/compare/v1.29.3...v1.29.4) (2026-04-16)

### New Features

* deleting from sidebar will now ask whether to remove all data as well ([e9c7a50](https://github.com/siteboon/claudecodeui/commit/e9c7a5041c31a6f7b2032f06abe19c52d3d4cd8c))

### Bug Fixes

* pass pathToClaudeCodeExecutable to SDK when CLAUDE_CLI_PATH is set ([4c106a5](https://github.com/siteboon/claudecodeui/commit/4c106a5083d90989bbeedaefdbb68f5b3fa6fd58)), closes [#468](https://github.com/siteboon/claudecodeui/issues/468)

### Refactoring

* remove the sqlite3 dependency ([2895208](https://github.com/siteboon/claudecodeui/commit/289520814cf3ca36403056739ef22021f78c6033))
* **server:** extract URL detection and color utils from index.js ([#657](https://github.com/siteboon/claudecodeui/issues/657)) ([63e996b](https://github.com/siteboon/claudecodeui/commit/63e996bb77cfa97b1f55f6bdccc50161a75a3eee))

### Maintenance

* upgrade commit lint to 20.5.0 ([0948601](https://github.com/siteboon/claudecodeui/commit/09486016e67d97358c228ebc6eb4502ccb0012e4))

## [1.29.3](https://github.com/siteboon/claudecodeui/compare/v1.29.2...v1.29.3) (2026-04-15)

### Bug Fixes

* **version-upgrade-modal:** implement reload countdown and update UI messages ([#655](https://github.com/siteboon/claudecodeui/issues/655)) ([6413042](https://github.com/siteboon/claudecodeui/commit/641304242d7705b54aab65faa4a7673438c92c60))

### Maintenance

* remove unused route (migrated to providers already) ([31f28a2](https://github.com/siteboon/claudecodeui/commit/31f28a2c183f6ead50941027632d7ab64b7bb2d4))

## [1.29.2](https://github.com/siteboon/claudecodeui/compare/v1.29.1...v1.29.2) (2026-04-14)

### Bug Fixes

* **sandbox:** use backgrounded sbx run to keep sandbox  alive ([9b11c03](https://github.com/siteboon/claudecodeui/commit/9b11c034d9a19710a23b56c62dcf07c21a17bd97))

## [1.29.1](https://github.com/siteboon/claudecodeui/compare/v1.29.0...v1.29.1) (2026-04-14)

### Bug Fixes

* add latest tag to docker npx command and change the detach mode to work without spawn ([4a56972](https://github.com/siteboon/claudecodeui/commit/4a569725dae320a505753359d8edfd8ca79f0fd7))

## [1.29.0](https://github.com/siteboon/claudecodeui/compare/v1.28.1...v1.29.0) (2026-04-14)

### New Features

* adding docker sandbox environments ([13e97e2](https://github.com/siteboon/claudecodeui/commit/13e97e2c71254de7a60afb5495b21064c4bc4241))

### Bug Fixes

* **thinking-mode:** fix dropdown positioning ([#646](https://github.com/siteboon/claudecodeui/issues/646)) ([c7a5baf](https://github.com/siteboon/claudecodeui/commit/c7a5baf1479404bd40e23aa58bd9f677df9a04c6))

### Maintenance

* update release flow node version ([e2459cb](https://github.com/siteboon/claudecodeui/commit/e2459cb0f8b35f54827778a7b444e6c3ca326506))

## [1.28.1](https://github.com/siteboon/claudecodeui/compare/v1.28.0...v1.28.1) (2026-04-10)

### New Features

* add branding, community links, GitHub star badge, and About settings tab ([2207d05](https://github.com/siteboon/claudecodeui/commit/2207d05c1ca229214aa9c2e2c9f4d0827d421574))

### Bug Fixes

* corrupted binary downloads ([#634](https://github.com/siteboon/claudecodeui/issues/634)) ([e61f8a5](https://github.com/siteboon/claudecodeui/commit/e61f8a543d63fe7c24a04b3d2186085a06dcbcdb))
* **ui:** remove mobile bottom nav, unify processing indicator, and improve tooltip behavior on mobile ([#632](https://github.com/siteboon/claudecodeui/issues/632)) ([a8dab0e](https://github.com/siteboon/claudecodeui/commit/a8dab0edcf949ae610820bae9500c433781f7c73))

### Refactoring

* remove unused whispher transcribe logic ([#637](https://github.com/siteboon/claudecodeui/issues/637)) ([590dd42](https://github.com/siteboon/claudecodeui/commit/590dd42649424ab990353fcf59ce0965036d3d25))

## [1.28.0](https://github.com/siteboon/claudecodeui/compare/v1.27.1...v1.28.0) (2026-04-03)

### New Features

* adding session resume in the api ([8f1042c](https://github.com/siteboon/claudecodeui/commit/8f1042cf256be282f009adcceeb55ab2dddf3fba))
* moving new session button higher ([1628868](https://github.com/siteboon/claudecodeui/commit/16288684702dec894cf054291ca3d545ddb8214b))

### Maintenance

* changing package name to @cloudcli-ai/cloudcli ([ef51de2](https://github.com/siteboon/claudecodeui/commit/ef51de259ea2b963bc15f058b084e11220bc216a))

## [1.27.1](https://github.com/siteboon/claudecodeui/compare/v1.26.3...v1.27.1) (2026-03-29)

### Bug Fixes

* prevent split on undefined（[#491](https://github.com/siteboon/claudecodeui/issues/491)） ([#563](https://github.com/siteboon/claudecodeui/issues/563)) ([b54cdf8](https://github.com/siteboon/claudecodeui/commit/b54cdf8168fc224e9907796e4229ae8ed34e6885))

### Maintenance

* add release-it github action ([42a1313](https://github.com/siteboon/claudecodeui/commit/42a131389a6954df0d2c3bedd2cb6d3406c5ebc1))
* add terminal plugin in the plugins list ([004135e](https://github.com/siteboon/claudecodeui/commit/004135ef0187023e1da29c4a7137a28a42ebf9af))
* release tokens ([f1063fd](https://github.com/siteboon/claudecodeui/commit/f1063fd33964ccb517f5ebcdd14526ed162e1138))
* relicense to AGPL-3.0-or-later ([27cd124](https://github.com/siteboon/claudecodeui/commit/27cd12432b7d3237981f86acd9cc99532d843d4a))

## [1.26.3](https://github.com/siteboon/claudecodeui/compare/v1.26.2...v1.26.3) (2026-03-22)

## [1.26.2](https://github.com/siteboon/claudecodeui/compare/v1.26.0...v1.26.2) (2026-03-21)

### Bug Fixes

* change SW cache mechanism ([17d6ec5](https://github.com/siteboon/claudecodeui/commit/17d6ec54af18d333c8b04d2ffc64793e688d996e))
* claude auth changes and adding copy on mobile ([a41d2c7](https://github.com/siteboon/claudecodeui/commit/a41d2c713e87d56f23d5884585b4bb43c43a250a))

## [1.26.0](https://github.com/siteboon/claudecodeui/compare/v1.25.2...v1.26.0) (2026-03-20)

### New Features

* add German (Deutsch) language support ([#525](https://github.com/siteboon/claudecodeui/issues/525)) ([a7299c6](https://github.com/siteboon/claudecodeui/commit/a7299c68237908c752d504c2e8eea91570a30203))
* add WebSocket proxy for plugin backends ([#553](https://github.com/siteboon/claudecodeui/issues/553)) ([88c60b7](https://github.com/siteboon/claudecodeui/commit/88c60b70b031798d51ce26c8f080a0f64d824b05))
* Browser autofill support for login form ([#521](https://github.com/siteboon/claudecodeui/issues/521)) ([72ff134](https://github.com/siteboon/claudecodeui/commit/72ff134b315b7a1d602f3cc7dd60d47c1c1c34af))
* git panel redesign ([#535](https://github.com/siteboon/claudecodeui/issues/535)) ([adb3a06](https://github.com/siteboon/claudecodeui/commit/adb3a06d7e66a6d2dbcdfb501615e617178314af))
* introduce notification system and claude notifications ([#450](https://github.com/siteboon/claudecodeui/issues/450)) ([45e71a0](https://github.com/siteboon/claudecodeui/commit/45e71a0e73b368309544165e4dcf8b7fd014e8dd))
* **refactor:** move plugins to typescript ([#557](https://github.com/siteboon/claudecodeui/issues/557)) ([612390d](https://github.com/siteboon/claudecodeui/commit/612390db536417e2f68c501329bfccf5c6795e45))
* unified message architecture with provider adapters and session store ([#558](https://github.com/siteboon/claudecodeui/issues/558)) ([a4632dc](https://github.com/siteboon/claudecodeui/commit/a4632dc4cec228a8febb7c5bae4807c358963678))

### Bug Fixes

* detect Claude auth from settings env ([#527](https://github.com/siteboon/claudecodeui/issues/527)) ([95bcee0](https://github.com/siteboon/claudecodeui/commit/95bcee0ec459f186d52aeffe100ac1a024e92909))
* remove /exit command from claude login flow during onboarding ([#552](https://github.com/siteboon/claudecodeui/issues/552)) ([4de8b78](https://github.com/siteboon/claudecodeui/commit/4de8b78c6db5d8c2c402afce0f0b4cc16d5b6496))

### Documentation

* add German language link to all README files ([#534](https://github.com/siteboon/claudecodeui/issues/534)) ([1d31c3e](https://github.com/siteboon/claudecodeui/commit/1d31c3ec8309b433a041f3099955addc8c136c35))
* **readme:** hotfix and improve for README.jp.md ([#550](https://github.com/siteboon/claudecodeui/issues/550)) ([7413c2c](https://github.com/siteboon/claudecodeui/commit/7413c2c78422c308ac949e6a83c3e9216b24b649))
* **README:** update translations with CloudCLI branding and feature restructuring ([#544](https://github.com/siteboon/claudecodeui/issues/544)) ([14aef73](https://github.com/siteboon/claudecodeui/commit/14aef73cc6085fbb519fe64aea7cac80b7d51285))

## [1.25.2](https://github.com/siteboon/claudecodeui/compare/v1.25.0...v1.25.2) (2026-03-11)

### New Features

* **i18n:** localize plugin settings for all languages ([#515](https://github.com/siteboon/claudecodeui/issues/515)) ([621853c](https://github.com/siteboon/claudecodeui/commit/621853cbfb4233b34cb8cc2e1ed10917ba424352))

### Bug Fixes

* codeql user value provided path validation ([aaa14b9](https://github.com/siteboon/claudecodeui/commit/aaa14b9fc0b9b51c4fb9d1dba40fada7cbbe0356))
* numerous bugs ([#528](https://github.com/siteboon/claudecodeui/issues/528)) ([a77f213](https://github.com/siteboon/claudecodeui/commit/a77f213dd5d0b2538dea091ab8da6e55d2002f2f))
* **security:** disable executable gray-matter frontmatter in commands ([b9c902b](https://github.com/siteboon/claudecodeui/commit/b9c902b016f411a942c8707dd07d32b60bad087c))
* session reconnect catch-up, always-on input, frozen session recovery ([#524](https://github.com/siteboon/claudecodeui/issues/524)) ([4d8fb6e](https://github.com/siteboon/claudecodeui/commit/4d8fb6e30aa03d7cdb92bd62b7709422f9d08e32))

### Refactoring

* new settings page design and new pill component ([8ddeeb0](https://github.com/siteboon/claudecodeui/commit/8ddeeb0ce8d0642560bd3fa149236011dc6e3707))

## [1.25.0](https://github.com/siteboon/claudecodeui/compare/v1.24.0...v1.25.0) (2026-03-10)

### New Features

* add copy as text or markdown feature for assistant messages ([#519](https://github.com/siteboon/claudecodeui/issues/519)) ([1dc2a20](https://github.com/siteboon/claudecodeui/commit/1dc2a205dc2a3cbf960625d7669c7c63a2b6905f))
* add full Russian language support; update Readme.md files, and .gitignore update ([#514](https://github.com/siteboon/claudecodeui/issues/514)) ([c7dcba8](https://github.com/siteboon/claudecodeui/commit/c7dcba8d9117e84db8aac7d8a7bf6a3aa683e115))
* new plugin system ([#489](https://github.com/siteboon/claudecodeui/issues/489)) ([8afb46a](https://github.com/siteboon/claudecodeui/commit/8afb46af2e5514c9284030367281793fbb014e4f))

### Bug Fixes

* resolve duplicate key issue when rendering model options ([#520](https://github.com/siteboon/claudecodeui/issues/520)) ([9bceab9](https://github.com/siteboon/claudecodeui/commit/9bceab9e1a6e063b0b4f934ed2d9f854fcc9c6a4))

### Maintenance

* add plugins section in readme ([e581a0e](https://github.com/siteboon/claudecodeui/commit/e581a0e1ccd59fd7ec7306ca76a13e73d7c674c1))

## [1.24.0](https://github.com/siteboon/claudecodeui/compare/v1.23.2...v1.24.0) (2026-03-09)

### New Features

* add full-text search across conversations ([#482](https://github.com/siteboon/claudecodeui/issues/482)) ([3950c0e](https://github.com/siteboon/claudecodeui/commit/3950c0e47f41e93227af31494690818d45c8bc7a))

### Bug Fixes

* **git:** prevent shell injection in git routes ([86c33c1](https://github.com/siteboon/claudecodeui/commit/86c33c1c0cb34176725a38f46960213714fc3e04))
* replace getDatabase with better-sqlite3 db in getGithubTokenById ([#501](https://github.com/siteboon/claudecodeui/issues/501)) ([cb4fd79](https://github.com/siteboon/claudecodeui/commit/cb4fd795c938b1cc86d47f401973bfccdd68fdee))

## [1.23.2](https://github.com/siteboon/claudecodeui/compare/v1.22.1...v1.23.2) (2026-03-06)

### New Features

* add clickable overlay buttons for CLI prompts in Shell terminal ([#480](https://github.com/siteboon/claudecodeui/issues/480)) ([2444209](https://github.com/siteboon/claudecodeui/commit/2444209723701dda2b881cea2501b239e64e51c1)), closes [#427](https://github.com/siteboon/claudecodeui/issues/427)
* add terminal shortcuts panel for mobile ([#411](https://github.com/siteboon/claudecodeui/issues/411)) ([b0a3fdf](https://github.com/siteboon/claudecodeui/commit/b0a3fdf95ffdb961261194d10400267251e42f17))
* implement session rename with SQLite storage ([#413](https://github.com/siteboon/claudecodeui/issues/413)) ([198e3da](https://github.com/siteboon/claudecodeui/commit/198e3da89b353780f53a91888384da9118995e81)), closes [#72](https://github.com/siteboon/claudecodeui/issues/72) [#358](https://github.com/siteboon/claudecodeui/issues/358)

### Bug Fixes

* **chat:** finalize terminal lifecycle to prevent stuck processing/thinking UI ([#483](https://github.com/siteboon/claudecodeui/issues/483)) ([0590c5c](https://github.com/siteboon/claudecodeui/commit/0590c5c178f4791e2b039d525ecca4d220c3dcae))
* **codex-history:** prevent AGENTS.md/internal prompt leakage when reloading Codex sessions ([#488](https://github.com/siteboon/claudecodeui/issues/488)) ([64a96b2](https://github.com/siteboon/claudecodeui/commit/64a96b24f853acb802f700810b302f0f5cf00898))
* preserve pending permission requests across WebSocket reconnections ([#462](https://github.com/siteboon/claudecodeui/issues/462)) ([4ee88f0](https://github.com/siteboon/claudecodeui/commit/4ee88f0eb0c648b54b05f006c6796fb7b09b0fae))
* prevent React 18 batching from losing messages during session sync ([#461](https://github.com/siteboon/claudecodeui/issues/461)) ([688d734](https://github.com/siteboon/claudecodeui/commit/688d73477a50773e43c85addc96212aa6290aea5))
* release it script ([dcea8a3](https://github.com/siteboon/claudecodeui/commit/dcea8a329c7d68437e1e72c8c766cf33c74637e9))

### Styling

* improve UI for processing banner ([#477](https://github.com/siteboon/claudecodeui/issues/477)) ([2320e1d](https://github.com/siteboon/claudecodeui/commit/2320e1d74b59c65b5b7fc4fa8b05fd9208f4898c))

### Maintenance

* remove logging of received WebSocket messages in production ([#487](https://github.com/siteboon/claudecodeui/issues/487)) ([9193feb](https://github.com/siteboon/claudecodeui/commit/9193feb6dc83041f3c365204648a88468bdc001b))

## [1.22.0](https://github.com/siteboon/claudecodeui/compare/v1.21.0...v1.22.0) (2026-03-03)

### New Features

* add community button in the app ([84d4634](https://github.com/siteboon/claudecodeui/commit/84d4634735f9ee13ac1c20faa0e7e31f1b77cae8))
* Advanced file editor and file tree improvements ([#444](https://github.com/siteboon/claudecodeui/issues/444)) ([9768958](https://github.com/siteboon/claudecodeui/commit/97689588aa2e8240ba4373da5f42ab444c772e72))
* update document title based on selected project ([#448](https://github.com/siteboon/claudecodeui/issues/448)) ([9e22f42](https://github.com/siteboon/claudecodeui/commit/9e22f42a3d3a781f448ddac9d133292fe103bb8c))

### Bug Fixes

* **claude:** correct project encoded path ([#451](https://github.com/siteboon/claudecodeui/issues/451)) ([9c0e864](https://github.com/siteboon/claudecodeui/commit/9c0e864532dcc5ce7ee890d3b4db722872db2b54)), closes [#447](https://github.com/siteboon/claudecodeui/issues/447)
* **claude:** move model usage log to result message only ([#454](https://github.com/siteboon/claudecodeui/issues/454)) ([506d431](https://github.com/siteboon/claudecodeui/commit/506d43144b3ec3155c3e589e7e803862c4a8f83a))
* missing translation label ([855e22f](https://github.com/siteboon/claudecodeui/commit/855e22f9176a71daa51de716370af7f19d55bfb4))

### Maintenance

* add Gemini-CLI support to README ([#453](https://github.com/siteboon/claudecodeui/issues/453)) ([503c384](https://github.com/siteboon/claudecodeui/commit/503c3846850fb843781979b0c0e10a24b07e1a4b))

## [1.21.0](https://github.com/siteboon/claudecodeui/compare/v1.20.1...v1.21.0) (2026-02-27)

### New Features

* add copy icon for user messages ([#449](https://github.com/siteboon/claudecodeui/issues/449)) ([b359c51](https://github.com/siteboon/claudecodeui/commit/b359c515277b4266fde2fb9a29b5356949c07c4f))
* Google's gemini-cli integration ([#422](https://github.com/siteboon/claudecodeui/issues/422)) ([a367edd](https://github.com/siteboon/claudecodeui/commit/a367edd51578608b3281373cb4a95169dbf17f89))
* persist active tab across reloads via localStorage ([#414](https://github.com/siteboon/claudecodeui/issues/414)) ([e3b6892](https://github.com/siteboon/claudecodeui/commit/e3b689214f11d549ffe1b3a347476d58f25c5aca)), closes [#387](https://github.com/siteboon/claudecodeui/issues/387)

### Bug Fixes

* add support for Codex in the shell ([#424](https://github.com/siteboon/claudecodeui/issues/424)) ([23801e9](https://github.com/siteboon/claudecodeui/commit/23801e9cc15d2b8d1bfc6e39aee2fae93226d1ad))

### Maintenance

* upgrade @anthropic-ai/claude-agent-sdk to version 0.2.59 and add model usage logging ([#446](https://github.com/siteboon/claudecodeui/issues/446)) ([917c353](https://github.com/siteboon/claudecodeui/commit/917c353115653ee288bf97be01f62fad24123cbc))
* upgrade better-sqlite to latest version to support node 25 ([#445](https://github.com/siteboon/claudecodeui/issues/445)) ([4ab94fc](https://github.com/siteboon/claudecodeui/commit/4ab94fce4257e1e20370fa83fa4c0f6fadbb8a2b))

## [1.20.1](https://github.com/siteboon/claudecodeui/compare/v1.19.1...v1.20.1) (2026-02-23)

### New Features

* implement install mode detection and update commands in version upgrade process ([f986004](https://github.com/siteboon/claudecodeui/commit/f986004319207b068431f9f6adf338a8ce8decfc))
* migrate legacy database to new location and improve last login update handling ([50e097d](https://github.com/siteboon/claudecodeui/commit/50e097d4ac498aa9f1803ef3564843721833dc19))

## [1.19.1](https://github.com/siteboon/claudecodeui/compare/v1.19.0...v1.19.1) (2026-02-23)

### Bug Fixes

* add prepublishOnly script to build before publishing ([82efac4](https://github.com/siteboon/claudecodeui/commit/82efac4704cab11ed8d1a05fe84f41312140b223))

## [1.19.0](https://github.com/siteboon/claudecodeui/compare/v1.18.2...v1.19.0) (2026-02-23)

### New Features

* add HOST environment variable for configurable bind address ([#360](https://github.com/siteboon/claudecodeui/issues/360)) ([cccd915](https://github.com/siteboon/claudecodeui/commit/cccd915c336192216b6e6f68e2b5f3ece0ccf966))
* subagent tool grouping ([#398](https://github.com/siteboon/claudecodeui/issues/398)) ([0207a1f](https://github.com/siteboon/claudecodeui/commit/0207a1f3a3c87f1c6c1aee8213be999b23289386))

### Bug Fixes

* **macos:** fix node-pty posix_spawnp error with postinstall script ([#347](https://github.com/siteboon/claudecodeui/issues/347)) ([38a593c](https://github.com/siteboon/claudecodeui/commit/38a593c97fdb2bb7f051e09e8e99c16035448655)), closes [#284](https://github.com/siteboon/claudecodeui/issues/284)
* slash commands with arguments bypass command execution ([#392](https://github.com/siteboon/claudecodeui/issues/392)) ([597e9c5](https://github.com/siteboon/claudecodeui/commit/597e9c54b76e7c6cd1947299c668c78d24019cab))

### Refactoring

* **releases:** Create a contributing guide and proper release notes using a release-it plugin ([fc369d0](https://github.com/siteboon/claudecodeui/commit/fc369d047e13cba9443fe36c0b6bb2ce3beaf61c))

### Maintenance

* update @anthropic-ai/claude-agent-sdk to version 0.1.77 in package-lock.json ([#410](https://github.com/siteboon/claudecodeui/issues/410)) ([7ccbc8d](https://github.com/siteboon/claudecodeui/commit/7ccbc8d92d440e18c157b656c9ea2635044a64f6))
