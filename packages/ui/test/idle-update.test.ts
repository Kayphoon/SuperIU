/**
 * Regression tests for the idle self-update loop in `@agent/ui/daemon`.
 *
 * Four defects are pinned here, all of them observable from the seams alone
 * (no network, no real GitHub release):
 *
 *  1. systemd self-deadlock — the in-process path must never block on
 *     `systemctl --user restart` (asserted structurally, by reading the source).
 *  2. the draining window — draining may only cover the swap, never the
 *     download, so `/api/chat` keeps serving during a slow transfer.
 *  3. the wedge — a failed `writeUpdateState` must not abort the tick nor leave
 *     the daemon draining forever.
 *  4. the lost flag — the respawn replays the auto-update settings.
 *  5. the wrong channel — the tick resolves the release base from the persisted
 *     state first, so a private mirror is never silently replaced by the default
 *     GitHub base.
 *  6. the one-shot flag — `commandStart` must treat the persisted settings as the
 *     default, so a restart without the flag keeps auto-update on.
 *
 * `startServer` is exercised for real in the last suite: the 503 gate is the
 * user-visible half of defect 2, and only the real HTTP server can prove it.
 * Defect 6 is likewise proven end-to-end: its suite boots the real daemon in a
 * child process rather than stubbing the seams it is about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodeModule from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isBackoffBlocked,
  main,
  readUpdateState,
  resolveAutoUpdateSettings,
  restartDaemonDetached,
  runUpdateTick,
  writeUpdateState,
  type UpdateTickSeams
} from '../src/daemon.js';
import { startServer, type ServerHandle } from '../src/server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A version no build under test will ever report, so it is always "newer". */
const NEWER = '9.9.9';

/** A version below `@agent/ui`'s package version, so it is never newer. */
const OLDER = '0.0.1';

/** Records the drain state so a wedged `true` can never hide behind a mock. */
interface FakeHandle extends Pick<ServerHandle, 'isIdle' | 'setDraining' | 'close'> {
  isDraining(): boolean;
  drainCalls: boolean[];
  closeCalls: number;
  /** Flip to make the NEXT `isIdle()` report busy. */
  setBusy(busy: boolean): void;
}

function fakeHandle(options: { busy?: boolean } = {}): FakeHandle {
  let busy = options.busy ?? false;
  let draining = false;
  const handle: FakeHandle = {
    isIdle: () => !busy,
    setDraining: (value: boolean) => {
      draining = value;
      handle.drainCalls.push(value);
    },
    close: async () => {
      handle.closeCalls += 1;
    },
    isDraining: () => draining,
    drainCalls: [],
    closeCalls: 0,
    setBusy: (value: boolean) => {
      busy = value;
    }
  };
  return handle;
}

/**
 * A tick state for a daemon whose auto-update settings are on, so the respawn
 * assertions have something to replay.
 */
function daemonState(workspace: string, overrides: Record<string, unknown> = {}) {
  return {
    pid: process.pid,
    port: 4321,
    host: '127.0.0.1',
    url: 'http://127.0.0.1:4321',
    workspace,
    token: 'token',
    version: '0.1.0',
    startedAt: new Date().toISOString(),
    autoUpdateIdle: true,
    autoUpdateIntervalHours: 3,
    ...overrides
  };
}

/** Spawn double: never touches the process table, records the invocation. */
function spawnSpy() {
  return vi.fn(() => ({ unref: vi.fn() }));
}

let workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-idle-update-'));
  workspaces.push(dir);
  return dir;
}

beforeEach(() => {
  workspaces = [];
});

afterEach(() => {
  for (const dir of workspaces) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A workspace that refuses removal must not fail the suite.
    }
  }
  workspaces = [];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Defect 7 — the one-way switch: an explicit OFF must exist
// ---------------------------------------------------------------------------
//
// `commandStart` used to resolve `enabled` as `flag || persisted`, so a
// desktop/wizard toggle OFF only omitted the flag: the daemon re-enabled from
// the persisted `true` and the switch silently reverted. The resolution is now
// a pure function with the precedence CLI > env > persisted, asserted here for
// every combination — no daemon boot needed.

