#!/usr/bin/env node
/**
 * 假化控制：`scripts/suite-concurrency-check.sh` 自身的墙钟预算闸。
 *
 * 背景（AC-103 / task gap-suite-criterion-wallclock-budget）：那条判据要跑两遍服务端逐文件
 * 读数，而两遍都由同一个 32s 的最重文件定价，于是它自己就装不进 goal 判据 gate 的 60000ms
 * 硬上限。修法是两件事：①安静基线的持久复用（省掉重复的那一遍）；②预算闸 —— 装不下时以
 * exit 3 `not-evaluated` 收场，⛔ 不是被判红（旧形态里「超预算」唯一可能的表达就是被外层
 * SIGKILL，然后记成 verdict=fail，与被检测的互拖红同形）。
 *
 * 这个文件证伪的是 ② 的【机制】，不是它的墙钟数字（那由 AC1 的实跑读数负责）：
 * 夹具把两个阶段缩到毫秒级（stub `bash scripts/test.sh` 按收到的文件参数逐条吐 __PERFILE__
 * 行；stub `npx` 睡一小会儿后退出 0，于是两份套件有正的并发重叠），判据的形状、基线键、
 * 命中前的逐项再校验、判定语义全部照跑。
 *
 * 覆盖（AC4 逐条）：
 *   T1 默认预算字面量（判词里是 /60000ms）+ 正面控制：预算充裕时【不因预算红】，
 *      且覆盖面无损（安静读数条数 = 判据真正枚举出的服务端文件数）。
 *   T2 第二次运行真的复用基线（判词点名 provenance），不是每次都重量。
 *   T3 `--budget-ms` 覆盖判词里的字面量（45000），且判定结论不变。
 *   T4 超预算 ⇒ exit 3，判词点名预算与实测墙钟，且【不打印任何红/绿判词】。
 *   T5 阶段被剩余预算夹断（开工了但跑不完）⇒ 同样 exit 3，而不是假红。
 *   T6 冷启动的活读数【完整】落盘：在「安静相跑完就落盘」与「结尾再落盘」之间退出的路径
 *      （fail-closed / 预算闸）上，只有前一次写生效 —— 它必须带上真的 median/n。
 *   T7 estimate 段的 `0` 是【没量过】的占位而不是读数：并发相窗口为 0 时，估计必须落到
 *      安静相窗口那格真读数，⛔ 不许短接到冷地板 45000（判词点名的来源就是这件事的读数）。
 *   T8–T11 是【逐文件再校验】那一半（`gap-ac103-whole-set-baseline-key-revives-full-quiet-phase`），
 *      跑在一棵临时树里（判据的 ROOT_DIR 由 BASH_SOURCE 推出 ⇒ 服务端文件集可数）：
 *   T8 粒度是【内容】不是 mtime：touch 一个文件后仍然全命中，且安静相一次读数都没跑。
 *   T9 内容变了的那个文件重量、其余复用：读数只收到那一个文件，复用的读数逐条来自记录
 *      （这一轮的伪读数被换成 777ms ⇒ 表里只有那一个是 777，其余仍是上一轮的 50 ——
 *      「重量」与「复用」在读数上不可互换），中位分母仍是整个文件集。
 *   T10 ⛔ 没有逐文件表就一条都不许复用：删表 ⇒ 全部重量（复用必须逐条有据）。
 *   T11 表里没有的文件（新增）也只重量它自己，且这一相把表补全 ⇒ 下一相全命中。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const CRITERION = path.join(SCRIPT_DIR, 'suite-concurrency-check.sh');

// ⛔ 真 bash 必须在改 PATH 【之前】解析：判据内部要调 `bash scripts/test.sh …`（那一条正是
// 夹具要拦的），而判据【自己】必须由真 bash 跑，否则 stub 会连判据一起接管。
const REAL_BASH = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

// 判词行（PASS/FAIL/NOT-EVALUATED 三种头）。
const VERDICT_RE = /^suite-concurrency-check: (PASS|FAIL|NOT-EVALUATED) /m;

/**
 * 夹具的根与三条被 stub 接管的路径（`bin` 前置进 PATH，`logs`/`cache` 由环境变量指进来）。
 *
 * @typedef {object} Fixture
 * @property {string} root
 * @property {string} bin
 * @property {string} logs
 * @property {string} cache
 */

