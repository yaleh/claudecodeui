/**
 * The resident status bar, its sidebar mark and the popover's two verbs — read off a real browser
 * against a real server, driven by the debug agent's own scenario clock.
 *
 * What this file is *for*. The feature is a surface that describes a process the page does not own:
 * four states, a lease count, an address, and one row style for a turn nobody typed. Every one of
 * those is a comparison — the bar against the sidebar, the UI's count against the listing's, the
 * label against the locale file, the divider against the trigger that produced it — and a comparison
 * is only evidence when both sides were read from somewhere that could have disagreed. So nothing
 * here is asserted against a value this file also wrote: the states come from `GET
 * /api/session-hosts`, the copy comes from the platform clipboard, the labels come from the shipped
 * locale JSON, and the rows come from the transcript the server wrote.
 *
 * Why the debug agent. The alternative is a real `claude` process, and a criterion that needs one is
 * a criterion that cannot run where the binary is absent. `POST /api/debug-agent/clock` walks a
 * scenario instead: the same product chain (provider runtime → host manager → run registry → the
 * normalizer the transcript is read through) with the child process replaced by a scripted clock, so
 * a turn can be opened, held and ended at a moment this file chooses. The gate that mounts that face
 * is opened by `playwright.config.ts` for exactly this file's selection, so no other run's server
 * grows a fixture-writing endpoint.
 *
 * Why the clock is not awaited where it is fired. `POST /clock` blocks for the whole walk — it awaits
 * each step's absolute offset from the run's start. Every reading below therefore happens *while* the
 * walk is in flight, which is the only place the states exist at all: after the response returns, the
 * process has already been walked back to rest. The response is awaited at the end, for the two facts
 * only it carries (which run opened the unattended turn, and whether the seam that opens runs is
 * wired).
 *
 * Two arms, one session each, because the popover's Close and the walk's `exit` cannot both be last:
 * arm A carries the identity, the popover, the copy and the close; arm B carries the walk, the
 * counts, the abort and the transcript rows. Splitting them is not a convenience — an arm that both
 * closed a host and expected it to exit would be reading the second half of its own first half.
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

/** The locale the page is seeded with, and the one the rendered copy is checked against. */
const LOCALE = 'en';
/** Every locale the shipped keys must be present in — the app's own set, read from disk. */
const ALL_LOCALES = fs.readdirSync(LOCALES_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** The chat pane, the same anchor transcript-follow uses to know the session actually opened. */
const PANE = '.chat-messages-pane';
const BAR = '[data-resident-status-bar]';
const TRIGGER = '[data-resident-status-bar-trigger]';
const STATE_TEXT = '[data-resident-state-text]';
const START = '[data-resident-start]';
const ADDRESS = '[data-resident-address]';
const COPY = '[data-resident-copy]';
const CLOSE = '[data-resident-close]';
const MARK = '[data-resident-mark]';
const DIVIDER = '[data-unattended-divider]';
const UNATTENDED_ROW = '[data-unattended-row]';
const LEASE_PILL = '[data-lease-kind]';

/** The account this run creates. Any name works; it is the same one for both arms. */
const USERNAME = 'resident-status-bar-e2e';
const PASSWORD = 'resident-status-bar-e2e-pass';

/** The two sessions' titles, and the address the scenario reports for the process. */
const TITLE_A = 'Resident status bar — popover arm';
const TITLE_B = 'Resident status bar — walk arm';
const PEER_NAME = 'peer-resident-status-bar';
const SEED_USER_TEXT = 'seeded user turn for the resident status bar criterion';

/** The two turns the walk opens unattended, each with the trigger that produced it. */
const CRON_TURN_TEXT = 'unattended turn opened by a scheduled task';
const CROSS_SESSION_TURN_TEXT = 'unattended turn opened by another conversation';

/**
 * Arm A: report the address, then hold the clock open long enough for the popover to be read, the
 * address copied and the process closed. No host step may follow — the close is this arm's last act.
 */
const ARM_A_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_A, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'identity', name: PEER_NAME },
    { at: 5_000, op: 'wait' },
  ],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

/**
 * Arm B: the whole state walk on one clock.
 *
 * Each plateau is wide enough for the status bar's one-second poll to land inside it, and the offsets
 * are absolute from the run's start, so the shape of the walk — and therefore where each reading can
 * be taken — does not depend on how long this file took to get there. The long `wait` between the
 * second turn and its end is the window the abort is clicked in; `exit` is last because a host that
 * has exited serves no further step.
 */
const ARM_B_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_B, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'identity', name: PEER_NAME },
    { at: 1_000, op: 'unattended-turn', text: CRON_TURN_TEXT, trigger: 'cron' },
    { at: 3_000, op: 'turn-end' },
    { at: 5_000, op: 'keepalive-add', kind: 'monitor' },
    { at: 7_000, op: 'unattended-turn', text: CROSS_SESSION_TURN_TEXT, trigger: 'cross-session', sender: PEER_NAME },
    { at: 12_000, op: 'wait' },
    { at: 13_000, op: 'turn-end' },
    { at: 14_000, op: 'exit', detail: 'oom' },
    { at: 14_500, op: 'wait' },
  ],
  expect: {
    rows: { delta: 2 },
    content: { mustContain: [CRON_TURN_TEXT, CROSS_SESSION_TURN_TEXT] },
  },
};

/** The four process states and the mark each one draws, as the proposal's §15.1 pins them. */
const MARK_SHAPES: Record<string, string> = {
  unstarted: 'hollow',
  idle: 'solid',
  busy: 'solid+spinner',
  exited: 'exited',
};

