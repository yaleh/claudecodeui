/**
 * Claude session cgroup scoping.
 *
 * A Claude session is not one process: it is the CLI plus its MCP servers (and, when the CLI is
 * launched through an npm shim, a wrapper process on top), which on this host adds up to roughly
 * a gigabyte per idle session. The server used to spawn all of them into its own cgroup, where
 * `memory.max` is `max`, so a single runaway session — or one MCP it launched — was enough for the
 * kernel to reap the whole unit, server included. This module puts every session in its own
 * transient systemd scope with a hard `MemoryMax`, which confines that kill to the session.
 *
 * `systemd-run --user --scope` registers a transient scope and then `exec`s the target command in
 * the same PID, so stdio, PID and exit status are unchanged; `scripts/with-memory-cap.sh` already
 * relies on that property for test scopes.
 *
 * Environments without a usable systemd user manager (macOS, CI containers) must keep today's
 * behaviour byte for byte: {@link createClaudeSessionScopeSpawn} then returns `undefined` and the
 * caller does not install the spawn hook at all.
 *
 * Consumers:
 * - `claude-runtime.provider.js`'s `mapCliOptionsToSDK` installs the SDK `spawnClaudeCodeProcess`
 *   hook returned by {@link createClaudeSessionScopeSpawn}.
 * - `server/index.ts` starts up by sweeping orphaned scopes and shuts down by stopping the scopes
 *   this server owns; both calls arrive through `server/modules/providers/index.ts`.
 * - `server/modules/providers/tests/claude-session-scope.test.ts` drives the generated argv, the
 *   degradation path, the scope lifecycle and the OOM attribution.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import type { SpawnOptions as NodeSpawnOptions } from 'node:child_process';
import crypto from 'node:crypto';

import type { SpawnOptions as SdkSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

/**
 * Prefix of every scope this module creates. It namespaces the unit so stop/sweep can address
 * exactly the sessions a claudecodeui server owns, and so an operator can find them by hand.
 */
const SESSION_SCOPE_PREFIX = 'claudecodeui-session-';

/**
 * Default per-session memory cap. Measured on this host 2026-09-25: an idle session subtree (the
 * `claude` process plus its MCP servers) sits around 0.75-1.1 GB RSS, and a session doing real
 * work — a build, a suite run — goes well past that. 8G leaves an order of magnitude of headroom
 * over idle while still being far below the point where killing the session is preferable to the
 * kernel picking the server.
 */
export const DEFAULT_CLAUDE_SESSION_MEMORY_MAX = '8G';

/** Substring systemd writes into a unit's journal when its cgroup cap reaped a process. */
const OOM_JOURNAL_MARKER = 'OOM killer';

/** How many times, and how far apart, the exit path re-asks the journal for the OOM verdict. */
const OOM_ATTRIBUTION_ATTEMPTS = 5;
const OOM_ATTRIBUTION_RETRY_MS = 200;

/** Bound on how long one `systemctl stop` may block the server's shutdown path. */
const UNIT_STOP_TIMEOUT_MS = 15_000;

/**
 * What the hook returns: the SDK's process contract, plus the optional `stderr` and `signalCode` a
 * Node `ChildProcess` carries. The SDK interface leaves both out, but the debug-forwarding path and
 * the tests' exit accounting need them.
 */
export type SessionScopeProcess = SpawnedProcess & {
  readonly stderr?: NodeJS.ReadableStream | null;
  readonly signalCode?: NodeJS.Signals | null;
};

/**
 * The spawn implementation the hook calls. Node's `child_process.spawn` in production; a recording
 * stub in the tests, which is how the generated argv is pinned without launching a CLI.
 */
export type SessionScopeSpawnImpl = (
  command: string,
  args: readonly string[],
  options: NodeSpawnOptions,
) => SessionScopeProcess;

/** Options of {@link createClaudeSessionScopeSpawn}; every field has a production default. */
export type ClaudeSessionScopeSpawnDeps = {
  /** Cap in systemd size syntax. `undefined` reads `CLAUDE_SESSION_MEMORY_MAX`; `null` disables. */
  memoryMax?: string | null;
  /** Owner encoded in the unit name, i.e. the server whose shutdown stops these scopes. */
  ownerPid?: number;
  /** Availability probe. Defaults to the cached real probe; pass `() => true` to skip it. */
  probe?: (memoryMax: string) => boolean;
  /** Spawn implementation. Defaults to `child_process.spawn`. */
  spawnImpl?: SessionScopeSpawnImpl;
};

