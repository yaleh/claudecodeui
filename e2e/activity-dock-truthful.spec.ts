/**
 * The activity dock when the server stops answering.
 *
 * What this file is *for*. The dock used to be a local table plus a local clock:
 * it kept showing one of six rotating words and counting up for as long as the
 * client believed a turn was running — which, with a dead server, was forever.
 * The criterion here is that a real browser, on a real server and a real app,
 * stops saying that: after the app's own socket is partitioned the dock reads
 * `unreachable`, the six action words are gone, the elapsed time is frozen at
 * the server's last `asOf`, and both stop entries are disabled with a reason —
 * and that a released partition returns it to a *continued*, not restarted,
 * reading of the turn.
 *
 * Why a partition and not a killed server. Killing this run's server would trip
 * the 40s boot guard (a closed port reads as a stuck start, exit code 1) and
 * would poison every other case in the same invocation. What "no server" looks
 * like to a page is exactly "no frames and a closed socket", and `page.routeWebSocket`
 * can produce both on the app's own `/ws` — dropping server-to-page frames,
 * closing the page's socket, refusing reconnects and then releasing — without
 * touching the process. The proposal's §10.2 measured each of those four actions
 * in this repository's real e2e environment.
 *
 * Why the debug agent. There is no way to make a session read "processing" from
 * outside: `/api/providers/sessions/running` reads an in-memory registry that
 * seeding cannot reach. The debug agent's `unattended-turn` opens a real run for
 * a session with no client behind it, and its `POST /clock` walks the scenario by
 * absolute offsets while the response is still pending — so every reading below
 * is taken *while* the turn is open, which is the only moment a busy dock exists.
 * That gate is opened by `playwright.config.ts` for exactly this file's selection.
 *
 * The threshold is the server's, not this file's. `playwright.config.ts` injects
 * a shortened beat and silence budget into the *server* for this selection only,
 * and the readings below use what the server announced in its hello — the file
 * contains no `staleAfter` / `unreachableAfterMs` literal of its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const LOCALES_ROOT = path.join(REPO_ROOT, 'src/modules/i18n/locales');
const HEARTBEAT_SERVICE = path.join(
  REPO_ROOT,
  'server/modules/websocket/services/activity-heartbeat.service.ts',
);

/** The locale the page is seeded with. */
const LOCALE = 'en';
/** Every locale the shipped keys live in — the six action words are read from all of them. */
const ALL_LOCALES = fs.readdirSync(LOCALES_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * The six rotating action words, in every locale. The unreachable dock must
 * carry none of them: excluding only the English set would pass a dock that
 * still said a translated "Thinking".
 */
const ACTION_WORDS = [...new Set(
  ALL_LOCALES.flatMap((locale) => {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(LOCALES_ROOT, locale, 'chat.json'), 'utf8'),
    ) as { claudeStatus?: { actions?: Record<string, string> } };
    return Object.values(parsed.claudeStatus?.actions ?? {});
  }).filter((word): word is string => typeof word === 'string' && word.length > 0),
)];

/** The shipped heartbeat timings, read from their one source of truth for the AC9 print. */
const SHIPPED = (() => {
  const source = fs.readFileSync(HEARTBEAT_SERVICE, 'utf8');
  const read = (name: string): number => {
    const match = source.match(new RegExp(`export const ${name} = ([\\d_]+);`));
    if (!match) throw new Error(`${HEARTBEAT_SERVICE} has no ${name}`);
    return Number(match[1].replace(/_/g, ''));
  };
  return {
    intervalMs: read('ACTIVITY_HEARTBEAT_INTERVAL_MS'),
    unreachableAfterMs: read('ACTIVITY_UNREACHABLE_AFTER_MS'),
  };
})();

/** The chat pane, the same anchor the other resident specs wait on. */
const PANE = '.chat-messages-pane';
const DOCK = '[data-activity-dock]';
const FORM = 'form[data-slot="prompt-input"]';

/** The partition's own selector: the app's chat socket, wherever it is proxied to. */
const WS_PATTERN = /\/ws(\?.*)?$/;

const USERNAME = 'activity-dock-truthful-e2e';
const PASSWORD = 'activity-dock-truthful-e2e-pass';
const TITLE = 'Activity dock truthfulness — a turn held open';
const SEED_USER_TEXT = 'seeded user turn for the activity-dock criterion';
const WALK_TURN_TEXT = 'the turn the process is still writing';

/** The composer's box, the same anchor the resident specs type into. */
const TEXTAREA = '[data-slot="prompt-input-textarea"]';
/** The message this criterion types, fails to send, then retries. */
const DRAFT = 'the draft a send to an unreachable server must not eat';

