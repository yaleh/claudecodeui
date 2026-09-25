#!/usr/bin/env node
// resident-experiment.mjs — 阶段 0 实验台（E1–E8）。给 `docs/proposals/claude-resident-sessions.md`
// 的「验证方法 / 阶段 0」表取读数，结论写回 `docs/proposals/claude-resident-sessions-experiments.md`。
//
// 它是什么
// --------
// 一个**只取读数、不写产品代码**的算子工具。每个子命令跑一个实验，把**原始**读数（pid、时间戳、
// 流中出现的消息类型序列、请求体摘要、RSS 样本）追加进记录文件对应小节，结论单独一行。
//
// 真实链路，不是 mock 自证
// ------------------------
// 除 E7（真实模型）与 E2 的交互式那一半（tmux 里的交互式 CLI）外，一律用**真实 `claude` 二进制 +
// mock Anthropic 兼容端点**：端点按脚本返回 `tool_use` / `text`，工具在本地 CLI 里真实执行。做法照
// `server/modules/providers/tests/model-gateway-end-to-end.test.ts`。mock 端点在**请求体**里识别
// 请求用途（SDK 的标题请求也走同一个端点），不按 token 识别。
//
// 护栏（每条都是 `scripts/resident-experiment.test.mjs` 里的一个具名用例）
// ----------------------------------------------------------------------
//   1. 必须**显式**给出临时 `DATABASE_PATH`（`--database-path`），且它不得等于 shell 导出的
//      `DATABASE_PATH`（本机 shell 指向真实库 `/data/home/yale/.cloudcli/auth.db`），也不得落在
//      临时根之外。三条都拒绝运行——一次手滑就会往真实库写会话。
//   2. 端口不得是 3001（本机常驻服务在跑；重启它会杀掉托管本次会话的服务）。
//   3. `--check-record` 逐节检查记录文件：E1–E8 每节都要有 `读数：` 与 `结论：`，缺哪节点名哪节，
//      exit 1。
//
// 运行：
//   node scripts/resident-experiment.mjs e1 --database-path /tmp/resident-e1/auth.db [--record <file>]
//   node scripts/resident-experiment.mjs e7 --database-path <db> --hours 24
//   node scripts/resident-experiment.mjs --check-record docs/proposals/claude-resident-sessions-experiments.md
//
// 退出码：0 = 实验跑完且读数已写入；1 = 拒绝运行或检查未通过（原因在 stderr）；2 = 用法错误。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from '@anthropic-ai/claude-agent-sdk';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 记录文件里必须齐全的小节。`--check-record` 按这个数组逐节检查。 */
export const SECTION_IDS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'];

/** 小节标题（`## E<n> <标题>` 里的标题部分）。 */
/** @type {Record<string, string>} */
export const SECTION_TITLES = {
  E1: '常驻输入下 CronCreate 是否按时触发',
  E2: 'busy 时推入用户消息（stream-json 与交互式 CLI 两种形态）',
  E3: '无人轮进行中推入用户消息 / busy 时跨会话消息到达',
  E4: 'interrupt() 后进程与 cron 是否仍存活',
  E5: '服务进程被 kill 后常驻进程是否因 EOF 退出',
  E6: 'extraArgs.name 是否生效、是否接受中文与空格',
  E7: '长驻内存增长（≥24 小时浸泡）',
  E8: 'bypassPermissions 下 AskUserQuestion 走不走 canUseTool',
};

/** 本机常驻服务端口；实验一律避开它。 */
export const PROTECTED_PORT = 3001;

/** 记录文件默认位置。 */
export const DEFAULT_RECORD = path.join(ROOT, 'docs/proposals/claude-resident-sessions-experiments.md');

/** 护栏拒绝。带这个名字的错误一律 exit 1，并且不产生任何读数。 */
export class GuardRefusal extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GuardRefusal';
  }
}

// ---------------------------------------------------------------------------
// 护栏（纯函数，测试直接调用）
// ---------------------------------------------------------------------------

/**
 * 拒绝理由：`--database-path` 必须显式给出、必须落在临时根下、且不得等于环境里已有的
 * `DATABASE_PATH`。返回解析后的绝对路径。
 *
 * @param {{ databasePath: string | undefined, ambientDatabasePath?: string | undefined, tempRoot?: string }} input
 * @returns {string} 解析后的绝对路径
 */
export function assertIsolatedDatabasePath({ databasePath, ambientDatabasePath, tempRoot = os.tmpdir() }) {
  if (typeof databasePath !== 'string' || databasePath.trim() === '') {
    throw new GuardRefusal('拒绝运行：必须显式给出临时 DATABASE_PATH（--database-path <临时目录>/auth.db）');
  }
  const resolved = path.resolve(databasePath);
  if (typeof ambientDatabasePath === 'string' && ambientDatabasePath.trim() !== ''
    && resolved === path.resolve(ambientDatabasePath)) {
    throw new GuardRefusal(`拒绝运行：--database-path 等于 shell 导出的 DATABASE_PATH（${resolved}），那是真实库`);
  }
  const root = path.resolve(tempRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new GuardRefusal(`拒绝运行：--database-path（${resolved}）不在临时根 ${root} 下`);
  }
  return resolved;
}

/**
 * 拒绝占用受保护端口。
 * @param {number} port
 */
export function assertSafePort(port) {
  if (port === PROTECTED_PORT) {
    throw new GuardRefusal(`拒绝运行：端口 ${PROTECTED_PORT} 是本机常驻服务，实验一律避开`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new GuardRefusal(`拒绝运行：端口 ${port} 不在可用范围`);
  }
}

// ---------------------------------------------------------------------------
// 记录文件：解析与逐节检查
// ---------------------------------------------------------------------------

/**
 * 抽出某个小节的正文（从 `## E<n>` 到下一个 `## ` 或文件尾）。
 * @param {string} text
 * @param {string} id
 * @returns {string | null}
 */
export function extractSection(text, id) {
  const heading = new RegExp(`^##\\s+${id}\\b.*$`, 'm');
  const match = heading.exec(text);
  if (match === null) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = /^##\s+/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/**
 * 逐节检查：每节都要有 `读数：` 与 `结论：` 行。返回缺什么（空数组 = 齐全）。
 * @param {string} text
 * @returns {Array<{ id: string, reason: string }>}
 */
export function checkRecordText(text) {
  /** @type {Array<{ id: string, reason: string }>} */
  const missing = [];
  for (const id of SECTION_IDS) {
    const section = extractSection(text, id);
    if (section === null) {
      missing.push({ id, reason: '缺整个小节' });
      continue;
    }
    if (!/^读数：/m.test(section)) missing.push({ id, reason: '缺 `读数：` 行' });
    if (!/^结论：/m.test(section)) missing.push({ id, reason: '缺 `结论：` 行' });
  }
  return missing;
}

/**
 * 读文件后逐节检查。
 * @param {string} filePath
 * @returns {Array<{ id: string, reason: string }>}
 */
export function checkRecordFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return SECTION_IDS.map((id) => ({ id, reason: `记录文件不存在（${filePath}）` }));
  }
  return checkRecordText(fs.readFileSync(filePath, 'utf8'));
}

/**
 * 幂等写入小节：已存在同名 `## E<n>` 就整段替换，否则追加。这样重跑一个实验不会留两份。
 * @param {string} filePath
 * @param {string} id
 * @param {string} body
 */
export function upsertSection(filePath, id, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const heading = `## ${id} ${SECTION_TITLES[id] ?? ''}\n`;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : recordHeader();
  const match = new RegExp(`^##\\s+${id}\\b.*$`, 'm').exec(existing);
  let next;
  if (match === null) {
    next = `${existing.replace(/\s*$/, '')}\n\n${heading}${body.replace(/^\s+/, '')}\n`;
  } else {
    const rest = existing.slice(match.index);
    const nextHeading = /^##\s+/m.exec(rest.slice(match[0].length));
    const tail = nextHeading === null ? '' : rest.slice(match[0].length + nextHeading.index);
    const head = existing.slice(0, match.index);
    next = `${head}${heading}${body.replace(/^\s+/, '')}\n\n${tail}`;
  }
  fs.writeFileSync(filePath, next);
}