interface ResolverRow {
  name: string;
  parsed: {
    autoUpdateIdle: boolean;
    noAutoUpdateIdle?: boolean;
    autoUpdateIntervalHours?: number;
    releaseBase?: string;
  };
  state: { autoUpdateIdle?: boolean; autoUpdateIntervalHours?: number; releaseBase?: string } | null;
  env: string | undefined;
  expected: { enabled: boolean; intervalHours: number; releaseBase: string | undefined; clearPersisted: boolean };
}

const RESOLVER_ROWS: ResolverRow[] = [
  {
    name: 'no flags + no state + no env -> off, defaults, nothing cleared',
    parsed: { autoUpdateIdle: false },
    state: null,
    env: undefined,
    expected: { enabled: false, intervalHours: 6, releaseBase: undefined, clearPersisted: false }
  },
  {
    name: '--auto-update-idle -> on, flag interval wins',
    parsed: { autoUpdateIdle: true, autoUpdateIntervalHours: 9 },
    state: null,
    env: undefined,
    expected: { enabled: true, intervalHours: 9, releaseBase: undefined, clearPersisted: false }
  },
  {
    name: '--no-auto-update-idle -> off, nothing persisted, nothing to clear',
    parsed: { autoUpdateIdle: false, noAutoUpdateIdle: true },
    state: null,
    env: undefined,
    expected: { enabled: false, intervalHours: 6, releaseBase: undefined, clearPersisted: true }
  },
  {
    name: 'SUPERIU_AUTO_UPDATE_IDLE=1 -> on',
    parsed: { autoUpdateIdle: false },
    state: null,
    env: '1',
    expected: { enabled: true, intervalHours: 6, releaseBase: undefined, clearPersisted: false }
  },
  {
    name: 'SUPERIU_AUTO_UPDATE_IDLE=0 -> off AND clears the persisted keys',
    parsed: { autoUpdateIdle: false },
    state: { autoUpdateIdle: true, autoUpdateIntervalHours: 3 },
    env: '0',
    expected: { enabled: false, intervalHours: 3, releaseBase: undefined, clearPersisted: true }
  },
  {
    name: 'persisted true + no flags -> inherits on, interval and base',
    parsed: { autoUpdateIdle: false },
    state: { autoUpdateIdle: true, autoUpdateIntervalHours: 12, releaseBase: 'http://mirror.invalid/v0' },
    env: undefined,
    expected: { enabled: true, intervalHours: 12, releaseBase: 'http://mirror.invalid/v0', clearPersisted: false }
  },
  {
    name: 'persisted true + --no-auto-update-idle -> off AND clears (no resurrection)',
    parsed: { autoUpdateIdle: false, noAutoUpdateIdle: true },
    state: { autoUpdateIdle: true, autoUpdateIntervalHours: 3 },
    env: undefined,
    expected: { enabled: false, intervalHours: 3, releaseBase: undefined, clearPersisted: true }
  },
  {
    name: '--auto-update-idle + persisted true -> on, flag interval wins, base inherited',
    parsed: { autoUpdateIdle: true, autoUpdateIntervalHours: 9 },
    state: { autoUpdateIdle: true, autoUpdateIntervalHours: 3, releaseBase: 'http://mirror.invalid/v0' },
    env: undefined,
    expected: { enabled: true, intervalHours: 9, releaseBase: 'http://mirror.invalid/v0', clearPersisted: false }
  },
  {
    name: 'flag ON beats a falsy env (CLI > env): still on, nothing cleared',
    parsed: { autoUpdateIdle: true, autoUpdateIntervalHours: 9 },
    state: null,
    env: '0',
    expected: { enabled: true, intervalHours: 9, releaseBase: undefined, clearPersisted: false }
  }
];

