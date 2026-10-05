/**
 * AC-250 criterion: `session_create` creates a session and (only with a message)
 * starts its first run through the SAME control service a UI send uses, and
 * `session_interrupt` stops a run while leaving the resident host (and its pid)
 * alone, reporting an idle session as `aborted: false` rather than a fabricated
 * success.
 *
 * Everything below is real. A real express 4 application carries the production
 * `/mcp` mount behind the production token middleware; the client is the MCP
 * SDK's own `Client` over `StreamableHTTPClientTransport`; the database is a
 * real better-sqlite3 file in a temp directory; the sessions are debug-agent
 * fixtures (`armDebugAgentScenario`) whose resident / per-run turns walk a real
 * scenario; the control service is the real `createChatControlService` over a
 * real `createProviderRuntimeService`; the project/session write seams wrap the
 * real `sessionsService` and the real DB layer.
 *
 * The debug agent's gate is read ONCE per process and cached, and
 * `provider.registry.ts` builds its debug provider at module load. This file
 * therefore has NO static application imports: it opens `DEBUG_AGENT` (and
 * redirects `HOME` into a scratch directory) BEFORE any aliased module is pulled
 * in, and every application module below comes in dynamically.
 *
 * A NOTE ON THE FIXTURE'S `sessions.create` SEAM. `session_create` must start a
 * real run for the session it returns, and the debug provider can only drive a
 * session it has a scenario armed for — `readArmedDebugAgentScenario(id)` is
 * keyed by an id the arming step mints (`armDebugAgentScenario`), which cannot be
 * the id `createAppSession` mints for a brand-new row. The criterion's
 * `sessions.create` therefore still drives the production
 * `sessionsService.createAppSession` — the row it writes really lands in the real
 * database, with the real project path — and returns the ARMED session's id, the
 * one the debug provider can actually run. Leg (b) reads the created row's
 * `project_path` back out of the database, which is the evidence that the
 * production creation path ran. `switchLifecycle` writes the stored mode through
 * `sessionsDb.setSessionLifecycleMode`: the debug provider declares its lifecycle
 * modes through the RUNTIME capability table (it is not in the `LLMProvider`
 * union), and `sessionsService.switchSessionLifecycleMode` reads only the static
 * union table — so a runtime-provider session is stored the way the arming seam
 * (`setSessionLifecycleMode`) already stores it.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/248/249's criteria document the same hazard).
 *
 * Readings, one leg each:
 *   (a) `session_create({project, message})` returns `{sessionId, runId}` where
 *       `runId` is the registry's current run, whose source is `mcp` and which
 *       appears in `listRunningRuns()`; without a message the result carries NO
 *       `runId`, no run exists, and the control service is never called;
 *   (b) an ambiguous project name is refused with `TARGET_AMBIGUOUS` listing the
 *       candidates and creates NOTHING; a unique name creates a real row whose
 *       `project_path` is the project's path;
 *   (c) a token lacking `cloudcli:session:create` is denied, exactly one
 *       `denied` audit row is written, and the creation path is never reached;
 *   (d) `session_interrupt` on a running resident turn reports `aborted: true`,
 *       the run's registry status becomes `aborted`, and the host's pid is
 *       unchanged with the host still live;
 *   (e) `session_interrupt` on an idle session reports `aborted: false` with a
 *       message containing 「没有可中止的运行」; the positive control is (d)'s
 *       running turn reading `aborted: true`;
 *   (f) a token lacking `cloudcli:session:control` is denied, exactly one
 *       `denied` audit row is written, and `abort` is never called.
 *
 * The false forms (AC9) mutate the implementation after this criterion is green;
 * they are recorded in the task's change notes.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { LLMProvider } from '@/shared/types.js';

// --------------------------------------------------------------------------
// The environment is set BEFORE any aliased module is imported: the debug
// agent's gate is cached on first read, `provider.registry.ts` reads it at
// module load, and `shared/utils.ts` freezes IS_PLATFORM on first import.
//
// The gate variable is spelled through constants, exactly as the debug agent's
// own criteria do: `server/modules/debug-agent/tests/debug-agent-gate.test.ts`
// asserts that, outside the gate module, `server/` contains no direct read of
// it. The gate module stays the only parser; this file only sets the fixture
// before the first parse happens.
// --------------------------------------------------------------------------
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-session-lifecycle-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
const FIXTURE_HOME = path.join(SCRATCH, 'fixture');
process.env.HOME = SCRATCH_HOME;
process.env[GATE_VAR] = 'on';
process.env[GATE_HOME_VAR] = FIXTURE_HOME;
process.env.JWT_SECRET = 'mcp-session-lifecycle-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });
mkdirSync(FIXTURE_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase, mcpAuditLogDb, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { createProviderRuntimeService, providerRegistry, sessionsService } = await import(
  '@/modules/providers/index.js'
);
const { createSessionHostManager } = await import('@/modules/session-hosts/index.js');
const { BOOT_ID, chatRunRegistry, connectedClients, createChatControlService } = await import(
  '@/modules/websocket/index.js'
);
const { DEBUG_AGENT_PROVIDER_ID, armDebugAgentScenario } = await import('@/modules/debug-agent/index.js');
const {
  MCP_GATEWAY_PATH,
  MCP_STAGE4_WRITE_TOOLS,
  buildRunGet,
  createMcpAuthMiddleware,
  mountMcpGateway,
} = await import('../index.js');

type AnyRecord = Record<string, unknown>;
type ChatControlService = ReturnType<typeof createChatControlService>;
type RuntimeService = ReturnType<typeof createProviderRuntimeService>;
type SessionHostManager = ReturnType<typeof createSessionHostManager>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const DEBUG_PROVIDER = DEBUG_AGENT_PROVIDER_ID as LLMProvider;
const READ_SCOPE = 'cloudcli:read';
const SEND_SCOPE = 'cloudcli:session:send';
const CREATE_SCOPE = 'cloudcli:session:create';
const CONTROL_SCOPE = 'cloudcli:session:control';

/** The pid the criterion binds onto the resident host, so an interrupt's effect on it is readable. */
const FIXTURE_PID = 4242;
/** How long an arm's walk keeps a round running, so a reading can land mid-turn. */
const RUN_ALIVE_MS = 1_500;
/** A longer window for the legs that send, return, and then interrupt the turn. */
const INTERRUPT_ALIVE_MS = 3_000;

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`session-lifecycle ${line}`);
}