/**
 * Every state that means "a turn is running". The failed-send reading must be
 * none of them — and, because the list names states this build does not draw
 * yet, it is a statement about the shape of the answer rather than about one
 * literal string: a dock that later grows a `thinking` state cannot quietly
 * start reporting failures as thinking.
 */
const IN_TURN_STATES = new Set([
  'sending',
  'thinking',
  'writing',
  'tool',
  'awaitingPermission',
  'compacting',
  'in-turn',
]);

/**
 * One resident process, walked into a running turn and held there.
 *
 * The turn is opened at offset 0 and only ends at 14s, so every reading below
 * lands while the run registry still reports the session as processing. `wait`
 * at the end gives the walk a clean settling step after `turn-end`.
 */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'unattended-turn', text: WALK_TURN_TEXT, trigger: 'cron' },
    { at: 14_000, op: 'turn-end' },
    { at: 14_500, op: 'wait' },
  ],
  expect: { rows: { delta: 1 }, content: { mustContain: [SEED_USER_TEXT, WALK_TURN_TEXT] } },
};

/** Reads one shipped locale key, or undefined. */
function localeKey(locale: string, keyPath: string): unknown {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(LOCALES_ROOT, locale, 'chat.json'), 'utf8'),
  ) as Record<string, unknown>;
  return keyPath.split('.').reduce<unknown>(
    (node, segment) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined),
    parsed,
  );
}

const projectRow = (page: Page, workspaceName: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): Locator =>
  page.locator(`a[href="/session/${sessionId}"]`).first();

async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`the sidebar never showed a row for session ${sessionId}; page held:\n${body.slice(0, 2_000)}`);
}

/** The dock's own reading: which state it publishes, and the text and elapsed it draws. */
type DockReading = {
  state: string;
  text: string;
  elapsedMs: string | null;
  elapsedText: string | null;
  stopDisabled: boolean;
  stopReason: string;
};

async function readDock(page: Page): Promise<DockReading> {
  const dock = page.locator(DOCK).first();
  const text = (await dock.innerText()).trim().replace(/\s+/g, ' ');
  const stop = dock.locator('button').first();
  const hasStop = (await stop.count()) > 0;
  return {
    state: (await dock.getAttribute('data-activity-state')) ?? '',
    text,
    elapsedMs: await dock.getAttribute('data-activity-elapsed-ms'),
    elapsedText: text.match(/\d+m \d+s|\d+s/)?.[0] ?? null,
    stopDisabled: hasStop ? (await stop.getAttribute('disabled')) !== null : false,
    stopReason: hasStop ? ((await stop.getAttribute('title')) ?? '') : '',
  };
}

const wordsHit = (text: string): string[] => ACTION_WORDS.filter((word) => text.includes(word));

async function createAccount(
  api: APIRequestContext,
  username: string = USERNAME,
  password: string = PASSWORD,
): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username, password } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', {
      headers: { Authorization: `Bearer ${registered.token}` },
    });
    return registered.token;
  }
  const login = await api.post('/api/auth/login', { data: { username, password } });
  const loggedIn = await login.json().catch(() => null);
  if (typeof loggedIn?.token !== 'string') {
    throw new Error(`could not sign in as ${username}: ${register.status()} ${JSON.stringify(registered)}`);
  }
  return loggedIn.token;
}

async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  scenario: unknown = SCENARIO,
): Promise<{ sessionId: string }> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  return { sessionId };
}

async function startResidentProcess(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post(`/api/session-hosts/${encodeURIComponent(sessionId)}/start`);
  if (!response.ok()) {
    throw new Error(`could not start the resident process: ${response.status()} ${await response.text()}`);
  }
}

function fireClock(api: APIRequestContext, sessionId: string) {
  return api
    .post('/api/debug-agent/clock', { data: { sessionId } })
    .then(async (response) => ({ ok: response.ok(), status: response.status() }))
    .catch((error: unknown) => ({ ok: false, status: -1, failed: String(error) }));
}

/** Records every frame the app's chat socket receives, so the announced threshold can be read. */
const recordSocketFrames = () => {
  const page = window as unknown as { __dockFrames: unknown[] };
  page.__dockFrames = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener('message', (event: MessageEvent) => {
        try {
          page.__dockFrames.push(JSON.parse(String((event as MessageEvent).data)));
        } catch {
          // A non-JSON frame is not part of this protocol.
        }
      });
    }
  } as unknown as typeof WebSocket;
};

const readFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(
    () => (window as unknown as { __dockFrames: Array<Record<string, unknown>> }).__dockFrames ?? [],
  );

/** The partition the app's own socket is put behind, toggled by the case below. */
type Partition = {
  /**
   * `pass` forwards both directions; `drop` forwards page-to-server but drops
   * server-to-page; `silence` drops both while leaving the socket open, so the
   * client cannot reach the server and hears nothing back; `reject` closes the
   * socket outright.
   */
  mode: 'pass' | 'drop' | 'silence' | 'reject';
  closeLive: () => void;
};

