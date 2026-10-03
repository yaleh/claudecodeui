#!/usr/bin/env node
// activity-dock-human-gate.mjs —— AC-190 人工关卡的取证通道（**只读**）。
//
// 本条是 GOAL-014 的 L4 人工关卡（提案 §10.3 表格末行逐字）：真实部署上真的停掉/杀掉服务端，
// 肉眼读到坞的状态。这份脚本既不写产品代码（坞、心跳、新鲜度状态机由 AC-182…AC-189 落地），
// 也**不写记录**：它只把两件事读出来 —— 「人工验收小节是否写全」与「人证行是否已经由人写下」。
//
// 判据（AC-190 的 criterion 逐字）数的是**行首**匹配：
//   grep -c '^- 人工验收 GOAL-014：accepted' docs/proposals/claude-session-activity-dock.md
// 所以记录小节里说明格式时，那一段模板**必须以行首之外的形式**出现；一旦它以行首形式出现、
// 又不带 `<人> <日期>` 两段载荷，就是模板泄漏 —— 人还没验收，判据就被模板自己点绿了。
// 本脚本把这一种情况判红（`state === 'leak'`），这是本条唯一的机械陷阱。
//
// 用法：
//   node scripts/activity-dock-human-gate.mjs --check-record <记录文件>
//
// 退出码：0 = 小节齐全且无模板泄漏（stdout 打印 `人证行：absent|present`）；1 = 缺项或泄漏。
// 本文件没有任何写盘路径（只有 fs.existsSync / fs.readFileSync）：AC6 用一条 fs 写调用的
// 名字正则把「人证行不可能由执行者代写」钉成机械事实 —— 那个正则的逐字放在任务文件里，
// 故意**不**抄进本文件，否则注释自己就会命中它。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 记录小节标题（提案 §11）。整行相等比对，所以不会被别的小节误配。 */
export const RECORD_SECTION_TITLE = '11. 人工验收记录（GOAL-014 / AC-190）';

/** 人证行的行首逐字前缀 —— 与 AC-190 判据 grep 的那一段必须逐字一致。 */
export const HUMAN_LINE_PREFIX = '- 人工验收 GOAL-014：accepted';

/** 载荷里的占位符：出现它们说明写的是格式模板，不是人证。 */
export const PLACEHOLDERS = ['<人>', '<日期>'];

/**
 * 人工验收小节必须逐项齐全的清单：四步人工步骤 + 三件人要读到的事 + 人证行格式说明 + 只由人写的声明。
 * `name` 里带上要点逐字，缺哪项就在 stderr 里点名哪项 —— AC4 的正控制（删去「计时不再前进」即红）
 * 靠的就是这条：读数里能直接读到缺的那句话。
 */
export const REQUIRED_ITEMS = [
  { name: '步骤一「让一个会话处于处理中」', needles: ['处理中'] },
  { name: '步骤二「停掉或杀掉服务端」', needles: ['停掉或杀掉服务端'] },
  { name: '步骤三「约 15 秒内读坞」', needles: ['约 15 秒内'] },
  { name: '步骤四「重启服务端看恢复」', needles: ['重启', '恢复'] },
  { name: '人要读到的第一件事「连接中断」', needles: ['连接中断'] },
  { name: '人要读到的第二件事「不再显示 Thinking」', needles: ['不再显示 Thinking'] },
  { name: '人要读到的第三件事「计时不再前进」', needles: ['计时不再前进'] },
  { name: '人证行格式说明', needles: ['人工验收 GOAL-014：accepted', '<人> <日期>'] },
  { name: '「只由人写」声明', needles: ['只由人写'] },
];

/**
 * 抽出某个 `##` 小节的正文（从 `## <标题>` 到下一个 `## ` 或文件尾）。
 *
 * 标题整行相等（尾部允许空白），所以 `## 11. …` 不会匹配到标题里含同样字样的别处。
 * @param {string} text
 * @param {string} title
 * @returns {string | null}
 */