/**
 * 一次判据运行的读数。`verdict` 只收判词行（PASS/FAIL/NOT-EVALUATED），`context` 把
 * stdout/stderr/exit 一并摊给断言，失败时不必再回捞日志。
 *
 * @typedef {object} CriterionRun
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} verdict
 * @property {(s: string) => string} context
 */

/**
 * 夹具：stub 掉被观测的两条命令，把每相从 ~32s 压到 ~0.3s。
 * stub 只拦 `bash scripts/test.sh …`；其余 bash 调用回落真 bash。stub 从环境里读
 * SCC_TEST_STUB_SLEEP / SCC_TEST_STUB_DURATION，于是同一个夹具可以扮演「快相」与「慢相」。
 *
 * @returns {Fixture}
 */
function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'scc-budget-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });

  // ⛔ shebang 必须写【绝对的】真 bash，不能写 `#!/usr/bin/env bash`：stub 自己叫 bash 且
  // 排在 PATH 最前，`env bash` 会把 stub 当成解释器再 exec 一遍自己（实测报
  // `/usr/bin/env: 'bash': Argument list too long`，读数直接空掉）。
  writeFileSync(
    path.join(bin, 'bash'),
    `#!${REAL_BASH}
if [ "\${1:-}" = "scripts/test.sh" ]; then
  shift
  if [ -n "\${SCC_TEST_STUB_ARGS_LOG:-}" ]; then
    printf 'CALL' >> "\$SCC_TEST_STUB_ARGS_LOG"
    for a in "\$@"; do
      case "\$a" in --*) ;; *) printf ' %s' "\$a" >> "\$SCC_TEST_STUB_ARGS_LOG" ;; esac
    done
    printf '\\n' >> "\$SCC_TEST_STUB_ARGS_LOG"
  fi
  while [ "\$#" -gt 0 ]; do
    case "\$1" in
      --*) shift ;;
      *) dur="\${SCC_TEST_STUB_DURATION:-50}"
         if [ -n "\${SCC_TEST_STUB_DUR_MAP:-}" ]; then
           m="\$(awk -v p="\$1" '\$1 == p { print \$2; exit }' "\$SCC_TEST_STUB_DUR_MAP" 2>/dev/null)"
           [ -n "\$m" ] && dur="\$m"
         fi
         printf '__PERFILE__ duration_ms=%s %s passed=true end_ms=0\\n' "\$dur" "\$1"; shift ;;
    esac
  done
  exit 0
fi
exec ${REAL_BASH} "\$@"
`,
    { mode: 0o755 },
  );

  writeFileSync(
    path.join(bin, 'npx'),
    `#!${REAL_BASH}
exec sleep "\${SCC_TEST_STUB_SLEEP:-0.3}"
`,
    { mode: 0o755 },
  );

  return { root, bin, logs: path.join(root, 'logs'), cache: path.join(root, 'cache') };
}

/**
 * 跑一次判据：真 bash + 夹具的 PATH 前置（stub 只拦 `bash scripts/test.sh …`）。
 * 读数装进普通字面量对象返回 —— 直接往 spawnSync 的结果上挂属性在 `checkJs` 下过不了
 * typecheck（TS2339），而这份文件应当说得清自己带了什么。
 *
 * @param {Fixture} fx
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {CriterionRun}
 */
function runCriterion(fx, args, extraEnv = {}) {
  const r = spawnSync(REAL_BASH, [CRITERION, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      PATH: `${fx.bin}:${process.env.PATH}`,
      SCC_LOG_DIR: fx.logs,
      SCC_CACHE_DIR: fx.cache,
      ...extraEnv,
    },
  });
  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '');
  return {
    status: r.status,
    stdout,
    stderr,
    verdict: stdout
      .split('\n')
      .filter((l) => VERDICT_RE.test(`${l}\n`))
      .join('\n'),
    context: (s) => `${s}\n--- exit=${r.status}\n${stdout}\n${stderr}`,
  };
}