/** 记录文件表头。 */
function recordHeader() {
  return [
    '# Claude 常驻会话阶段 0 实验记录（E1–E8）',
    '',
    '本文件由 `scripts/resident-experiment.mjs` 写入：每节含**原始**读数（pid、时间戳、消息类型序列、',
    'RSS 样本）与一行结论。`node scripts/resident-experiment.mjs --check-record <本文件>` 逐节检查',
    '`读数：`/`结论：` 是否齐全。',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// mock Anthropic 兼容端点
// ---------------------------------------------------------------------------

/** @typedef {{ url: string, at: string, model?: string, lastUserText: string, lastIsToolResult: boolean, bytes: number, hasTools: boolean, respondedWith: string, toolResultNames: string[], toolResults: Array<{ id: string, isError: boolean, text: string }>, body: string }} MockRequest */

/** @param {Array<[string, unknown]>} events */
function sse(events) {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/**
 * 一段文本回复的 SSE 流。
 * @param {string} text
 */
export function textStream(text) {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * 一个 `tool_use` 回复的 SSE 流。工具在本地 CLI 里真实执行。
 * @param {string} id
 * @param {string} name
 * @param {unknown} input
 */
export function toolUseStream(id, name, input) {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * 起一个 mock Anthropic 兼容端点。`respond(request, index)` 返回这段 SSE；`/v1/messages` 之外的
 * 路径回 `{}`（SDK 会发一些非消息请求）。
 *
 * @param {(request: MockRequest, index: number) => string} respond
 * @returns {Promise<{ baseUrl: string, received: MockRequest[], close: () => Promise<void> }>}
 */
export async function startMockAnthropic(respond) {
  /** @type {MockRequest[]} */
  const received = [];
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      /** @type {any} */
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 非 JSON 请求 */ }
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const last = messages.length > 0 ? messages[messages.length - 1] : null;
      const lastUserText = JSON.stringify(last?.content ?? '').slice(0, 400);
      // 最新一条消息是不是工具结果？cron 触发的无人轮推入的是一条**纯文本**用户消息，
      // 而工具执行后的回炉请求最新一条是 tool_result——两者都含创建时的 prompt，只有这个标志能分开。
      const lastIsToolResult = Array.isArray(last?.content)
        && last.content.some((/** @type {any} */ block) => block?.type === 'tool_result');
      /** @type {string[]} */
      const toolResultNames = [];
      /**
       * 工具结果的**正文**。区分"工具被拒/报错"与"工具成功但副作用没发生"要靠它——
       * 只看请求数会把这两种完全不同的原因读成同一个 0。
       * @type {Array<{ id: string, isError: boolean, text: string }>}
       */
      const toolResults = [];
      for (const message of messages) {
        if (Array.isArray(message?.content)) {
          for (const block of message.content) {
            if (block?.type === 'tool_result') {
              toolResultNames.push(String(block.tool_use_id ?? ''));
              toolResults.push({
                id: String(block.tool_use_id ?? ''),
                isError: block.is_error === true,
                text: JSON.stringify(block.content ?? '').slice(0, 600),
              });
            }
          }
        }
      }
      const record = {
        url: req.url ?? '',
        at: new Date().toISOString(),
        model: typeof parsed?.model === 'string' ? parsed.model : undefined,
        lastUserText,
        lastIsToolResult,
        // 一轮开始时 CLI 会发不止一条请求：带 tools 的才是真正的 agent 轮，小的那条是别的
        // （标题/技能预检）。按序号或按"用户文本"发 tool_use 都可能发给错的那条。
        bytes: body.length,
        hasTools: body.includes('"tools"'),
        respondedWith: '',
        toolResultNames,
        toolResults,
        body,
      };
      received.push(record);
      if ((req.url ?? '').startsWith('/v1/messages')) {
        const index = received.filter((r) => r.url.startsWith('/v1/messages')).length - 1;
        const scripted = respond(record, index);
        // 这条请求实际拿到的是哪种回复？"按请求体识别"只有把结果记下来才可核对。
        record.respondedWith = /^__DELAY__/.test(scripted)
          ? `delay${/^__DELAY__(\d+)$/.exec(scripted)?.[1] ?? '?'}`
          : (scripted.includes('tool_use') ? `tool_use:${/"name":"([^"]+)"/.exec(scripted)?.[1] ?? '?'}` : 'text');
        // `__DELAY__<ms>` 让这一轮慢下来——"busy 时推入"这类实验需要一轮真的在进行中。
        const delayed = /^__DELAY__(\d+)$/.exec(scripted);
        if (delayed === null) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(scripted);
        } else {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(textStream('slow-turn-reply'));
          }, Number(delayed[1]));
        }
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new GuardRefusal('mock 端点未能拿到端口');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    received,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

// ---------------------------------------------------------------------------
// 常驻驱动：一个不结束的输入队列 + 贯穿进程生命周期的读取循环
// ---------------------------------------------------------------------------

/**
 * SDK `query()` 的输入队列。`push()` 推进一条用户消息，`close()` 关闭 stdin（CLI 正常退出）。
 */
export function createInputQueue() {
  /** @type {any[]} */
  const buffer = [];
  /** @type {Array<(r: IteratorResult<any>) => void>} */
  const waiters = [];
  let closed = false;
  return {
    /** @param {string} text */
    push(text) {
      if (closed) return;
      const message = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
      };
      const waiter = waiters.shift();
      if (waiter) waiter({ value: message, done: false });
      else buffer.push(message);
    },
    /** 关闭输入：CLI 读到 EOF 后正常退出。 */
    close() {
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter) waiter({ value: undefined, done: true });
      }
    },
    /** @returns {AsyncIterator<any>} */
    [Symbol.asyncIterator]() { return this; },
    /** @returns {Promise<IteratorResult<any>>} */
    next() {
      const buffered = buffer.shift();
      if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { waiters.push(resolve); });
    },
  };
}

/**
 * 起一个常驻进程并返回句柄。读数由调用方从 `messages` / `mock.received` 里取。
 *
 * `mockBaseUrl` 传 `null` 表示**用真实模型**：此时不改写 `ANTHROPIC_*`，沿用调用方的取值
 * （本机是 `ANTHROPIC_BASE_URL` 指向本地网关）。E7 按 proposal 要求走这条。
 *
 * @param {{ cwd: string, mockBaseUrl: string | null, configDir: string, databasePath: string, name?: string, permissionMode?: string, extraArgs?: Record<string, string | null>, canUseTool?: (toolName: string, input: unknown) => Promise<{ behavior: string, updatedInput?: unknown }> }} init
 */
export function startResident(init) {
  const input = createInputQueue();
  const abortController = new AbortController();
  /** @type {any[]} */
  const messages = [];
  const startedAt = new Date().toISOString();

  /** @type {Record<string, string | undefined>} */
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: init.configDir,
    DATABASE_PATH: init.databasePath,
  };
  if (init.mockBaseUrl === null) {
    // 真实模型：把 mock 专用的两个变量从继承来的环境里摘掉会改动真实端点，所以什么都不做。
    if (!env.ANTHROPIC_BASE_URL) throw new GuardRefusal('真实模型模式要求 ANTHROPIC_BASE_URL 已由调用方设置。');
  } else {
    env.ANTHROPIC_BASE_URL = init.mockBaseUrl;
    env.ANTHROPIC_AUTH_TOKEN = 'resident-experiment-token';
    delete env.ANTHROPIC_API_KEY;
  }

  // CLI 自己的 stderr。工具执行失败、参数被拒这类事只有它说得清；只看"请求数没涨"会把
  // "工具没执行"和"执行了但没触发"读成同一件事。
  /** @type {string[]} */
  const stderrLines = [];

  /** @type {any} */
  const options = {
    cwd: init.cwd,
    env,
    abortController,
    permissionMode: init.permissionMode ?? 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    stderr: (/** @type {string} */ chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== '') stderrLines.push(line.slice(0, 400));
      }
    },
    ...(init.canUseTool === undefined ? {} : { canUseTool: init.canUseTool }),
    ...(init.extraArgs === undefined ? {} : { extraArgs: init.extraArgs }),
  };

  const q = query({ prompt: input, options });
  /** @type {Promise<void>} */
  const loop = (async () => {
    try {
      for await (const message of q) {
        const raw = /** @type {any} */ (message);
        messages.push({ at: new Date().toISOString(), type: raw.type, subtype: raw.subtype ?? null, raw });
      }
    } catch (error) {
      const detail = /** @type {any} */ (error);
      messages.push({ at: new Date().toISOString(), type: 'error', subtype: null, raw: { message: String(detail?.message ?? detail) } });
    }
  })();

  return {
    input,
    query: q,
    messages,
    startedAt,
    loop,
    /** @returns {string[]} */
    types() { return messages.map((m) => (m.subtype ? `${m.type}/${m.subtype}` : m.type)); },
    /** CLI 的 stderr 原文（尾部若干行）。 */
    /** @param {number} [n] @returns {string[]} */
    stderrTail(n = 12) { return stderrLines.slice(-n); },
    /** 助手里出现的 tool_use 名（按顺序）——判断 tool_use 有没有真的到 CLI。 */
    /** @returns {string[]} */
    assistantToolNames() {
      /** @type {string[]} */
      const names = [];
      for (const m of messages) {
        const content = m.raw?.message?.content;
        if (m.type === 'assistant' && Array.isArray(content)) {
          for (const block of content) if (block?.type === 'tool_use') names.push(String(block.name ?? '?'));
        }
      }
      return names;
    },
    /** @param {string} text */
    send(text) { input.push(text); },
    async stop() {
      input.close();
      try { abortController.abort(); } catch { /* 已关闭 */ }
      await Promise.race([loop, delay(10_000)]);
    },
  };
}

// ---------------------------------------------------------------------------
// 进程与内存读数
// ---------------------------------------------------------------------------

/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 本进程的子孙里命令行含 `claude` 的 pid 列表（常驻进程就是其中之一）。
 * @param {number} rootPid
 * @returns {number[]}
 */
export function descendantClaudePids(rootPid) {
  /** @type {Map<number, number>} */
  const parentOf = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      parentOf.set(pid, Number(fields[1]));
    } catch { /* 进程已退出 */ }
  }
  /** @type {Set<number>} */
  const descendants = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, parent] of parentOf) {
      if (descendants.has(pid)) continue;
      if (parent === rootPid || descendants.has(parent)) { descendants.add(pid); grew = true; }
    }
  }
  /** @type {number[]} */
  const hits = [];
  for (const pid of descendants) {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmdline.includes('claude')) hits.push(pid);
    } catch { /* 进程已退出 */ }
  }
  return hits.sort((a, b) => a - b);
}

/**
 * 在**进程还活着的时候**取常驻 pid。`descendantClaudePids` 必须在运行中采样：等
 * `resident.stop()` 之后再采样，进程早已退出，读数会变成 `（无）`——那读的不是"没有常驻进程"，
 * 只是采样的时机错了。
 *
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<number[]>} 采到的 pid；超时返回空数组。
 */
export async function awaitClaudePid({ timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = descendantClaudePids(process.pid);
    if (pids.length > 0) return pids;
    if (Date.now() >= deadline) return [];
    await delay(intervalMs);
  }
}

/**
 * 读一个进程的 RSS（KB）。不存在的进程返回 null。
 * @param {number} pid
 * @returns {number | null}
 */
export function readRssKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** @param {number} pid */
export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 一个进程及其整棵子树的 RSS 合计（KB）。DoD 要求主进程与子树分开记。
 * @param {number} pid
 * @returns {{ tree: number, self: number | null, pids: number[] }}
 */
export function rssTree(pid) {
  /** @type {number[]} */
  const pids = [pid];
  for (const child of descendantClaudePids(pid)) pids.push(child);
  let tree = 0;
  for (const p of pids) {
    const kb = readRssKb(p);
    if (kb !== null) tree += kb;
  }
  return { tree, self: readRssKb(pid), pids };
}

