/**
 * AC-278 criterion — the production assembly hands the gateway the three
 * optional session-write deps, so the four session write tools no longer answer
 * the AC-249 placeholder in production.
 *
 * The claim has three readings, and the one that matters is (b): AC-250 and
 * AC-251 both proved their handlers through criteria that assemble their OWN
 * deps bag, so neither ever read whether the composition root actually supplies
 * those deps. This file closes that hole by driving the SAME exported builders
 * `server/index.ts` uses (`buildSessionCreateDeps` / `buildSessionInterruptDeps`
 * / `createSessionHostControl`) rather than a second, test-only bag.
 *
 *   (a) a pure TypeScript syntax-tree scan of `server/index.ts` finds the
 *       `createMcpGatewayModule(` argument, its `writeTools` object, and the
 *       three members `sessionCreate` / `sessionInterrupt` / `sessionHostControl`
 *       — each bound to the process singletons the WebSocket and scheduled
 *       paths already share (`chatControl`, `sessionsService`,
 *       `sessionHostManager`). A positive control removes `sessionInterrupt`
 *       from the real source and the SAME scanner reports it missing.
 *
 *   (b) a real express 4 app + real better-sqlite3 temp DB + MCP SDK `Client`
 *       over `StreamableHTTPClientTransport` (with a `node:http`-based fetch, to
 *       avoid the `listen(0)` undici bad-port lottery) mounts the production
 *       assembly path and calls the four tools against a target that names
 *       nothing: every returned `code` is the real handler's refusal
 *       (`PROJECT_NOT_FOUND` / `SESSION_NOT_FOUND`), NEVER
 *       `MCP_TOOL_NOT_IMPLEMENTED`. The single control spy proves the gateway
 *       used the SUPPLIED instance (its `abort` counter moved).
 *
 *   (c) the anti-false-green negative control: the SAME probe over a mount that
 *       omits the three deps gets `MCP_TOOL_NOT_IMPLEMENTED` with the owner
 *       `AC-250` / `AC-251` — proving the probe separates "wired" from "not
 *       wired" rather than reading true whatever the assembly does.
 *
 * Face (b) is NOT a test-only deps bag: the project repository, `sessionsService`
 * and `sessionHostManager` are the real process singletons, reached through the
 * two exported deps builders and AC-251's `createSessionHostControl` — the exact
 * construction `server/index.ts` performs.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import type { RequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import ts from 'typescript';

import type {
  McpControlAbortResult,
  McpControlAbortSeam,
  McpControlSeam,
  McpControlSendResult,
  McpGatewayModuleDeps,
} from '../index.js';

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-production-session-wiring-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
process.env.HOME = SCRATCH_HOME;
process.env.JWT_SECRET = 'mcp-production-session-wiring-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });

const { closeConnection, initializeDatabase, projectsDb } = await import('@/modules/database/index.js');
const { sessionsService } = await import('@/modules/providers/index.js');
const { sessionHostManager } = await import('@/modules/session-hosts/index.js');
const { ACCESS_TOKEN_SCOPES } = await import('@/modules/oauth/index.js');
const {
  buildRunGet,
  buildSessionCreateDeps,
  buildSessionInterruptDeps,
  createMcpGatewayModule,
  createSessionHostControl,
  MCP_GATEWAY_PATH,
  MCP_STAGE4_WRITE_TOOLS,
  MCP_TOOL_NOT_IMPLEMENTED_CODE,
  mountMcpGateway,
} = await import('../index.js');

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`production-session-wiring ${line}`);
}

// =====================================================================
// (a) the writeTools wiring scanner over server/index.ts
// =====================================================================

const MODULE_FN = 'createMcpGatewayModule';
const WRITE_TOOLS_MEMBER = 'writeTools';
const REQUIRED_MEMBERS = ['sessionCreate', 'sessionInterrupt', 'sessionHostControl'] as const;
/** The singletons the WebSocket / scheduled paths already share, per AC-253. */
const SHARED_SINGLETONS = ['chatControl', 'sessionsService', 'sessionHostManager'] as const;
const SHARED_CONSUMERS = ['createWebSocketServer', 'initializeScheduledMessageDispatcher'] as const;