/** @param {import('node:test').TestContext} t @returns {Fixture} */
function fixture(t) {
  const fx = buildFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  return fx;
}

// ── T8–T11 的夹具：一个【可数的】服务端文件集 ────────────────────────────────
// 判据的 ROOT_DIR 由 BASH_SOURCE 推出、服务端文件集是 `find server …`（相对 ROOT_DIR）。
// 于是把判据脚本【原样复制】到一棵临时树里，它就只看得见那棵树里那几个合成文件 ——
// 这是「逐文件」这件事唯一测得动的前提：真仓的服务端文件上百个，「哪一个被复用了」不可断言。
// ⛔ 复制的就是本仓那一份脚本（不是改写过的副本）：被判的仍然是被判对象本身。

/** @param {import('node:test').TestContext} t @returns {string} 临时树根（内含 scripts/ 与 server/） */
function treeFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'scc-tree-'));
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'server', 'nested'), { recursive: true });
  copyFileSync(CRITERION, path.join(root, 'scripts', 'suite-concurrency-check.sh'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * 在临时树里跑一次判据（判据的 ROOT_DIR = 临时树，故服务端文件集 = 合成文件集）。
 * ⛔ 不设 SCC_LOG_DIR / SCC_CACHE_DIR：走判据自己的默认路径（<root>/.quay/…），
 * 于是这份测试顺带证明默认落点也在被覆盖的树里。
 *
 * @param {string} root
 * @param {Fixture} fx 只用它的 bin（stub 的 PATH）
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {CriterionRun}
 */
function runTree(root, fx, args, extraEnv = {}) {
  const r = spawnSync(REAL_BASH, [path.join(root, 'scripts', 'suite-concurrency-check.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, ...extraEnv },
  });
  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '');
  return {
    status: r.status,
    stdout,
    stderr,
    verdict: stdout
      .split('\n')
      .filter((l) => VERDICT_RE.test(`${l}\n`))
      .join('\n'),
    context: (s) => `${s}\n--- exit=${r.status}\n${stdout}\n${stderr}`,
  };
}

/** @param {string} p */
function sha256Of(p) {
  return execFileSync('sha256sum', [p], { encoding: 'utf8' }).split(' ')[0];
}

/**
 * stub 收到的每一次 `bash scripts/test.sh …` 调用的【文件参数】。stub 每被调用一行
 * `CALL <file>…` —— 于是「安静相这一次到底量了几个文件」是实测，不是推断。
 *
 * @param {string} logPath
 * @returns {string[][]}
 */
function stubCalls(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('CALL'))
    .map((l) => l.slice('CALL'.length).trim().split(/\s+/).filter(Boolean));
}

/**
 * 逐文件读数表 `<内容sha256> <duration_ms> <passed> <path>` → path → 那一行的三个字段。
 *
 * @param {string} root
 * @returns {Map<string, { sha: string, dur: string, passed: string }>}
 */
function tableMap(root) {
  const p = path.join(root, '.quay', 'suite-concurrency-check', 'cache', 'quiet-baseline.files');
  assert.ok(existsSync(p), `逐文件读数表应存在：${p}`);
  const out = new Map();
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const [sha, dur, passed, ...rest] = line.split(' ');
    out.set(rest.join(' '), { sha, dur, passed });
  }
  return out;
}

/** 一棵临时树里的合成服务端文件（含一个子目录、一个 .test.js —— 两条 find 分支都要覆盖）。 */
const SEED_FILES = [
  'server/alpha.test.ts',
  'server/beta.test.ts',
  'server/delta.test.js',
  'server/epsilon.test.ts',
  'server/nested/gamma.test.ts',
];

/** @param {string} root @param {string[]} files */
function seedServer(root, files) {
  for (const f of files) writeFileSync(path.join(root, f), `// ${f}\n`);
}

