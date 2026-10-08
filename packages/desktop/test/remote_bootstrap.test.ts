/**
 * Unit tests for the remote bootstrap argv builder and the manager's
 * apply-on-change restart of a running daemon.
 *
 * The invariant under test: idle auto-update is tri-state on the wire. An
 * explicit `true`/`false` must reach the daemon as `--auto-update-idle` /
 * `--no-auto-update-idle`, `undefined` must emit neither flag, and a running
 * daemon whose persisted value disagrees with an explicit request must be
 * stopped and started again with the requested flag.
 *
 * Also covered: the socket transport. When the remote binary advertises
 * `--socket`, the daemon is started on a workspace-local Unix socket and the
 * tunnel forwards to that socket instead of a TCP port; when it does not, the
 * original `--port`/`127.0.0.1` behaviour is unchanged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { RemoteBootstrapper, type RemoteRunner, type RemoteRunResult } from '../src/remote/bootstrap.js';
import { RemoteConnectionManager } from '../src/remote/manager.js';
import { sshControlArgs } from '../src/remote/ssh_control.js';

const ok = (stdout = ''): RemoteRunResult => ({ stdout, stderr: '', exitCode: 0 });

/**
 * A recording runner that answers the commands the bootstrapper/manager issue.
 * `serverState` is the JSON the fake `server.json` reports, so a test can put a
 * daemon "in flight" with a specific persisted `autoUpdateIdle`.
 *
 * `socketSupport` controls the probe's `SOCKET_SUPPORT` line and, when enabled,
 * makes `status` report a Unix socket (and no TCP port) so the manager adopts
 * the socket transport.
 */
function makeRecorder(
  serverState?: Record<string, unknown>,
  opts: { socketSupport?: boolean; statusRunning?: boolean } = {},
): {
  runner: RemoteRunner;
  commands: string[];
} {
  const socketSupport = opts.socketSupport === true;
  let running = opts.statusRunning !== false;
  const commands: string[] = [];
  const runner: RemoteRunner = async (_alias, cmd) => {
    commands.push(cmd);
    if (cmd.includes('printf "OS=')) {
      return ok(
        'OS=Linux\nARCH=x86_64\nHOME=/home/u\nINSTALLED=1\nVERSION={"version":"1.0.0"}\n' +
          `RUNNING=1\nSOCKET_SUPPORT=${socketSupport ? '1' : '0'}\n`,
      );
    }
    if (cmd.includes('server.json')) {
      return ok(serverState ? `${JSON.stringify(serverState)}\n` : '');
    }
    // The launch command embeds its own `status --workspace` probe, so the start
    // must be matched first: a started daemon then reports running to the poll.
    if (cmd.includes('setsid nohup') || cmd.includes('systemctl --user restart')) {
      running = true;
      return ok('');
    }
    if (cmd.includes(' stop --workspace')) return ok('{"stopped":true}\n');
    if (cmd.includes('status --workspace')) {
      if (!running) return ok('{"running":false}\n');
      return ok(
        socketSupport
          ? '{"running":true,"socketPath":"/w/.superiu/server.sock"}\n'
          : '{"running":true,"port":7345}\n',
      );
    }
    return ok('');
  };
  return { runner, commands };
}

/** Extract the argv of the `setsid nohup` launch line from a recorded command. */
function launchArgv(commands: string[]): string {
  const launch = commands.find((cmd) => cmd.includes('setsid nohup'));
  expect(launch, 'expected a nohup launch command').toBeDefined();
  const bin = '$HOME/.superiu/bin/superiu-server ';
  const start = launch!.lastIndexOf(bin) + bin.length;
  const end = launch!.indexOf(' </dev/null');
  return launch!.slice(start, end);
}

/** A manager wired to a fake tunnel/gateway, recording the tunnel's open options. */
function makeManager(
  serverState: Record<string, unknown> | undefined,
  opts: { socketSupport?: boolean; statusRunning?: boolean } = {},
): {
  manager: RemoteConnectionManager;
  commands: string[];
  openCalls: Array<Record<string, unknown>>;
} {
  const { runner, commands } = makeRecorder(serverState, opts);
  const bootstrapper = new RemoteBootstrapper(runner);
  const openCalls: Array<Record<string, unknown>> = [];
  const manager = new RemoteConnectionManager({
    bootstrapper,
    tunnel: {
      open: async (o: Record<string, unknown>) => {
        openCalls.push(o);
        return { localPort: 51234 };
      },
    } as never,
    gatewayClientFactory: () => ({ connect() {}, close() {} }) as never,
    // Keep the readiness probe off the network in unit tests.
    probeReadyz: async () => {},
  });
  return { manager, commands, openCalls };
}