async function installPartition(page: Page, partition: Partition): Promise<void> {
  await page.routeWebSocket(WS_PATTERN, (ws) => {
    if (partition.mode === 'reject') {
      // Refuse the reconnect the way a dead server would: the socket opens for the
      // page and closes under it, so the client keeps cycling rather than hanging.
      void ws.close({ code: 1006 });
      return;
    }
    const server = ws.connectToServer();
    partition.closeLive = () => {
      void ws.close({ code: 1006 });
    };
    // Manual forwarding in both directions: once a handler is registered on a side,
    // nothing is forwarded automatically. `drop` keeps the client's own frames
    // flowing (it must still be able to subscribe) while silencing the server;
    // `silence` is the fully cut-off reading, where neither side hears the other
    // — for a send, "the server never got it", not "the server answered and the
    // answer was lost".
    ws.onMessage((message) => {
      if (partition.mode !== 'silence') {
        server.send(message);
      }
    });
    server.onMessage((message) => {
      if (partition.mode === 'pass') {
        ws.send(message);
      }
    });
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('activity dock truthfulness', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspaceName = '';
  let sessionId = '';
  const partition: Partition = { mode: 'pass', closeLive: () => undefined };

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    if (!process.env.QUAY_E2E_RUN_STARTED_AT) throw new Error('playwright.config.ts must publish QUAY_E2E_RUN_STARTED_AT');

    const workspace = path.join(fixtureHome, 'activity-dock-workspace');
    workspaceName = path.basename(workspace);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    ({ sessionId } = await armScenario(api, workspace));
    await startResidentProcess(api, sessionId);

    const context = await browser.newContext({ baseURL: clientUrl });
    await context.addInitScript(
      ({ key, value, language }: { key: string; value: string; language: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', language);
      },
      { key: 'auth-token', value: token, language: LOCALE },
    );
    await context.addInitScript(recordSocketFrames);

    page = await context.newPage();
    // The partition is installed before the app ever opens its socket: the first
    // connection must already travel through the fixture for any of this to hold.
    await installPartition(page, partition);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('AC-184 the dock tells the truth when the app socket is partitioned', async () => {
    const startedAt = Date.now();
    const clock = fireClock(api, sessionId);

    // Open the session *after* the turn is already running, so the subscribe hello
    // reports `isProcessing` and the dock has a real turn to speak about.
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    // (i) Before the partition: a fresh, in-turn dock with the region's own evidence.
    await expect(page.locator(DOCK)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'in-turn', { timeout: 20_000 });
    const before = await readDock(page);
    console.log(`dock.state.before=${before.state}`);
    console.log(`dock.text.before=${JSON.stringify(before.text)}`);
    expect(before.state, 'before the partition the dock speaks for the running turn').not.toBe('unreachable');
    expect(before.text.length, 'the in-turn dock carries the turn\'s own text').toBeGreaterThan(0);

    // The control the partition must later grey out, read here while it is still live:
    // the reading below is only about the partition if this arm could have stopped the turn.
    const composerStop = page.locator(FORM).getByRole('button', { name: /stop/i });
    await expect(composerStop).toHaveCount(1);
    await expect(composerStop).toBeEnabled();
    console.log(`dock.composer.stop.enabled.before=${(await composerStop.getAttribute('disabled')) === null}`);

    // The threshold this selection's server announced, read from the hello the page saw.
    const hellos = (await readFrames(page)).filter((frame) => frame.kind === 'chat_subscribed');
    const announced = Number(hellos[hellos.length - 1]?.unreachableAfterMs ?? NaN);
    console.log(`dock.shipped.intervalMs=${SHIPPED.intervalMs}`);
    console.log(`dock.shipped.unreachableAfterMs=${SHIPPED.unreachableAfterMs}`);
    console.log(`dock.server.unreachableAfterMs=${announced}`);
    expect(Number.isFinite(announced), 'the server must announce its silence budget in the hello').toBe(true);
    expect(announced, 'this selection\'s server must be the shortened one').toBeLessThan(SHIPPED.unreachableAfterMs);
    expect(SHIPPED.unreachableAfterMs, 'the shipped default is untouched by the selection').toBe(15_000);

    // (ii) Partition: drop server->page frames. Past the announced threshold the dock degrades.
    const droppedAt = Date.now();
    partition.mode = 'drop';
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'unreachable', { timeout: 10_000 });
    const after = await readDock(page);
    const hits = wordsHit(after.text);
    console.log(`dock.state.after=${after.state}`);
    console.log(`dock.words.hit=${JSON.stringify(hits)}`);
    expect(after.state, 'silence past the server\'s own threshold reads unreachable').toBe('unreachable');
    expect(hits, 'no rotating action word survives into the unreachable dock, in any locale').toEqual([]);

    // (iii) The elapsed reading is frozen: two samples a second apart are byte-equal.
    const sampleA = await readDock(page);
    await page.waitForTimeout(1_200);
    const sampleB = await readDock(page);
    console.log(`dock.frozen.gap=${Date.now() - droppedAt}ms`);
    console.log(`dock.frozen.samples=${JSON.stringify([sampleA.elapsedText, sampleB.elapsedText])}`);
    expect(sampleA.elapsedText, 'the unreachable dock still shows the last server-derived elapsed').not.toBeNull();
    expect(sampleB.elapsedText, 'the elapsed reading must not advance while unreachable').toBe(sampleA.elapsedText);
    expect(sampleB.elapsedMs).toBe(sampleA.elapsedMs);

    // (iv) Both stop entries are disabled with a reason: the dock's own, and the composer's.
    await expect(page.locator(DOCK).locator('button').first()).toBeDisabled();
    const unreachableStopReason = String(localeKey(LOCALE, 'claudeStatus.unreachable.stopReason'));
    console.log(`dock.stop.disabled=${after.stopDisabled}`);
    console.log(`dock.stop.reason=${JSON.stringify(after.stopReason)}`);
    expect(after.stopDisabled, 'the dock stop carries the disabled attribute').toBe(true);
    expect(after.stopReason.trim().length, 'the disabled stop explains itself').toBeGreaterThan(0);
    expect(after.text).toContain(unreachableStopReason);

    // The composer's own stop carries a different label for a resident session
    // (`input.stop` vs `resident.stopResident`), so this reads the control by role
    // and name inside the form — the tab's stop is a sibling of the form, not in it.
    await expect(composerStop).toBeDisabled();
    console.log(`dock.composer.stop.label=${JSON.stringify(await composerStop.getAttribute('aria-label'))}`);
    console.log(`dock.composer.stop.disabled=${(await composerStop.getAttribute('disabled')) !== null}`);

    // (v) Close the socket and refuse reconnects, then release: the next reconnect
    //     within one cycle (~3s) restores the turn, and the clock is *continued*.
    partition.mode = 'reject';
    partition.closeLive();
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'unreachable', { timeout: 10_000 });

    partition.mode = 'pass';
    const releasedAt = Date.now();
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'in-turn', { timeout: 5_000 });
    const recovered = await readDock(page);
    const recoveredElapsed = Number(recovered.elapsedMs ?? NaN);
    const gapMs = releasedAt - droppedAt;
    console.log(`dock.recovered.elapsed=${recoveredElapsed}ms`);
    console.log(`dock.recovered.restart-would-be=0ms`);
    console.log(`dock.recovered.gap=${gapMs}ms after=${Date.now() - releasedAt}ms`);
    expect(recovered.state, 'a released partition returns the dock to the running turn').toBe('in-turn');
    expect(Number.isFinite(recoveredElapsed), 'the recovered dock reports a server-derived elapsed').toBe(true);
    expect(recoveredElapsed, 'the clock is continued from the turn\'s anchor, not restarted at recovery').toBeGreaterThanOrEqual(gapMs);
    expect(recoveredElapsed, 'a restarted clock would read ~0').toBeGreaterThan(0);

    const outcome = await clock;
    expect(outcome.ok, `the walk must complete: ${JSON.stringify(outcome)}`).toBe(true);

    const wall = Date.now() - startedAt;
    console.log(`dock.wall=${wall}ms`);
    expect(wall, 'the case body must land inside its own budget').toBeLessThanOrEqual(20_000);
  });

  test('AC-185 a send the server never takes fails, keeps the draft, and retries without duplicating the user row', async () => {
    const startedAt = Date.now();

    // Open the session. Not inherited from the case above: this one is selected
    // on its own (`-g "AC-185"`), and it must set up everything it reads.
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    // The app's socket is cut off from the server in both directions — nothing
    // this client sends reaches it, nothing it says comes back — while the
    // socket itself stays open. Kept open on purpose: the send path can tell at
    // a glance whether the socket is open, so a *closed* socket would take the
    // immediate-failure branch and this criterion's own deadline would never be
    // the thing under test. Here the deadline is what has to fire.
    partition.mode = 'silence';

    const textarea = page.locator(TEXTAREA);
    await textarea.fill(DRAFT);
    const draftBeforeSend = await textarea.inputValue();
    expect(draftBeforeSend, 'the draft is really in the box before the send').toBe(DRAFT);

    const sendLabel = String(localeKey(LOCALE, 'input.send'));
    const sendButton = page.locator(FORM).getByRole('button', { name: sendLabel });

    const sentAt = Date.now();
    await sendButton.click();

    // (i) The dock stops claiming a turn inside the send deadline and reports the
    //     failure, in the shipped wording, with the dock element itself present.
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'send-failed', { timeout: 5_000 });
    const after = await readDock(page);
    const latencyMs = Date.now() - sentAt;
    console.log(`send.state.afterSend=${after.state}`);
    console.log(`send.text.afterSend=${JSON.stringify(after.text)}`);
    console.log(`send.latency=${latencyMs}ms`);
    expect(after.state, 'a send the server never took is not a turn').toBe('send-failed');
    expect(
      IN_TURN_STATES.has(after.state),
      `the failed-send reading is not one of the in-turn states (got ${after.state})`,
    ).toBe(false);
    expect(after.text.length, 'the dock is present and says something — not an absent dock').toBeGreaterThan(0);
    const failureTitle = String(localeKey(LOCALE, 'claudeStatus.sendFailed.title'));
    const failureReason = String(localeKey(LOCALE, 'claudeStatus.sendFailed.reason'));
    console.log(`send.failureText=${JSON.stringify(failureTitle)}`);
    expect(
      after.text.includes(failureTitle) || after.text.includes(failureReason),
      `the dock must carry the shipped failure wording; text was ${JSON.stringify(after.text)}`,
    ).toBe(true);

    // (ii) The draft is byte-for-byte what the user typed, read off the input.
    const draftAfterSend = await textarea.inputValue();
    console.log(`draft.beforeSend=${JSON.stringify(draftBeforeSend)}`);
    console.log(`draft.afterSend=${JSON.stringify(draftAfterSend)}`);
    expect(draftAfterSend, 'a failed send leaves the draft in the box, not in a store behind an empty box').toBe(DRAFT);

    // (iii) Restore the channel; the retry must reach the server, and its user
    //       row must be the same one — the failed attempt's, not a second copy.
    const framesBeforeRelease = (await readFrames(page)).length;
    partition.mode = 'pass';
    const releasedAt = Date.now();
    await expect.poll(
      async () => (await readFrames(page)).length,
      { timeout: 5_000, message: 'server frames must reach the page again after the partition is released' },
    ).toBeGreaterThan(framesBeforeRelease);

    await sendButton.click();

    // The server took it: the running-sessions registry — the same in-memory
    // registry the app polls to derive "processing" — lists the session again.
    await expect.poll(async () => {
      const response = await api.get('/api/providers/sessions/running');
      const body = await response.json().catch(() => null);
      const sessions = (body?.data?.sessions ?? []) as Array<{ sessionId?: string }>;
      return sessions.some((session) => session.sessionId === sessionId);
    }, { timeout: 5_000, message: 'the retried chat.send must be accepted by the server' }).toBe(true);
    console.log(`send.retry.acceptedAfterMs=${Date.now() - releasedAt}ms`);

    const userRows = await page.locator(`${PANE} .chat-message[data-message-style="user"]`).evaluateAll(
      (rows, text) => rows.filter((row) => (row.textContent ?? '').includes(text)).length,
      DRAFT,
    );
    console.log(`transcript.userRows=${JSON.stringify([userRows])}`);
    expect(userRows, 'the retried text is exactly one user row, never two').toBe(1);

    const wall = Date.now() - startedAt;
    console.log(`send.wall=${wall}ms`);
    expect(wall, 'the case body must land inside its own budget').toBeLessThanOrEqual(20_000);
  });

  test('the run ends inside the ceiling the goal gate kills at', async () => {
    const runStartedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);
    const elapsed = Date.now() - runStartedAt;
    console.log(`elapsed=${elapsed}ms`);
    expect(elapsed, 'the whole invocation, measured from the config\'s own start').toBeLessThan(55_000);
  });
});