/**
 * The word each state is printed with.
 *
 * Kept beside {@link MARK_SHAPES} rather than derived from the host's own vocabulary: this file
 * reports what a reader saw, and the reader's four words are not the host manager's six states.
 */
const STATE_WORD: Record<string, string> = {
  unstarted: '未运行',
  idle: '空闲',
  busy: '运行中',
  exited: 'exited(oom)',
};

// ---------------------------------------------------------------------------------------------
// The wire, read by this file rather than through the page.
//
// Every assertion about the process is made against this listing, and the same listing is what the
// status bar polls — so a bar that rendered a stale or invented state has something to disagree
// with. The two projections below mirror the frontend's own `findLiveHost`/`findSessionHost` rules
// (`src/shared/hooks/useSessionHosts.ts`), which is the point: they are a *second* reading of the
// same rule, and a change to one that the other has not followed shows up as a red here.
// ---------------------------------------------------------------------------------------------

type HostLease = { kind: string; id?: string };
type HostBinding = { appSessionId: string; leases?: HostLease[]; peerName?: string | null };
type HostRecord = {
  hostId: string;
  state: string;
  pid: number | null;
  /**
   * When this host record was opened, as the listing publishes it.
   *
   * Carried because the debug fixture's host has no OS pid: `pid` is the field a
   * real resident process is identified by, and for this driver it is empty, so
   * the reading that a stopped turn left the *same* process behind has to be
   * taken off a field that is actually populated. Two hosts opened by the same
   * test can share a pid of `null`; they cannot share a start stamp.
   */
  startedAt: number | null;
  closeReason: string | null;
  closeDetail: string | null;
  bindings: HostBinding[];
};
type SessionRecord = {
  appSessionId: string;
  provider: string;
  lifecycleMode: string;
  running: boolean;
  reason: string | null;
};

type HostsSnapshot = { hosts: HostRecord[]; sessions: SessionRecord[] };

/** The live host holding one session, or null. Closed hosts are skipped, as the frontend skips them. */
function liveHost(snapshot: HostsSnapshot, sessionId: string): HostRecord | null {
  for (const host of snapshot.hosts) {
    if (host.state === 'closed') continue;
    if (host.bindings.some((binding) => binding.appSessionId === sessionId)) return host;
  }
  return null;
}

/** The host that most recently served one session, closed or not — the frontend's `findSessionHost`. */
function lastHost(snapshot: HostsSnapshot, sessionId: string): HostRecord | null {
  let found: HostRecord | null = null;
  for (const host of snapshot.hosts) {
    if (host.bindings.some((binding) => binding.appSessionId === sessionId)) found = host;
  }
  return found;
}

/** The session's binding on its live host, or null. */
function liveBinding(snapshot: HostsSnapshot, sessionId: string): HostBinding | null {
  return liveHost(snapshot, sessionId)?.bindings.find((binding) => binding.appSessionId === sessionId) ?? null;
}

/**
 * The UI's word for a host's state.
 *
 * A restatement of `readResidentProcessState` — deliberately a second one. The criterion's whole
 * subject is that the bar and the listing agree about one process, and a check that imported the
 * bar's own rule would agree with the bar by construction, including when both were wrong.
 */
function uiStateOf(host: HostRecord | null): string {
  if (!host) return 'unstarted';
  if (host.state === 'closed') return host.closeReason === 'exited' ? 'exited' : 'unstarted';
  if (host.state === 'busy' || host.state === 'starting') return 'busy';
  return 'idle';
}

/** One kind's lease count on a binding, as a plain map. */
function leaseCounts(binding: HostBinding | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lease of binding?.leases ?? []) {
    counts.set(lease.kind, (counts.get(lease.kind) ?? 0) + 1);
  }
  return counts;
}