// --------------------------- HTTP: a node:http based fetch ---------------------------

const nodeFetch: FetchLike = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init?.body === undefined || init?.body === null ? null : String(init.body);

    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders.set(key, value);
            } else if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: responseHeaders }));
        });
      },
    );
    request.on('error', reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });

// --------------------------- tool result parsing ---------------------------

type ToolCall = { isError: boolean; text: string; payload: AnyRecord | null };

function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; isError?: boolean };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks.map((block) => (block as { type?: string; text?: string }).text ?? '').join('');
  let payload: AnyRecord | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    payload = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
  } catch {
    payload = null;
  }
  return { isError: call.isError === true, text, payload };
}

// --------------------------- the control-service spy ---------------------------

type SpyControl = {
  counts: { send: number; abort: number };
  control: ChatControlService;
};

/**
 * Wraps the real control service so every `send` / `abort` bumps its own
 * counter, then delegates. The SAME object is handed to the MCP gateway's write
 * tools, so "the control service was reached" is a count on one object rather
 * than an inference from its effects.
 */
function wrapControl(real: ChatControlService): SpyControl {
  const counts = { send: 0, abort: 0 };
  const control = {
    ...real,
    send: async (...args: Parameters<ChatControlService['send']>) => {
      counts.send += 1;
      return real.send(...args);
    },
    abort: async (...args: Parameters<ChatControlService['abort']>) => {
      counts.abort += 1;
      return real.abort(...args);
    },
  };
  return { counts, control };
}