/** 读 pid 的环境变量（核对 DATABASE_PATH 用）。 */
/** @param {number} pid */
export function readEnviron(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    /** @type {Record<string, string>} */
    const env = {};
    for (const pair of raw.split('\0')) {
      const eq = pair.indexOf('=');
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return env;
  } catch {
    return null;
  }
}

/**
 * 在临时配置目录的转录文件里找 `agent-name` / `custom-title` 记录。
 * ⛔ peer 名**不进** API 请求体，只落在这台机器本地的转录里——判定 `extraArgs.name` 是否生效
 * 必须读这个通道。"mock 收到的请求体里没有这个名字"是**观察错了通道**，不是"没生效"。
 * @param {string} configDir
 * @returns {{ path: string | null, agentName: string | null, customTitle: string | null }}
 */
export function readPeerNameFromTranscript(configDir) {
  const projectsDir = path.join(configDir, 'projects');
  if (!fs.existsSync(projectsDir)) return { path: null, agentName: null, customTitle: null };
  for (const slug of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, slug);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(dir, file);
      /** @type {string | null} */
      let agentName = null;
      /** @type {string | null} */
      let customTitle = null;
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          const rec = JSON.parse(line);
          if (rec?.type === 'agent-name' && typeof rec.agentName === 'string') agentName = rec.agentName;
          if (rec?.type === 'custom-title' && typeof rec.customTitle === 'string') customTitle = rec.customTitle;
        } catch { /* 尾部半行等坏行忽略 */ }
      }
      if (agentName !== null || customTitle !== null) return { path: full, agentName, customTitle };
    }
  }
  return { path: null, agentName: null, customTitle: null };
}

/**
 * 同一个 tool_result 会在后续每个请求的历史里重复出现；按"id + 文本"去重，读数里只留一份。
 * @param {Array<{ id: string, isError: boolean, text: string }>} results
 * @returns {Array<{ id: string, isError: boolean, text: string }>}
 */
export function dedupeToolResults(results) {
  /** @type {Map<string, { id: string, isError: boolean, text: string }>} */
  const unique = new Map();
  for (const item of results) unique.set(`${item.id}\u0000${item.text}`, item);
  return [...unique.values()];
}

/**
 * 常驻进程**自己**的 `/proc/<pid>/environ` 里的 `DATABASE_PATH`。DoD 要的是这个直接证据，
 * 不是脚本自述"我用的是临时库"——脚本说自己守规矩，和进程实际拿到了什么，是两件事。
 *
 * @param {number[]} pids
 * @param {string} expected
 * @returns {Promise<string>} 一行原始读数。
 */
export async function databasePathWitness(pids, expected) {
  const want = path.resolve(expected);
  const seen = new Set(pids);
  // `/proc/<pid>/environ` 对**刚 exec 完**的进程会短暂读不到（procfs 还没把 environ 挂上），
  // 一次性取样会把它误报成"读不到 environ"。重试若干轮，并且每轮重新扫一次后代进程兜底。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    for (const pid of [...seen, ...descendantClaudePids(process.pid)]) {
      seen.add(pid);
      const environ = readEnviron(pid);
      if (environ === null) continue;
      const value = environ.DATABASE_PATH;
      if (typeof value === 'string' && path.resolve(value) === want) {
        return `DATABASE_PATH 核对（/proc/${pid}/environ）：${value} —— 与 --database-path 一致`;
      }
      return `DATABASE_PATH 核对（/proc/${pid}/environ）：${value ?? '（未设置）'} —— ⛔与 --database-path（${want}）不一致`;
    }
    await delay(150);
  }
  return `DATABASE_PATH 核对（/proc/<pid>/environ）：未能读到一个常驻 pid 的 environ（pid=${[...seen].join(', ') || '（无）'}）`;
}

/**
 * `claude --help` 里 `--name <name>` 那一行。用来证明 `extraArgs.name` 对应的是一个**真实存在**的
 * 旗标（不是被 CLI 静默忽略的野参数）——否则"转录里没有这个名字"会有第二种解释。
 * @returns {Promise<string | null>}
 */
export function cliNameFlagLine() {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const line = out.split('\n').find((l) => l.includes('--name <name>'));
      resolve(line === undefined ? null : line.trim());
    });
  });
}

/** `claude --version` 的输出，写进每节的元信息。 */
export async function claudeVersion() {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', () => resolve('unknown'));
    child.on('close', () => resolve(out.trim() || 'unknown'));
  });
}

/** 本实验是否在 systemd scope 内（DoD 要求每节写明）。 */
export function inSystemdScope() {
  return typeof process.env.INVOCATION_ID === 'string' && process.env.INVOCATION_ID !== '';
}

// ---------------------------------------------------------------------------
// 公共：为一次实验准备一间临时房
// ---------------------------------------------------------------------------

/**
 * 建一间临时房：目录、config dir、database 路径。返回前核对目录可写。
 * @param {string} tag
 */
export function prepareRoom(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `resident-${tag}-`));
  const configDir = path.join(dir, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  return { dir, configDir, databasePath: path.join(dir, 'auth.db') };
}

/** 记录一节的元信息（取数时间、claude 版本、是否 scope 内）。 */
export async function sectionMeta() {
  return [
    `取数时间：${new Date().toISOString()}`,
    `claude --version：${await claudeVersion()}`,
    `systemd scope：${inSystemdScope() ? '是（INVOCATION_ID 存在）' : '否（进程在服务 cgroup 之外）'}`,
  ].join('\n');
}

/**
 * 把一串原始读数包成 `读数：…` / `结论：…` 两行。
 * @param {{ meta: string, rawLines: string[], conclusion: string }} args
 */