/** One `writeTools` member: its name and every identifier its value subtree mentions. */
export type MemberReading = { name: string; identifiers: string[] };

export type WriteToolsReading = {
  moduleCallFound: boolean;
  writeToolsFound: boolean;
  /** The member names present, with the identifiers each value binds to. */
  members: MemberReading[];
  /** Whether `chatControl` appears among the arguments of each shared consumer. */
  consumers: { websocket: boolean; scheduled: boolean };
};

function collectIdentifiers(node: ts.Node): string[] {
  const out = new Set<string>();
  const walk = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) {
      out.add(current.text);
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return [...out];
}

function subtreeHasIdentifier(node: ts.Node, wanted: string): boolean {
  if (ts.isIdentifier(node) && node.text === wanted) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && subtreeHasIdentifier(child, wanted)) {
      found = true;
    }
  });
  return found;
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** The object literal passed as the first argument of `createMcpGatewayModule(`. */
function findModuleArgument(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      found === undefined &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === MODULE_FN
    ) {
      const first = node.arguments[0];
      if (first !== undefined && ts.isObjectLiteralExpression(first)) {
        found = first;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The `writeTools` object inside a `createMcpGatewayModule(` argument. */
function findWriteToolsObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  const moduleArgument = findModuleArgument(sourceFile);
  if (moduleArgument === undefined) {
    return undefined;
  }
  for (const property of moduleArgument.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === WRITE_TOOLS_MEMBER &&
      ts.isObjectLiteralExpression(property.initializer)
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

/**
 * A PURE syntax-tree read: it never imports `server/index.ts` (importing the
 * entrypoint would run the whole process). The same function grades the real
 * source and the positive-control variant, so a green reading is discriminating
 * power rather than a scanner that always answers clean.
 */
export function scanWriteToolsWiring(source: string): WriteToolsReading {
  const sourceFile = parse(source);
  const writeTools = findWriteToolsObject(sourceFile);

  const members: MemberReading[] = [];
  if (writeTools !== undefined) {
    for (const property of writeTools.properties) {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
        members.push({ name: property.name.text, identifiers: collectIdentifiers(property.initializer) });
      }
    }
  }

  const sharedConsumerHit = (name: string): boolean => {
    let hit = false;
    const visit = (node: ts.Node): void => {
      if (
        !hit &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === name &&
        node.arguments.some((argument) => subtreeHasIdentifier(argument, 'chatControl'))
      ) {
        hit = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (hit) {
      return true;
    }
    return false;
  };

  return {
    moduleCallFound: findModuleArgument(sourceFile) !== undefined,
    writeToolsFound: writeTools !== undefined,
    members,
    consumers: {
      websocket: sharedConsumerHit(SHARED_CONSUMERS[0]),
      scheduled: sharedConsumerHit(SHARED_CONSUMERS[1]),
    },
  };
}

/**
 * The real source with one `writeTools` member's property assignment deleted —
 * the positive control that proves the scanner reports a MISSING member rather
 * than answering "all present" unconditionally.
 */
export function withoutWriteToolsMember(source: string, memberName: string): string {
  const sourceFile = parse(source);
  const writeTools = findWriteToolsObject(sourceFile);
  if (writeTools === undefined) {
    return source;
  }
  for (const property of writeTools.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === memberName) {
      return source.replace(`${property.getText(sourceFile)},`, '');
    }
  }
  return source;
}

/** The identifiers of one member, or `[]` when the member is absent. */
function memberIdentifiers(reading: WriteToolsReading, name: string): string[] {
  return reading.members.find((member) => member.name === name)?.identifiers ?? [];
}

test('(a) server/index.ts hands sessionCreate / sessionInterrupt / sessionHostControl to createMcpGatewayModule', () => {
  const indexSource = readFileSync(fileURLToPath(new URL('../../../index.ts', import.meta.url)), 'utf8');
  const real = scanWriteToolsWiring(indexSource);

  const removedSource = withoutWriteToolsMember(indexSource, 'sessionInterrupt');
  const removed = scanWriteToolsWiring(removedSource);

  say(`(a) real.moduleCallFound=${real.moduleCallFound} writeToolsFound=${real.writeToolsFound}`);
  say(`(a) real.members=${JSON.stringify(real.members.map((member) => ({ name: member.name, identifiers: member.identifiers })))}`);
  say(`(a) real.consumers=${JSON.stringify(real.consumers)}`);
  say(`(a) removed.members=${JSON.stringify(removed.members.map((member) => member.name))}`);

  assert.equal(real.moduleCallFound, true, 'server/index.ts must call createMcpGatewayModule with an object argument');
  assert.equal(real.writeToolsFound, true, 'that argument must carry a writeTools object');

  const names = real.members.map((member) => member.name);
  for (const required of REQUIRED_MEMBERS) {
    assert.ok(names.includes(required), `writeTools must declare \`${required}\` (saw ${JSON.stringify(names)})`);
  }

  // Each member is bound to the process singletons: the SCAN reads the
  // identifiers in the member's value subtree, so `session_create` reaching
  // `sessionsService` + `chatControl`, `session_interrupt` reaching the one
  // `chatControl`, and `sessionHostControl` reaching `sessionHostManager` are
  // properties of the assembly, not of a comment.
  const sessionCreate = memberIdentifiers(real, 'sessionCreate');
  const sessionInterrupt = memberIdentifiers(real, 'sessionInterrupt');
  const sessionHostControl = memberIdentifiers(real, 'sessionHostControl');
  say(`(a) sessionCreate identifiers include chatControl=${sessionCreate.includes('chatControl')} sessionsService=${sessionCreate.includes('sessionsService')}`);
  say(`(a) sessionInterrupt identifiers include chatControl=${sessionInterrupt.includes('chatControl')}`);
  say(`(a) sessionHostControl identifiers include sessionHostManager=${sessionHostControl.includes('sessionHostManager')}`);

  assert.ok(sessionCreate.includes('sessionsService'), 'sessionCreate must bind the process sessionsService');
  assert.ok(sessionCreate.includes('chatControl'), 'sessionCreate must bind the one shared chatControl');
  assert.ok(sessionInterrupt.includes('chatControl'), 'sessionInterrupt must bind the one shared chatControl');
  assert.ok(sessionHostControl.includes('sessionHostManager'), 'sessionHostControl must bind the process sessionHostManager');

  assert.equal(real.consumers.websocket, true, 'chatControl must also reach createWebSocketServer');
  assert.equal(real.consumers.scheduled, true, 'chatControl must also reach initializeScheduledMessageDispatcher');

  // Positive control: deleting one member from the REAL source is reported.
  assert.ok(!removed.members.some((member) => member.name === 'sessionInterrupt'), 'the deleted member must be reported missing');
  assert.ok(
    removed.members.some((member) => member.name === 'sessionCreate') &&
      removed.members.some((member) => member.name === 'sessionHostControl'),
    'the other two members must survive the deletion (the scanner discriminates one member, not the whole object)',
  );
});

// =====================================================================
// the shared runtime harness
// =====================================================================

const USER_ONE = 1;
const ALL_SCOPES = [...ACCESS_TOKEN_SCOPES];

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

type SpyControl = {
  calls: { send: number; abort: number };
  seam: McpControlSeam & McpControlAbortSeam;
};

/** A control seam whose `abort` records its calls, so "the supplied instance was used" is countable. */
function makeControl(): SpyControl {
  const calls = { send: 0, abort: 0 };
  const seam = {
    async send(): Promise<McpControlSendResult> {
      calls.send += 1;
      return { ok: true, runId: 'run-unused', queued: false, queuedMessageUuid: null };
    },
    async abort(): Promise<McpControlAbortResult> {
      calls.abort += 1;
      return { ok: false, aborted: false, code: 'SESSION_NOT_FOUND', message: 'no such session' };
    },
  };
  return { calls, seam };
}

/** AC-248's `run_get` deps, minimal but real-shaped so registration typechecks. */
function runGetSeam() {
  return {
    deps: {
      activity: { snapshot: () => null },
      sessions: { fetchHistory: async () => ({ messages: [] }) },
      now: () => Date.now(),
      sleep: async () => undefined,
      bootId: () => 'ac278-boot',
    },
    build: buildRunGet,
  };
}

async function startGateway(
  writeTools: McpGatewayModuleDeps['writeTools'],
  control: McpControlSeam,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const authorize: RequestHandler = (_req, res, next) => {
    res.locals.mcpPrincipal = { userId: USER_ONE, tokenId: 1, clientId: null, scopes: ALL_SCOPES };
    next();
  };
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(
    app,
    createMcpGatewayModule({ env: { MCP_ENABLED: 'true' }, authorize, control, writeTools }),
  );

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: nodeFetch });
  const client = new Client({ name: 'ac278-criterion', version: '0.0.0' });
  await client.connect(transport);

  return {
    client,
    close: async () => {
      await transport.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type ToolReading = { code: string | null; owner: string | null; isError: boolean; raw: string };

/** Calls one tool and reads the structured `code` / `owner` out of its error body. */
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolReading> {
  const result = (await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0])) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
    structuredContent?: unknown;
  };
  const raw = result.content?.[0]?.text ?? '';
  let code: string | null = null;
  let owner: string | null = null;
  // AC-284: every failure now carries `{ code, message, retryable, details? }`
  // in `structuredContent`, not as a JSON string in the text. The placeholder's
  // `owner` rides along in `details`, so it is read from there rather than from
  // the sentence. A body with no envelope still falls back to the text, so this
  // reader would notice if the wire regressed to a text-only refusal.
  const envelope =
    typeof result.structuredContent === 'object' && result.structuredContent !== null
      ? (result.structuredContent as { code?: unknown; details?: { owner?: unknown } })
      : null;
  if (typeof envelope?.code === 'string') {
    code = envelope.code;
    owner = typeof envelope.details?.owner === 'string' ? envelope.details.owner : null;
  } else {
    try {
      const parsed = JSON.parse(raw) as { code?: string; owner?: string };
      code = parsed.code ?? null;
      owner = parsed.owner ?? null;
    } catch {
      // A non-JSON body is a reading in itself (raw is printed below).
    }
  }
  return { code, owner, isError: result.isError === true, raw };
}

/** The four session write tools and an argument naming a target that exists nowhere. */
const PROBES: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'session_create', args: { project: 'no-such-project-ac278' } },
  { name: 'session_interrupt', args: { session: 'no-such-session-ac278' } },
  { name: 'session_start', args: { session: 'no-such-session-ac278' } },
  { name: 'session_close', args: { session: 'no-such-session-ac278' } },
];