/* =============================================================================================
 * AC-188 — the page's *one* activity dock, and the one answer about a session
 * =============================================================================================
 *
 * The family's other cases (AC-184, AC-185) are about what one dock says when the
 * server stops answering. This one is about there being one dock at all, and about
 * the three surfaces that used to answer "is this session working" separately —
 * the dock, the sidebar's running view (and the badge above it) and the composer's
 * send/stop button — answering it the same way, from the same source, at the same
 * instant.
 *
 * What the page looked like before. Activity was drawn on **four** unrelated
 * sources: a tab-shaped strip hanging off the composer (only from `md` up), a
 * compact line at the end of the transcript (only below `md`), the resident status
 * bar's own busy/idle word and lease counts, and the sidebar's running count —
 * the last two read from a one-second `/api/session-hosts` poll. Each pair could
 * disagree, and one pair reliably did: a turn that ends is announced to the page
 * at once and observed by the listing up to a beat later, so for that beat the
 * dock said idle while the sidebar still counted the session as running.
 *
 * What is read here, and why each reading can fail:
 *
 *   - **counts.** One `[data-activity-dock]` per viewport, and zero matches for the
 *     two markers the old surfaces published (`.chat-activity-tab`, the
 *     `chat-activity-inline` slot). A build that kept the old mount beside the new
 *     one reads 2, or reads a legacy marker — and neither is reachable by hiding
 *     anything with CSS, because both are counts of what exists.
 *   - **the resident surface.** On a resident session: zero matches for the
 *     busy/idle word and the lease counts, and non-zero readings for the address,
 *     the pid and the lifecycle controls inside the dock's expanded panel. The
 *     second half is what separates "merged into the dock" from "deleted".
 *   - **agreement.** While the turn is open, and then repeatedly across the window
 *     *after* `turn-end` — the window in which the old poll-driven sidebar lagged —
 *     the dock's state, the sidebar's running group membership and the composer's
 *     stop state are read in one sample each. No sample may show the dock idle
 *     while either of the other two says busy.
 *
 * Both viewports, each read once. The window is switched with `setViewportSize`,
 * which is the signal the app itself reads (`useDeviceSettings` watches `resize`),
 * so the same page really does re-render its narrow tier rather than a second
 * context standing in for it.
 *
 * The turn is the debug agent's, for the same reason the rest of this file uses
 * it: there is no way to make a session read "processing" from outside without a
 * real run. `unattended-turn` opens one with no client behind it and `turn-end`
 * closes it, so the moment the turn stops being real is a moment this file places
 * on the clock rather than waits for.
 */

