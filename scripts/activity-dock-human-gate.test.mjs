#!/usr/bin/env node
// activity-dock-human-gate.test.mjs —— `scripts/activity-dock-human-gate.mjs` 的护栏判据（AC3/AC4）。
//
// 为什么这份护栏值得有自己的测试
// ------------------------------
// AC-190 的判据是一条 `grep -c '^- 人工验收 GOAL-014：accepted'`，它数的是**行首**匹配。于是
// 记录小节里最容易被模板自身点亮：只要说明格式的那一行以人证行的行首形式出现，人还没验收判据就绿了。
// 所以「模板泄漏判红」不是风格问题，是这条人工关卡唯一挡得住作弊的东西 —— 它必须被钉住，而且必须由
// **真的跑一遍 CLI**来钉，不是只调一次纯函数（`main()` 的接线本身也会坏）。
//
// 覆盖：
//   1. 缺文件 → exit 1 并点名；
//   2. 缺小节 → exit 1 并点名该小节；
//   3. 缺任一件事（三件要读的事各删一次）→ exit 1 并点名；
//      —— 其中「删去『计时不再前进』」是 AC4 的**正控制**：证明校验不是恒真；
//   4. 小节齐全但人证行缺失 → exit 0 且 stdout 含 `人证行：absent`；
//   5. 小节齐全且人证行带载荷 → exit 0 且 stdout 含 `人证行：present`；
//   6. 行首模板泄漏 → exit 1 并点名；
//   7. 真实提案文件 → exit 0（这是 AC2 的判据本身）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HUMAN_LINE_PREFIX,
  RECORD_SECTION_TITLE,
  REQUIRED_ITEMS,
  checkRecordText,
  extractSection,
  scanHumanLine,
} from './activity-dock-human-gate.mjs';

