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
 * 命中前三样再校验、判定语义全部照跑。
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
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  while [ "\$#" -gt 0 ]; do
    case "\$1" in
      --*) shift ;;
      *) printf '__PERFILE__ duration_ms=%s %s passed=true end_ms=0\\n' "\${SCC_TEST_STUB_DURATION:-50}" "\$1"; shift ;;
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