test('T1 默认预算字面量是 /60000ms；预算充裕时判据不因预算红（正面控制）', (t) => {
  const fx = fixture(t);
  const r = runCriterion(fx, ['--test-concurrency=8']);

  assert.equal(r.status, 0, r.context('默认预算下判据应为绿'));
  assert.match(r.verdict, /^suite-concurrency-check: PASS — /m, r.context('判词应为 PASS'));
  assert.match(r.verdict, /墙钟=\d+ms\/60000ms/, r.context('判词里的预算字面量应为 60000'));
  assert.doesNotMatch(r.verdict, /NOT-EVALUATED/, r.context('预算充裕时不该走 not-evaluated'));

  // 覆盖面正面控制：stub 逐条吐出的就是判据真正枚举出来的服务端文件集，
  // 所以「安静 n」必须与它同规模。这同时挡住「读数为空也照样绿」的解。
  const n = Number(r.verdict.match(/安静=\d+ms\(n=(\d+)\)/)?.[1] ?? -1);
  assert.ok(n >= 100, r.context(`服务端文件覆盖面不足：n=${n}`));

  // 冷缓存这一次是活读数，且把它落盘了（下一条 T2 就是靠它）。
  assert.match(r.verdict, /安静基线=活读数/, r.context('首次运行应为活读数'));
  assert.ok(
    existsSync(path.join(fx.cache, 'quiet-baseline.json')),
    r.context('安静基线应已落盘'),
  );
});