/**
 * Resolves the per-session memory cap from `CLAUDE_SESSION_MEMORY_MAX`.
 *
 * Unset or blank means {@link DEFAULT_CLAUDE_SESSION_MEMORY_MAX}; `off` or `0` disables scope
 * wrapping entirely (`null`), which is the same shape as "no systemd user manager" and therefore
 * travels the same degraded path.
 *
 * Consumed by `createClaudeSessionScopeSpawn` and pinned by the session-scope tests, which need
 * the exact same read the runtime makes.
 */
export function resolveClaudeSessionMemoryMax(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = (env.CLAUDE_SESSION_MEMORY_MAX ?? '').trim();
  if (!raw) {
    return DEFAULT_CLAUDE_SESSION_MEMORY_MAX;
  }
  if (raw === 'off' || raw === '0') {
    return null;
  }
  return raw;
}

/**
 * Names one session's scope. The owner PID is encoded so a later process can tell whether the
 * server that created the scope is still alive — that is what makes sweep-after-SIGKILL possible.
 *
 * Paired with {@link parseClaudeSessionScopeOwnerPid}; the session-scope tests build names with
 * this function so the encoded contract has a single definition.
 */
export function buildClaudeSessionScopeUnitName(ownerPid: number, suffix: string): string {
  return `${SESSION_SCOPE_PREFIX}${ownerPid}-${suffix}`;
}

/**
 * Reads the owner PID back out of a scope unit name, or `null` when the name is not one of ours.
 * The inverse of {@link buildClaudeSessionScopeUnitName}; consumed by stop and sweep.
 */
export function parseClaudeSessionScopeOwnerPid(unitName: string): number | null {
  const match = new RegExp(`^${SESSION_SCOPE_PREFIX}(\\d+)-`).exec(unitName);
  if (!match) {
    return null;
  }
  const ownerPid = Number.parseInt(match[1], 10);
  return Number.isFinite(ownerPid) ? ownerPid : null;
}

/**
 * The argv the hook hands to `systemd-run` for one session.
 *
 * `--scope` keeps the target on the same PID (no forking wrapper), `MemorySwapMax=0` stops a
 * capped session from surviving on swap, and `--` ends option parsing so a CLI argument can never
 * be read as a systemd option.
 */
function buildClaudeSessionScopeArgv(params: {
  unitName: string;
  memoryMax: string;
  command: string;
  args: readonly string[];
}): string[] {
  return [
    '--user',
    '--scope',
    '--quiet',
    `--unit=${params.unitName}`,
    '-p', `MemoryMax=${params.memoryMax}`,
    '-p', 'MemorySwapMax=0',
    '--',
    params.command,
    ...params.args,
  ];
}

/**
 * Runs one `true` inside a capped scope and reports whether that worked.
 *
 * The probe has to be a real execution: `systemd-run` failing (no user manager) and the command
 * failing (a cap too small to even fork) are indistinguishable by exit status, so nothing weaker
 * than a real capped run can tell us whether the wrapper is usable. `true` under a cap is the
 * cheapest command that still exercises scope creation, accounting and exec.
 *
 * Consumed by the cached default probe and asserted directly by the session-scope tests, which
 * must red rather than skip when this host cannot scope.
 */
export function probeSystemdUserScope(memoryMax: string): boolean {
  const result = spawnSync('systemd-run', [
    '--user',
    '--scope',
    '--quiet',
    '-p', `MemoryMax=${memoryMax}`,
    '-p', 'MemorySwapMax=0',
    'true',
  ], { stdio: 'ignore' });

  return result.status === 0;
}

/**
 * Cached availability verdict. Probing costs a real process, and the answer cannot change while
 * this server lives, so it is settled once on first use.
 */
let cachedProbeResult: boolean | null = null;

/**
 * Drops the cached probe verdict so the next factory call probes again.
 *
 * Exists for the session-scope tests: the degradation case has to drive the probe with a failing
 * `systemd-run` earlier on `PATH`, and a verdict cached by an earlier case would mask it.
 */
export function resetClaudeSessionScopeProbeCache(): void {
  cachedProbeResult = null;
}

function probeOnce(memoryMax: string): boolean {
  if (cachedProbeResult === null) {
    cachedProbeResult = probeSystemdUserScope(memoryMax);
  }
  return cachedProbeResult;
}