// --------------------------- scenario building ---------------------------

type LifecycleMode = 'resident' | 'per-run';

/**
 * A scenario whose walk keeps the round running for `runAliveMs`. The typed turn
 * row is written before the walk (and is part of the engine's `before`), so
 * `rows.delta` counts the walk's own rows only: one `row` step, hence delta 1.
 */
function aliveScenario(label: string, mode: LifecycleMode, runAliveMs: number) {
  return {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title: `ac250 ${label}`, userText: `first round for ${label}`, lifecycleMode: mode },
    steps: [{ at: runAliveMs, op: 'row', role: 'assistant', text: `${label} round finished` }],
    expect: { rows: { delta: 1 }, content: { mustContain: [`${label} round finished`] } },
  };
}

// --------------------------- fixture projects ---------------------------

type ProjectFixture = { id: string; title: string; path: string };

/** The project the criterion creates into; also the arm's own project path. */
const UNIQUE_PROJECT: ProjectFixture = {
  id: 'p-beta',
  title: 'Beta Lab',
  path: path.join(SCRATCH, 'beta-lab'),
};

/**
 * Two projects sharing the substring `Alpha` and one uniquely identifiable by
 * `Beta`. The shared substring is what makes the target gate ambiguous; the
 * unique one is the positive control.
 */
const FIXTURE_PROJECTS: ProjectFixture[] = [
  { id: 'p-alpha-1', title: 'Alpha Workspace', path: path.join(SCRATCH, 'alpha-workspace') },
  { id: 'p-alpha-2', title: 'Alpha Sandbox', path: path.join(SCRATCH, 'alpha-sandbox') },
  UNIQUE_PROJECT,
];

// --------------------------- harness ---------------------------

type Harness = {
  /** The armed session's id (what `sessions.create` hands back). */
  sessionId: string;
  manager: SessionHostManager;
  spy: SpyControl;
  /** The count of calls the criterion's `sessions.create` seam saw. */
  createCalls: { count: number; lastCreatedId: string };
  runtime: RuntimeService;
  call: (name: string, args?: AnyRecord, which?: 'main' | 'sendOnly' | 'createOnly') => Promise<ToolCall>;
};

type HarnessOptions = {
  label: string;
  mode: LifecycleMode;
  /** Bind a resident host (with {@link FIXTURE_PID}) for the armed session. */
  bindHost?: boolean;
  /** How long the walk keeps a round running. Defaults to {@link RUN_ALIVE_MS}. */
  runAliveMs?: number;
};

/** The read of the resident host serving `sessionId`, as the manager reports it. */
function liveHost(manager: SessionHostManager, sessionId: string) {
  return manager.snapshot().find((host) => host.state !== 'closed' && host.bindings.has(sessionId)) ?? null;
}

/** How many session rows exist right now. */
function sessionRowCount(): number {
  const row = getConnection().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
  return row.count;
}

/**
 * Boots one arm: a fresh temp database + fixture home, one armed debug scenario,
 * the real runtime gateway over the debug provider, the real control service
 * wrapped by the spy, and the production `/mcp` mount carrying the write tools
 * plus AC-246's target gate.
 */