test('T2 第二次运行复用持久基线（判词点名复用与 provenance）', (t) => {
  const fx = fixture(t);
  const first = runCriterion(fx, ['--test-concurrency=8']);
  assert.equal(first.status, 0, first.context('预热运行应为绿'));

  const second = runCriterion(fx, ['--test-concurrency=8']);
  assert.equal(second.status, 0, second.context('复用基线的运行应为绿'));
  assert.match(
    second.verdict,
    /安静基线=复用\(key=[0-9a-f]{16}… 实测于 \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ 窗口=\d+ms 中位=\d+ms n=\d+ provenance=/,
    second.context('判词应点名复用与 provenance'),
  );
  // 复用的读数与活读数在下游同形：安静中位/n/rc 都还在判词里。
  assert.match(second.verdict, /安静=\d+ms\(n=\d+\)/, second.context('复用的读数应物化进判词'));
});

test('T3 --budget-ms 覆盖判词里的预算字面量，且判定结论不变', (t) => {
  const fx = fixture(t);
  const warm = runCriterion(fx, ['--test-concurrency=8']);
  assert.equal(warm.status, 0, warm.context('预热运行应为绿'));

  const r = runCriterion(fx, ['--test-concurrency=8', '--budget-ms', '45000']);
  assert.equal(r.status, 0, r.context('45000ms 预算下（相只有 ~0.3s）应为绿'));
  assert.match(r.verdict, /墙钟=\d+ms\/45000ms/, r.context('预算字面量应随 --budget-ms 改'));
  assert.doesNotMatch(r.verdict, /\/60000ms/, r.context('覆盖后不该还写着默认值'));
  assert.match(r.verdict, /K=4/, r.context('判定语义不该被预算改写（K 仍是 4）'));
});

test('T4 超过预算 ⇒ exit 3 not-evaluated，判词点名预算，且不打印任何红/绿判词', (t) => {
  const fx = fixture(t);
  // 冷缓存 + 预算远小于保守地板：预检直接不开工。
  const r = runCriterion(fx, ['--test-concurrency=8', '--budget-ms', '1000']);

  assert.equal(r.status, 3, r.context('超预算应以 exit 3 收场'));
  assert.match(r.verdict, /NOT-EVALUATED — 超出自身预算/, r.context('判词应自报未评估'));
  assert.match(r.verdict, /预算=1000ms/, r.context('判词应点名预算'));
  assert.match(r.verdict, /实测墙钟=\d+ms/, r.context('判词应带实测墙钟'));
  // 关键：不许出现红判词（旧形态里「超预算」只能表达成 verdict=fail）。
  assert.doesNotMatch(r.stdout, /^suite-concurrency-check: (PASS|FAIL) — /m, r.context('超预算不是判红'));
});

test('T5 阶段被剩余预算夹断（开工了但跑不完）⇒ exit 3，而不是假红', (t) => {
  const fx = fixture(t);
  // 先按快相预热：记下的「历史相窗口」很小 ⇒ 下一次预检会放行。
  const warm = runCriterion(fx, ['--test-concurrency=8'], { SCC_TEST_STUB_SLEEP: '0.3' });
  assert.equal(warm.status, 0, warm.context('预热运行应为绿'));

  // 再让套件变慢：这一相装得进预检估计，却跑不过剩余预算 ⇒ 被 timeout 夹断。
  // 这正是旧的失败形状（判据没跑完 ⇒ 外层 SIGKILL ⇒ verdict=fail「超时」）。
  const cut = runCriterion(fx, ['--test-concurrency=8', '--budget-ms', '2000'], {
    SCC_TEST_STUB_SLEEP: '30',
  });

  assert.equal(cut.status, 3, cut.context('被夹断应以 exit 3 收场'));
  assert.match(cut.verdict, /NOT-EVALUATED/, cut.context('判词应自报未评估'));
  assert.match(cut.verdict, /预算=2000ms/, cut.context('判词应点名预算'));
  assert.match(
    cut.stdout,
    /被本阶段的剩余预算夹断|判据自身墙钟越过预算/,
    cut.context('判词应点名是「没跑完」而不是「跑红了」'),
  );
  assert.doesNotMatch(cut.stdout, /^suite-concurrency-check: FAIL — /m, cut.context('夹断不是判红'));
});

test('T6 冷启动的活读数会被完整落盘（median/n 不是 0），复用命中时才抄不出假读数', (t) => {
  const fx = fixture(t);
  // `--concurrency 1` 让判据在【安静相已跑、结尾 write_state 还没到】之间就 fail-closed 退出，
  // 于是「安静相一跑完就落盘」的那次写是本次唯一的写。若它只写 window_ms、把 median/n 留成
  // 默认的 0，记录里就永久是 0，此后每次复用命中都会把这组 0 原样抄进判词 —— 判词会自己
  // 说出一条假读数（基线其实量到了上百个文件）。
  const r = runCriterion(fx, ['--test-concurrency=8', '--concurrency', '1']);
  assert.equal(r.status, 1, r.context('并发数 1 应 fail-closed 退出'));
  assert.match(r.verdict, /FAIL — 并发数 1 < 2/, r.context('应为 fail-closed 判词'));

  const saved = JSON.parse(readFileSync(path.join(fx.cache, 'quiet-baseline.json'), 'utf8'));
  assert.ok(saved.quiet.n >= 100, r.context(`落盘的安静条数应是真的（实得 n=${saved.quiet.n}）`));
  assert.ok(
    saved.quiet.median_ms > 0,
    r.context(`落盘的安静中位耗时应是真的（实得 ${saved.quiet.median_ms}ms）`),
  );

  // 复用这一份：判词点名的中位/n 必须与落盘的一致，而不是 0。
  const warm = runCriterion(fx, ['--test-concurrency=8']);
  assert.equal(warm.status, 0, warm.context('复用基线后应为绿'));
  assert.match(
    warm.verdict,
    new RegExp(`中位=${saved.quiet.median_ms}ms n=${saved.quiet.n} provenance=`),
    warm.context('复用命中时判词不该把中位/n 写成 0'),
  );
});

test('T7 estimate 的 `0` 是「没量过」不是读数：必须回退到安静相窗口，不许短接到冷地板', (t) => {
  const fx = fixture(t);
  // 先真跑一次，让判据自己写出一份【键与读数日志都对得上】的记录 —— 下面只动 estimate 段。
  const warm = runCriterion(fx, ['--test-concurrency=8']);
  assert.equal(warm.status, 0, warm.context('预热运行应为绿'));

  const statePath = path.join(fx.cache, 'quiet-baseline.json');
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));

  // 默认路径跑完一次后，并发相【真的被量过】⇒ 那一格是真读数，不是占位。
  assert.ok(
    Number(saved.estimate.concurrent_window_ms) > 0,
    warm.context(`跑完一次默认路径后并发相窗口应 > 0（实得 ${saved.estimate.concurrent_window_ms}）`),
  );

  // 冷路径落盘的形状：并发相还没被量过 ⇒ concurrent_window_ms = 0，而安静相窗口是真读数。
  // ⛔ 只改这两格：键/日志 sha/覆盖面三样再校验都在 cache_load 里，动别处就变 miss 了。
  const quietWindowMs = 90000;
  saved.estimate.concurrent_window_ms = 0;
  saved.estimate.quiet_window_ms = quietWindowMs;
  writeFileSync(statePath, JSON.stringify(saved));

  // 预算落在这两格之间：quiet 窗口 × 5/4 = 112500 > 100000 ⇒ 预检必然在并发相开工前
  // not-evaluated，而它的判词里带着「这个估计是从哪来的」。若回退够不到 quiet 那格，
  // 估计就退回冷地板 45000（×5/4 = 56250 < 100000），预检放行、判据转而跑完变绿。
  const r = runCriterion(fx, ['--test-concurrency=8', '--budget-ms', '100000']);

  assert.equal(r.status, 3, r.context('预检应判 not-evaluated（estimate 段必须被当成读数用）'));
  assert.match(r.verdict, /NOT-EVALUATED — 超出自身预算/, r.context('判词应自报未评估'));
  assert.match(r.verdict, /预算=100000ms/, r.context('判词应点名预算'));
  assert.match(
    r.verdict,
    new RegExp(`历史相窗口 ${quietWindowMs}ms × 5/4`),
    r.context('0 必须回退到安静相窗口那格真读数'),
  );
  assert.doesNotMatch(
    r.verdict,
    /无历史读数，保守地板/,
    r.context('quiet 窗口还在时不许短接到冷地板（0 不是读数）'),
  );
});