export function formatSection({ meta, rawLines, conclusion }) {
  return [
    meta,
    '',
    '读数：',
    '```',
    ...rawLines,
    '```',
    `结论：${conclusion}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// E1 — 常驻输入下 CronCreate 是否按时触发
// ---------------------------------------------------------------------------

/** @param {{ databasePath: string, seconds: number }} args */
export async function experimentE1({ databasePath, seconds }) {
  const room = prepareRoom('e1');
  const marker = `cron-tick-${Date.now()}`;
  // ⛔ 按**请求体**识别这一轮是什么，不按请求序号。CLI 在一轮开始时除了真正的用户轮之外还会
  // 发别的请求（技能表、标题…），按序号发 tool_use 会把 CronCreate 发给别的那一条，用户轮反而
  // 拿到一句文本、这一轮就结束了——读数是"cron 0 次"，但真相是 cron 压根没被创建。
  // 一轮开始时 CLI 发**两条**请求：一条 ~2KB 的预检（也带 tools、也带用户文本），一条 ~77KB 的
  // 真 agent 轮（完整 system prompt + skills）。把 tool_use 发给预检那条，回复会被丢掉，用户轮
  // 拿到别处的文本、`num_turns: 1` 就结束了——读数长得像"cron 不触发"，其实是工具从没被创建。
  // 用**体量**挑出真轮：只有它才带完整的 system prompt。
  const instruction = '请创建一个每分钟触发的周期任务';
  const mock = await startMockAnthropic((request) => {
    if (request.lastUserText.includes(marker) && !request.lastIsToolResult) return textStream('cron-fired');
    if (request.bytes > 10_000 && request.body.includes(instruction) && !request.lastIsToolResult) {
      return toolUseStream('toolu_cron_e1', 'CronCreate', { cron: '* * * * *', prompt: marker, recurring: true });
    }
    return textStream('ack');
  });
  /** @type {string[]} */
  const canUseToolCalls = [];
  const resident = startResident({
    cwd: room.dir, mockBaseUrl: mock.baseUrl, configDir: room.configDir, databasePath,
    canUseTool: async (/** @type {string} */ toolName) => {
      canUseToolCalls.push(toolName);
      return { behavior: 'allow', updatedInput: undefined };
    },
  });
  const livePids = await awaitClaudePid();
  // environ 必须在常驻进程**还活着**的时候读（stop() 之后 /proc/<pid> 就没了）。
  let dbWitness = '（未取到）';
  try {
    resident.send('请创建一个每分钟触发的周期任务');
    await delay(seconds * 1000);
    dbWitness = await databasePathWitness(descendantClaudePids(process.pid), databasePath);
  } finally {
    await resident.stop();
    await mock.close();
  }
  const messages = mock.received.filter((r) => r.url.startsWith('/v1/messages'));
  // 每一轮以正好一条 `result` 结束，而本实验只发过一次用户消息 ⇒ 第 1 条 result 是创建那一轮，
  // 之后每多一条 result 就是 cron 自己发起的无人轮。
  // ⛔ 不要用"最新一条消息里带 prompt 标记"来数：cron 推入的那一轮里，标记同时出现在历史
  // （tool_use 的入参）和最新消息里，而创建轮的续问也带着 tool_result——两种数法都会数错。
  const results = resident.messages.filter((m) => m.type === 'result');
  const fires = Math.max(0, results.length - 1);
  // CronCreate 的工具结果：这是区分"工具被拒"与"工具成功但调度器不发火"的唯一读数。
  // 同一轮的每次续问都会把整段历史重发一遍，于是同一个 tool_result 会在多个请求里重复出现。
  // 去重后再印，否则一行读数看起来像"创建了 N 个周期任务"。
  const cronToolResults = dedupeToolResults(messages.flatMap((r) => r.toolResults).filter((t) => t.id === 'toolu_cron_e1'));
  const rawLines = [
    `pid（运行中采样）：${livePids.join(', ') || '（无）'}`,
    dbWitness,
    `跑时长：${seconds}s`,
    `标记：${marker}`,
    `mock /v1/messages 请求总数：${messages.length}`,
    `CronCreate 工具结果：${cronToolResults.length === 0 ? '（未回流）' : cronToolResults.map((t) => `isError=${t.isError} text=${t.text}`).join(' | ')}`,
    `result 条数：${results.length}（第 1 条是创建轮）⇒ cron 触发 ${fires} 次（要求 ≥3）`,
    `各轮结束时刻：${results.map((m) => m.at).join(' | ') || '（无）'}`,
    ...messages.map((r, i) => `请求[${i}] ${r.at} 回复=${r.respondedWith} bytes=${r.bytes} tools=${r.hasTools ? 'Y' : 'N'} lastUser=${r.lastUserText.slice(0, 60)}`),
    `消息类型序列：${resident.types().join(' → ')}`,
    `助手里的 tool_use：${resident.assistantToolNames().join(', ') || '（无）'}`,
    `canUseTool 被调用：${canUseToolCalls.length === 0 ? '（无）' : canUseToolCalls.join(', ')}`,
    `助手消息原文：${resident.messages.filter((m) => m.type === 'assistant').map((m) => JSON.stringify(m.raw).slice(0, 260)).join(' ¶ ') || '（无）'}`,
    `result 原文：${resident.messages.filter((m) => m.type === 'result').map((m) => JSON.stringify(m.raw).slice(0, 260)).join(' ¶ ') || '（无）'}`,
    '--- CLI stderr（尾部） ---',
    ...resident.stderrTail(10),
    `观察窗：${seconds}s（cron 为 * * * * *，期望 ≥${Math.floor(seconds / 60)} 次）`,
  ];
  let conclusion;
  if (fires >= 3) {
    conclusion = `周期任务连续触发 ${fires} 次（要求 ≥3），每次都以一次独立的无人轮（多一条 result）出现在流里；常驻输入下 CronCreate 按时触发。`;
  } else if (cronToolResults.some((t) => t.isError)) {
    conclusion = `CronCreate 本身被拒（isError=true，原文见上），周期任务一次未触发——不是窗口太短，是工具没被接受。`;
  } else if (cronToolResults.length === 0) {
    conclusion = `CronCreate 的工具结果没有回流到 mock，无法判断工具是否被接受；观察到 ${fires} 个无人轮。`;
  } else {
    conclusion = `CronCreate 被接受（isError=false）但在 ${seconds}s 窗口内只触发 ${fires} 次（要求 ≥3）——见各轮结束时刻，窗口内应发生 ≥${Math.floor(seconds / 60)} 次。`;
  }
  return { section: formatSection({ meta: await sectionMeta(), rawLines, conclusion }), sectionId: 'E1' };
}

// ---------------------------------------------------------------------------
// E2 — busy 时推入用户消息（stream-json 形态）
// ---------------------------------------------------------------------------

/** @param {{ databasePath: string, seconds: number }} args */
export async function experimentE2StreamJson({ databasePath, seconds }) {
  const room = prepareRoom('e2json');
  // 第一轮故意慢：延迟 SSE，让"正在一轮中"这个前提成立。
  // 延迟必须发给**真 agent 轮**（体量最大的那条，见 E1 注释），不能按序号——一轮开始时 CLI 先发
  // 一条 ~2KB 的预检请求，把延迟发给它等于没延迟，第一轮会瞬间结束，"busy 时推入"的前提就不成立了。
  const slowMs = Math.min(20_000, Math.max(6_000, Math.round(seconds * 1000 * 0.5)));
  let delayedOnce = false;
  const mock = await startMockAnthropic((request) => {
    if (!delayedOnce && request.bytes > 10_000 && !request.lastIsToolResult) {
      delayedOnce = true;
      return `__DELAY__${slowMs}`;
    }
    return textStream('second-turn-reply');
  });
  const server = mock;
  const resident = startResident({ cwd: room.dir, mockBaseUrl: server.baseUrl, configDir: room.configDir, databasePath });
  const livePids = await awaitClaudePid();
  /** @type {string[]} */
  const timeline = [];
  let dbWitness = '（未取到）';
  try {
    resident.send('第一条：请慢慢回答');
    // 等到第一条的**真 agent 轮**已经到达 mock（此刻它的响应正被延迟），再推第二条——这才是
    // "一轮进行中"。只等"随便一条请求到达"会被预检请求抢先满足，前提就不成立。
    while (mock.received.filter((r) => r.url.startsWith('/v1/messages') && r.bytes > 10_000).length < 1) await delay(100);
    timeline.push(`推入第二条的时刻：${new Date().toISOString()}（第一条已发出请求）`);
    resident.send('第二条：我在你回答时插一句话');
    await delay(seconds * 1000);
    dbWitness = await databasePathWitness(descendantClaudePids(process.pid), databasePath);
  } finally {
    await resident.stop();
    await server.close();
  }
  const results = resident.messages.filter((m) => m.type === 'result');
  const rawLines = [
    `pid（运行中采样）：${livePids.join(', ') || '（无）'}`,
    dbWitness,
    `第一轮延迟：${slowMs}ms（发给体量 >10KB 的真 agent 轮）`,
    ...timeline,
    `mock 请求：${mock.received.filter((r) => r.url.startsWith('/v1/messages')).map((r) => `${r.at} bytes=${r.bytes} 回复=${r.respondedWith}`).join(' | ')}`,
    `result 条数：${results.length}（1 = 并入当前轮；2 = 另起一轮）`,
    `result 时刻：${results.map((m) => m.at).join(' | ')}`,
    `消息类型序列：${resident.types().join(' → ')}`,
  ];
  const conclusion = results.length <= 1
    ? `stream-json 形态：busy 时推入的第二条消息**并入当前轮**（全程只有 ${results.length} 个 result），未丢失。`
    : `stream-json 形态：busy 时推入的第二条消息**另起一轮**（出现 ${results.length} 个 result），未丢失。`;
  return { section: formatSection({ meta: await sectionMeta(), rawLines, conclusion }), sectionId: 'E2' };
}

// ---------------------------------------------------------------------------
// E2 交互式那一半 — tmux 里的交互式 claude
// ---------------------------------------------------------------------------

/**
 * 在 tmux 会话里跑交互式 `claude`，指向同一个 mock 端点，用 `tmux send-keys` 在一轮进行中输入
 * 第二条消息。读数取自 mock 收到的请求序列与 pane 的原始输出。
 *
 * @param {{ databasePath: string, seconds: number }} args
 */
export async function experimentE2Interactive({ databasePath, seconds }) {
  const room = prepareRoom('e2tmux');
  const session = `resident-e2-${process.pid}`;
  const slowMs = Math.min(20_000, Math.max(6_000, Math.round(seconds * 1000 * 0.5)));
  // 同 E2 stream-json：延迟只发给真 agent 轮（体量 >10KB），不按序号。
  let delayedOnce = false;
  const mock = await startMockAnthropic((request) => {
    if (!delayedOnce && request.bytes > 10_000 && !request.lastIsToolResult) {
      delayedOnce = true;
      return `__DELAY__${slowMs}`;
    }
    return textStream('interactive-second-reply');
  });
  // ⛔ 不要 `...process.env`。上一轮就是这么干的，读数里出现了一个"Enter to confirm · Esc to
  // cancel"的框：交互式 CLI 继承了本会话的 CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_CHILD_SESSION /
  // CLAUDE_CODE_MESSAGING_* 等身份变量，把自己当成另一个会话的子会话；而 :3001 那套 env 还带
  // 着 SERVER_PORT / HOST / npm_lifecycle_* 等无关变量。交互式那条腿只传最小集合。
  /** @type {Record<string, string>} */
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    USER: process.env.USER ?? '',
    SHELL: '/bin/bash',
    TMPDIR: os.tmpdir(),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
    ANTHROPIC_BASE_URL: mock.baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'resident-experiment-token',
    CLAUDE_CONFIG_DIR: room.configDir,
    DATABASE_PATH: databasePath,
  };
  // ⛔ 交互式 CLI 首跑会在这个目录上弹"是否信任此文件夹"（Security guide / `❯ No, exit` /
  // `Yes, I trust this folder`）。卡在那张对话框上时读数是 **0 个请求**、pane 里只有对话框原文，
  // 看起来像"busy 输入被并入当前轮"，其实实验根本没开始。先在临时配置目录里把信任标记写好。
  const cfgPath = path.join(room.configDir, '.claude.json');
  /** @type {any} */
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { cfg = {}; }
  if (cfg === null || typeof cfg !== 'object') cfg = {};
  cfg.projects = { ...(cfg.projects ?? {}), [room.dir]: { ...(cfg.projects?.[room.dir] ?? {}), hasTrustDialogAccepted: true } };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // ⛔ 不要写成 `tmux new-session -- KEY=VAL ... claude ...`：tmux 不解释 `KEY=VAL`，它会把
  // 它当成**要 exec 的程序名**，于是会话瞬间就死、pane 也没了（读数是 0 个请求，看不出原因）。
  // 走一个真正的启动脚本，用 `env -i` 起干净环境（见上）。
  const launcher = path.join(room.dir, 'launch-interactive.sh');
  fs.writeFileSync(launcher, [
    '#!/bin/bash',
    // cwd 必须显式切到这间房：tmux 新会话继承的是 **tmux 客户端**的 cwd，不是启动脚本所在的目录。
    // 信任标记按"项目路径"存，cwd 不对就白写，对话框照弹。
    `cd ${JSON.stringify(room.dir)}`,
    `exec env -i ${Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')} claude --permission-mode bypassPermissions`,
    '',
  ].join('\n'), { mode: 0o755 });

  const tmux = (/** @type {string[]} */ argv) => spawnSyncQuiet('tmux', argv);
  const capture = () => (spawnSyncStatus('tmux', ['has-session', '-t', session]) === 0 ? tmux(['capture-pane', '-t', session, '-p', '-S', '-']) : '');
  tmux(['kill-session', '-t', session]);
  tmux(['new-session', '-d', '-s', session, '-x', '200', '-y', '50', '--', 'bash', launcher]);
  await delay(6_000);
  // 会话还在不在？不在就说明 claude 根本没起来——这必须写进读数，否则 0 个请求会被误读成
  // "interactive 形态下 busy 输入被并入当前轮"。
  const aliveAfterBoot = spawnSyncStatus('tmux', ['has-session', '-t', session]) === 0;
  // 全新 CLAUDE_CONFIG_DIR 的首启向导是**固定三屏**，而且第三屏的默认高亮就是"退出"：
  //   1) "Choose the text style"（主题）——Enter 即可
  //   2) "Security notes … Press Enter to continue…"——Enter
  //   3) "WARNING: … Bypass Permissions mode … ❯ No, exit / Yes, I accept"——必须 Down 再
  //      Enter，直接 Enter 会把会话**退出**（上一轮就是这个：pane 里留着那一屏，会话没了，
  //      0 个请求）。
  // 因此把向导走完再输入第一条；每一步都记进读数。
  /** @type {string[]} */
  const wizardSteps = [];
  let bootPane = '';
  for (let step = 0; step < 6; step += 1) {
    bootPane = capture();
    if (bootPane === '') break;
    if (bootPane.includes('Choose the text style')) {
      tmux(['send-keys', '-t', session, 'Enter']);
      wizardSteps.push('主题选择：Enter');
    } else if (bootPane.includes('Press Enter to continue')) {
      tmux(['send-keys', '-t', session, 'Enter']);
      wizardSteps.push('安全说明：Enter');
    } else if (bootPane.includes('Bypass Permissions mode')) {
      tmux(['send-keys', '-t', session, 'Down']);
      await delay(400);
      tmux(['send-keys', '-t', session, 'Enter']);
      wizardSteps.push('bypass 权限警告：Down+Enter（默认高亮是 No, exit）');
    } else if (bootPane.includes('I trust this folder')) {
      tmux(['send-keys', '-t', session, 'Down']);
      await delay(400);
      tmux(['send-keys', '-t', session, 'Enter']);
      wizardSteps.push('信任对话框：Down+Enter');
    } else {
      wizardSteps.push('向导已走完（无已知对话框）');
      break;
    }
    await delay(2_500);
  }
  const sawTrustDialog = bootPane.includes('I trust this folder');
  // 临时库见证：交互式这条腿也是"一次性临时实例"，同样要读一次 /proc/<pid>/environ。
  // 启动脚本最后是 `exec env -i … claude`，所以 pane 的进程**就是** claude 本身。
  const panePidRaw = (tmux(['list-panes', '-t', session, '-F', '#{pane_pid}']) || '').trim();
  const panePid = /^\d+$/.test(panePidRaw) ? Number(panePidRaw) : null;
  const paneEnv = panePid === null ? null : readEnviron(panePid);
  const dbWitness = panePid === null
    ? 'DATABASE_PATH 核对（/proc/<pane_pid>/environ）：没读到 pane 的 pid'
    : paneEnv === null
      ? `DATABASE_PATH 核对（/proc/${panePid}/environ）：environ 读不到（pid=${panePid}）`
      : `DATABASE_PATH 核对（/proc/${panePid}/environ）：${paneEnv.DATABASE_PATH ?? '（未设置）'} —— 与 --database-path${path.resolve(paneEnv.DATABASE_PATH ?? '') === path.resolve(databasePath) ? '一致' : `（${databasePath}）不一致`}`;
  tmux(['send-keys', '-t', session, '第一条：请慢慢回答', 'Enter']);
  // 等到 mock 真的收到第一条请求，才输入第二条。
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && mock.received.filter((r) => r.url.startsWith('/v1/messages') && r.bytes > 10_000).length < 1) await delay(200);
  const secondAt = new Date().toISOString();
  tmux(['send-keys', '-t', session, '第二条：我在你回答时插一句话', 'Enter']);
  await delay(seconds * 1000);
  const pane = capture();
  tmux(['kill-session', '-t', session]);
  await mock.close();

  const requests = mock.received.filter((r) => r.url.startsWith('/v1/messages'));
  // 一轮 = 一条真 agent 轮请求（体量 >10KB）；预检请求不算，否则请求数会被系统性高估一倍。
  const agentTurns = requests.filter((r) => r.bytes > 10_000).length;
  // 只看**实验结束时**的 pane：开机时出现过、随后被按掉的对话框不算挡住。
  const stuckOnDialog = pane.includes('I trust this folder') || pane.includes('Enter to confirm · Esc to cancel');
  const rawLines = [
    `tmux session：${session}`,
    `交互式 CLI 的环境：env -i 起干净环境（不含本会话的 CLAUDE_CODE_* 身份变量），仅传 PATH/HOME/LANG/USER/SHELL/TMPDIR/XDG_RUNTIME_DIR + ANTHROPIC_BASE_URL/AUTH_TOKEN + CLAUDE_CONFIG_DIR + DATABASE_PATH`,
    `启动后会话仍存在：${aliveAfterBoot ? '是' : '否（claude 没起来，本次读数无效）'}`,
    `首启向导：${wizardSteps.length === 0 ? '（没走到——会话启动后即不存在）' : wizardSteps.join(' → ')}`,
    dbWitness,
    `启动后 pane 尾部：${bootPane.split('\n').filter((l) => l.trim() !== '').slice(-6).join(' / ').slice(0, 300)}`,
    `推入第二条的时刻：${secondAt}（第一条的真 agent 轮已到达）`,
    `mock /v1/messages 请求数：${requests.length}（其中真 agent 轮 ${agentTurns}）`,
    ...requests.map((r, i) => `请求[${i}] ${r.at} bytes=${r.bytes} 回复=${r.respondedWith} lastUser=${r.lastUserText.slice(0, 120)}`),
    `真 agent 轮数：${agentTurns}（1 = 第二条并入当前轮；2 = 另起一轮）`,
    `信任对话框出现过：${sawTrustDialog ? '是' : '否'}`,
    `实验结束时仍卡在对话框上：${stuckOnDialog ? '是（本次读数无效）' : '否'}`,
    '--- pane 原文（尾部） ---',
    ...pane.split('\n').slice(-40),
  ];
  let conclusion;
  if (!aliveAfterBoot) {
    conclusion = '交互式 CLI 形态：claude 在 tmux 里没有起来（会话启动后即不存在），本次**没有**拿到有效读数——不能用它裁定 busy 输入的行为。';
  } else if (stuckOnDialog) {
    conclusion = '交互式 CLI 形态：会话卡在启动对话框上，一条请求都没发出——本次读数无效，不能用它裁定 busy 输入的行为。';
  } else if (agentTurns >= 2) {
    conclusion = `交互式 CLI 形态：busy 时输入的第二条消息**另起一轮**（真 agent 轮数 ${agentTurns}），未丢失。`;
  } else if (agentTurns === 1) {
    conclusion = '交互式 CLI 形态：只出现 1 条真 agent 轮请求——第二条消息**并入了当前轮**（或在同一轮里排队），未另起一轮。';
  } else {
    conclusion = '交互式 CLI 形态：本次没有观察到任何真 agent 轮请求，读数无效。';
  }
  return { section: formatSection({ meta: await sectionMeta(), rawLines, conclusion }), sectionId: 'E2' };
}