describe('resolveAutoUpdateSettings: CLI > env > persisted', () => {
  it.each(RESOLVER_ROWS)('$name', ({ parsed, state, env, expected }) => {
    expect(resolveAutoUpdateSettings(parsed, state, env)).toEqual(expected);
  });

  it('rejects contradicting flags as a usage error before resolution', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await main(['start', '--auto-update-idle', '--no-auto-update-idle']);
      expect(process.exitCode).toBe(2);
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(
        '--auto-update-idle and --no-auto-update-idle are mutually exclusive'
      );
    } finally {
      process.exitCode = previousExitCode;
      stderr.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — the process keeps serving during the download
// ---------------------------------------------------------------------------

describe('runUpdateTick: draining covers only the swap', () => {
  it('does nothing while the daemon is busy', async () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const handle = fakeHandle({ busy: true });
    const download = vi.fn(async () => undefined);
    const fetchLatest = vi.fn(async () => NEWER);

    await runUpdateTick(handle, daemonState(workspace), workspace, target, { fetchLatest, download });

    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
    expect(handle.drainCalls).toEqual([]);
    expect(handle.isDraining()).toBe(false);
  });

  it('does not download when the candidate is not newer', async () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const handle = fakeHandle();
    const download = vi.fn(async () => undefined);

    await runUpdateTick(handle, daemonState(workspace), workspace, target, {
      fetchLatest: async () => OLDER,
      download
    });

    expect(download).not.toHaveBeenCalled();
    expect(handle.drainCalls).toEqual([]);
    // The bookkeeping write still lands, so the next tick knows when it ran.
    expect(readUpdateState(workspace).lastCheckAt).toBeTypeOf('string');
  });

  it('starts draining only AFTER the download and probe, and swaps once', async () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const handle = fakeHandle();
    const order: string[] = [];
    const drainingDuringDownload: boolean[] = [];

    const download = vi.fn(async (_url: string, destination: string) => {
      order.push('download');
      // The whole point of the reorder: the ~80MB transfer must not 503 chat.
      drainingDuringDownload.push(handle.isDraining());
      fs.writeFileSync(destination, 'new-binary');
    });
    const probeVersion = vi.fn(() => {
      order.push('probe');
      drainingDuringDownload.push(handle.isDraining());
      return NEWER;
    });
    const originalSetDraining = handle.setDraining;
    handle.setDraining = (value: boolean) => {
      order.push(`draining:${value}`);
      originalSetDraining(value);
    };
    const restart = vi.fn();
    const exit = vi.fn();

    await runUpdateTick(handle, daemonState(workspace), workspace, target, {
      fetchLatest: async () => NEWER,
      download,
      probeVersion,
      restart,
      exit
    });

    expect(download).toHaveBeenCalledTimes(1);
    // The regression: draining used to be set before the 500ms sleep + download.
    expect(order).toEqual(['download', 'probe', 'draining:true']);
    expect(drainingDuringDownload).toEqual([false, false]);
    expect(handle.drainCalls).toEqual([true]);
    // The rename really happened: the target holds what the download wrote and
    // the temporary file is gone.
    expect(fs.readFileSync(target, 'utf-8')).toBe('new-binary');
    expect(fs.existsSync(path.join(workspace, `.superiu-server.update.${process.pid}`))).toBe(false);
    expect(handle.closeCalls).toBe(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart.mock.calls[0]?.[0]).toBe(target);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('un-drains and cleans up when the daemon became busy during the download', async () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const handle = fakeHandle();
    const download = vi.fn(async (_url: string, destination: string) => {
      fs.writeFileSync(destination, 'new-binary');
      // A turn started while the binary was downloading: the swap must wait.
      handle.setBusy(true);
    });
    const restart = vi.fn();
    const exit = vi.fn();

    await runUpdateTick(handle, daemonState(workspace), workspace, target, {
      fetchLatest: async () => NEWER,
      download,
      probeVersion: () => NEWER,
      restart,
      exit
    });

    // Draining was set for the swap, then released by the `finally` — the
    // unusable window is bounded, it is never left set.
    expect(handle.drainCalls).toEqual([true, false]);
    expect(handle.isDraining()).toBe(false);
    expect(fs.existsSync(path.join(workspace, `.superiu-server.update.${process.pid}`))).toBe(false);
    // Nothing was swapped, nothing was closed, nothing was restarted.
    expect(fs.existsSync(target)).toBe(false);
    expect(handle.closeCalls).toBe(0);
    expect(restart).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Defect 3 — a failing state write must never wedge the daemon
// ---------------------------------------------------------------------------
describe('runUpdateTick: update-state persistence is never fatal', () => {
  it('survives a writeUpdateState that throws on the invalid-binary path', async () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const handle = fakeHandle();
    const download = vi.fn(async (_url: string, destination: string) => {
      fs.writeFileSync(destination, 'stale-binary');
    });

    await expect(
      runUpdateTick(handle, daemonState(workspace), workspace, target, {
        fetchLatest: async () => NEWER,
        download,
        // The probed version is NOT newer: the tick takes the backoff branch,
        // which is exactly where the old code un-drained after the write.
        probeVersion: () => OLDER,
        writeState: () => {
          throw new Error('ENOSPC: no space left on device');
        }
      })
    ).resolves.toBeUndefined();

    // The wedge regression: draining must never be left set by a failed write.
    expect(handle.isDraining()).toBe(false);
    expect(handle.drainCalls).not.toContain(true);
  });

  it('records the backoff for a binary that is not newer, and un-drains', async () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const handle = fakeHandle();
    const download = vi.fn(async (_url: string, destination: string) => {
      fs.writeFileSync(destination, 'stale-binary');
    });

    await runUpdateTick(handle, daemonState(workspace), workspace, target, {
      fetchLatest: async () => NEWER,
      download,
      probeVersion: () => OLDER
    });

    const state = readUpdateState(workspace);
    expect(state.lastFailedVersion).toBe(NEWER);
    expect(state.lastFailedAt).toBeTypeOf('string');
    expect(isBackoffBlocked(state, NEWER)).toBe(true);
    expect(handle.isDraining()).toBe(false);
    // The unusable tmp file is gone, so the next tick can download cleanly.
    expect(fs.existsSync(path.join(workspace, `.superiu-server.update.${process.pid}`))).toBe(false);
  });

  it('does not abort the tick when the real writer fails', async () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const handle = fakeHandle();
    // A regular file where the state directory belongs: `mkdirSync` raises
    // ENOTDIR for real, so the tick runs against the genuine writer rather than
    // a mock — the failure mode defect 3 describes.
    fs.writeFileSync(path.join(workspace, '.superiu'), 'not a directory');

    await expect(
      runUpdateTick(handle, daemonState(workspace), workspace, target, {
        fetchLatest: async () => OLDER,
        download: vi.fn(async () => undefined)
      })
    ).resolves.toBeUndefined();

    expect(handle.isDraining()).toBe(false);
    expect(handle.drainCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe('runUpdateTick: 24h backoff for a failed version', () => {
  it('skips the download for the same version inside the window', async () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const handle = fakeHandle();
    const download = vi.fn(async () => undefined);
    writeUpdateState(workspace, { lastFailedVersion: NEWER, lastFailedAt: new Date().toISOString() });

    await runUpdateTick(handle, daemonState(workspace), workspace, target, {
      fetchLatest: async () => NEWER,
      download
    });

    expect(download).not.toHaveBeenCalled();
    expect(handle.drainCalls).toEqual([]);
  });

  it('lets a different version through', async () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const handle = fakeHandle();
    const download = vi.fn(async (_url: string, destination: string) => {
      fs.writeFileSync(destination, 'stale-binary');
    });
    writeUpdateState(workspace, { lastFailedVersion: '9.9.8', lastFailedAt: new Date().toISOString() });

    await runUpdateTick(handle, daemonState(workspace), workspace, target, {
      fetchLatest: async () => NEWER,
      download,
      // Keep the tick off the swap path: this test is only about backoff.
      probeVersion: () => OLDER
    });

    expect(isBackoffBlocked({ lastFailedVersion: '9.9.8', lastFailedAt: new Date().toISOString() }, NEWER)).toBe(
      false
    );
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('expires the window after 24h', () => {
    const now = Date.now();
    const stale = { lastFailedVersion: NEWER, lastFailedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() };
    const fresh = { lastFailedVersion: NEWER, lastFailedAt: new Date(now - 23 * 60 * 60 * 1000).toISOString() };
    expect(isBackoffBlocked(stale, NEWER, now)).toBe(false);
    expect(isBackoffBlocked(fresh, NEWER, now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defect 5 — the tick honours the persisted release base
// ---------------------------------------------------------------------------

describe('runUpdateTick: release base precedence', () => {
  /** The base the tick actually asked the download seam for. */
  async function downloadBase(
    workspace: string,
    stateOverrides: Record<string, unknown>,
    envBase?: string
  ): Promise<string> {
    const target = path.join(workspace, 'superiu-server');
    const handle = fakeHandle();
    const seen: string[] = [];
    const previous = process.env.SUPERIU_RELEASE_BASE;
    if (envBase === undefined) delete process.env.SUPERIU_RELEASE_BASE;
    else process.env.SUPERIU_RELEASE_BASE = envBase;
    try {
      await runUpdateTick(handle, daemonState(workspace, stateOverrides), workspace, target, {
        fetchLatest: async () => NEWER,
        download: async (url, destination) => {
          seen.push(url);
          // Materialize the file the production path chmods; without it the
          // `chmodSync` throws ENOENT and every passing case prints a
          // misleading 'download failed' line.
          fs.writeFileSync(destination, 'x');
        },
        // Keep the tick off the swap path: this suite is only about the URL.
        probeVersion: () => OLDER
      });
    } finally {
      if (previous === undefined) delete process.env.SUPERIU_RELEASE_BASE;
      else process.env.SUPERIU_RELEASE_BASE = previous;
    }
    expect(seen).toHaveLength(1);
    return seen[0]!;
  }

  it("prefers the state's release base over SUPERIU_RELEASE_BASE", async () => {
    const url = await downloadBase(makeWorkspace(), { releaseBase: 'http://state.example/v9' }, 'http://env.example/v9');
    expect(url.startsWith('http://state.example/v9/')).toBe(true);
  });

  it('falls back to SUPERIU_RELEASE_BASE when the state has no base', async () => {
    const url = await downloadBase(makeWorkspace(), {}, 'http://env.example/v9');
    expect(url.startsWith('http://env.example/v9/')).toBe(true);
  });

  it('falls back to the default GitHub base when neither is set', async () => {
    const url = await downloadBase(makeWorkspace(), {});
    expect(url.startsWith('https://github.com/Kayphoon/SuperIU/releases/latest/download/')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defect 4 — the respawn replays the auto-update settings
// ---------------------------------------------------------------------------

describe('restartDaemonDetached', () => {
  it('replays the auto-update flags on the detached respawn', () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const spawn = spawnSpy();

    restartDaemonDetached(target, daemonState(workspace), { hasUnit: () => false, spawn });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { detached?: boolean }];
    expect(file).toBe(target);
    // Defect 4: without the replay, enabling via the CLI flag would silently
    // become a one-shot after the first self-update.
    expect(args).toEqual([
      'start',
      '--port',
      '4321',
      '--host',
      '127.0.0.1',
      '--token',
      'token',
      '--workspace',
      workspace,
      '--auto-update-idle',
      '--auto-update-interval-hours',
      '3'
    ]);
    expect(options.detached).toBe(true);
  });

  it('replays --release-base so a private mirror survives the self-restart', () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const spawn = spawnSpy();

    restartDaemonDetached(target, daemonState(workspace, { releaseBase: 'http://mirror.example/v1' }), {
      hasUnit: () => false,
      spawn
    });

    const args = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
    const index = args.indexOf('--release-base');
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe('http://mirror.example/v1');
  });

  it('omits --release-base when the daemon was started without one', () => {
    const workspace = makeWorkspace();
    const spawn = spawnSpy();

    restartDaemonDetached(path.join(workspace, 'superiu-server'), daemonState(workspace), {
      hasUnit: () => false,
      spawn
    });

    const args = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).not.toContain('--release-base');
  });

  it('omits the auto-update flags when the feature is off', () => {
    const workspace = makeWorkspace();
    const spawn = spawnSpy();

    restartDaemonDetached(
      path.join(workspace, 'superiu-server'),
      daemonState(workspace, { autoUpdateIdle: undefined, autoUpdateIntervalHours: undefined }),
      { hasUnit: () => false, spawn }
    );

    const args = (spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).not.toContain('--auto-update-idle');
  });

  it('asks systemd to restart the unit instead of respawning when a unit exists', () => {
    const workspace = makeWorkspace();
    const spawn = spawnSpy();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    restartDaemonDetached(path.join(workspace, 'superiu-server'), daemonState(workspace), {
      hasUnit: () => true,
      spawn
    });

    const [file, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('systemctl');
    expect(args).toEqual(['--user', 'restart', 'superiu-server']);
    // A unit cannot receive CLI flags, so the operator is told where to put the
    // env var instead — one line, not a silent one-shot.
    const line = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(line).toContain('EnvironmentFile');
  });

  it('spawns detached and unreferenced, never blocking on its own exit', () => {
    // Structural guard for defect 1: the in-process restart must not use the
    // synchronous `execFileSync('systemctl', ...restart...)` that deadlocks
    // against systemd waiting for this very process to exit.
    const source = fs.readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');
    const start = source.indexOf('export function restartDaemonDetached');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('detached: true');
    expect(body).not.toContain("execFileSync('systemctl', ['--user', 'restart'");
    // The blocking call that caused the deadlock must live only in the sync
    // variant used by the standalone `update` command.
    expect(source).toContain("execFileSync('systemctl', ['--user', 'restart', 'superiu-server']");
  });
});

// ---------------------------------------------------------------------------
// The state file survives the update path
// ---------------------------------------------------------------------------

describe('the update path never removes the daemon state file', () => {
  it('leaves .superiu/server.json for the respawned process to rewrite', async () => {
    const workspace = makeWorkspace();
    const target = path.join(workspace, 'superiu-server');
    const stateFile = path.join(workspace, '.superiu', 'server.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(daemonState(workspace))}\n`);
    const handle = fakeHandle();

    await runUpdateTick(handle, daemonState(workspace), workspace, target, {
      fetchLatest: async () => NEWER,
      download: async (_url, destination) => {
        fs.writeFileSync(destination, 'new-binary');
      },
      probeVersion: () => NEWER,
      restart: vi.fn(),
      exit: vi.fn()
    });

    // Removing it here would leave the respawned process — and `status`/`stop`
    // — with nothing to read; `commandStart` owns rewriting it.
    expect(fs.existsSync(stateFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real server: the 503 gate is the user-visible half of defect 2
// ---------------------------------------------------------------------------

describe('startServer draining gate', () => {
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    if (handle) {
      const closing = handle;
      handle = undefined;
      await closing.close();
    }
  });

  it('is idle at boot, refuses /api/chat with 503 while draining, and serves again after', async () => {
    const workspace = makeWorkspace();
    handle = await startServer({ port: 0, host: '127.0.0.1', workspaceDir: workspace, quiet: true });

    expect(handle.isIdle()).toBe(true);

    const post = async (): Promise<number> => {
      const response = await fetch(`${handle!.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'ping' }),
        signal: AbortSignal.timeout(5_000)
      });
      // A 200 is an SSE stream; cancel it so no socket outlives the test.
      await response.body?.cancel().catch(() => undefined);
      return response.status;
    };

    handle.setDraining(true);
    expect(await post()).toBe(503);

    handle.setDraining(false);
    // The server is idle again, so the same request is accepted (the turn
    // itself fails later without a live model; only the gate is under test).
    expect(await post()).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Defect 6 — the persisted settings are the DEFAULT on the next start
// ---------------------------------------------------------------------------
//
// "Enable it once" has to survive. `commandStart` persists `autoUpdateIdle` /
// `autoUpdateIntervalHours` / `releaseBase` into `server.json`, but it used to
// read them back only for the stale-binary takeover and then decide everything
// from the CLI flag alone. So every restart that did not repeat the flag — the
// desktop's remote `install()` (stop, then start), a systemd restart, a crash
// recovery — silently turned auto-update off.
//
// `main()`/`commandStart` are driven FOR REAL here: a child node process runs
// the TypeScript daemon through `fixtures/boot-daemon.mjs`, with the node binary
// hard-linked to `<workspace>/superiu-server` so the production guard
// (`basename(process.execPath) === 'superiu-server'`) passes. The restart path
// used is SIGKILL, which is what an in-place binary swap and a crash both look
// like: it leaves `server.json` on disk for the next start to inherit. A
// graceful `stop` would delete it (see `commandStop`), which is why it is not
// the restart under test.

const DAEMON_SOURCE = new URL('../src/daemon.ts', import.meta.url).pathname;
const BOOT_SHIM = new URL('./fixtures/boot-daemon.mjs', import.meta.url).pathname;

/** A release base that can never resolve, so no test ever downloads anything. */
const DEAD_RELEASE_BASE = 'http://127.0.0.1:1/v0';

/**
 * How long a child daemon gets to print `SUPERIU_READY`. This is a liveness
 * ceiling on a real process boot (node startup + asset materialization), not a
 * pacing sleep: the normal path resolves on the ready line itself.
 */
const DAEMON_READY_TIMEOUT_MS = 15_000;

/** A child `superiu-server start` under test. */
interface RunningDaemon {
  child: ChildProcess;
}

/**
 * Hard-link the running node binary into the workspace as `superiu-server`, so
 * the daemon under test sees the executable name the production guard requires.
 *
 * A hard link is the cheapest way to reuse the binary, but it needs both paths
 * on one filesystem — `/tmp` is a separate mount in most containers, so the
 * `EXDEV` case falls back to a copy. A copy is also what a real install does.
 */
function linkServerBinary(workspace: string): string {
  const binary = path.join(workspace, 'superiu-server');
  // The second start in the same workspace finds the link the first one made:
  // a real daemon's binary survives its own restart, so keep it.
  if (fs.existsSync(binary)) return binary;
  try {
    fs.linkSync(process.execPath, binary);
  } catch {
    fs.copyFileSync(process.execPath, binary);
    fs.chmodSync(binary, 0o755);
  }
  return binary;
}

/**
 * Whether this node can run the TypeScript daemon in a child process at all.
 *
 * The fixture needs `registerHooks` (node >= 22.15) and `--experimental-strip-types`;
 * on an older runtime the subprocess suite is skipped rather than failing the
 * whole run for a reason that has nothing to do with the daemon.
 */
const SUPPORTS_TS_CHILD = ((): boolean => {
  // `registerHooks` landed in node 22.15; older runtimes (and older type
  // definitions) do not have it, so probe the value instead of assuming it.
  if (!('registerHooks' in nodeModule) || typeof nodeModule.registerHooks !== 'function') return false;
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', '-e', ''], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

if (!SUPPORTS_TS_CHILD) {
  console.warn(
    'idle-update: skipping the end-to-end daemon suite — this node lacks registerHooks/' +
      '--experimental-strip-types (needs node >= 22.15)'
  );
}

function readServerJson(workspace: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(workspace, '.superiu', 'server.json'), 'utf-8'));
  // Boundary parse of a file this suite's daemon just wrote; the guard keeps the
  // read honest without trusting the shape.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('server.json is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** The `pid` from a daemon's `SUPERIU_READY` payload line. */
function readyPid(payload: string): number {
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed) || typeof parsed.pid !== 'number') {
    throw new Error(`ready payload has no numeric pid: ${payload}`);
  }
  return parsed.pid;
}

/**
 * Start the real daemon and wait for its `SUPERIU_READY` line — the same signal
 * the desktop parses.
 */
async function startDaemon(workspace: string, args: string[]): Promise<RunningDaemon> {
  const binary = linkServerBinary(workspace);
  const child = spawn(
    binary,
    ['--experimental-strip-types', BOOT_SHIM, DAEMON_SOURCE, 'start', '--workspace', workspace, ...args],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Await the ready line rather than sleeping a guessed duration: the child
  // exits (or the timeout fires) if the daemon never comes up, so a failure
  // reports the real stderr instead of a mystery timeout.
  const { promise: ready, resolve: onReady, reject: onFailed } = Promise.withResolvers<string>();
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    const index = stdout.indexOf('SUPERIU_READY');
    if (index !== -1) onReady(stdout.slice(index + 'SUPERIU_READY '.length).split('\n')[0]!);
  });
  child.once('exit', (code) => onFailed(new Error(`daemon exited before ready (code ${code}):\n${stderr}`)));

  const timeout = setTimeout(
    () => onFailed(new Error(`daemon never became ready:\n${stderr}`)),
    DAEMON_READY_TIMEOUT_MS
  );

  let payload: string;
  try {
    payload = await ready;
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  // The ready line must name this very process: it is the handle the caller
  // kills, and a mismatch would mean the state file describes another daemon.
  if (readyPid(payload) !== child.pid) {
    child.kill('SIGKILL');
    throw new Error(`ready payload pid ${readyPid(payload)} != spawned pid ${child.pid}`);
  }
  return { child };
}

/** SIGKILL without a graceful `stop`, which would delete the state file. */
function killDaemon(daemon: RunningDaemon): void {
  daemon.child.kill('SIGKILL');
}

/** Await the child actually leaving the process table. */
async function waitForExit(daemon: RunningDaemon): Promise<void> {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  daemon.child.once('exit', () => resolve());
  await promise;
}

describe.skipIf(!SUPPORTS_TS_CHILD)('commandStart: persisted auto-update settings are the default', () => {
  /** Every daemon started by this suite, killed even when an assertion throws. */
  const started: RunningDaemon[] = [];

  afterEach(async () => {
    for (const daemon of started.splice(0)) {
      killDaemon(daemon);
      await waitForExit(daemon);
    }
  });

  it('persists --auto-update-idle and the interval on the first start', async () => {
    const workspace = makeWorkspace();
    const daemon = await startDaemon(workspace, [
      '--port',
      '0',
      '--auto-update-idle',
      '--auto-update-interval-hours',
      '12',
      '--release-base',
      DEAD_RELEASE_BASE
    ]);
    started.push(daemon);

    const state = readServerJson(workspace);
    expect(state.autoUpdateIdle).toBe(true);
    expect(state.autoUpdateIntervalHours).toBe(12);
    expect(state.releaseBase).toBe(DEAD_RELEASE_BASE);
  });

  it('keeps auto-update enabled when the SAME workspace restarts without the flag', async () => {
    const workspace = makeWorkspace();
    const first = await startDaemon(workspace, [
      '--port',
      '0',
      '--auto-update-idle',
      '--auto-update-interval-hours',
      '12',
      '--release-base',
      DEAD_RELEASE_BASE
    ]);
    started.push(first);
    expect(readServerJson(workspace).autoUpdateIdle).toBe(true);

    // The regression: a restart that does not repeat the flag must inherit the
    // persisted settings, not silently turn the feature off.
    killDaemon(first);
    await waitForExit(first);

    const second = await startDaemon(workspace, ['--port', '0']);
    started.push(second);

    const state = readServerJson(workspace);
    expect(state.autoUpdateIdle).toBe(true);
    expect(state.autoUpdateIntervalHours).toBe(12);
  });

  it('inherits --release-base from server.json when restarted without the flag', async () => {
    const workspace = makeWorkspace();
    const first = await startDaemon(workspace, [
      '--port',
      '0',
      '--auto-update-idle',
      '--release-base',
      DEAD_RELEASE_BASE
    ]);
    started.push(first);

    killDaemon(first);
    await waitForExit(first);

    const second = await startDaemon(workspace, ['--port', '0']);
    started.push(second);

    // Without the inheritance the daemon would fall back to the public GitHub
    // base — the wrong release channel for a daemon provisioned from a mirror.
    expect(readServerJson(workspace).releaseBase).toBe(DEAD_RELEASE_BASE);
  });

  it('stays disabled, and writes no autoUpdateIdle key, with no flag and no prior state', async () => {
    const workspace = makeWorkspace();
    const daemon = await startDaemon(workspace, ['--port', '0']);
    started.push(daemon);

    const state = readServerJson(workspace);
    // The default boot must keep the pre-auto-update state-file shape exactly:
    // an explicit `false` would be a shape change even though the behaviour
    // matches.
    expect('autoUpdateIdle' in state).toBe(false);
    expect('autoUpdateIntervalHours' in state).toBe(false);
    expect('releaseBase' in state).toBe(false);
  });

  it('--no-auto-update-idle turns it off AND clears the persisted keys, so a flagless restart stays off', async () => {
    const workspace = makeWorkspace();
    const first = await startDaemon(workspace, ['--port', '0', '--auto-update-idle', '--auto-update-interval-hours', '12']);
    started.push(first);
    expect(readServerJson(workspace).autoUpdateIdle).toBe(true);

    // The regression: the wizard/desktop toggling OFF must be expressible. It
    // SIGKILLs the daemon (a crash / in-place swap leaves server.json behind)
    // and restarts with the negative flag.
    killDaemon(first);
    await waitForExit(first);

    const second = await startDaemon(workspace, ['--port', '0', '--no-auto-update-idle']);
    started.push(second);

    const cleared = readServerJson(workspace);
    expect('autoUpdateIdle' in cleared).toBe(false);
    expect('autoUpdateIntervalHours' in cleared).toBe(false);

    // And a third, flagless start must not resurrect the stale value.
    killDaemon(second);
    await waitForExit(second);

    const third = await startDaemon(workspace, ['--port', '0']);
    started.push(third);

    const state = readServerJson(workspace);
    expect('autoUpdateIdle' in state).toBe(false);
    expect('autoUpdateIntervalHours' in state).toBe(false);
  });
});
