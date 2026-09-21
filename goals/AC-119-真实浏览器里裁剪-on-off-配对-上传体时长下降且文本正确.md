---
id: AC-119
title: 真实浏览器里裁剪 on/off 配对：上传体时长下降且文本正确
status: active
kind: criterion
goal: GOAL-006
criterion: npx playwright test e2e/voice-trim.spec.ts -g "AC-119"
expect: 真实 Chromium 打真实后端 + Vite（playwright.config.ts 起，隔离 dataDir，每轮自取空闲端口）+
  假麦克风（--use-fake-device-for-media-stream 与 --use-file-for-fake-audio-capture
  必须同时给，缺前者则后者被忽略、设备改合成 beep）+ 与 AC-115 同形的识别器替身（本地 HTTP server 应答
  /audio/transcriptions）。同一 spec 内配对跑两次：?voiceTrim=off（不裁）与默认（裁），断言 (1)
  两次上传体都能解析出音频时长，且裁的那次严格更短；(2) 两次 composer 都持有识别器返回的文本；(3) 不裁那次的上传体时长 ≈ fixture
  时长 —— 证明「关」真的是不裁，而不是两次都失败成同一个值。⛔ 不得 stub 后端、不得 evaluate 改 store
  冒充转写；语音配置种入走既有约定（uiPreferences / user-preferences 镜像 + legacy
  voiceConfig），夹具播种必须在服务器启动前。取假形态：裁剪没接线（on == off）使 (1)
  红。当前必红：e2e/voice-trim.spec.ts 不存在（playwright 报 No tests found）。e2e
  只证明运输与时长，不证明识别质量 —— 假麦克风的音频是合成音，识别器是替身。
origin: 2026-09-21：本仓库「真实对象经机制实际运转」的落地要求；骨架复用 e2e/voice-identifier-repair.spec.ts。
activatedAt: 2026-09-21T15:17:59.998Z
---