// ---------------------------------------------------------------------------
// E3 — 无人轮进行中推入用户消息
// ---------------------------------------------------------------------------

/** @param {{ databasePath: string, seconds: number }} args */
export async function experimentE3({ databasePath, seconds }) {
  const room = prepareRoom('e3');
  const marker = `unattended-${Date.now()}`;
  const slowMs = Math.min(20_000, Math.max(6_000, Math.round(seconds * 1000 * 0.4)));
  // 按请求体识别（理由同 E1）：用户轮 → 创建 cron；cron 自己触发的那一轮 → 故意慢。
  // 真 agent 轮是体量最大的那条（见 E1 的注释）：按体量挑，不按序号、也不只看用户文本。
  // ⛔ 上一版靠"等 70 秒"来假定注入时无人轮正在进行，实际读数里注入落在两轮之间的空档
  // （创建轮 09:34:50 结束、注入 09:35:43、cron 轮 09:35:24 就结束了），于是那一轮**没有**
  // 回答"无人轮进行中"这个问题。这一版改成确定性的：等 mock 收到**第二条**带 tool_result 的
  // 真 agent 轮（第一条是创建轮的续写，第二条才是 cron 触发的无人轮），而那条被 __DELAY__ 挂住
  // ——注入时刻必然落在该轮的窗口内。
  const mock = await startMockAnthropic((request) => {
    if (request.bytes > 10_000 && request.body.includes('请创建一个每分钟触发的周期任务') && !request.lastIsToolResult) {
      return toolUseStream('toolu_cron_e3', 'CronCreate', { cron: '* * * * *', prompt: marker, recurring: true });
    }
    if (request.bytes > 10_000 && request.lastIsToolResult) return `__DELAY__${slowMs}`;
    return textStream('ack');
  });
  const resident = startResident({ cwd: room.dir, mockBaseUrl: mock.baseUrl, configDir: room.configDir, databasePath });
  const livePids = await awaitClaudePid();
  let dbWitness = '（未取到）';
  let inFlightAtInjection = false;
  let injectedAt = '（未注入）';
  let resultsAtInjection = 0;
  let delayedTurnAt = '（无）';
  try {
    resident.send('请创建一个每分钟触发的周期任务');
    // 第 1 条带 tool_result 的真轮 = 创建轮的续写；第 2 条 = cron 触发的无人轮。等它。
    const waitDeadline = Date.now() + 150_000;
    const cronTurns = () => mock.received.filter((r) => r.url.startsWith('/v1/messages') && r.bytes > 10_000 && r.lastIsToolResult);
    while (Date.now() < waitDeadline && cronTurns().length < 2) await delay(200);
    const reached = cronTurns().length >= 2;
    delayedTurnAt = reached ? `${cronTurns()[1].at}（该轮被 __DELAY__${slowMs} 挂住）` : '（未等到 cron 触发的无人轮）';
    inFlightAtInjection = reached;
    resultsAtInjection = resident.messages.filter((m) => m.type === 'result').length;
    injectedAt = new Date().toISOString();
    resident.send('无人轮进行中我插一句');
    // 注入后等的窗口要盖住"被挂住的那一轮结束"这一段，但别长到把下一次 cron 也等进来。
    await delay(slowMs + 15_000);
    dbWitness = await databasePathWitness(descendantClaudePids(process.pid), databasePath);
  } finally {
    await resident.stop();
    await mock.close();
  }
  const all = mock.received.filter((r) => r.url.startsWith('/v1/messages'));
  const results = resident.messages.filter((m) => m.type === 'result');
  const afterInjection = results.filter((m) => m.at > injectedAt);
  const cronToolResults = dedupeToolResults(all.flatMap((r) => r.toolResults).filter((t) => t.id === 'toolu_cron_e3'));
  const rawLines = [
    `pid（运行中采样）：${livePids.join(', ') || '（无）'}`,
    dbWitness,
    `标记：${marker}`,
    `CronCreate 工具结果：${cronToolResults.length === 0 ? '（未回流）' : cronToolResults.map((t) => `isError=${t.isError} text=${t.text}`).join(' | ')}`,
    `cron 触发的无人轮请求：${delayedTurnAt}`,
    `注入时刻：${injectedAt}（注入时无人轮仍在进行：${inFlightAtInjection ? '是' : '否——本次读数无效'}；注入前的 result 条数 ${resultsAtInjection}）`,
    ...all.map((r, i) => `请求[${i}] ${r.at} ${r.lastIsToolResult ? 'tool-result' : 'user'} bytes=${r.bytes} 回复=${r.respondedWith} lastUser=${r.lastUserText.slice(0, 60)}`),
    `result 总条数：${results.length}`,
    `注入之后的 result：${afterInjection.length} 条 —— ${afterInjection.map((m) => m.at).join(' | ') || '（无）'}`,
    `消息类型序列：${resident.types().join(' → ')}`,
  ];
  // 判定：注入发生在无人轮窗口内（inFlightAtInjection）。若注入的消息**并入**了正在跑的那一轮，
  // 注入之后只会再出现 1 条 result（那一轮结束，或加一次后续 cron）；若它**另起一轮**，注入之后
  // 会出现 2 条 result（无人轮结束 + 注入轮结束）——两条 result 的时刻会明显错开。
  const conclusion = !inFlightAtInjection
    ? '本次没有拿到"无人轮进行中"的窗口（没等到 cron 触发的无人轮请求），读数不能用。'
    : afterInjection.length >= 2
      ? `无人轮（cron 触发）进行中推入用户消息：**没有被拒绝，另起了一轮**（注入后出现 ${afterInjection.length} 条 result：无人轮结束 ${afterInjection[0]?.at}、注入轮结束 ${afterInjection[1]?.at}）。`
      : `无人轮（cron 触发）进行中推入用户消息：没有被拒绝，并且**并入了当前轮**（注入后只出现 ${afterInjection.length} 条 result）。`;
  return { section: formatSection({ meta: await sectionMeta(), rawLines, conclusion }), sectionId: 'E3' };
}