/** A count map printed as `kind:count` pairs, ordered so two readings of one state print one string. */
function describeCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind}:${count}`)
    .join(',') || '(none)';
}

// ---------------------------------------------------------------------------------------------
// Locale reading. The copy a reader sees is never written down in this file: it is read from the
// shipped JSON and substituted into, so a criterion cannot pass against a sentence only it knows.
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Reads one shipped locale file. `null` when it, or the key path, is absent. */
function readLocaleFile(locale: string, file: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCALES_ROOT, locale, file), 'utf8')) as Json;
  } catch {
    return null;
  }
}

/** One dot-path inside a parsed locale file, or `undefined`. */
function readKey(source: Json | null, keyPath: string): unknown {
  let node: unknown = source;
  for (const segment of keyPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Json)[segment];
  }
  return node;
}

/** Substitutes `{{name}}` placeholders, the way i18next's default interpolation does. */
function render(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => params[name] ?? '');
}

const chatLocale = (locale: string) => readLocaleFile(locale, 'chat.json');
const sidebarLocale = (locale: string) => readLocaleFile(locale, 'sidebar.json');

/** The shipped sentence for one status-bar state, in the page's own locale. */
function statusBarText(state: string, params: Record<string, string> = {}): string {
  const template = readKey(chatLocale(LOCALE), `resident.statusBar.${state}`);
  if (typeof template !== 'string') throw new Error(`en/chat.json has no resident.statusBar.${state}`);
  return render(template, params);
}

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

type BarReading = {
  uiState: string;
  hostState: string;
  hostId: string;
  closeReason: string;
  closeDetail: string;
  pid: string;
  text: string;
  counts: Map<string, number>;
};

/** Everything the bar publishes, in one round trip each so a reading is one moment. */
async function readBar(page: Page): Promise<BarReading> {
  const bar = page.locator(BAR);
  const pills = await page.locator(LEASE_PILL).evaluateAll((nodes) =>
    nodes.map((node) => [
      node.getAttribute('data-lease-kind') ?? '',
      Number(node.getAttribute('data-lease-count') ?? '0'),
    ] as [string, number]),
  );
  const counts = new Map<string, number>(pills);
  return {
    uiState: (await bar.getAttribute('data-resident-ui-state')) ?? '',
    hostState: (await bar.getAttribute('data-resident-host-state')) ?? '',
    hostId: (await bar.getAttribute('data-resident-host-id')) ?? '',
    closeReason: (await bar.getAttribute('data-resident-close-reason')) ?? '',
    closeDetail: (await bar.getAttribute('data-resident-close-detail')) ?? '',
    pid: (await bar.getAttribute('data-resident-pid')) ?? '',
    text: (await page.locator(STATE_TEXT).innerText()).trim(),
    counts,
  };
}

/** The sidebar's mark for one session: its shape, its state and the exit detail when it has one. */
async function readMark(page: Page, sessionId: string) {
  const mark = page.locator(`a[href="/session/${sessionId}"]`).first().locator(MARK);
  await mark.waitFor({ state: 'attached', timeout: 15_000 });
  return {
    shape: (await mark.getAttribute('data-resident-mark')) ?? '',
    state: (await mark.getAttribute('data-resident-state')) ?? '',
    detail: (await mark.getAttribute('data-resident-exit-detail')) ?? '',
  };
}

/** Fails with what the page actually held, rather than with a locator timeout and nothing else. */
async function explain(page: Page, what: string): Promise<never> {
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`${what}; the page held:\n${body.slice(0, 2_000)}`);
}

/**
 * The project row's toggle, whose accessible name starts with the workspace's directory name.
 *
 * The sidebar's own control, clicked rather than bypassed: a session row only exists once its
 * project is expanded, and expanding it any other way would leave the row this file reads not
 * necessarily the row a user would see.
 */
const projectRow = (page: Page, workspaceName: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): Locator => page.locator(`a[href="/session/${sessionId}"]`).first();

/** Expands the fixture project until the session's row is on screen. Bounded, and never silent. */
async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  await explain(page, `the sidebar never showed a row for session ${sessionId}`);
}

/**
 * Records every frame the chat socket receives, for the life of the page.
 *
 * The abort's outcome reaches this client as a terminal frame and nowhere else: the REST listing has
 * no field for it, and the run registry that does is not exposed over HTTP. Installing a subclass
 * rather than re-assigning `onmessage` keeps the app's own handlers working — the recorded frames
 * are copies of what the app already got.
 */
const recordSocketFrames = () => {
  const page = window as unknown as { __socketFrames: unknown[] };
  page.__socketFrames = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener('message', (event: MessageEvent) => {
        try {
          page.__socketFrames.push(JSON.parse(String((event as MessageEvent).data)));
        } catch {
          // A binary or non-JSON frame is not part of this protocol; nothing to record.
        }
      });
    }
  } as unknown as typeof WebSocket;
};

const socketFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(() => (window as unknown as { __socketFrames: Array<Record<string, unknown>> }).__socketFrames ?? []);

// ---------------------------------------------------------------------------------------------
// Setup.
// ---------------------------------------------------------------------------------------------

/**
 * An account this run owns, created over the API.
 *
 * The onboarding wizard is a three-screen flow that exists to collect a display name and an email,
 * neither of which this criterion reads; driving it would spend a third of the run's budget on
 * screens the subject never appears in. The profile flag it sets is the only thing the app checks
 * afterwards, so it is set here through the same endpoint the wizard's last screen calls.
 */
async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', {
      headers: { Authorization: `Bearer ${registered.token}` },
    });
    return registered.token;
  }

  const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  const loggedIn = await login.json().catch(() => null);
  if (typeof loggedIn?.token !== 'string') {
    throw new Error(
      `could not create or sign in as ${USERNAME}: register ${register.status()} ${JSON.stringify(registered)}, `
      + `login ${login.status()} ${JSON.stringify(loggedIn)}`,
    );
  }
  return loggedIn.token;
}

/** Arms one scenario and returns the ids the rest of this file addresses it by. */
async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  scenario: unknown,
): Promise<{ sessionId: string; transcriptPath: string }> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const data = body?.data;
  if (typeof data?.sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return { sessionId: data.sessionId, transcriptPath: data.transcriptPath };
}

test.describe.configure({ mode: 'serial' });

test.describe('resident status bar', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let workspaceName = '';
  let armA = '';
  let armB = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for the debug agent selection');
    }
    if (!process.env.QUAY_E2E_RUN_STARTED_AT) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_RUN_STARTED_AT for the elapsed reading');
    }

    // The workspace has to sit inside the fixture home: the control plane writes only under
    // `DEBUG_AGENT_HOME` and refuses a `projectPath` outside it. The transcript it arms lands under
    // that home's `.claude/projects`, which is a tree of the debug provider's own — no other
    // provider's scan reads it, so the row stays the one the debug synchronizer wrote.
    workspace = path.join(fixtureHome, 'resident-status-bar-workspace');
    workspaceName = path.basename(workspace);

    // The account is created on a context of its own, and every read below runs on a context that
    // carries its token: both faces this file reads — the host listing and the debug agent's
    // control plane — are mounted behind the same `authenticateToken` as the rest of `/api`, so an
    // anonymous request is answered with a refusal rather than with the state.
    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({
      baseURL: clientUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    armA = (await armScenario(api, workspace, ARM_A_SCENARIO)).sessionId;
    armB = (await armScenario(api, workspace, ARM_B_SCENARIO)).sessionId;

    // What the two armed sessions are stored as, before anything is started. Printed rather than
    // assumed: the `[启动]` control resolves its host driver from `session.provider`, so a row that
    // named a different provider than the one that armed it would be refused by a driver belonging
    // to someone else — and the refusal would arrive as a state, not as an error a reader could
    // attribute.
    for (const session of (await readHosts(api)).sessions) {
      if (session.appSessionId !== armA && session.appSessionId !== armB) continue;
      console.log(
        `armed.session=${session.appSessionId} provider=${session.provider} `
        + `lifecycleMode=${session.lifecycleMode} running=${String(session.running)}`,
      );
    }

    const context = await browser.newContext({ baseURL: clientUrl });
    // Read and written by this criterion only; granted here rather than at the click so a refusal is
    // this run's own, named at setup, instead of a silent empty string later.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: clientUrl });
    await context.addInitScript(
      ({ key, value, language }: { key: string; value: string; language: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', language);
      },
      { key: 'auth-token', value: token, language: LOCALE },
    );
    await context.addInitScript(recordSocketFrames);

    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[e2e] page console error: ${message.text()}`);
    });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    // The sidebar is the proof the account and the fixture project both landed.
    await revealSession(page, workspaceName, armA);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  /**
   * The address, the copy and the close — arm A.
   *
   * Ordered so the close is the last thing that happens to arm A's host: its address can only be read
   * once the scenario has reported one, and its mark can only be read as "hollow" once the host is
   * gone. Both are read through the surfaces a user reads — the popover's own text and the sidebar's
   * mark — while the values they are compared against come from the listing this page also polls.
   */
  test('the popover reports the address the listing publishes, copies it, and closes the process', async () => {
    await revealSession(page, workspaceName, armA);
    await sessionRow(page, armA).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });

    // Start through the bar's own control, so the state this arm walks into is one the product
    // produced rather than one this file wrote.
    const beforeStart = await readBar(page);
    expect(beforeStart.uiState, 'a resident session with no host must read as not running').toBe('unstarted');
    await page.locator(START).click();
    await expect(page.locator(BAR)).toHaveAttribute('data-resident-ui-state', 'idle', { timeout: 15_000 });

    const started = await readBar(page);
    const snapshotAtStart = await readHosts(api);
    const startState = uiStateOf(lastHost(snapshotAtStart, armA));
    console.log(
      `state=${STATE_WORD[started.uiState]} mark=${MARK_SHAPES[started.uiState]} bar=${JSON.stringify(started.text)} `
      + `snapshot.state=${liveHost(snapshotAtStart, armA)?.state ?? 'absent'} closeReason= detail= via=start`,
    );
    expect(started.uiState, 'the bar and the listing must agree about the started process').toBe(startState);
    expect(started.text, 'the bar reads its sentence from the shipped locale').toBe(statusBarText('idle'));
    expect(started.uiState, 'the mark is the shape §15.1 pins for this state').toBe('idle');

    // Fired without awaiting: the walk blocks until its last offset, and the popover is read while it
    // is in flight. Awaiting here would mean reading a state the walk had already left.
    // Reduced to a settled value rather than left as a bare promise: if an assertion below fails
    // while the walk is still in flight, `afterAll` disposes the request context under it, and a
    // promise left dangling here would report *that* as this test's error instead of the real one.
    const clockA = api
      .post('/api/debug-agent/clock', { data: { sessionId: armA } })
      .then(async (response) => ({
        ok: response.ok(),
        status: response.status(),
        body: (await response.json().catch(() => null)) as { success?: boolean } | null,
      }))
      .catch((error: unknown) => ({ ok: false, status: -1, body: { failed: String(error) } }));

    await page.locator(TRIGGER).click();
    await expect(page.locator(ADDRESS)).toBeVisible({ timeout: 10_000 });
    // The scenario's identity step runs at the walk's own zero, so the address arrives with it.
    await expect(page.locator(ADDRESS)).not.toBeEmpty({ timeout: 10_000 });

    const address = (await page.locator(ADDRESS).innerText()).trim();
    const snapshotAtAddress = await readHosts(api);
    const peerName = liveBinding(snapshotAtAddress, armA)?.peerName ?? null;
    console.log(
      `popover.address=${JSON.stringify(address)} snapshot.peerName=${JSON.stringify(peerName)} `
      + `equal=${String(address === peerName && address.length > 0)}`,
    );
    expect(address, 'the popover must show the address the listing publishes, not a second one').toBe(peerName);
    expect(address.length, 'an empty address would make the equality above vacuous').toBeGreaterThan(0);

    await page.locator(COPY).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    console.log(
      `copy.clipboard=${JSON.stringify(clipboard)} equalToAddress=${String(clipboard === address)}`,
    );
    expect(clipboard, 'Copy must put the address it displays on the clipboard').toBe(address);

    // Let the walk finish before the close. Closing a host is what ends the scenario, and a walk cut
    // off at offset 4 of 6 never reports a reading — the `/clock` call would answer 500
    // `DEBUG_AGENT_RUN_READING_MISSING`, which is a reading about this file's ordering rather than
    // about the product. The process is still live afterwards: the walk's own turn ends at 5000 and a
    // resident host is meant to sit there between turns, so the close below is still closing a
    // running process.
    const clockABody = await clockA;
    expect(clockABody.ok, `arm A's clock walk must complete: ${JSON.stringify(clockABody)}`).toBe(true);
    expect(clockABody.body?.success, `arm A's walk must report success: ${JSON.stringify(clockABody.body)}`).toBe(true);

    // The positive control for the close below: the same host id must be present *before* it is
    // closed, or "the count went down" would also be satisfied by a host that was never there.
    const snapshotBeforeClose = await readHosts(api);
    const hostBeforeClose = liveHost(snapshotBeforeClose, armA);
    console.log(`host.present=${String(hostBeforeClose !== null)} host.id=${hostBeforeClose?.hostId ?? '(none)'}`);
    expect(hostBeforeClose, 'the popover was opened over a process, so a live host must exist').not.toBeNull();

    const [closeResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/api/session-hosts/${armA}/close`)),
      page.locator(CLOSE).click(),
    ]);
    const snapshotAfterClose = await readHosts(api);
    console.log(
      `close.request=${closeResponse.status()} hosts.beforeClose=${snapshotBeforeClose.hosts.length} `
      + `hosts.afterClose=${snapshotAfterClose.hosts.length}`,
    );
    expect(closeResponse.status(), 'closing a live host is accepted').toBeLessThan(300);
    // The two counts are printed rather than compared: the listing keeps a closed host's record for a
    // retention window, so the array does not shrink and a `after < before` here would be asserting a
    // contract the listing never made. What the close must change is the host's own reading — it stops
    // being live, and it records who ended it — and those are the assertions below.
    expect(
      liveHost(snapshotAfterClose, armA),
      'the host the user closed must stop being a live host for its session',
    ).toBeNull();
    expect(
      lastHost(snapshotAfterClose, armA)?.state,
      'the closed host must be recorded as closed, not dropped from the listing',
    ).toBe('closed');
    expect(
      lastHost(snapshotAfterClose, armA)?.closeReason,
      'the record must say the user is why it closed',
    ).toBe('user');

    await expect(page.locator(BAR)).toHaveAttribute('data-resident-ui-state', 'unstarted', { timeout: 15_000 });
    const closed = await readBar(page);
    const markAfterClose = await readMark(page, armA);
    console.log(
      `state=${STATE_WORD[closed.uiState]} mark=${markAfterClose.shape} bar=${JSON.stringify(closed.text)} `
      + `snapshot.state=${lastHost(snapshotAfterClose, armA)?.state ?? 'absent'} `
      + `closeReason=${lastHost(snapshotAfterClose, armA)?.closeReason ?? '(none)'} detail= via=close`,
    );
    expect(closed.uiState, 'a process the user closed is back to not running').toBe('unstarted');
    expect(markAfterClose.shape, 'the mark for a session nobody started is the hollow one').toBe(
      MARK_SHAPES.unstarted,
    );
    expect(closed.text, 'the not-running sentence carries the reason the listing gives').toBe(
      statusBarText('unstarted', {
        reason: readSessionState(snapshotAfterClose, armA)?.reason ?? '',
      }),
    );
  });

  /**
   * The state walk, the lease counts, the abort and the unattended rows — arm B.
   *
   * One clock carries all four readings because they are four views of one process: the state is what
   * the lease set derives, the count is that same set, the abort is what happens to one of those
   * leases, and the rows are what the turns that held them wrote.
   */
  test('the walk drives all four states, the counts track the leases, and stopping leaves the process', async () => {
    await revealSession(page, workspaceName, armB);
    await sessionRow(page, armB).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });

    await page.locator(START).click();
    await expect(page.locator(BAR)).toHaveAttribute('data-resident-ui-state', 'idle', { timeout: 15_000 });

    // Every debug-agent response this run sees, so the seam reading below counts what the wire said
    // rather than what this file expected it to say.
    const controlPlaneTraffic: string[] = [];
    const recordTraffic = (response: { url(): string; text(): Promise<string> }) => {
      if (response.url().includes('/api/debug-agent/')) {
        void response.text().then((text) => controlPlaneTraffic.push(text), () => undefined);
      }
    };
    page.on('response', recordTraffic);

    const clockB = api
      .post('/api/debug-agent/clock', { data: { sessionId: armB } })
      .then(async (response) => ({
        ok: response.ok(),
        status: response.status(),
        body: (await response.json().catch(() => null)) as
          | { success?: boolean; data?: { runSource?: string | null } }
          | null,
      }))
      .catch((error: unknown) => ({ ok: false, status: -1, body: { failed: String(error) } }));

    // --- the first turn opens: 运行中 ------------------------------------------------------------
    await expect(page.locator(BAR)).toHaveAttribute('data-resident-ui-state', 'busy', { timeout: 10_000 });
    const busy = await readBar(page);
    const snapshotBusy = await readHosts(api);
    const busyHost = liveHost(snapshotBusy, armB);
    console.log(
      `state=${STATE_WORD[busy.uiState]} mark=${MARK_SHAPES[busy.uiState]} bar=${JSON.stringify(busy.text)} `
      + `snapshot.state=${busyHost?.state ?? 'absent'} closeReason= detail= via=scenario-step`,
    );
    expect(busy.uiState, 'a turn in flight is the running state').toBe('busy');
    expect(busy.uiState, 'the bar and the listing must agree while a turn is in flight').toBe(uiStateOf(busyHost));
    expect(busy.uiState, 'the mark is the shape §15.1 pins for this state').toBe('busy');
    expect((await readMark(page, armB)).shape, 'the sidebar draws the same state as the bar').toBe(
      MARK_SHAPES.busy,
    );
    console.log(
      `host.leases=${describeCounts(leaseCounts(liveBinding(snapshotBusy, armB)))} `
      + `ui.counts=${describeCounts(busy.counts)}`,
    );
    expect(
      describeCounts(busy.counts),
      'the bar counts the leases the listing reports, kind for kind',
    ).toBe(describeCounts(leaseCounts(liveBinding(snapshotBusy, armB))));

    // --- the turn ends: 空闲, and the count this arm measures the keepalive against -------------
    await expect(page.locator(BAR)).toHaveAttribute('data-resident-ui-state', 'idle', { timeout: 10_000 });
    const idle = await readBar(page);
    const snapshotIdle = await readHosts(api);
    console.log(
      `state=${STATE_WORD[idle.uiState]} mark=${MARK_SHAPES[idle.uiState]} bar=${JSON.stringify(idle.text)} `
      + `snapshot.state=${liveHost(snapshotIdle, armB)?.state ?? 'absent'} closeReason= detail= via=scenario-step`,
    );
    expect(idle.text, 'the idle sentence is the shipped one for this locale').toBe(statusBarText('idle'));
    expect(idle.counts.size, 'a turn that ended must not leave its kind behind').toBeLessThan(busy.counts.size);
    const countsBefore = await readCountReading(page, snapshotIdle, armB);
    console.log(`界面类别 ← lease kind：${countsBefore.mapping}`);
    console.log(`counts.before=${describeCounts(countsBefore.counts)}`);

    // --- one more reason to stay open: the count must grow, and only by that reason -------------
    await expect
      .poll(async () => (await readBar(page)).counts.has('monitor'), { timeout: 10_000 })
      .toBe(true);
    await expect
      .poll(async () => describeCounts((await readBar(page)).counts), { timeout: 10_000 })
      .not.toBe(describeCounts(countsBefore.counts));
    const snapshotAfterKeepalive = await readHosts(api);
    const countsAfter = await readCountReading(page, snapshotAfterKeepalive, armB);
    console.log(`counts.after=${describeCounts(countsAfter.counts)}`);
    expect(
      totalOf(countsAfter.counts),
      'adding one keepalive must raise the count the bar shows and the count the listing reports',
    ).toBeGreaterThan(totalOf(countsBefore.counts));

    // The page is reloaded here, and only for this: a document open before the run started was never
    // attached to it, and an unattached socket is never told how the run ended. Reloading subscribes
    // to a run already in flight, which is exactly the state a user returning to a working session is
    // in — the reading below is the one that user gets.
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(BAR)).toHaveAttribute('data-resident-ui-state', 'busy', { timeout: 15_000 });

    // --- stopping the turn leaves the process running: the abort ---------------------------------
    const barBeforeAbort = await readBar(page);
    const abortHostId = barBeforeAbort.hostId;
    const snapshotBeforeAbort = await readHosts(api);
    const hostBeforeAbort = liveHost(snapshotBeforeAbort, armB);
    const stopLabel = readKey(chatLocale(LOCALE), 'resident.stopResident');
    if (typeof stopLabel !== 'string') throw new Error('en/chat.json has no resident.stopResident');
    const stop = page.getByRole('button', { name: stopLabel }).first();
    await stop.waitFor({ state: 'visible', timeout: 15_000 });
    await stop.click();

    await expect
      .poll(async () => completedAborts(await socketFrames(page), armB), { timeout: 15_000 })
      .toBeGreaterThan(0);

    const snapshotAfterAbort = await readHosts(api);
    const hostAfterAbort = liveHost(snapshotAfterAbort, armB);
    console.log(
      `run.status=aborted host.hostId.before=${hostBeforeAbort?.hostId ?? '(none)'} `
      + `host.hostId.after=${hostAfterAbort?.hostId ?? '(none)'} `
      + `same=${String(hostBeforeAbort?.hostId === hostAfterAbort?.hostId && abortHostId === hostAfterAbort?.hostId)}`,
    );
    const barAfterAbort = await readBar(page);
    const sameHost = hostBeforeAbort?.hostId === hostAfterAbort?.hostId && abortHostId === hostAfterAbort?.hostId;
    console.log(
      `host.state.after=${hostAfterAbort?.state ?? '(none)'} pid.before=${hostBeforeAbort?.pid ?? '(none)'} `
      + `pid.after=${hostAfterAbort?.pid ?? '(none)'} same=${String(hostBeforeAbort?.pid === hostAfterAbort?.pid)} `
      // The debug fixture is a clock walk over a file, so its host carries no OS pid and the line above
      // reads `(none)` twice — true, and worth nothing on its own. The readings that make "the same
      // process is still here" falsifiable are the ones below: the host record's own identity and birth
      // stamp, and the pid the *bar* shows a reader, must all be unchanged by a stopped turn.
      + `startedAt.before=${hostBeforeAbort?.startedAt ?? '(none)'} startedAt.after=${hostAfterAbort?.startedAt ?? '(none)'} `
      + `startedAt.same=${String(hostBeforeAbort?.startedAt === hostAfterAbort?.startedAt)} `
      + `bar.pid.before=${JSON.stringify(barBeforeAbort.pid)} bar.pid.after=${JSON.stringify(barAfterAbort.pid)} `
      + `host.closeReason.after=${JSON.stringify(hostAfterAbort?.closeReason ?? null)}`,
    );
    expect(hostBeforeAbort, 'the turn was stopped inside a live process, so one must exist').not.toBeNull();
    expect(hostAfterAbort?.hostId, 'stopping a turn must not replace the process').toBe(hostBeforeAbort?.hostId);
    expect(sameHost, 'the bar must still be pointed at the process the turn was stopped in').toBe(true);
    expect(hostAfterAbort?.pid, 'stopping a turn must not restart the process').toBe(hostBeforeAbort?.pid);
    expect(hostAfterAbort?.startedAt, 'the process the turn was stopped in must not be a new one').toBe(
      hostBeforeAbort?.startedAt,
    );
    expect(['idle', 'lingering'], 'a stopped turn leaves a process between turns').toContain(
      hostAfterAbort?.state ?? '',
    );
    expect(hostAfterAbort?.closeReason ?? null, 'a stopped turn must not close the host').toBeNull();

    // --- the process exits on its own: exited(oom) -----------------------------------------------
    await expect(page.locator(BAR)).toHaveAttribute('data-resident-ui-state', 'exited', { timeout: 15_000 });
    const exited = await readBar(page);
    const snapshotExited = await readHosts(api);
    const exitedHost = lastHost(snapshotExited, armB);
    console.log(
      `state=${STATE_WORD.exited} mark=${MARK_SHAPES.exited} bar=${JSON.stringify(exited.text)} `
      + `snapshot.state=${exitedHost?.state ?? 'absent'} closeReason=${exitedHost?.closeReason ?? '(none)'} `
      + `detail=${exitedHost?.closeDetail ?? '(none)'} via=scenario-step`,
    );
    expect(exitedHost?.closeReason, 'the walked process ended on its own').toBe('exited');
    expect(exitedHost?.closeDetail, 'the exit detail the scenario stated must survive to the listing').toBe('oom');
    expect(exited.text, 'the exited sentence carries the detail the listing publishes').toBe(
      statusBarText('exited', { detail: exitedHost?.closeDetail ?? '' }),
    );
    const exitedMark = await readMark(page, armB);
    expect(exitedMark.shape, 'the sidebar draws the exited shape').toBe(MARK_SHAPES.exited);
    expect(exitedMark.detail, 'the mark carries the same exit detail as the bar').toBe('oom');

    page.off('response', recordTraffic);
    const clockBReading = await clockB;
    const runSource = clockBReading.body?.data?.runSource ?? null;
    const seamRefusals = controlPlaneTraffic.filter((text) => text.includes('DEBUG_AGENT_RUN_SEAM_UNAVAILABLE')).length;
    console.log(`unattended.run.source=${String(runSource)} seam.unwired=${String(seamRefusals > 0)}`);
    console.log(`run.seamRefusals=${seamRefusals}`);
    expect(clockBReading.ok, `arm B's clock walk must complete: ${JSON.stringify(clockBReading)}`).toBe(true);
    expect(runSource, 'the unattended turn opens the run, so that run is the one the registry holds').toBe(
      'unattended',
    );
    expect(seamRefusals, 'a run that reaches this reading had its seam wired').toBe(0);

    // --- the transcript rows, read after a load that started from nothing ------------------------
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    // The pane mounts before its transcript does, so the rows below are awaited rather than read on
    // the next line: `toBeVisible` on the pane says the container is up, and a row count read against
    // a still-loading transcript is a reading of an empty pane — the same number a product that had
    // dropped every unattended row would produce.
    const userRow = page.locator(`[data-message-style="user"]`).filter({ hasText: SEED_USER_TEXT }).first();
    await expect(userRow, 'the stored transcript must be on screen before its rows are counted').toBeVisible({
      timeout: 30_000,
    });

    const dividers = await page.locator(DIVIDER).evaluateAll((nodes) =>
      nodes.map((node) => ({
        trigger: node.getAttribute('data-unattended-divider') ?? '',
        sender: node.getAttribute('data-unattended-sender') ?? '',
        text: (node.textContent ?? '').trim(),
      })),
    );
    const unattendedRows = await page.locator(UNATTENDED_ROW).evaluateAll((nodes) =>
      nodes.map((node) => ({
        style: node.getAttribute('data-message-style') ?? '',
        sender: node.getAttribute('data-unattended-sender') ?? '',
        text: (node.textContent ?? '').trim(),
      })),
    );

    for (const divider of dividers) {
      console.log(
        `divider=${JSON.stringify(divider.text)} trigger=${divider.trigger} `
        + `sender=${JSON.stringify(divider.sender)}`,
      );
    }
    for (const row of unattendedRows) {
      console.log(
        `row.text=${JSON.stringify(row.text)} row.class=${row.style} isUserStyle=${String(row.style === 'user')}`,
      );
    }

    expect(dividers.length, 'each unattended turn is introduced by its own divider').toBe(2);
    const cronDivider = dividers.find((divider) => divider.trigger === 'cron');
    const crossDivider = dividers.find((divider) => divider.trigger === 'cross-session');
    expect(cronDivider, 'a turn a scheduled task opened keeps that trigger on its divider').toBeTruthy();
    expect(crossDivider, 'a turn another conversation opened keeps that trigger on its divider').toBeTruthy();

    const cronTemplate = readKey(chatLocale(LOCALE), 'resident.divider.cron');
    const crossTemplate = readKey(chatLocale(LOCALE), 'resident.divider.crossSession');
    if (typeof cronTemplate !== 'string' || typeof crossTemplate !== 'string') {
      throw new Error('en/chat.json has no resident.divider templates');
    }
    // The time in a divider is the row's own timestamp, printed the way the app prints one — read off
    // the rendered sentence rather than recomputed, so this checks the *label* the trigger produced
    // and not this file's idea of what time it was.
    const clockOf = (text: string): string => (/(\d{1,2}:\d{2})/.exec(text) ?? ['', ''])[1];
    expect(cronDivider?.text, 'the scheduled-task divider is the shipped sentence for that trigger').toBe(
      render(cronTemplate, { time: clockOf(cronDivider?.text ?? '') }),
    );
    expect(crossDivider?.sender, 'the cross-session divider names the sender the scenario stated').toBe(PEER_NAME);
    expect(crossDivider?.text, 'the cross-session divider is the shipped sentence with that sender').toBe(
      render(crossTemplate, { sender: PEER_NAME, time: clockOf(crossDivider?.text ?? '') }),
    );

    expect(unattendedRows.length, 'both unattended turns render as rows of their own').toBe(2);
    for (const row of unattendedRows) {
      expect(row.style, 'a turn nobody typed must not wear the user\'s own bubble style').not.toBe('user');
    }
    console.log(
      `userRow.isUserStyle=${String((await userRow.getAttribute('data-message-style')) === 'user')} `
      + `userRow.text=${JSON.stringify((await userRow.innerText()).trim())}`,
    );
    expect(
      await userRow.getAttribute('data-message-style'),
      'the control for the two rows above: a turn the reader did type still renders as one',
    ).toBe('user');
  });

  /**
   * The shipped copy, in every locale the app ships.
   *
   * The sentences this criterion renders are read from the files the app loads, so a criterion that
   * hard-coded one would pass while the product showed nothing. This test is the other half: the keys
   * must exist, and be non-empty, in all of them — a locale missing a key renders the raw key string
   * to a user, which is a face of the product this feature must not add.
   */
  test('every shipped locale carries the keys the bar, the mark and the dividers read', async () => {
    const required: Array<{ file: 'chat.json' | 'sidebar.json'; path: string }> = [
      ...['unstarted', 'idle', 'busy', 'exited', 'start', 'restart', 'close', 'copyAddress', 'copied', 'address']
        .map((key) => ({ file: 'chat.json' as const, path: `resident.statusBar.${key}` })),
      ...['turn', 'background-task', 'monitor', 'cron', 'resident-policy']
        .map((key) => ({ file: 'chat.json' as const, path: `resident.statusBar.counts.${key}` })),
      ...['cron', 'crossSession', 'backgroundTask', 'unknown']
        .map((key) => ({ file: 'chat.json' as const, path: `resident.divider.${key}` })),
      { file: 'chat.json', path: 'resident.stopResident' },
      ...['unstarted', 'idle', 'busy', 'exited']
        .map((key) => ({ file: 'sidebar.json' as const, path: `resident.mark.${key}` })),
    ];

    const missing: string[] = [];
    for (const locale of ALL_LOCALES) {
      for (const entry of required) {
        const value = readKey(readLocaleFile(locale, entry.file), entry.path);
        if (typeof value !== 'string' || value.trim().length === 0) {
          missing.push(`${locale}/${entry.file}:${entry.path}`);
        }
      }
    }

    console.log(`locales.checked=${ALL_LOCALES.length} keys.perLocale=${required.length} missing=${missing.length}`);
    console.log(`locales=${ALL_LOCALES.join(',')}`);
    expect(missing, `every locale must carry these keys; missing: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * The wall clock, against the ceiling the goal gate kills at.
   *
   * Read from the run's own start — published by `playwright.config.ts` because a spec can only see
   * itself, and the ceiling binds the whole `npx playwright test` invocation: config evaluation,
   * seeding, server boot and browser launch all happen inside it. A spec that timed its own body
   * would report a number whose shortfall against the ceiling is exactly the part it could not see.
   */
  test('the run ends inside the ceiling the goal gate kills at', async () => {
    const runStartedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);
    const elapsed = Date.now() - runStartedAt;
    console.log(`elapsed=${elapsed}ms`);
    expect(elapsed, `the whole invocation, measured from the config's own start`).toBeLessThan(55_000);
  });
});