// ── T8–T11：逐文件再校验（复用的颗粒度是【文件的内容】）──────────────────────
// 判词里那截归因读数是断言面：`安静相成本=模式:<m> 复用=<r>/<n> 重跑=[<名单>] 重跑窗口=<ms>ms`。

test('T8 复用的粒度是【内容】不是 mtime：touch 一个文件后仍然全命中，安静相一次读数都没跑', (t) => {
  const fx = fixture(t);
  const root = treeFixture(t);
  seedServer(root, SEED_FILES);
  const argsLog = path.join(root, 'stub-args.log');

  const warm = runTree(root, fx, ['--test-concurrency=4'], { SCC_TEST_STUB_ARGS_LOG: argsLog });
  assert.equal(warm.status, 0, warm.context('预热运行应为绿'));
  // 冷路径：整相活读数，一条都没复用。
  assert.match(warm.verdict, /安静基线=活读数/, warm.context('首次运行应为活读数'));
  assert.match(warm.verdict, /安静相成本=模式:live 复用=0\/5 /, warm.context('冷路径不该复用任何读数'));
  assert.equal(stubCalls(argsLog).length, 3, warm.context('冷路径的安静相 + 并发相各读过一次'));
  assert.equal(stubCalls(argsLog)[0].length, 5, warm.context('冷路径的安静相应量整个文件集'));

  // ⛔ 把 alpha 的 mtime 推到未来，内容一字未动。旧实现（整集「路径+大小+mtime」指纹）会因此
  // 判定键失配 ⇒ 整相重量；逐文件内容哈希这一版必须仍然全命中 —— mtime 只对「真的改了内容」
  // 敏感、对「只是摸了一下」过敏，两个方向都错。
  const future = Date.now() / 1000 + 4000;
  utimesSync(path.join(root, 'server', 'alpha.test.ts'), future, future);
  writeFileSync(argsLog, '');

  const again = runTree(root, fx, ['--test-concurrency=4'], { SCC_TEST_STUB_ARGS_LOG: argsLog });
  assert.equal(again.status, 0, again.context('touch 之后的运行应为绿'));
  assert.match(
    again.verdict,
    /安静相成本=模式:cached 复用=5\/5 重跑=\[无\] /,
    again.context('mtime 变了但内容没变 ⇒ 必须逐文件全命中'),
  );
  const calls = stubCalls(argsLog);
  assert.equal(calls.length, 2, again.context('全命中时安静相不许起读数：只剩并发相的两次'));
  for (const c of calls) {
    assert.equal(c.length, 5, again.context('并发相仍然是整个文件集'));
  }
});