const SCRIPT = fileURLToPath(new URL('./activity-dock-human-gate.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(SCRIPT), '..');
/** AC2 的判据文件：真实提案。 */
const REAL_RECORD = path.join(ROOT, 'docs/proposals/claude-session-activity-dock.md');

/** 三件人要读到的事（AC2 逐字）；列表化是为了「缺任一件事」能逐个删。 */
const READINGS = ['连接中断', '不再显示 Thinking', '计时不再前进'];

/** @param {string[]} argv */
function runCli(argv) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' });
}

/**
 * 一份小节齐全的最小记录。`omit` 里的短语会被删掉（用来造「缺任一件事」的红态），
 * `humanLine` 非空时追加一行**行首**人证行（用来造 present/leak 两态）。
 * @param {{ omit?: string[], humanLine?: string }} [opts]
 */
function sampleRecord({ omit = [], humanLine = '' } = {}) {
  const readings = READINGS.filter((reading) => !omit.includes(reading)).join(' / ');
  const tail = humanLine === '' ? '' : `${humanLine}\n`;
  return [
    '# 样本记录',
    '',
    `## ${RECORD_SECTION_TITLE}`,
    '',
    '1. 让一个会话处于处理中。',
    '2. 停掉或杀掉服务端。',
    '3. 约 15 秒内读坞。',
    '4. 重启服务端看恢复。',
    '',
    `- 人要读到的三件事：${readings}。`,
    '- 人证行格式（只由人写）：`- 人工验收 GOAL-014：accepted <人> <日期>`。',
    '- 执行者不得代写。',
    '',
    tail,
  ].join('\n');
}

/**
 * 把内容写进一个临时文件，返回其路径（测试自清理）。
 * @param {string} content
 */
function tempRecord(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-dock-human-gate-'));
  const file = path.join(dir, 'record.md');
  fs.writeFileSync(file, content);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('缺文件：exit 1 并点名文件不存在', () => {
  const missing = path.join(os.tmpdir(), 'activity-dock-human-gate-absent-record.md');
  assert.equal(fs.existsSync(missing), false);
  const result = runCli(['--check-record', missing]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('记录文件不存在'), `stderr 应点名文件不存在，实际：${result.stderr}`);
});

test('缺小节：exit 1 并点名该小节', () => {
  const { file, cleanup } = tempRecord('# 样本记录\n\n## 别的小节\n\n无关内容。\n');
  try {
    const result = runCli(['--check-record', file]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(RECORD_SECTION_TITLE), `stderr 应点名小节，实际：${result.stderr}`);
  } finally {
    cleanup();
  }
});

test('缺任一件事：三件各删一次都 exit 1 并点名', () => {
  for (const reading of READINGS) {
    const { file, cleanup } = tempRecord(sampleRecord({ omit: [reading] }));
    try {
      const result = runCli(['--check-record', file]);
      assert.equal(result.status, 1, `删去「${reading}」后应 exit 1`);
      assert.ok(result.stderr.includes(reading), `stderr 应点名「${reading}」，实际：${result.stderr}`);
    } finally {
      cleanup();
    }
  }
});

test('AC4 正控制：删去「计时不再前进」前 exit 0、删后 exit 1（打印两次读数）', () => {
  const before = tempRecord(sampleRecord());
  const after = tempRecord(sampleRecord({ omit: ['计时不再前进'] }));
  try {
    const beforeResult = runCli(['--check-record', before.file]);
    const afterResult = runCli(['--check-record', after.file]);
    console.log(`[正控制] 删前 exit=${beforeResult.status} stdout=${beforeResult.stdout.trim()}`);
    console.log(`[正控制] 删后 exit=${afterResult.status} stderr=${afterResult.stderr.trim()}`);
    assert.equal(beforeResult.status, 0, '删前应 exit 0（样本本身合格）');
    assert.equal(afterResult.status, 1, '删后应 exit 1（正控制必须红）');
    assert.ok(
      afterResult.stderr.includes('计时不再前进'),
      `删后应点名「计时不再前进」，实际：${afterResult.stderr}`,
    );
  } finally {
    before.cleanup();
    after.cleanup();
  }
});

test('小节齐全且人证行缺失：exit 0 且打印 人证行：absent', () => {
  const { file, cleanup } = tempRecord(sampleRecord());
  try {
    const result = runCli(['--check-record', file]);
    assert.equal(result.status, 0, `应 exit 0，stderr=${result.stderr}`);
    assert.ok(result.stdout.includes('人证行：absent'), `stdout 应含 人证行：absent，实际：${result.stdout}`);
  } finally {
    cleanup();
  }
});

test('小节齐全且人证行带载荷：exit 0 且打印 人证行：present', () => {
  const { file, cleanup } = tempRecord(sampleRecord({ humanLine: `${HUMAN_LINE_PREFIX} yale 2026-10-02` }));
  try {
    const result = runCli(['--check-record', file]);
    assert.equal(result.status, 0, `应 exit 0，stderr=${result.stderr}`);
    assert.ok(result.stdout.includes('人证行：present'), `stdout 应含 人证行：present，实际：${result.stdout}`);
  } finally {
    cleanup();
  }
});

test('行首模板泄漏：exit 1 并点名', () => {
  const { file, cleanup } = tempRecord(sampleRecord({ humanLine: `${HUMAN_LINE_PREFIX} <人> <日期>` }));
  try {
    const result = runCli(['--check-record', file]);
    assert.equal(result.status, 1, '模板泄漏应 exit 1');
    assert.ok(result.stderr.includes('模板泄漏'), `stderr 应点名模板泄漏，实际：${result.stderr}`);
  } finally {
    cleanup();
  }
});

test('正控制：格式模板内联（行首不是人证行）时不算泄漏', () => {
  const text = sampleRecord();
  assert.equal(scanHumanLine(text).state, 'absent');
  assert.equal(checkRecordText(text).missing.length, 0);
});

test('真实提案文件是 AC2 的判据：exit 0', () => {
  const result = runCli(['--check-record', REAL_RECORD]);
  assert.equal(result.status, 0, `真实提案应 exit 0，stderr=${result.stderr}`);
  assert.ok(result.stdout.includes('人证行：absent'), `交付时人证行应为 absent，实际：${result.stdout}`);
});

test('纯函数：小节抽取按整行相等，不会误配别的小节', () => {
  assert.equal(extractSection(sampleRecord(), RECORD_SECTION_TITLE)?.includes('停掉或杀掉服务端'), true);
  assert.equal(extractSection(`## ${RECORD_SECTION_TITLE} 别的东西\n`, RECORD_SECTION_TITLE), null);
});

test('REQUIRED_ITEMS 覆盖四步 + 三件事 + 格式 + 声明', () => {
  const names = REQUIRED_ITEMS.map((item) => item.name).join('\n');
  for (const needle of ['处理中', '停掉或杀掉服务端', '约 15 秒内', '重启', '恢复', ...READINGS, '格式', '只由人写']) {
    assert.ok(names.includes(needle), `REQUIRED_ITEMS 应覆盖「${needle}」`);
  }
});