// ---------------------------------------------------------------------------------------------
// Small readings shared by the tests above.
// ---------------------------------------------------------------------------------------------

/** `GET /api/session-hosts`, as this file reads it. */
async function readHosts(api: APIRequestContext): Promise<HostsSnapshot> {
  const response = await api.get('/api/session-hosts');
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`GET /api/session-hosts answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  return { hosts: body?.data?.hosts ?? [], sessions: body?.data?.sessions ?? [] };
}

/** One session's stored state, or null. */
function readSessionState(snapshot: HostsSnapshot, sessionId: string): SessionRecord | null {
  return snapshot.sessions.find((session) => session.appSessionId === sessionId) ?? null;
}

/** The sum of a count map — the one number a "grew" assertion is about. */
function totalOf(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

/**
 * The bar's counts, beside the listing's, with the mapping between a lease kind and the pill a
 * reader sees spelled out for every kind present.
 *
 * Returns the bar's own map: the mapping is printed, not asserted, because "which pill a kind is
 * drawn as" is decided by the shipped locale's `counts` keys, and the assertion that matters — that
 * both sides agree kind for kind — is made by the caller against the same map.
 */
async function readCountReading(
  page: Page,
  snapshot: HostsSnapshot,
  sessionId: string,
): Promise<{ counts: Map<string, number>; mapping: string }> {
  const bar = await readBar(page);
  const host = leaseCounts(liveBinding(snapshot, sessionId));
  const mapping = [...bar.counts.keys()]
    .sort()
    .map((kind) => {
      const label = readKey(chatLocale(LOCALE), `resident.statusBar.counts.${kind}`);
      return `${String(label ?? kind)} ← ${kind}(${host.get(kind) ?? 0})`;
    })
    .join('; ');
  expect(
    describeCounts(bar.counts),
    'the bar counts the leases the listing reports, kind for kind',
  ).toBe(describeCounts(host));
  return { counts: bar.counts, mapping };
}

/**
 * How many terminal `complete` frames carrying `aborted` this document has received for a session.
 *
 * The frame is the run's own report of how it ended, which is the only place "aborted" exists at all:
 * the REST listing describes the process, and a process a user stopped is still running.
 */
function completedAborts(frames: Array<Record<string, unknown>>, sessionId: string): number {
  return frames.filter(
    (frame) => frame.kind === 'complete' && frame.aborted === true && frame.sessionId === sessionId,
  ).length;
}