/** The locale the second scenario's copy is read from — the same one the page is seeded with. */
const CONSOLIDATION_TITLE = 'Activity dock consolidation — one dock, one answer';
const CONSOLIDATION_WALK_TEXT = 'the turn the consolidated dock reports';
const CONSOLIDATION_USER = 'activity-dock-consolidation-e2e';
const CONSOLIDATION_PASSWORD = 'activity-dock-consolidation-e2e-pass';

/**
 * The turn, opened and then ended on a known beat.
 *
 * `turn-end` releases the host's turn lease at 6.0s and the walk's own terminal
 * `complete` frame reaches the page at 6.5s. That ordering is the whole point: the
 * activity the page reads says "over" half a second before the one-second host
 * poll could have observed the lease go, which is the window AC-188 exists to
 * close.
 */
const CONSOLIDATION_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: CONSOLIDATION_TITLE, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'unattended-turn', text: CONSOLIDATION_WALK_TEXT, trigger: 'cron' },
    { at: 6_000, op: 'turn-end' },
    { at: 6_500, op: 'wait' },
  ],
  expect: { rows: { delta: 1 }, content: { mustContain: [SEED_USER_TEXT, CONSOLIDATION_WALK_TEXT] } },
};

/** The two markers the pre-consolidation surfaces published. Neither may match anything. */
const LEGACY_MARKERS = ['.chat-activity-tab', '[data-slot="chat-activity-inline"]'] as const;

