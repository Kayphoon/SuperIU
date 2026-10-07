/**
 * Unit tests for the remote bootstrap argv builder and the manager's
 * apply-on-change restart of a running daemon.
 *
 * The invariant under test: idle auto-update is tri-state on the wire. An
 * explicit `true`/`false` must reach the daemon as `--auto-update-idle` /
 * `--no-auto-update-idle`, `undefined` must emit neither flag, and a running
 * daemon whose persisted value disagrees with an explicit request must be
 * stopped and started again with the requested flag.
 */

import { describe, it, expect } from 'vitest';
import { RemoteBootstrapper, type RemoteRunner, type RemoteRunResult } from '../src/remote/bootstrap.js';
import { RemoteConnectionManager } from '../src/remote/manager.js';

const ok = (stdout = ''): RemoteRunResult => ({ stdout, stderr: '', exitCode: 0 });

/**
 * A recording runner that answers the commands the bootstrapper/manager issue.
 * `serverState` is the JSON the fake `server.json` reports, so a test can put a
 * daemon "in flight" with a specific persisted `autoUpdateIdle`.
 */
function makeRecorder(serverState?: Record<string, unknown>): {
  runner: RemoteRunner;
  commands: string[];
} {
  const commands: string[] = [];
  const runner: RemoteRunner = async (_alias, cmd) => {
    commands.push(cmd);
    if (cmd.includes('printf "OS=')) {
      return ok('OS=Linux\nARCH=x86_64\nHOME=/home/u\nINSTALLED=1\nVERSION={"version":"1.0.0"}\nRUNNING=1\n');
    }
    if (cmd.includes('server.json')) {
      return ok(serverState ? `${JSON.stringify(serverState)}\n` : '');
    }
    if (cmd.includes(' stop --workspace')) return ok('{"stopped":true}\n');
    if (cmd.includes('status --workspace')) return ok('{"running":true,"port":7345}\n');
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
  function makeManager(serverState: Record<string, unknown> | undefined) {
    const { runner, commands } = makeRecorder(serverState);
    const bootstrapper = new RemoteBootstrapper(runner);
    const manager = new RemoteConnectionManager({
      bootstrapper,
      tunnel: { open: async () => ({ localPort: 51234 }) } as never,
      gatewayClientFactory: () => ({ connect() {}, close() {} }) as never,
    });
    return { manager, commands };
  }

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