// ---------------------------------------------------------------------------
// E4 — interrupt() 后进程与 cron 是否仍存活
// ---------------------------------------------------------------------------

/** @param {{ databasePath: string }} args */
export async function experimentE4({ databasePath }) {
  const room = prepareRoom('e4');
  const marker = `cron-tick-e4-${Date.now()}`;
  // 按请求体识别（理由同 E1）。
  // 真 agent 轮按体量挑（见 E1 注释）。
  const mock = await startMockAnthropic((request) => {
    if (request.bytes > 10_000 && request.body.includes('请创建一个每分钟触发的周期任务') && !request.lastIsToolResult) {
      return toolUseStream('toolu_cron_e4', 'CronCreate', { cron: '* * * * *', prompt: marker, recurring: true });
    }
    return textStream('ack');
  });
  const resident = startResident({ cwd: room.dir, mockBaseUrl: mock.baseUrl, configDir: room.configDir, databasePath });
  try {
    resident.send('请创建一个每分钟触发的周期任务');
    await delay(75_000);
    const pidsBefore = await awaitClaudePid();
    // 每轮结束各产生一条 result；本实验先发 1 条用户消息，打断前又发 1 条 ⇒ 用户轮基数随时刻变。
    /** @param {number} userTurns */
    const fireCount = (userTurns) => Math.max(0, resident.messages.filter((m) => m.type === 'result').length - userTurns);
    const firesBefore = fireCount(1);
    resident.send('再来一轮，然后我会打断它');
    await delay(3_000);
    const interruptAt = new Date().toISOString();
    await resident.query.interrupt();
    await delay(2_000);
    const pidsAfter = descendantClaudePids(process.pid);
    // 打断之后还要再等一个 cron 周期，看它是否继续触发。
    await delay(90_000);
    const firesAfter = fireCount(2);
    const cronToolResults = dedupeToolResults(mock.received.flatMap((r) => r.toolResults).filter((t) => t.id === 'toolu_cron_e4'));
    const rawLines = [
      `interrupt 时刻：${interruptAt}`,
      await databasePathWitness(pidsBefore, databasePath),
      `interrupt 前 pid：${pidsBefore.join(', ') || '（无）'}`,
      `interrupt 后 pid：${pidsAfter.join(', ') || '（无）'}`,
      `进程仍存活：${pidsAfter.some((p) => pidsBefore.includes(p)) ? '是' : '否'}`,
      `CronCreate 工具结果：${cronToolResults.length === 0 ? '（未回流）' : cronToolResults.map((t) => `isError=${t.isError} text=${t.text}`).join(' | ')}`,
      `cron 触发次数：interrupt 前 ${firesBefore} → 之后 ${firesAfter}`,
      `消息类型序列：${resident.types().join(' → ')}`,
    ];
    const conclusion = pidsAfter.some((p) => pidsBefore.includes(p)) && firesAfter > firesBefore
      ? `interrupt() 只停了当前一轮：同一 pid（${pidsBefore.join(', ')}）仍在，cron 从 ${firesBefore} 次继续涨到 ${firesAfter} 次。`
      : `interrupt() 后进程存活=${pidsAfter.some((p) => pidsBefore.includes(p)) ? '是' : '否'}，cron ${firesBefore}→${firesAfter}——未同时满足"进程仍在 + cron 继续"，见读数。`;
    return { section: formatSection({ meta: await sectionMeta(), rawLines, conclusion }), sectionId: 'E4' };
  } finally {
    await resident.stop();
    await mock.close();
  }
}

// ---------------------------------------------------------------------------
// E5 — 服务进程被 kill 后常驻进程是否因 EOF 退出
// ---------------------------------------------------------------------------

/** @param {{ databasePath: string, seconds: number }} args */
export async function experimentE5({ databasePath }) {
  const room = prepareRoom('e5');
  // 真实的"服务进程"由本脚本的一个子进程扮演：它持有常驻进程并撑着 stdin。杀掉它 = 服务进程消失。
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--hold-resident', room.dir, databasePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RESIDENT_MOCK_PORT: '0' },
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  // 等子进程报出它持有的 claude pid。
  const deadline = Date.now() + 60_000;
  /** @type {number | null} */
  let residentPid = null;
  while (Date.now() < deadline) {
    const match = /RESIDENT_PID=(\d+)/.exec(stdout);
    if (match) { residentPid = Number(match[1]); break; }
    await delay(200);
  }
  const rawLines = [
    `子进程（扮演服务进程）pid：${child.pid}`,
    `常驻 claude pid：${residentPid ?? '（未报出）'}`,
    // 常驻进程自己的 environ 是"它真的拿到了临时库"的直接证据（脚本自述不算）。
    await databasePathWitness(residentPid === null ? [] : [residentPid], databasePath),
  ];
  if (residentPid === null) {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    return {
      section: formatSection({ meta: await sectionMeta(), rawLines, conclusion: '子进程未在 60s 内报出常驻 pid，本次未取到读数。' }),
      sectionId: 'E5',
    };
  }
  const aliveBefore = isAlive(residentPid);
  const killedAt = Date.now();
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  /** @type {number | null} */
  let exitAfterSeconds = null;
  const exitDeadline = Date.now() + 120_000;
  while (Date.now() < exitDeadline) {
    if (!isAlive(residentPid)) { exitAfterSeconds = (Date.now() - killedAt) / 1000; break; }
    await delay(200);
  }
  rawLines.push(
    `kill 前常驻存活：${aliveBefore ? '是' : '否'}`,
    `kill 时刻：${new Date(killedAt).toISOString()}`,
    `常驻退出用时：${exitAfterSeconds === null ? '>120s（未退出）' : `${exitAfterSeconds.toFixed(1)}s`}`,
  );
  // 这个"没退出"的进程正是本实验要证明的事实，但它不该留在这台机器上——扫掉，并把清扫结果也写进读数。
  let swept = '（无需清扫：已自行退出）';
  if (exitAfterSeconds === null) {
    try { process.kill(residentPid, 'SIGKILL'); } catch { /* 已退出 */ }
    const sweepDeadline = Date.now() + 10_000;
    while (Date.now() < sweepDeadline && isAlive(residentPid)) await delay(100);
    swept = isAlive(residentPid) ? '⛔清扫失败：常驻进程仍在' : '已由本实验清扫（SIGKILL），无残留';
  }
  rawLines.push(`残留清扫：${swept}`);
  const conclusion = exitAfterSeconds === null
    ? '服务进程被 kill 后常驻进程 120 秒内**没有**退出——清扫逻辑是必需的。'
    : `服务进程被 kill 后常驻进程在 ${exitAfterSeconds.toFixed(1)} 秒内因 EOF 退出——清扫仍建议保留，但非硬需求。`;
  return { section: formatSection({ meta: await sectionMeta(), rawLines, conclusion }), sectionId: 'E5' };
}

// ---------------------------------------------------------------------------
// E6 — extraArgs.name 是否生效、是否接受中文与空格
// ---------------------------------------------------------------------------