describe('RemoteBootstrapper.start argv', () => {
  async function startWith(
    options: { autoUpdateIdle?: boolean; autoUpdateIntervalHours?: number },
    serverState?: Record<string, unknown>,
  ): Promise<string[]> {
    const { runner, commands } = makeRecorder(serverState);
    const bootstrapper = new RemoteBootstrapper(runner);
    await bootstrapper.start('host', {
      port: 7345,
      token: 'tok',
      workspace: '/w',
      ...options,
    });
    return commands;
  }

  it('emits --auto-update-idle and the interval when enabled with a positive interval', async () => {
    const commands = await startWith({ autoUpdateIdle: true, autoUpdateIntervalHours: 12 });
    const argv = launchArgv(commands);
    expect(argv).toContain('--auto-update-idle');
    expect(argv).toContain('--auto-update-interval-hours 12');
    expect(argv).not.toContain('--no-auto-update-idle');
  });

  it('emits --no-auto-update-idle and no interval when explicitly disabled', async () => {
    const commands = await startWith({ autoUpdateIdle: false });
    const argv = launchArgv(commands);
    expect(argv).toContain('--no-auto-update-idle');
    expect(argv).not.toContain('--auto-update-idle');
    expect(argv).not.toContain('--auto-update-interval-hours');
  });

  it('emits neither auto-update flag when the caller expresses no preference', async () => {
    const commands = await startWith({});
    const argv = launchArgv(commands);
    expect(argv).not.toContain('--auto-update-idle');
    expect(argv).not.toContain('--no-auto-update-idle');
    expect(argv).not.toContain('--auto-update-interval-hours');
  });

  it('drops a stray interval when the feature is explicitly off', async () => {
    const commands = await startWith({ autoUpdateIdle: false, autoUpdateIntervalHours: 12 });
    const argv = launchArgv(commands);
    expect(argv).toContain('--no-auto-update-idle');
    expect(argv).not.toContain('--auto-update-interval-hours');
  });

  it('ignores a non-positive interval even when the feature is on', async () => {
    const commands = await startWith({ autoUpdateIdle: true, autoUpdateIntervalHours: 0 });
    const argv = launchArgv(commands);
    expect(argv).toContain('--auto-update-idle');
    expect(argv).not.toContain('--auto-update-interval-hours');
  });
});