async function setupDatabase(): Promise<string> {
  closeConnection();
  const directory = await mkdtemp(path.join(SCRATCH, 'db-'));
  process.env.DATABASE_PATH = path.join(directory, 'ac278.db');
  await initializeDatabase();
  return directory;
}

// =====================================================================
// (b) the production assembly reaches the real handlers
// =====================================================================

test('(b) the production deps construction path gives the four session write tools real handlers', { concurrency: false }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await setupDatabase();
  const control = makeControl();
  const gateway = await startGateway(
    {
      runGet: runGetSeam(),
      // The SAME exported builders `server/index.ts` calls: the real project
      // repository, the real `sessionsService`, and the one control seam.
      sessionCreate: buildSessionCreateDeps({ projects: projectsDb, sessions: sessionsService, control: control.seam }),
      sessionInterrupt: buildSessionInterruptDeps({ control: control.seam }),
      // AC-251's production constructor, handed the real process manager and the
      // same session-row reader the HTTP route injects.
      sessionHostControl: createSessionHostControl({
        sessionHostManager,
        readSession: (sessionId) => sessionsService.readSessionLifecycle(sessionId),
        resolveHostDriver: () => null,
        startResidentSession: async () => {
          throw new Error('the criterion never reaches the launch seam');
        },
      }),
    },
    control.seam,
  );

  try {
    const readings: Record<string, ToolReading> = {};
    for (const probe of PROBES) {
      readings[probe.name] = await callTool(gateway.client, probe.name, probe.args);
    }
    say(`(b) readings=${JSON.stringify(readings)}`);
    say(`(b) controlCalls=${JSON.stringify(control.calls)}`);

    for (const probe of PROBES) {
      const reading = readings[probe.name];
      assert.notEqual(
        reading.code,
        MCP_TOOL_NOT_IMPLEMENTED_CODE,
        `${probe.name} must reach its real handler, not the AC-249 placeholder (got ${reading.raw})`,
      );
      assert.equal(reading.isError, true, `${probe.name} must refuse a target that names nothing`);
    }

    assert.equal(readings.session_create.code, 'PROJECT_NOT_FOUND', 'session_create must refuse an unknown project');
    assert.equal(readings.session_interrupt.code, 'SESSION_NOT_FOUND', 'session_interrupt must forward the control refusal');
    assert.equal(readings.session_start.code, 'SESSION_NOT_FOUND', 'session_start must refuse an unknown session');
    assert.equal(readings.session_close.code, 'SESSION_NOT_FOUND', 'session_close must refuse an unknown session');

    // The SAME instance: the supplied control seam's abort ran exactly once. A
    // gateway that fabricated its own control plane would leave this at zero.
    assert.equal(control.calls.abort, 1, 'session_interrupt must use the SUPPLIED control instance');
    assert.equal(control.calls.send, 0, 'no probe supplies a message, so the control send must not run');
  } finally {
    await gateway.close();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

// =====================================================================
// (c) the negative control: no deps, the placeholder answers
// =====================================================================

test('(c) a mount without the three deps gets MCP_TOOL_NOT_IMPLEMENTED with the AC-250 / AC-251 owner', { concurrency: false }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await setupDatabase();
  const control = makeControl();
  const gateway = await startGateway({ runGet: runGetSeam() }, control.seam);

  try {
    const readings: Record<string, ToolReading> = {};
    for (const probe of PROBES) {
      readings[probe.name] = await callTool(gateway.client, probe.name, probe.args);
    }
    say(`(c) readings=${JSON.stringify(readings)}`);

    const expectedOwner: Record<string, string> = {
      session_create: 'AC-250',
      session_interrupt: 'AC-250',
      session_start: 'AC-251',
      session_close: 'AC-251',
    };
    for (const probe of PROBES) {
      const reading = readings[probe.name];
      assert.equal(
        reading.code,
        MCP_TOOL_NOT_IMPLEMENTED_CODE,
        `${probe.name} must answer the placeholder without its deps (got ${reading.raw})`,
      );
      assert.equal(
        reading.owner,
        expectedOwner[probe.name],
        `${probe.name}'s placeholder must name ${expectedOwner[probe.name]}`,
      );
    }
    assert.equal(control.calls.abort, 0, 'the placeholder must never reach the control service');
  } finally {
    await gateway.close();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

// The tables the runtime face reads are named here so a drift in the stage-4
// name set is a compile-time reading, not a silent skip.
const expectedWriteToolNames = MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name).filter((name) =>
  ['session_create', 'session_interrupt', 'session_start', 'session_close'].includes(name),
);
assert.equal(expectedWriteToolNames.length, 4, 'the four probed tools must still be in the stage-4 write table');

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});