/** @param {{ databasePath: string, seconds: number }} args */
export async function experimentE6({ databasePath, seconds }) {
  const room = prepareRoom('e6');
  const asciiName = `resident-e6-${process.pid}`;
  const cjkName = '实验会话 中文 空格';
  const mock = await startMockAnthropic(() => textStream('ok'));
  const resident = startResident({
    cwd: room.dir,
    mockBaseUrl: mock.baseUrl,
    configDir: room.configDir,
    databasePath,
    extraArgs: { name: asciiName },
  });
  try {
    resident.send('打个招呼');
    await delay(Math.max(8_000, seconds * 500));
  } finally {
    await resident.stop();
  }
  const init = resident.messages.find((m) => m.type === 'system' && m.subtype === 'init');
  const initRaw = JSON.stringify(init?.raw ?? {}).slice(0, 1500);
  const bodyHasAscii = mock.received.some((r) => r.body.includes(asciiName));
  const nameFlag = await cliNameFlagLine();
  const peer = readPeerNameFromTranscript(room.configDir);
  const rawLines = [
    `extraArgs.name（ASCII）：${asciiName}`,
    `--name 是合法旗标：${nameFlag ?? '（未读到 claude --help 的 --name 行）'}`,
    `本地转录里找到的 agent-name：${peer.agentName ?? '（无）'}`,
    `本地转录里找到的 custom-title：${peer.customTitle ?? '（无）'}`,
    `转录文件：${peer.path ?? '（无）'}`,
    `mock 收到的请求体里出现该名：${bodyHasAscii ? '是' : '否（peer 名不进 API，这条不能用来判定生效与否）'}`,
    `system/init 原文：${initRaw}`,
  ];
  // 中文 + 空格的第二次尝试，单独一间房（同一个 CLAUDE_CONFIG_DIR 会被 CLI 复用）。
  const room2 = prepareRoom('e6b');
  const resident2 = startResident({
    cwd: room2.dir,
    mockBaseUrl: mock.baseUrl,
    configDir: room2.configDir,
    databasePath,
    extraArgs: { name: cjkName },
  });
  try {
    resident2.send('打个招呼');
    await delay(Math.max(8_000, seconds * 500));
  } finally {
    await resident2.stop();
    await mock.close();
  }
  const init2 = resident2.messages.find((m) => m.type === 'system' && m.subtype === 'init');
  const peer2 = readPeerNameFromTranscript(room2.configDir);
  const rawLines2 = [
    `extraArgs.name（中文 + 空格）：${cjkName}`,
    `本地转录里找到的 agent-name：${peer2.agentName ?? '（无）'}`,
    `本地转录里找到的 custom-title：${peer2.customTitle ?? '（无）'}`,
    `转录文件：${peer2.path ?? '（无）'}`,
    `system/init 原文：${JSON.stringify(init2?.raw ?? {}).slice(0, 1500)}`,
  ];
  const conclusion = peer.agentName === asciiName && peer2.agentName === cjkName
    ? `extraArgs.name 生效：本地转录里 \`agent-name\` 与设定值逐字一致（ASCII="${asciiName}"，中文+空格="${cjkName}"），中文与空格**被原样接受**。该名不进 API 请求体（mock 端看不到），判定必须读转录。`
    : peer.agentName === asciiName
      ? `ASCII 名生效（转录 agent-name="${peer.agentName}"）；中文 + 空格那条转录里是 ${JSON.stringify(peer2.agentName)}，与设定值不一致——按 §12 只用 ID 前缀。`
      : `转录里没有找到与设定值一致的 agent-name（ASCII 那条是 ${JSON.stringify(peer.agentName)}），extraArgs.name 本次未生效。`;
  return {
    section: formatSection({ meta: await sectionMeta(), rawLines: [...rawLines, ...rawLines2], conclusion }),
    sectionId: 'E6',
  };
}

// ---------------------------------------------------------------------------
// E7 — 长驻内存增长（≥24 小时浸泡）
// ---------------------------------------------------------------------------