/** Default spawn: Node's own, cast because `ChildProcess.stdin` is `Writable | null` in the typings. */
const defaultScopeSpawn: SessionScopeSpawnImpl = (command, args, options) =>
  nodeSpawn(command, [...args], options) as unknown as SessionScopeProcess;

/** Sleeps between journal retries. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Asks the unit's journal whether a memory-cap kill happened.
 *
 * The exit status alone cannot say: the OOM killer picks a victim inside the scope, so the CLI may
 * exit `1` (its own error path) or `137` (SIGKILL), and a cap too tight for a plain crash looks
 * identical. The journal is the only witness, which is the same conclusion `scripts/test.sh`
 * reached for capped test scopes.
 */
function journalReportsOomKill(unitName: string): boolean {
  const result = spawnSync('journalctl', ['--user', '-u', `${unitName}.scope`, '--no-pager'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.status !== 0 || !result.stdout) {
    return false;
  }
  return result.stdout.includes(OOM_JOURNAL_MARKER);
}

/**
 * Names the cap in one `console.error` line when a session was killed by it.
 *
 * Silent when the journal is unreadable or says nothing about an OOM: that is a known gap, and a
 * guess here would be worse than the silence. Consumed by the spawn hook's exit path.
 */
function logSessionOomKill(unitName: string, memoryMax: string): boolean {
  if (!journalReportsOomKill(unitName)) {
    return false;
  }

  console.error(
    `[claude-session-scope] session killed by the memory cap ${memoryMax} (unit ${unitName}.scope)`,
  );
  return true;
}

/**
 * Retries the attribution briefly, because the journal write trails the scope's exit.
 */
async function attributeSessionScopeOom(unitName: string, memoryMax: string): Promise<void> {
  for (let attempt = 0; attempt < OOM_ATTRIBUTION_ATTEMPTS; attempt += 1) {
    if (logSessionOomKill(unitName, memoryMax)) {
      return;
    }
    await delay(OOM_ATTRIBUTION_RETRY_MS);
  }
}

/**
 * Closes out a session that exited non-zero: blame the cap when the journal says so, then clear
 * the `failed` record systemd leaves on the unit.
 *
 * The second half matters as much as the first: a killed scope is not collected like a finished
 * one, so without it every crashed session would leave a dead unit in `systemctl list-units`
 * forever, and the operator's view of "which sessions exist" would rot. Clearing the record does
 * not touch the journal, so the attribution above still reads the real verdict.
 */
async function finishFailedSessionScope(unitName: string, memoryMax: string): Promise<void> {
  await attributeSessionScopeOom(unitName, memoryMax);
  stopClaudeSessionScopeUnit(unitName);
}

/**
 * Builds the SDK's `spawnClaudeCodeProcess` hook, or `undefined` when sessions must not be scoped.
 *
 * `undefined` is the whole degradation contract: the caller then leaves the option unset and the
 * SDK spawns the CLI exactly as it does today. That happens when the cap is `off`, and when a real
 * capped probe fails — the environment has no usable systemd user manager.
 *
 * The returned hook rewrites the spawn into a transient scope, keeps `cwd`, `env` and the abort
 * `signal` untouched, and reports a cap kill once the session exits non-zero.
 *
 * Consumed by `mapCliOptionsToSDK` and by the session-scope tests.
 */
export function createClaudeSessionScopeSpawn(
  deps: ClaudeSessionScopeSpawnDeps = {},
): ((options: SdkSpawnOptions) => SessionScopeProcess) | undefined {
  const memoryMax = deps.memoryMax === undefined ? resolveClaudeSessionMemoryMax() : deps.memoryMax;
  if (!memoryMax) {
    return undefined;
  }

  const probe = deps.probe ?? probeOnce;
  if (!probe(memoryMax)) {
    // One line, not one per session: the rest of the run keeps today's unscoped behaviour.
    console.log(
      '[claude-session-scope] no usable systemd user manager; Claude sessions run uncapped',
    );
    return undefined;
  }

  const ownerPid = deps.ownerPid ?? process.pid;
  const spawnImpl = deps.spawnImpl ?? defaultScopeSpawn;
  // Mirrors the SDK's own default spawn: the CLI's stderr is dropped unless debugging is on.
  const pipedStderr = Boolean(process.env.DEBUG_CLAUDE_AGENT_SDK);

  return (spawnOptions: SdkSpawnOptions): SessionScopeProcess => {
    const unitName = buildClaudeSessionScopeUnitName(
      ownerPid,
      crypto.randomBytes(4).toString('hex'),
    );

    const child = spawnImpl('systemd-run', buildClaudeSessionScopeArgv({
      unitName,
      memoryMax,
      command: spawnOptions.command,
      args: spawnOptions.args,
    }), {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      signal: spawnOptions.signal,
      stdio: ['pipe', 'pipe', pipedStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
    });

    if (pipedStderr) {
      child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    }

    // A non-zero exit is the only signal Node gives us that something went wrong; whether the cap
    // is what did it can only be answered by the journal, hence the follow-up.
    child.on('exit', (code) => {
      if (code !== 0) {
        void finishFailedSessionScope(unitName, memoryMax);
      }
    });

    return child;
  };
}

/**
 * Every `claudecodeui-session-*` scope systemd still knows about, from the command an operator
 * would run.
 *
 * A cleanly finished scope is collected and drops off this list on its own, but one that was
 * killed — by its cap, by an abort, by a crash — stays listed as `failed` until it is explicitly
 * reset, and nothing about the failure removes it. So stop and sweep have to read the same list
 * the operator does, failed entries included, or a server that loses sessions to its cap would
 * leave a growing pile of dead units behind.
 *
 * Consumed by stop, sweep and the session-scope tests' emptiness assertions.
 */
export function listClaudeSessionScopeUnits(): string[] {
  const result = spawnSync('systemctl', [
    '--user',
    'list-units',
    `${SESSION_SCOPE_PREFIX}*`,
    '--no-legend',
    '--plain',
  ], { encoding: 'utf8' });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => unit.startsWith(SESSION_SCOPE_PREFIX) && unit.endsWith('.scope'));
}

/** True when a PID exists, including one this process may not signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

/**
 * Makes one scope disappear from `systemctl list-units`.
 *
 * Two steps, because neither alone is enough: `stop` is a SIGTERM plus a wait (and the wait is
 * what could hang a shutdown path, so it is bounded), while a unit that died on its own stays
 * behind as `failed` and only `reset-failed` clears that record. A scope still standing after both
 * is force-killed — the point of stopping these is that nothing of this server's outlives it.
 */
function stopClaudeSessionScopeUnit(unitName: string): void {
  // The two callers name the unit differently — `systemd-run --unit=` takes it bare while the
  // listing returns it suffixed — and `systemctl` defaults a bare name to `.service`, so an
  // unnormalized bare name silently addresses a unit that does not exist.
  const unit = unitName.endsWith('.scope') ? unitName : `${unitName}.scope`;

  spawnSync('systemctl', ['--user', 'stop', unit], {
    stdio: 'ignore',
    timeout: UNIT_STOP_TIMEOUT_MS,
  });
  spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' });

  if (!listClaudeSessionScopeUnits().includes(unit)) {
    return;
  }

  spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit], { stdio: 'ignore' });
  spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' });
  spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' });
}