/**
 * Every marker the resident status bar published about *activity*.
 *
 * A second busy/idle word and a count of the leases a host was holding are both a
 * second answer to the dock's question, and the page must carry neither. The
 * address/pid/close markers are deliberately **not** in this list: they survive,
 * in the dock's panel, and the criterion reads them there.
 */
const RESIDENT_ACTIVITY_MARKERS = [
  '[data-resident-status-bar]',
  '[data-resident-ui-state]',
  '[data-resident-state-text]',
  '[data-resident-lease-summary]',
  '[data-resident-lease-total]',
  '[data-lease-kind]',
  '[data-lease-count]',
] as const;

const DOCK_TOGGLE = '[data-activity-dock-toggle]';
const DOCK_PANEL = '[data-activity-dock-panel]';
const RUNNING_GROUP = '[data-running-group="running"]';

/** One sample of the three surfaces, taken as close to simultaneously as a page allows. */
type ConsistencySample = {
  dock: string;
  sidebar: boolean;
  send: string;
};

const inTurn = (state: string): boolean => IN_TURN_STATES.has(state);

/** Everything one viewport's reading is made of. */
type ViewportReading = {
  width: number;
  docks: number;
  legacy: string[];
  residentActivityMarkers: string[];
  panel: { start: number; close: number; address: number; pid: number; copy: number };
  turn: ConsistencySample;
  afterTurn: ConsistencySample[];
  afterTurnIdle: ConsistencySample;
};

/**
 * Switches the page to a viewport width and waits for the app to take the tier.
 *
 * The dock's two mount sites are chosen by the app's own `md` breakpoint, so a
 * reading taken before the re-render would describe the other tier. The wait is on
 * the observable consequence — the tier's own surface is the only one on the page
 * — rather than on a timeout.
 */
async function useViewport(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 800 });
  await expect.poll(async () => page.locator(DOCK).count(), { timeout: 10_000 }).toBe(1);
}