/** @param {{ databasePath: string, hours: number, intervalMs: number, real?: boolean }} args */
export async function experimentE7({ databasePath, hours, intervalMs = 5 * 60 * 1000, real = false }) {
  const room = prepareRoom('e7');
  const marker = `soak-${Date.now()}`;
  const instruction = '开始浸泡：请创建一个每 5 分钟的周期任务，再起一个 Monitor 盯着本目录的变化。';
  // mock 形态：按请求体识别（理由同 E1），把 CronCreate 发给体量 >10KB 的真 agent 轮，否则周期任务
  // 压根不会被创建，一次"没有 cron 触发的空转浸泡"会被误读成"长驻内存平稳"。
  // real 形态（proposal 要求的形态）：不架 mock，让真实模型自己决定调哪些工具——读数里因此不写
  // "mock 请求数"这类只对 mock 有意义的行，费用另记。
  const mock = real
    ? null
    : await startMockAnthropic((request) => {
      if (request.bytes > 10_000 && request.body.includes(instruction) && !request.lastIsToolResult) {
        return toolUseStream('toolu_cron_e7', 'CronCreate', { cron: '*/5 * * * *', prompt: marker, recurring: true });
      }
      return textStream('soak ack');
    });
  const resident = startResident({
    cwd: room.dir,
    mockBaseUrl: mock === null ? null : mock.baseUrl,
    configDir: room.configDir,
    databasePath,
  });
  const samples = [];
  const startedAt = Date.now();
  const deadline = startedAt + hours * 3600 * 1000;
  let sweepReading = '（未取到）';
  try {
    resident.send(instruction);
    while (Date.now() < deadline) {
      await delay(intervalMs);
      const pids = descendantClaudePids(process.pid);
      const main = pids.length > 0 ? rssTree(pids[0]) : { tree: 0, self: null, pids: [] };
      samples.push({
        at: new Date().toISOString(),
        elapsedHours: (Date.now() - startedAt) / 3600 / 1000,
        mainPid: pids[0] ?? null,
        selfKb: main.self,
        treeKb: main.tree,
        subtreePids: main.pids,
      });
      fs.writeFileSync(`${room.dir}/rss-samples.json`, JSON.stringify(samples, null, 1));
    }
  } finally {
    await resident.stop();
    // 浸泡里跑过真实工具（cron、Monitor），它们可能留下子进程；E5 已证明常驻进程不会因 stdin EOF
    // 自行退出，所以这里必须自己收尾——否则每跑一次浸泡就在机器上留一批常驻进程。
    for (const pid of descendantClaudePids(process.pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }
    const sweepDeadline = Date.now() + 10_000;
    while (Date.now() < sweepDeadline && descendantClaudePids(process.pid).length > 0) await delay(200);
    const leftovers = descendantClaudePids(process.pid);
    sweepReading = leftovers.length === 0 ? '已由本实验清扫，无残留' : `⛔清扫失败：仍有 pid=${leftovers.join(', ')}`;
    if (mock !== null) await mock.close();
  }
  const first = samples[0];
  const peak = samples.reduce((a, b) => (b.treeKb > a.treeKb ? b : a), samples[0]);
  const last = samples[samples.length - 1];
  const elapsedHours = (Date.now() - startedAt) / 3600 / 1000;
  const meetsTarget = elapsedHours >= 24;
  const soakRequests = mock === null ? [] : mock.received.filter((r) => r.url.startsWith('/v1/messages'));
  const soakCronToolResults = dedupeToolResults(soakRequests.flatMap((r) => r.toolResults).filter((t) => t.id === 'toolu_cron_e7'));
  // 第 1 条 result 是用户那条指令的轮；之后每条 result 都是一次 cron 触发的无人轮（理由同 E1）。
  const results = resident.messages.filter((m) => m.type === 'result');
  const soakFires = Math.max(0, results.length - 1);
  const costUsd = results.reduce((sum, m) => sum + (Number(m.raw?.total_cost_usd) || 0), 0);
  const usage = results.reduce((acc, m) => {
    const u = m.raw?.usage ?? {};
    return {
      input: acc.input + (Number(u.input_tokens) || 0),
      output: acc.output + (Number(u.output_tokens) || 0),
      cacheRead: acc.cacheRead + (Number(u.cache_read_input_tokens) || 0),
      cacheWrite: acc.cacheWrite + (Number(u.cache_creation_input_tokens) || 0),
    };
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const rawLines = [
    `端点：${mock === null ? `真实模型（沿用 ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL ?? '（未设置）'}，模型 ${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '（默认）'}）` : 'mock Anthropic 兼容端点'}`,
    `浸泡起点：${new Date(startedAt).toISOString()}`,
    `浸泡目标：${hours} 小时；本机实际观察窗：${elapsedHours.toFixed(2)} 小时 —— ${meetsTarget ? '满足 ≥24h' : '⛔未达 ≥24h，本次读数不能用来定 §11 的上限'}`,
    `采样间隔：${intervalMs / 60000} 分钟，样本数：${samples.length}`,
    ...(mock === null
      ? [`费用（SDK result.total_cost_usd 求和）：$${costUsd.toFixed(4)}`,
        `token：input=${usage.input} output=${usage.output} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite}`]
      : [`CronCreate 工具结果：${soakCronToolResults.length === 0 ? '（未回流——本次浸泡期间没有周期任务在跑）' : soakCronToolResults.map((t) => `isError=${t.isError} text=${t.text}`).join(' | ')}`,
        `mock /v1/messages 请求数：${soakRequests.length}`]),
    `浸泡期间 cron 触发的无人轮数：${soakFires}`,
    `残留清扫：${sweepReading}`,
    `起点 RSS：self=${first?.selfKb ?? '-'}KB tree=${first?.treeKb ?? '-'}KB`,
    `峰值 RSS：${peak?.at ?? '-'} self=${peak?.selfKb ?? '-'}KB tree=${peak?.treeKb ?? '-'}KB`,
    `终点 RSS：${last?.at ?? '-'} self=${last?.selfKb ?? '-'}KB tree=${last?.treeKb ?? '-'}KB`,
    ...samples.map((s) => `${s.at} +${s.elapsedHours.toFixed(2)}h pid=${s.mainPid} self=${s.selfKb}KB tree=${s.treeKb}KB`),
    `样本原文：${room.dir}/rss-samples.json`,
  ];
  const conclusion = samples.length === 0
    ? '本次没有取到 RSS 样本。'
    : meetsTarget
      ? `浸泡 ${elapsedHours.toFixed(2)} 小时（≥24h），峰值树 RSS ${peak?.treeKb ?? '-'}KB；据此建议单进程上限与 slice 总上限（见提案 §11）。`
      : `浸泡 ${elapsedHours.toFixed(2)} 小时，离 ≥24h 还差 ${(24 - elapsedHours).toFixed(2)} 小时：峰值树 RSS ${peak?.treeKb ?? '-'}KB 只够说明"没有分钟级的暴涨"，**不足以**定 §11 的上限数值——§11 的数值仍待一次真正的 24 小时浸泡。`;
  return { section: formatSection({ meta: await sectionMeta(), rawLines, conclusion }), sectionId: 'E7' };
}

// ---------------------------------------------------------------------------
// E8 — bypassPermissions 下 AskUserQuestion 走不走 canUseTool
// ---------------------------------------------------------------------------

/** @param {{ databasePath: string, seconds: number }} args */
export async function experimentE8({ databasePath, seconds }) {
  const room = prepareRoom('e8');
  let canUseToolCalls = 0;
  /** @type {string[]} */
  const toolNames = [];
  const mock = await startMockAnthropic((_request, index) => {
    if (index === 0) {
      return toolUseStream('toolu_ask_e8', 'AskUserQuestion', {
        questions: [{ question: '选一个', header: 'E8', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
      });
    }
    return textStream('done');
  });
  const input = createInputQueue();
  const abortController = new AbortController();
  /** @type {any[]} */
  const messages = [];
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: mock.baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'resident-experiment-token',
    CLAUDE_CONFIG_DIR: room.configDir,
    DATABASE_PATH: databasePath,
  };
  delete env.ANTHROPIC_API_KEY;
  const q = query({
    prompt: input,
    options: {
      cwd: room.dir,
      env,
      abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      canUseTool: async (/** @type {string} */ toolName) => {
        canUseToolCalls += 1;
        toolNames.push(toolName);
        return { behavior: 'deny', message: 'E8 探针：无人值守，自动拒绝' };
      },
    },
  });
  const loop = (async () => {
    try {
      for await (const m of q) { const raw = /** @type {any} */ (m); messages.push({ at: new Date().toISOString(), type: raw.type, subtype: raw.subtype ?? null }); }
    } catch { /* 忽略 */ }
  })();
  try {
    input.push('请问我一个问题');
    await delay(Math.max(10_000, seconds * 1000));
  } finally {
    input.close();
    try { abortController.abort(); } catch { /* 已关闭 */ }
    await Promise.race([loop, delay(10_000)]);
    await mock.close();
  }
  const rawLines = [
    `permissionMode：bypassPermissions`,
    `canUseTool 被调用次数：${canUseToolCalls}`,
    `拦截到的工具名：${toolNames.join(', ') || '（无）'}`,
    `消息类型序列：${messages.map((m) => (m.subtype ? `${m.type}/${m.subtype}` : m.type)).join(' → ')}`,
  ];
  const conclusion = canUseToolCalls > 0
    ? `bypassPermissions 下 AskUserQuestion **仍然**走 canUseTool（被调用 ${canUseToolCalls} 次，工具名 ${toolNames.join(', ')}），可以在回调里拦截。`
    : 'bypassPermissions 下 AskUserQuestion **没有**走 canUseTool——无人时的自动拒绝不能靠这个回调实现，需另找入口。';
  return { section: formatSection({ meta: await sectionMeta(), rawLines, conclusion }), sectionId: 'E8' };
}

// ---------------------------------------------------------------------------
// 子进程角色（E5 用）：持有一个常驻进程，把 claude pid 报到 stdout
// ---------------------------------------------------------------------------

/** @param {string} dir @param {string} databasePath */
async function holdResidentRole(dir, databasePath) {
  let mock = await startMockAnthropic(() => textStream('holder'));
  const resident = startResident({ cwd: dir, mockBaseUrl: mock.baseUrl, configDir: path.join(dir, 'claude-config'), databasePath });
  resident.send('holder 起床');
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const pids = descendantClaudePids(process.pid);
    if (pids.length > 0) {
      process.stdout.write(`RESIDENT_PID=${pids[0]}\n`);
      break;
    }
    await delay(200);
  }
  // 撑着 stdin 不关：被杀之前一直活着。
  await new Promise(() => {});
  await mock.close();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * 静默跑一个命令并返回 stdout（tmux 等）。
 * @param {string} command
 * @param {string[]} argv
 */
function spawnSyncQuiet(command, argv) {
  const result = spawnSync(command, argv, { encoding: 'utf8' });
  return (result.stdout ?? '') + (result.stderr ?? '');
}

/**
 * 只看退出码。`spawnSyncQuiet` 把 stderr 拼进返回值，于是"会话不存在"（tmux 往 stderr 写
 * `can't find session`）看起来**非空**——用真值判断会把死会话读成活会话。
 * @param {string} command
 * @param {string[]} argv
 */
function spawnSyncStatus(command, argv) {
  return spawnSync(command, argv, { encoding: 'utf8' }).status ?? -1;
}

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {Record<string, string | undefined>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[token.slice(2)] = next; i += 1; }
      else flags[token.slice(2)] = 'true';
    }
  }
  return flags;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);

  // 子进程角色，先于一切护栏（它由 E5 自己起，环境已核对过）。
  if (argv[0] === '--hold-resident') {
    await holdResidentRole(argv[1], argv[2]);
    return;
  }

  const record = flags.record ?? DEFAULT_RECORD;

  if (argv[0] === '--check-record') {
    const target = flags['check-record'] !== undefined && flags['check-record'] !== 'true' ? flags['check-record'] : record;
    const missing = checkRecordFile(target);
    if (missing.length === 0) {
      process.stdout.write(`--check-record OK：E1–E8 八节齐全（${target}）\n`);
      return;
    }
    process.stderr.write(`--check-record 未通过（${target}）：\n`);
    for (const item of missing) process.stderr.write(`  ${item.id}：${item.reason}\n`);
    process.exitCode = 1;
    return;
  }

  const sub = argv[0];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    process.stdout.write('用法：node scripts/resident-experiment.mjs <e1..e8> --database-path <临时库> [--record <文件>]\n');
    process.stdout.write('      node scripts/resident-experiment.mjs e2 --interactive --seconds <秒>   # 交互式 CLI 那一半\n');
    process.stdout.write('      node scripts/resident-experiment.mjs e7 --hours <小时> --interval-ms <毫秒> [--real]   # --real = 真实模型\n');
    process.stdout.write('      node scripts/resident-experiment.mjs --check-record <文件>\n');
    return;
  }
  if (!/^e[1-8]$/.test(sub)) {
    process.stderr.write(`未知子命令：${sub}\n`);
    process.exitCode = 2;
    return;
  }

  // 护栏：临时库三条 + 端口。任一条不过就 exit 1，且不产生读数。
  const databasePath = assertIsolatedDatabasePath({
    databasePath: flags['database-path'],
    ambientDatabasePath: process.env.DATABASE_PATH,
  });
  const seconds = Number(flags.seconds ?? '180');
  if (!Number.isFinite(seconds) || seconds <= 0) throw new GuardRefusal(`--seconds 非法：${flags.seconds}`);

  /** @type {{ section: string, sectionId: string }} */
  let result;
  if (sub === 'e1') result = await experimentE1({ databasePath, seconds });
  else if (sub === 'e2') {
    result = flags.interactive === 'true'
      ? await experimentE2Interactive({ databasePath, seconds })
      : await experimentE2StreamJson({ databasePath, seconds });
  } else if (sub === 'e3') result = await experimentE3({ databasePath, seconds });
  else if (sub === 'e4') result = await experimentE4({ databasePath });
  else if (sub === 'e5') result = await experimentE5({ databasePath, seconds });
  else if (sub === 'e6') result = await experimentE6({ databasePath, seconds });
  else if (sub === 'e7') {
    const intervalMs = flags['interval-ms'] === undefined ? 5 * 60 * 1000 : Number(flags['interval-ms']);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new GuardRefusal(`--interval-ms 非法：${flags['interval-ms']}`);
    result = await experimentE7({ databasePath, hours: Number(flags.hours ?? '24'), intervalMs, real: flags.real === 'true' });
  }
  else result = await experimentE8({ databasePath, seconds });

  // E2 的两半都写同一个 E2 小节，所以交互式那一半是**追加**而不是覆盖。
  if (sub === 'e2' && flags.interactive === 'true' && fs.existsSync(record)) {
    const existing = extractSection(fs.readFileSync(record, 'utf8'), 'E2');
    if (existing !== null && existing.includes('交互式 CLI 形态')) {
      process.stdout.write('E2 交互式读数已存在，跳过覆盖。\n');
      return;
    }
    upsertSection(record, 'E2', `${existing ?? ''}\n\n### 交互式 CLI 形态\n\n${result.section.replace(/^##\s+E2.*$/m, '').trim()}\n`);
    process.stdout.write(`E2 交互式读数已追加到 ${record}\n`);
    return;
  }

  upsertSection(record, result.sectionId, result.section);
  process.stdout.write(`${result.sectionId} 读数已写入 ${record}\n`);
}

// 只有本文件被**直接执行**时才跑 CLI：`scripts/resident-experiment.test.mjs` 与把各实验片段合并成
// 记录文件的脚本都要 `import` 这个模块，导入不该有副作用（否则导入方会看到一段用法输出，退出码也
// 被一并改写）。按 realpath 比较，脚本经符号链接调用时也认得出是自己。
const invokedDirectly = process.argv[1] !== undefined
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error) => {
    if (error instanceof GuardRefusal) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