/**
 * Stops every scope owned by `ownerPid`, and returns the units it stopped.
 *
 * Called from the server's shutdown path with the server's own PID. Scopes live outside the
 * server's cgroup, so nothing else would collect them: without this, `serve-scoped.sh stop` leaves
 * every session of that server running.
 *
 * Consumed by `server/index.ts` (through the providers barrel) and by the session-scope tests.
 */
export function stopClaudeSessionScopes(ownerPid: number = process.pid): string[] {
  const stopped: string[] = [];

  for (const unitName of listClaudeSessionScopeUnits()) {
    if (parseClaudeSessionScopeOwnerPid(unitName) !== ownerPid) {
      continue;
    }
    stopClaudeSessionScopeUnit(unitName);
    stopped.push(unitName);
  }

  return stopped;
}

/**
 * Stops the scopes whose owning server no longer exists, and returns the units it stopped.
 *
 * The shutdown path cannot run when the server is SIGKILLed, so its sessions survive as orphans
 * that nothing would ever reap. This runs at start-up instead, and touches only scopes whose
 * encoded owner PID is gone — a live server's sessions are left alone.
 *
 * Consumed by `server/index.ts` (through the providers barrel) and by the session-scope tests.
 */
export function sweepOrphanClaudeSessionScopes(): string[] {
  const swept: string[] = [];

  for (const unitName of listClaudeSessionScopeUnits()) {
    const ownerPid = parseClaudeSessionScopeOwnerPid(unitName);
    if (ownerPid === null || isProcessAlive(ownerPid)) {
      continue;
    }
    stopClaudeSessionScopeUnit(unitName);
    swept.push(unitName);
  }

  return swept;
}