describe('RemoteConnectionManager.ensureDaemon apply-on-change', () => {
  it('stops and restarts with --no-auto-update-idle when the running daemon has it on', async () => {
    const { manager, commands } = makeManager({
      running: true,
      port: 7345,
      token: 'tok-abc',
      workspace: '/w',
      autoUpdateIdle: true,
    });
    await manager.connect({ alias: 'host', workspace: '/w', autoUpdateIdle: false });

    const stopIdx = commands.findIndex((cmd) => cmd.includes(' stop --workspace'));
    const startIdx = commands.findIndex((cmd) => cmd.includes('setsid nohup'));
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);
    expect(launchArgv(commands)).toContain('--no-auto-update-idle');
  });

  it('adopts the running daemon untouched when the value already agrees', async () => {
    const { manager, commands } = makeManager({
      running: true,
      port: 7345,
      token: 'tok-abc',
      workspace: '/w',
      autoUpdateIdle: true,
    });
    await manager.connect({ alias: 'host', workspace: '/w', autoUpdateIdle: true });

    expect(commands.some((cmd) => cmd.includes(' stop --workspace'))).toBe(false);
    expect(commands.some((cmd) => cmd.includes('setsid nohup'))).toBe(false);
  });

  it('adopts the running daemon when the caller expresses no preference', async () => {
    const { manager, commands } = makeManager({
      running: true,
      port: 7345,
      token: 'tok-abc',
      workspace: '/w',
      autoUpdateIdle: true,
    });
    await manager.connect({ alias: 'host', workspace: '/w' });

    expect(commands.some((cmd) => cmd.includes(' stop --workspace'))).toBe(false);
    expect(commands.some((cmd) => cmd.includes('setsid nohup'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Staleness upgrade: an already-installed daemon must be upgraded when it is
// older than the desktop app, because remote mode loads the SPA FROM the daemon
// — a daemon older than the app serves a stale console (this is how a shipped
// connection badge ended up invisible to a user whose VPS ran a months-old
// binary). The upgrade is pinned to the target version so it converges instead
// of re-downloading an older stable forever.
// ---------------------------------------------------------------------------

describe('RemoteConnectionManager daemon staleness upgrade', () => {
  /**
   * A recorder whose probe reports `installedVersion` until an install lands,
   * after which it reports `installedVersion` = the version it was pinned to.
   * That models the real convergence: the post-install probe sees the new
   * binary, so a second connect must NOT install again.
   */
  function makeStatefulRecorder(installedVersion: string): {
    runner: RemoteRunner;
    commands: string[];
  } {
    const commands: string[] = [];
    let current = installedVersion;
    // Set by the download command, consumed by the install's verification step:
    // that is the moment the new binary actually lands on the remote.
    let pendingInstall: string | undefined;
    const runner: RemoteRunner = async (_alias, cmd) => {
      commands.push(cmd);
      if (cmd.includes('printf "OS=')) {
        return ok(
          `OS=Linux\nARCH=x86_64\nHOME=/home/u\nINSTALLED=1\nVERSION={"version":"${current}"}\nRUNNING=1\n`,
        );
      }
      if (cmd.includes('server.json')) return ok('');
      // The install script contains its own `stop --workspace` prelude, so the
      // download match MUST come first or the whole install is mistaken for a
      // bare stop and never records the pinned version.
      if (cmd.includes('curl -fsSL')) {
        pendingInstall = cmd.match(/download\/v([0-9.]+)\//)?.[1];
        return ok('');
      }
      if (cmd.includes(' stop --workspace')) return ok('{"stopped":true}\n');
      if (cmd.includes('status --workspace')) return ok('{"running":true,"port":7345}\n');
      // The install's own verification step: `${BIN} version`.
      if (cmd.includes('/superiu-server version')) {
        if (pendingInstall) {
          current = pendingInstall;
          pendingInstall = undefined;
        }
        return ok(`{"version":"${current}"}\n`);
      }
      return ok('');
    };
    return { runner, commands };
  }

  function managerFor(installedVersion: string) {
    const { runner, commands } = makeStatefulRecorder(installedVersion);
    const manager = new RemoteConnectionManager({
      bootstrapper: new RemoteBootstrapper(runner),
      tunnel: { open: async () => ({ localPort: 51234 }) } as never,
      gatewayClientFactory: () => ({ connect() {}, close() {} }) as never,
      // Keep the readiness probe off the network in unit tests.
      probeReadyz: async () => {},
    });
    return { manager, commands };
  }

  it('installs pinned to the target version when the installed daemon is older', async () => {
    const { manager, commands } = managerFor('0.1.0');
    await manager.connect({ alias: 'host', workspace: '/w', daemonTargetVersion: '0.2.18' });

    const download = commands.find((cmd) => cmd.includes('curl -fsSL'));
    expect(download, 'expected a download command').toBeDefined();
    expect(download).toContain('/releases/download/v0.2.18/');
  });

  it('converges: a second connect with the same target does not install again', async () => {
    const { manager, commands } = managerFor('0.1.0');
    await manager.connect({ alias: 'host', workspace: '/w', daemonTargetVersion: '0.2.18' });
    // The first connect MUST install, or "the second one does not" is vacuous.
    expect(commands.some((cmd) => cmd.includes('curl -fsSL'))).toBe(true);
    const afterFirst = commands.length;
    await manager.connect({ alias: 'host', workspace: '/w', daemonTargetVersion: '0.2.18' });

    expect(commands.slice(afterFirst).some((cmd) => cmd.includes('curl -fsSL'))).toBe(false);
  });

  it('leaves an equal or newer installed daemon untouched', async () => {
    for (const installed of ['0.2.18', '0.2.19']) {
      const { manager, commands } = managerFor(installed);
      await manager.connect({ alias: 'host', workspace: '/w', daemonTargetVersion: '0.2.18' });
      expect(commands.some((cmd) => cmd.includes('curl -fsSL'))).toBe(false);
    }
  });

  it('does not install when the installed version is unparseable', async () => {
    const { manager, commands } = managerFor('unknown-build');
    await manager.connect({ alias: 'host', workspace: '/w', daemonTargetVersion: '0.2.18' });
    expect(commands.some((cmd) => cmd.includes('curl -fsSL'))).toBe(false);
  });

  it('never upgrades without a target version, even when the daemon is ancient', async () => {
    const { manager, commands } = managerFor('0.0.1');
    await manager.connect({ alias: 'host', workspace: '/w' });
    expect(commands.some((cmd) => cmd.includes('curl -fsSL'))).toBe(false);
  });

  it('keeps the working daemon and connects when the staleness download fails', async () => {
    // A dev build's version has no release, so the pinned download 404s. The
    // stale-but-working daemon must still be adopted rather than failing the
    // whole connect. The install script is a single shell command, so a mock
    // cannot prove `mv` did not run; the observable contract is that the
    // connect succeeds and the install step reports the daemon was kept.
    const steps: { id: string; status: string; detail?: string }[] = [];
    const runner: RemoteRunner = async (_alias, cmd) => {
      if (cmd.includes('printf "OS=')) {
        return ok('OS=Linux\nARCH=x86_64\nHOME=/home/u\nINSTALLED=1\nVERSION={"version":"0.1.0"}\nRUNNING=1\n');
      }
      if (cmd.includes('server.json')) return ok('');
      if (cmd.includes('curl -fsSL')) return { stdout: '', stderr: 'curl: (22) 404', exitCode: 22 };
      if (cmd.includes('status --workspace')) return ok('{"running":true,"port":7345}\n');
      return ok('');
    };
    const manager = new RemoteConnectionManager({
      bootstrapper: new RemoteBootstrapper(runner),
      tunnel: { open: async () => ({ localPort: 51234 }) } as never,
      gatewayClientFactory: () => ({ connect() {}, close() {} }) as never,
      // Keep the readiness probe off the network in unit tests.
      probeReadyz: async () => {},
    });

    const result = await manager.connect({
      alias: 'host',
      workspace: '/w',
      daemonTargetVersion: '0.2.18',
      onProgress: (step) => steps.push(step),
    });
    expect(result.tunnelPort).toBe(51234);
    const install = steps.filter((s) => s.id === 'install');
    expect(install.at(-1)?.status).toBe('done');
    expect(install.at(-1)?.detail).toMatch(/kept/);
  });

  it('still fails the connect when no daemon is installed and the install fails', async () => {
    const runner: RemoteRunner = async (_alias, cmd) => {
      if (cmd.includes('printf "OS=')) {
        return ok('OS=Linux\nARCH=x86_64\nHOME=/home/u\nINSTALLED=0\nRUNNING=0\n');
      }
      if (cmd.includes('curl -fsSL')) return { stdout: '', stderr: 'boom', exitCode: 1 };
      return ok('');
    };
    const manager = new RemoteConnectionManager({
      bootstrapper: new RemoteBootstrapper(runner),
      tunnel: { open: async () => ({ localPort: 51234 }) } as never,
      gatewayClientFactory: () => ({ connect() {}, close() {} }) as never,
      // Keep the readiness probe off the network in unit tests.
      probeReadyz: async () => {},
    });

    await expect(
      manager.connect({ alias: 'host', workspace: '/w', daemonTargetVersion: '0.2.18' }),
    ).rejects.toThrow(/Install failed/);
  });
});

describe('RemoteConnectionManager socket transport', () => {
  it('starts with --socket and forwards to the remote socket when supported', async () => {
    const { manager, commands, openCalls } = makeManager(undefined, {
      socketSupport: true,
      statusRunning: false,
    });
    await manager.connect({ alias: 'host', workspace: '/w' });

    const argv = launchArgv(commands);
    expect(argv).toContain('--socket');
    expect(argv).not.toContain('--port');
    // The path is single-quoted for the remote shell (and escaped once more by
    // the outer `sh -c` wrapper), so assert on the path itself.
    expect(argv).toContain('/w/.superiu/server.sock');

    expect(openCalls).toHaveLength(1);
    expect(openCalls[0].remoteSocketPath).toBe('/w/.superiu/server.sock');
  });

  it('keeps the TCP port transport when the binary does not support sockets', async () => {
    const { manager, commands, openCalls } = makeManager(undefined, {
      socketSupport: false,
      statusRunning: false,
    });
    await manager.connect({ alias: 'host', workspace: '/w' });

    const argv = launchArgv(commands);
    expect(argv).toContain('--port');
    expect(argv).not.toContain('--socket');
    expect(openCalls[0].remoteSocketPath).toBeUndefined();
  });

  it('adopts a running socket-mode daemon without restarting it', async () => {
    // Regression: a socket daemon reports `port: 0`, so a port-only liveness
    // check skipped adoption and re-entered start(), losing the persisted token.
    const { manager, commands, openCalls } = makeManager(
      { running: true, socketPath: '/w/.superiu/server.sock', token: 'tok-abc', workspace: '/w' },
      { socketSupport: true },
    );
    await manager.connect({ alias: 'host', workspace: '/w' });

    expect(commands.some((cmd) => cmd.includes(' stop --workspace'))).toBe(false);
    expect(commands.some((cmd) => cmd.includes('setsid nohup'))).toBe(false);
    expect(openCalls[0].remoteSocketPath).toBe('/w/.superiu/server.sock');
  });

  it('starts an upgraded daemon on a socket after refreshing the probe', async () => {
    // The pre-install probe sees the old, socket-less binary; the install lands
    // the target build, so a fresh probe must report socket support or the new
    // daemon would be started in port mode and adopted there forever.
    const commands: string[] = [];
    let installedVersion = '0.1.0';
    let socketSupport = false;
    let running = false;
    let pendingInstall = false;
    const runner: RemoteRunner = async (_alias, cmd) => {
      commands.push(cmd);
      if (cmd.includes('printf "OS=')) {
        return ok(
          `OS=Linux\nARCH=x86_64\nHOME=/home/u\nINSTALLED=1\nVERSION={"version":"${installedVersion}"}\n` +
            `RUNNING=${running ? 1 : 0}\nSOCKET_SUPPORT=${socketSupport ? 1 : 0}\n`,
        );
      }
      if (cmd.includes('server.json')) return ok('');
      // The install script embeds a `stop --workspace` prelude, so match the
      // download first or the whole install is mistaken for a bare stop.
      if (cmd.includes('curl -fsSL')) {
        pendingInstall = true;
        return ok('');
      }
      if (cmd.includes('/superiu-server version')) {
        if (pendingInstall) {
          installedVersion = '0.2.20';
          socketSupport = true;
          pendingInstall = false;
        }
        return ok(`{"version":"${installedVersion}"}\n`);
      }
      if (cmd.includes('setsid nohup') || cmd.includes('systemctl --user restart')) {
        running = true;
        return ok('');
      }
      if (cmd.includes(' stop --workspace')) {
        running = false;
        return ok('{"stopped":true}\n');
      }
      if (cmd.includes('status --workspace')) {
        if (!running) return ok('{"running":false}\n');
        return ok(
          socketSupport
            ? '{"running":true,"socketPath":"/w/.superiu/server.sock"}\n'
            : '{"running":true,"port":7345}\n',
        );
      }
      return ok('');
    };
    const manager = new RemoteConnectionManager({
      bootstrapper: new RemoteBootstrapper(runner),
      tunnel: { open: async () => ({ localPort: 51234 }) } as never,
      gatewayClientFactory: () => ({ connect() {}, close() {} }) as never,
      probeReadyz: async () => {},
    });

    await manager.connect({ alias: 'host', workspace: '/w', daemonTargetVersion: '0.2.20' });

    const argv = launchArgv(commands);
    expect(argv).toContain('--socket');
    expect(argv).not.toContain('--port');
  });
});

describe('sshControlArgs', () => {
  it('enables ControlMaster reuse in the configured control dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-ssh-'));
    const previous = process.env.SUPERIU_SSH_CONTROL_DIR;
    process.env.SUPERIU_SSH_CONTROL_DIR = dir;
    try {
      const args = sshControlArgs();
      expect(args).toContain('ControlMaster=auto');
      expect(args).toContain('ControlPersist=10m');
      const controlPath = args.find((arg) => arg.startsWith('ControlPath='));
      expect(controlPath).toBeDefined();
      expect(controlPath).toContain(dir);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SUPERIU_SSH_CONTROL_DIR;
      else process.env.SUPERIU_SSH_CONTROL_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