export function extractSection(text, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##[ \\t]+${escaped}[ \\t]*$`, 'm');
  const match = heading.exec(text);
  if (match === null) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = /^##[ \t]+/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/**
 * 扫描**行首**以 `HUMAN_LINE_PREFIX` 开头的行，判定人证行状态。
 *
 * 三种读数：
 *   · `absent` —— 一行都没有：人还没验收（这是交付时应有的状态）。
 *   · `present` —— 至少一行带了 `<人> <日期>` 两段真载荷。
 *   · `leak` —— 出现了行首匹配但**不带**载荷（或载荷就是 `<人>`/`<日期>` 占位符）：格式模板泄漏，
 *     判据会被模板自己点绿。泄漏压过 present：记录里同时存在两种行时，泄漏本身就是缺陷。
 *
 * @param {string} text
 * @returns {{ state: 'absent' | 'present' | 'leak', line: string | null, reason: string | null }}
 */
export function scanHumanLine(text) {
  const lines = text.split('\n').filter((line) => line.startsWith(HUMAN_LINE_PREFIX));
  if (lines.length === 0) return { state: 'absent', line: null, reason: null };
  /** @type {string[]} */
  const leaks = [];
  let present = false;
  for (const line of lines) {
    const payload = line.slice(HUMAN_LINE_PREFIX.length);
    const match = /^\s+(\S+)\s+(\S+)\s*$/.exec(payload);
    if (match !== null && !PLACEHOLDERS.includes(match[1]) && !PLACEHOLDERS.includes(match[2])) {
      present = true;
      continue;
    }
    leaks.push(line);
  }
  if (leaks.length > 0) {
    return {
      state: 'leak',
      line: leaks[0],
      reason: `行首出现人证行但缺 <人> <日期> 两段载荷（模板泄漏）：${leaks[0]}`,
    };
  }
  return { state: present ? 'present' : 'absent', line: null, reason: null };
}

/**
 * 逐项检查记录文本。返回缺什么（`missing` 为空 = 合格）与人证行状态。
 *
 * 「缺小节」与「小节在但缺某项」是两种不同的缺失，分开报：只报前者会让写了一半的小节看起来像没写。
 * 模板泄漏扫的是**整个文件**（AC 措辞是「文件里出现行首 …」），不只小节内。
 * @param {string} text
 * @returns {{ missing: Array<{ item: string, reason: string }>, humanLine: 'absent' | 'present' | 'leak' }}
 */
export function checkRecordText(text) {
  /** @type {Array<{ item: string, reason: string }>} */
  const missing = [];
  const section = extractSection(text, RECORD_SECTION_TITLE);
  if (section === null) {
    missing.push({ item: `小节「${RECORD_SECTION_TITLE}」`, reason: '缺整个人工验收记录小节' });
  } else {
    for (const item of REQUIRED_ITEMS) {
      const absent = item.needles.filter((needle) => !section.includes(needle));
      if (absent.length > 0) {
        const named = absent.map((needle) => `「${needle}」`).join('');
        missing.push({ item: item.name, reason: `小节里找不到 ${named}` });
      }
    }
  }
  const human = scanHumanLine(text);
  if (human.state === 'leak') missing.push({ item: '人证行模板泄漏', reason: human.reason ?? '' });
  return { missing, humanLine: human.state };
}

/**
 * `--check-record`：逐项检查，缺哪项点名哪项；齐全 exit 0 并打印人证行状态。
 * @param {string} filePath
 * @returns {number} 进程退出码
 */
export function runCheckRecord(filePath) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`缺项：记录文件不存在（${filePath}）\n`);
    process.stderr.write(`记录不合格（${filePath}）：缺 1 处；要求见 AC2。\n`);
    return 1;
  }
  const result = checkRecordText(fs.readFileSync(filePath, 'utf8'));
  if (result.missing.length === 0) {
    process.stdout.write(`记录合格：${filePath} 人工验收小节齐全且无模板泄漏；人证行：${result.humanLine}\n`);
    return 0;
  }
  for (const entry of result.missing) {
    process.stderr.write(`缺项：${entry.item} —— ${entry.reason}\n`);
  }
  process.stderr.write(`记录不合格（${filePath}）：缺 ${result.missing.length} 处；要求见 AC2。\n`);
  return 1;
}

/**
 * 手写 flag 解析：`--k v` 与 `--k=v` 两种都收。
 * @param {string[]} argv
 * @returns {Record<string, string | undefined>}
 */
export function parseFlags(argv) {
  /** @type {Record<string, string | undefined>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[token.slice(2)] = next;
      i += 1;
    } else {
      flags[token.slice(2)] = 'true';
    }
  }
  return flags;
}

/**
 * 主入口。本脚本只读：没有任何分支会写盘。
 * @param {string[]} argv
 * @returns {number} 进程退出码
 */
export function main(argv) {
  const flags = parseFlags(argv);
  if (flags['check-record'] === undefined) {
    process.stderr.write('用法：node scripts/activity-dock-human-gate.mjs --check-record <记录文件>\n');
    return 2;
  }
  return runCheckRecord(flags['check-record']);
}

// 只有本文件被**直接执行**时才跑 CLI：判据要 `import` 它的纯函数，导入不该有副作用。
// 按 realpath 比较，脚本经符号链接调用时也认得出是自己。
const invokedDirectly = process.argv[1] !== undefined
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