test('T9 内容变了的那个文件重量、其余复用；中位分母仍是整个文件集', (t) => {
  const fx = fixture(t);
  const root = treeFixture(t);
  seedServer(root, SEED_FILES);
  const argsLog = path.join(root, 'stub-args.log');

  const warm = runTree(root, fx, ['--test-concurrency=4'], {
    SCC_TEST_STUB_ARGS_LOG: argsLog,
    SCC_TEST_STUB_DURATION: '50',
  });
  assert.equal(warm.status, 0, warm.context('预热运行应为绿'));

  // 改一个字符，并让 beta 这一步的伪读数变成 40ms（其余文件仍是 50ms）。⛔ 用【逐文件】的
  // 读数表而不是把整轮的伪读数换掉：并发相也要读同一张表，于是「安静 50 vs 并发 50」= 1.00×，
  // 判绿是它本来的理由，不是被 fixture 的常量差顶出来的。
  // 若实现把整集重量，quiet 的中位与表里的 alpha/delta/… 全都会变成新值 —— 复用的读数
  // 与重量的读数因此在【读数本身】上不可互换，而不是只靠条数说话。
  writeFileSync(path.join(root, 'server', 'beta.test.ts'), '// changed\n');
  const durMap = path.join(root, 'stub-dur.map');
  writeFileSync(
    durMap,
    SEED_FILES.map((f) => `${f} ${f === 'server/beta.test.ts' ? 40 : 50}`).join('\n') + '\n',
  );
  writeFileSync(argsLog, '');
  const again = runTree(root, fx, ['--test-concurrency=4'], {
    SCC_TEST_STUB_ARGS_LOG: argsLog,
    SCC_TEST_STUB_DURATION: '50',
    SCC_TEST_STUB_DUR_MAP: durMap,
  });

  assert.equal(again.status, 0, again.context('部分重量的运行应为绿'));
  assert.match(
    again.verdict,
    /安静相成本=模式:partial 复用=4\/5 重跑=\[server\/beta\.test\.ts\] 重跑窗口=\d+ms/,
    again.context('判词应点名「复用 4 条、只重跑 beta」'),
  );
  assert.match(again.verdict, /安静=\d+ms\(n=5\)/, again.context('中位分母仍是整个文件集'));

  const calls = stubCalls(argsLog);
  assert.equal(calls.length, 3, again.context('安静相 1 次 + 并发相 2 次'));
  assert.deepEqual(calls[0], ['server/beta.test.ts'], again.context('重跑相只许收到那一个文件'));

  const table = tableMap(root);
  assert.equal(table.size, 5, again.context('表应覆盖整个文件集'));
  assert.equal(
    table.get('server/beta.test.ts')?.dur,
    '40',
    again.context('被重跑的那条应是本节实测的新读数'),
  );
  for (const f of ['server/alpha.test.ts', 'server/delta.test.js', 'server/epsilon.test.ts', 'server/nested/gamma.test.ts']) {
    assert.equal(
      table.get(f)?.dur,
      '50',
      again.context(`复用来的读数必须【逐条来自记录】（${f} 该是上一轮的 50，整集重量的话会是 50 之外的新值）`),
    );
  }
  // 记录里的哈希 = 判定那一刻的内容哈希（两者同源）：beta 那条必须是【新】内容的哈希。
  assert.equal(
    table.get('server/beta.test.ts')?.sha,
    sha256Of(path.join(root, 'server', 'beta.test.ts')),
    again.context('记录里的哈希必须等于当前内容 —— 记录与复用判定同源'),
  );

  // 这一相之后没有别的内容变化 ⇒ 下一相必须全命中（部分重量把表补全了，而不是留着旧条）。
  const third = runTree(root, fx, ['--test-concurrency=4'], {
    SCC_TEST_STUB_ARGS_LOG: argsLog,
    SCC_TEST_STUB_DURATION: '50',
    SCC_TEST_STUB_DUR_MAP: durMap,
  });
  assert.match(
    third.verdict,
    /安静相成本=模式:cached 复用=5\/5 /,
    third.context('部分重量之后的表应已覆盖新内容 ⇒ 下一相全命中'),
  );
});