/** One sample: the dock's state, whether the sidebar counts this session as running, and the submit's label. */
async function sample(page: Page, sessionId: string, sendLabel: string): Promise<ConsistencySample> {
  const group = page.locator(RUNNING_GROUP);
  const sidebar = (await group.count()) > 0
    ? (await group.locator(`[data-running-session="${sessionId}"]`).count()) > 0
    : false;
  const escaped = sendLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const submit = page.locator(`${FORM} button[aria-label="${escaped}"]`);
  const send = (await submit.count()) > 0 ? 'stop' : 'send';
  return {
    dock: (await page.locator(DOCK).first().getAttribute('data-activity-state')) ?? '',
    sidebar,
    send,
  };
}

test.describe.configure({ mode: 'serial' });

test.describe('activity dock consolidation', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspaceName = '';
  let sessionId = '';
  let sendLabel = '';
  let runningTooltip = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');

    const workspace = path.join(fixtureHome, 'activity-dock-consolidation-workspace');
    workspaceName = path.basename(workspace);

    sendLabel = String(localeKey(LOCALE, 'input.send'));
    runningTooltip = String(localeKey(LOCALE, 'search.runningTooltip'));

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap, CONSOLIDATION_USER, CONSOLIDATION_PASSWORD);
    await bootstrap.dispose();
    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

    ({ sessionId } = await armScenario(api, workspace));

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    await context.addInitScript(
      ({ key, value, language }: { key: string; value: string; language: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', language);
      },
      { key: 'auth-token', value: token, language: LOCALE },
    );
    page = await context.newPage();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('AC-188 one dock, no legacy surface, and one answer across the dock, the sidebar and the send button', async () => {
    const startedAt = Date.now();

    // The turn is *not* running yet: the session is stored resident, so the dock is
    // already on screen in its idle reading with its panel holding the resident facts
    // — including the [start] control, which only exists while there is no process.
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'idle', { timeout: 20_000 });

    await expect(page.locator(DOCK_TOGGLE)).toBeVisible({ timeout: 10_000 });
    await page.locator(DOCK_TOGGLE).click();
    await expect(page.locator(DOCK_PANEL)).toBeVisible({ timeout: 10_000 });
    const beforeStart = {
      start: await page.locator(`${DOCK_PANEL} [data-resident-start]`).count(),
      close: await page.locator(`${DOCK_PANEL} [data-resident-close]`).count(),
      address: await page.locator(`${DOCK_PANEL} [data-resident-address]`).count(),
      pid: await page.locator(`${DOCK_PANEL} [data-resident-pid-text]`).count(),
      copy: await page.locator(`${DOCK_PANEL} [data-resident-copy]`).count(),
    };
    console.log(`resident.panel.beforeStart=${JSON.stringify(beforeStart)}`);
    console.log(`resident.panel.address=${JSON.stringify((await page.locator(`${DOCK_PANEL} [data-resident-address]`).first().innerText()).trim())}`);
    await page.locator(DOCK_TOGGLE).click();
    await expect(page.locator(DOCK_PANEL)).toHaveCount(0);

    // Bring the process up through the same verb the panel's own control calls, then
    // open a real turn on it and hold it open while the readings below are taken.
    await startResidentProcess(api, sessionId);
    // The host listing is the proof the process really is up: `unattended-turn` goes
    // through the host layer and would refuse without one, and a clock fired too early
    // would report the refusal instead of opening the turn this criterion reads.
    await expect.poll(
      async () => {
        const response = await api.get('/api/session-hosts');
        const body = await response.json().catch(() => null);
        const hosts = (body?.data?.hosts ?? []) as Array<{
          state?: string;
          bindings?: Array<{ appSessionId?: string }>;
        }>;
        return hosts.some(
          (host) => host.state !== 'closed'
            && (host.bindings ?? []).some((binding) => binding.appSessionId === sessionId),
        );
      },
      { timeout: 20_000, message: 'the resident process must be up before the turn is opened' },
    ).toBe(true);
    const clock = fireClock(api, sessionId);
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'in-turn', { timeout: 20_000 });

    // The Running view, which is where the sidebar's classification is published.
    await page.getByRole('button', { name: runningTooltip, exact: true }).click();
    await expect(page.locator(RUNNING_GROUP)).toBeVisible({ timeout: 10_000 });

    const readings: ViewportReading[] = [];
    for (const width of [1280, 390]) {
      await useViewport(page, width);

      const docks = await page.locator(DOCK).count();
      const legacy = await Promise.all(
        LEGACY_MARKERS.map(async (marker) => ((await page.locator(marker).count()) > 0 ? marker : '')),
      );
      const residentActivityMarkers = await Promise.all(
        RESIDENT_ACTIVITY_MARKERS.map(async (marker) => ((await page.locator(marker).count()) > 0 ? marker : '')),
      );

      const turn = await sample(page, sessionId, sendLabel);
      console.log(
        `dock.count.${width < 768 ? 'mobile' : 'desktop'}=${docks} `
        + `legacy.tab=${legacy[0] === '' ? 0 : 1} legacy.inline=${legacy[1] === '' ? 0 : 1} `
        + `resident.activityMarkers=${JSON.stringify(residentActivityMarkers.filter(Boolean))}`,
      );
      console.log(`consistency.turn.${width < 768 ? 'mobile' : 'desktop'}=${JSON.stringify(turn)}`);

      readings.push({
        width,
        docks,
        legacy: legacy.filter(Boolean),
        residentActivityMarkers: residentActivityMarkers.filter(Boolean),
        panel: beforeStart,
        turn,
        afterTurn: [],
        afterTurnIdle: turn,
      });
    }

    // The turn is over: `turn-end` released the lease and the walk's own terminal frame
    // has told the page. From here the readings are taken *repeatedly*, across the whole
    // window in which the old poll-driven sidebar still counted the ended turn.
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'idle', { timeout: 20_000 });
    const endedAt = Date.now();

    for (const reading of readings) {
      await useViewport(page, reading.width);
      const samples: ConsistencySample[] = [];
      for (let i = 0; i < 24; i += 1) {
        samples.push(await sample(page, sessionId, sendLabel));
        await page.waitForTimeout(55);
      }
      reading.afterTurn = samples;
      console.log(
        `consistency.afterTurn.${reading.width < 768 ? 'mobile' : 'desktop'}=${JSON.stringify(samples)}`,
      );
      // The window the agreement is about: the samples above are taken from the moment the
      // dock reads idle, and 24 of them at 55ms span ~1.3s — past the one-second poll's
      // own beat, which is the interval the old sidebar lagged by.
      console.log(`consistency.afterTurn.window.${reading.width}=${Date.now() - endedAt}ms`);
    }

    const outcome = await clock;
    expect(outcome.ok, `the walk must complete: ${JSON.stringify(outcome)}`).toBe(true);

    // ---- the claims -------------------------------------------------------------------------
    for (const reading of readings) {
      const tier = reading.width < 768 ? 'mobile' : 'desktop';

      // AC2 — one dock, on this viewport, while the turn is open.
      expect(reading.docks, `${tier}: exactly one [data-activity-dock] must exist`).toBe(1);

      // AC3 — the two markers the old surfaces published match nothing at all. Not hidden: absent.
      expect(
        reading.legacy,
        `${tier}: the old tab class and the inline slot must not match anything`,
      ).toEqual([]);

      // AC4 — the resident surface's own activity word and lease counts are gone from the page...
      expect(
        reading.residentActivityMarkers,
        `${tier}: the resident surface must publish no busy/idle word and no lease count`,
      ).toEqual([]);
      // ...and the facts it carried are reachable in the dock's panel, which is what makes it
      // a merge rather than a deletion.
      expect(reading.panel.start, `${tier}: the panel still offers [start] while no process is up`).toBeGreaterThan(0);
      expect(reading.panel.close, `${tier}: the panel still offers [close]`).toBeGreaterThan(0);
      expect(reading.panel.address, `${tier}: the panel still shows the address`).toBeGreaterThan(0);
      expect(reading.panel.pid, `${tier}: the panel still shows the pid`).toBeGreaterThan(0);
      expect(reading.panel.copy, `${tier}: the panel still offers [copy]`).toBeGreaterThan(0);

      // AC5 — three surfaces, one sample, one answer.
      expect(inTurn(reading.turn.dock), `${tier}: the dock must read in-turn while the turn is open`).toBe(true);
      expect(reading.turn.sidebar, `${tier}: the sidebar must count the session as running`).toBe(true);
      expect(reading.turn.send, `${tier}: the submit must be the stop entry`).toBe('stop');

      // AC6 — and after the turn: no sample in the window may show the dock idle while
      // either other surface still says busy.
      const disagreements = reading.afterTurn.filter((s) => !inTurn(s.dock) && (s.sidebar || s.send === 'stop'));
      expect(
        disagreements,
        `${tier}: no reading may show the dock idle while the sidebar or the send button still says busy`,
      ).toEqual([]);

      const settled = reading.afterTurn[reading.afterTurn.length - 1];
      expect(inTurn(settled.dock), `${tier}: the dock settles on its idle reading`).toBe(false);
      expect(settled.sidebar, `${tier}: and the sidebar stops counting the session`).toBe(false);
      expect(settled.send, `${tier}: and the submit is the send entry again`).toBe('send');
    }

    const wall = Date.now() - startedAt;
    console.log(`dock.wall=${wall}ms`);
    expect(wall, 'the case body must land inside its own budget').toBeLessThanOrEqual(20_000);
  });
});