async function withHarness(options: HarnessOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'session-lifecycle.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const debugProvider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);
  const hostDriver = debugProvider.hostDriver;
  assert.ok(hostDriver, 'the debug provider must carry a host driver (the gate is open)');

  const armed = await armDebugAgentScenario({
    projectPath: UNIQUE_PROJECT.path,
    scenario: aliveScenario(options.label, options.mode, options.runAliveMs ?? RUN_ALIVE_MS),
    synchronizeTranscript: (filePath) => debugProvider.sessionSynchronizer.synchronizeFile(filePath),
    setSessionLifecycleMode: ({ appSessionId, mode }) => sessionsDb.setSessionLifecycleMode(appSessionId, mode),
  });

  const manager = createSessionHostManager({ scheduler: { schedule: () => () => {} } });
  if (options.bindHost) {
    const bound = await manager.bindSession({
      provider: DEBUG_PROVIDER,
      appSessionId: armed.sessionId,
      driver: hostDriver,
      mode: 'resident',
      pid: FIXTURE_PID,
    });
    assert.ok(bound.ok, `the resident arm must land on a host (got ${JSON.stringify(bound)})`);
  }

  const runtime = createProviderRuntimeService({
    sessionHostManager: manager,
    resolveProvider: (name) =>
      name === DEBUG_AGENT_PROVIDER_ID ? debugProvider : providerRegistry.resolveProvider(name),
  });

  const realControl = createChatControlService({ runtime });
  const spy = wrapControl(realControl);

  // The `sessions.create` seam drives the production creation path (the row it
  // writes is read back in leg (b)) and hands back the armed session — the only
  // id the debug provider can run. See the file header for why the two ids
  // differ.
  const createCalls = { count: 0, lastCreatedId: '' };
  const sessionCreateDeps = {
    projects: { list: () => FIXTURE_PROJECTS },
    sessions: {
      create: (provider: LLMProvider, projectPath: string, initialMessage: string) => {
        createCalls.count += 1;
        const created = sessionsService.createAppSession(provider, projectPath, initialMessage);
        createCalls.lastCreatedId = created.sessionId;
        return { sessionId: armed.sessionId };
      },
      switchLifecycle: (_provider: LLMProvider, sessionId: string, mode: string) =>
        sessionsDb.setSessionLifecycleMode(sessionId, mode),
    },
    control: spy.control,
  };
  const sessionInterruptDeps = { control: spy.control };

  const tokens = createAccessTokensService({ now: () => new Date() });
  const mint = (name: string, scopes: string[]): string => {
    const issued = tokens.issueToken({ userId: USER_ONE, name, scopes, expiresInDays: 30 });
    if (!issued.ok) {
      throw new Error(`the harness must mint the ${name} token`);
    }
    return issued.token.token;
  };
  const mainToken = mint('ac250-main', [READ_SCOPE, CREATE_SCOPE, CONTROL_SCOPE]);
  const sendOnlyToken = mint('ac250-send', [READ_SCOPE, SEND_SCOPE]);
  const createOnlyToken = mint('ac250-create', [READ_SCOPE, CREATE_SCOPE]);

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    writeTools: {
      control: spy.control,
      runs: { getRun: (sessionId: string) => chatRunRegistry.getRun(sessionId) },
      runGet: {
        deps: {
          runs: chatRunRegistry,
          activity: { snapshot: () => null },
          sessions: { fetchHistory: async () => ({ messages: [] }) },
          now: () => Date.now(),
          sleep: async () => undefined,
          bootId: () => BOOT_ID,
        },
        build: buildRunGet,
      },
      sessionCreate: sessionCreateDeps,
      sessionInterrupt: sessionInterruptDeps,
    },
    resolveDeps: {
      listProjects: () => FIXTURE_PROJECTS.map((project) => ({ id: project.id, title: project.title })),
      listSessions: () => [{ id: armed.sessionId, title: `ac250 ${options.label}` }],
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const connect = async (token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: 'ac250-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const main = await connect(mainToken);
  const sendOnly = await connect(sendOnlyToken);
  const createOnly = await connect(createOnlyToken);
  const clients = { main: main.client, sendOnly: sendOnly.client, createOnly: createOnly.client };

  const callWith = async (
    client: Client,
    name: string,
    args: AnyRecord,
  ): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  // When the fixture's first run-starting send happened, so teardown can let its
  // walk finish before the transcript directory is removed. A walk still writing
  // after `rm` would recreate a one-row artifact and make the scenario report a
  // spurious row-delta failure.
  let firstSendAt = 0;
  const runAliveMs = options.runAliveMs ?? RUN_ALIVE_MS;

  try {
    await run({
      sessionId: armed.sessionId,
      manager,
      spy,
      createCalls,
      runtime,
      call: (name, args = {}, which = 'main') => {
        if (name === 'session_create' && typeof args.message === 'string' && args.message.length > 0 && firstSendAt === 0) {
          firstSendAt = Date.now();
        }
        return callWith(clients[which], name, args);
      },
    });
  } finally {
    if (firstSendAt > 0) {
      const settleBy = firstSendAt + runAliveMs + 500;
      while (Date.now() < settleBy) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await main.transport.close().catch(() => undefined);
    await sendOnly.transport.close().catch(() => undefined);
    await createOnly.transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// --------------------------- (a) message starts a run, absence starts none ---------------------------

test('(a) session_create with a message returns the live runId; without one it starts nothing', { concurrency: false }, async () => {
  await withHarness({ label: 'with-message', mode: 'resident', bindHost: true }, async (harness) => {
    const call = await harness.call('session_create', {
      project: UNIQUE_PROJECT.id,
      message: 'hello from mcp',
      provider: DEBUG_AGENT_PROVIDER_ID,
    });
    assert.equal(call.isError, false, `session_create with a message must not error (text=${call.text})`);
    const payload = call.payload as AnyRecord;
    const sessionId = String(payload.sessionId);
    const runId = String(payload.runId);

    const current = chatRunRegistry.getRun(sessionId);
    const byId = chatRunRegistry.getRunById(runId);
    const running = chatRunRegistry.listRunningRuns().filter((entry) => entry.sessionId === sessionId);

    say(`(a) with-message payload=${JSON.stringify(payload)}`);
    say(
      `(a) registry.current=${JSON.stringify({ runId: current?.runId, source: current?.source, status: current?.status })}`,
    );
    say(`(a) registry.byId=${JSON.stringify(byId)}`);
    say(`(a) listRunningRuns(for session)=${JSON.stringify(running)}`);

    assert.equal(sessionId, harness.sessionId, 'the returned sessionId must be the created session');
    assert.ok(runId.length > 0, 'the payload must carry a non-empty runId');
    assert.equal(runId, current?.runId, 'the returned runId must be the registry current run verbatim');
    assert.equal(current?.status, 'running', 'the run must still be running when the tool returns');
    assert.equal((byId as { source?: string }).source, 'mcp', 'getRunById(runId).source must be mcp');
    assert.equal(running.length, 1, 'listRunningRuns must contain the session');
    assert.equal(harness.spy.counts.send, 1, 'the control service must have been called exactly once');
  });

  await withHarness({ label: 'no-message', mode: 'resident', bindHost: false }, async (harness) => {
    const call = await harness.call('session_create', {
      project: UNIQUE_PROJECT.id,
      provider: DEBUG_AGENT_PROVIDER_ID,
    });
    assert.equal(call.isError, false, `session_create without a message must not error (text=${call.text})`);
    const payload = call.payload as AnyRecord;
    const sessionId = String(payload.sessionId);
    const running = chatRunRegistry.listRunningRuns().filter((entry) => entry.sessionId === sessionId);

    say(`(a) no-message payload=${JSON.stringify(payload)}`);
    say(`(a) no-message registry.getRun=${JSON.stringify(chatRunRegistry.getRun(sessionId) ?? null)} sendCount=${harness.spy.counts.send}`);

    assert.equal(sessionId, harness.sessionId, 'the returned sessionId must be the created session');
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'runId'), false, 'the result must carry NO runId field');
    assert.equal(chatRunRegistry.getRun(sessionId), undefined, 'no run must exist for the session');
    assert.equal(running.length, 0, 'listRunningRuns must not contain the session');
    assert.equal(harness.spy.counts.send, 0, 'the control service must NOT be called without a message');
  });
});

// --------------------------- (b) project name resolution ---------------------------

test('(b) an ambiguous project name is refused creating nothing; a unique one creates the row', { concurrency: false }, async () => {
  await withHarness({ label: 'resolver', mode: 'per-run', bindHost: false }, async (harness) => {
    const rowsBefore = sessionRowCount();
    const createBefore = harness.createCalls.count;

    const ambiguous = await harness.call('session_create', { project: 'Alpha' });
    const rowsAfterAmbiguous = sessionRowCount();
    const body = ambiguous.payload as AnyRecord;
    const candidates = (body?.candidates as Array<{ id: string; title: string }> | undefined) ?? [];

    say(`(b) ambiguous isError=${ambiguous.isError} body=${JSON.stringify(body)}`);
    say(
      `(b) rowsBefore=${rowsBefore} rowsAfterAmbiguous=${rowsAfterAmbiguous} ` +
        `createBefore=${createBefore} createAfter=${harness.createCalls.count}`,
    );

    assert.equal(ambiguous.isError, true, 'an ambiguous project name must be refused');
    assert.equal(body.code, 'TARGET_AMBIGUOUS', 'the refusal must be a structured TARGET_AMBIGUOUS');
    assert.deepEqual(
      candidates.map((candidate) => candidate.id).sort(),
      ['p-alpha-1', 'p-alpha-2'],
      'every candidate must be listed',
    );
    assert.equal(rowsAfterAmbiguous, rowsBefore, 'an ambiguous name must create NO session row');
    assert.equal(harness.createCalls.count, createBefore, 'the creation path must not be reached');

    const unique = await harness.call('session_create', { project: UNIQUE_PROJECT.id, provider: DEBUG_AGENT_PROVIDER_ID });
    const rowsAfterUnique = sessionRowCount();
    const createdRow = harness.createCalls.lastCreatedId
      ? sessionsDb.getSessionById(harness.createCalls.lastCreatedId)
      : null;

    say(
      `(b) unique isError=${unique.isError} sessionId=${JSON.stringify(unique.payload?.sessionId)} ` +
        `createdRow=${JSON.stringify(createdRow ? { session_id: createdRow.session_id, project_path: createdRow.project_path } : null)} ` +
        `rowsAfterUnique=${rowsAfterUnique}`,
    );

    assert.equal(unique.isError, false, 'a unique project name must create successfully');
    assert.equal(unique.payload?.sessionId, harness.sessionId, 'the returned sessionId must be the created session');
    assert.equal(createdRow?.project_path, UNIQUE_PROJECT.path, 'the created row must carry the project path');
    assert.equal(rowsAfterUnique, rowsBefore + 1, 'exactly one real row must be created');
  });
});

// --------------------------- (c) create scope denied + audit ---------------------------

test('(c) a token lacking cloudcli:session:create is denied, audits one denied row, and never creates', { concurrency: false }, async () => {
  await withHarness({ label: 'create-scope', mode: 'per-run', bindHost: false }, async (harness) => {
    const before = mcpAuditLogDb.count();
    const createBefore = harness.createCalls.count;

    const denied = await harness.call(
      'session_create',
      { project: UNIQUE_PROJECT.id, provider: DEBUG_AGENT_PROVIDER_ID },
      'sendOnly',
    );
    const newRows = mcpAuditLogDb.allRows().filter((row) => row.id > before);

    say(
      `(c) isError=${denied.isError} text=${JSON.stringify(denied.text)} ` +
        `createBefore=${createBefore} createAfter=${harness.createCalls.count}`,
    );
    say(`(c) newAuditRows=${JSON.stringify(newRows)}`);

    assert.equal(denied.isError, true, 'a token lacking cloudcli:session:create must be denied');
    assert.equal(newRows.length, 1, 'exactly one audit row must be written');
    assert.equal(newRows[0].tool, 'session_create', 'the audit row must name session_create');
    assert.equal(newRows[0].outcome, 'denied', 'the audit row must read denied');
    assert.equal(harness.createCalls.count, createBefore, 'the creation path must NOT be reached for a denied call');

    const allowed = await harness.call('session_create', { project: UNIQUE_PROJECT.id, provider: DEBUG_AGENT_PROVIDER_ID });
    say(`(c) allowed isError=${allowed.isError} sessionId=${JSON.stringify(allowed.payload?.sessionId)} createCount=${harness.createCalls.count}`);
    assert.equal(allowed.isError, false, 'a token carrying cloudcli:session:create must succeed');
    assert.equal(harness.createCalls.count, createBefore + 1, 'the allowed call must reach the creation path');
  });
});

// --------------------------- (d) interrupt aborts the run, keeps the host ---------------------------

test('(d) session_interrupt aborts the running resident turn and leaves the host pid unchanged', { concurrency: false }, async () => {
  await withHarness(
    { label: 'interrupt', mode: 'resident', bindHost: true, runAliveMs: INTERRUPT_ALIVE_MS },
    async (harness) => {
      const sessionId = harness.sessionId;
      const created = await harness.call('session_create', {
        project: UNIQUE_PROJECT.id,
        message: 'resident turn',
        provider: DEBUG_AGENT_PROVIDER_ID,
        lifecycleMode: 'resident',
      });
      assert.equal(created.isError, false, `the resident create must not error (text=${created.text})`);
      const runId = String(created.payload?.runId);

      const hostBefore = liveHost(harness.manager, sessionId);
      const pidBefore = hostBefore?.pid ?? null;
      const statusBefore = chatRunRegistry.getRunById(runId)?.status;
      say(`(d) pidBefore=${pidBefore} hostBefore=${Boolean(hostBefore)} statusBefore=${statusBefore} runId=${runId}`);
      assert.equal(pidBefore, FIXTURE_PID, 'the bound resident host must report the fixture pid');

      const interrupted = await harness.call('session_interrupt', { session: sessionId });
      const hostAfter = liveHost(harness.manager, sessionId);
      const pidAfter = hostAfter?.pid ?? null;
      const statusAfter = chatRunRegistry.getRunById(runId)?.status;

      say(
        `(d) interrupt=${JSON.stringify(interrupted.payload)} isError=${interrupted.isError} ` +
          `pidAfter=${pidAfter} hostAfter=${Boolean(hostAfter)} statusAfter=${statusAfter} abortCount=${harness.spy.counts.abort}`,
      );

      assert.equal(interrupted.isError, false, 'session_interrupt must not error');
      assert.equal(interrupted.payload?.aborted, true, 'a running resident turn must report aborted: true');
      assert.equal(statusAfter, 'aborted', 'the run registry must record the aborted terminal state');
      assert.ok(hostAfter, 'the resident host must still be present after an interrupt');
      assert.equal(pidAfter, pidBefore, 'the resident host pid must be unchanged');
      assert.equal(harness.spy.counts.abort, 1, 'the control service abort must have been called exactly once');
    },
  );
});

// --------------------------- (e) idle is reported honestly ---------------------------

test('(e) session_interrupt on an idle session reports aborted:false with the no-run message', { concurrency: false }, async () => {
  await withHarness(
    { label: 'idle', mode: 'resident', bindHost: true, runAliveMs: INTERRUPT_ALIVE_MS },
    async (harness) => {
      const sessionId = harness.sessionId;
      const created = await harness.call('session_create', { project: UNIQUE_PROJECT.id, provider: DEBUG_AGENT_PROVIDER_ID });
      assert.equal(created.isError, false, `the idle create must not error (text=${created.text})`);

      const idle = await harness.call('session_interrupt', { session: sessionId });
      say(`(e) idle=${JSON.stringify(idle.payload)} isError=${idle.isError}`);

      assert.equal(idle.isError, false, 'an idle interrupt must not error');
      assert.equal(idle.payload?.aborted, false, 'an idle session must report aborted: false');
      assert.ok(
        String(idle.payload?.message).includes('没有可中止的运行'),
        'the idle reading must literally say there was no run to abort',
      );

      // Positive control: a running resident turn reads aborted: true, so the
      // `false` above is a reading rather than a constant.
      const running = await harness.call('session_create', {
        project: UNIQUE_PROJECT.id,
        message: 'busy turn',
        provider: DEBUG_AGENT_PROVIDER_ID,
        lifecycleMode: 'resident',
      });
      const runId = String(running.payload?.runId);
      const busy = await harness.call('session_interrupt', { session: sessionId });
      say(`(e) busy=${JSON.stringify(busy.payload)} statusAfter=${chatRunRegistry.getRunById(runId)?.status}`);

      assert.equal(busy.payload?.aborted, true, 'the positive control must report aborted: true');
    },
  );
});

// --------------------------- (f) control scope denied + audit ---------------------------

test('(f) a token lacking cloudcli:session:control is denied, audits one denied row, and never aborts', { concurrency: false }, async () => {
  await withHarness(
    { label: 'control-scope', mode: 'resident', bindHost: true, runAliveMs: INTERRUPT_ALIVE_MS },
    async (harness) => {
      const before = mcpAuditLogDb.count();
      const abortBefore = harness.spy.counts.abort;

      const denied = await harness.call('session_interrupt', { session: harness.sessionId }, 'createOnly');
      const newRows = mcpAuditLogDb.allRows().filter((row) => row.id > before);

      say(
        `(f) isError=${denied.isError} text=${JSON.stringify(denied.text)} ` +
          `abortBefore=${abortBefore} abortAfter=${harness.spy.counts.abort}`,
      );
      say(`(f) newAuditRows=${JSON.stringify(newRows)}`);

      assert.equal(denied.isError, true, 'a token lacking cloudcli:session:control must be denied');
      assert.equal(newRows.length, 1, 'exactly one audit row must be written');
      assert.equal(newRows[0].tool, 'session_interrupt', 'the audit row must name session_interrupt');
      assert.equal(newRows[0].outcome, 'denied', 'the audit row must read denied');
      assert.equal(harness.spy.counts.abort, abortBefore, 'abort must NOT be called for a denied call');

      const running = await harness.call('session_create', {
        project: UNIQUE_PROJECT.id,
        message: 'busy turn',
        provider: DEBUG_AGENT_PROVIDER_ID,
        lifecycleMode: 'resident',
      });
      const runId = String(running.payload?.runId);
      const allowed = await harness.call('session_interrupt', { session: harness.sessionId });

      say(`(f) allowed=${JSON.stringify(allowed.payload)} abortCount=${harness.spy.counts.abort} status=${chatRunRegistry.getRunById(runId)?.status}`);
      assert.equal(allowed.isError, false, 'a token carrying cloudcli:session:control must succeed');
      assert.equal(allowed.payload?.aborted, true, 'the allowed interrupt must stop the running turn');
      assert.equal(harness.spy.counts.abort, abortBefore + 1, 'the allowed call must reach the abort seam');
    },
  );
});

// --------------------------- the stage-4 table ---------------------------

test('the stage-4 write table still names the five SPEC tools with their scopes', () => {
  const names = MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name).sort();
  say(`(table) ${JSON.stringify(names)}`);
  assert.deepEqual(names, ['session_close', 'session_create', 'session_interrupt', 'session_send', 'session_start']);
  assert.equal(
    MCP_STAGE4_WRITE_TOOLS.find((tool) => tool.name === 'session_create')?.requiredScope,
    CREATE_SCOPE,
  );
  assert.equal(
    MCP_STAGE4_WRITE_TOOLS.find((tool) => tool.name === 'session_interrupt')?.requiredScope,
    CONTROL_SCOPE,
  );
});

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