test('T10 ⛔ 没有逐文件读数表就一条都不许复用：删表 ⇒ 全部重量', (t) => {
  const fx = fixture(t);
  const root = treeFixture(t);
  seedServer(root, SEED_FILES);
  const argsLog = path.join(root, 'stub-args.log');

  const warm = runTree(root, fx, ['--test-concurrency=4'], { SCC_TEST_STUB_ARGS_LOG: argsLog });
  assert.equal(warm.status, 0, warm.context('预热运行应为绿'));

  // ⛔ AC 明文禁止的形态：读数【记录】不在了，却靠键或日志继续复用 —— 那等于把没有读数
  // 当过有读数。删掉表必须退成整相活读数。
  rmSync(path.join(root, '.quay', 'suite-concurrency-check', 'cache', 'quiet-baseline.files'));
  writeFileSync(argsLog, '');
  const again = runTree(root, fx, ['--test-concurrency=4'], { SCC_TEST_STUB_ARGS_LOG: argsLog });

  assert.equal(again.status, 0, again.context('退成活读数后应为绿'));
  assert.match(again.verdict, /安静基线=活读数/, again.context('表缺失 ⇒ 必须退成活读数'));
  assert.match(again.verdict, /安静相成本=模式:live 复用=0\/5 /, again.context('表缺失时复用条数必须是 0'));
  // 「为什么重量」印在 [quiet] 那一行（不是判词行）：它是运行过程的一部分，不是判定。
  assert.match(again.stdout, /逐文件读数表缺失/, again.context('判词应点名重量是因为表不在'));
  assert.equal(stubCalls(argsLog)[0].length, 5, again.context('退成活读数就要量整个文件集'));
});

test('T11 表里没有的文件（新增）也只重量它自己，且这一相把表补全 ⇒ 下一相全命中', (t) => {
  const fx = fixture(t);
  const root = treeFixture(t);
  seedServer(root, SEED_FILES);
  const argsLog = path.join(root, 'stub-args.log');

  const warm = runTree(root, fx, ['--test-concurrency=4'], { SCC_TEST_STUB_ARGS_LOG: argsLog });
  assert.equal(warm.status, 0, warm.context('预热运行应为绿'));

  writeFileSync(path.join(root, 'server', 'zeta.test.ts'), '// new\n');
  writeFileSync(argsLog, '');
  const again = runTree(root, fx, ['--test-concurrency=4'], { SCC_TEST_STUB_ARGS_LOG: argsLog });

  assert.equal(again.status, 0, again.context('新增文件后的运行应为绿'));
  assert.match(
    again.verdict,
    /安静相成本=模式:partial 复用=5\/6 重跑=\[server\/zeta\.test\.ts\] /,
    again.context('新增文件只重量它自己（「表里没这个条目」与「哈希不等」同一条口径）'),
  );
  // 分母跟着文件集长：覆盖面是【本次枚举到的文件集】，不是上一轮的规模。
  assert.match(again.verdict, /安静=\d+ms\(n=6\)/, again.context('中位分母应含新增的那个文件'));
  assert.deepEqual(
    stubCalls(argsLog)[0],
    ['server/zeta.test.ts'],
    again.context('重跑相只许收到新增的那一个文件'),
  );

  const third = runTree(root, fx, ['--test-concurrency=4'], { SCC_TEST_STUB_ARGS_LOG: argsLog });
  assert.equal(third.status, 0, third.context('第三相应为绿'));
  assert.match(
    third.verdict,
    /安静相成本=模式:cached 复用=6\/6 重跑=\[无\] /,
    third.context('部分重量应已把新文件补进表 ⇒ 下一相全命中'),
  );
});
