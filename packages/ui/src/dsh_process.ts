import { execFile, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export type DshErrorCode =
  | 'invalid_url'
  | 'node_unsupported'
  | 'cli_missing'
  | 'auth_required'
  | 'unavailable'
  | 'start_failed'
  | 'timeout';

export class DshError extends Error {
  readonly code: DshErrorCode;

  constructor(code: DshErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'DshError';
  }
}

function nodeVersionSupported(raw: string): boolean {
  const match = /^v(\d+)\.(\d+)\./.exec(raw.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 24 || (major === 24 && minor >= 9);
}

/** Resolve a system Node, never Electron's embedded runtime. */
export async function resolveDshNode(env: NodeJS.ProcessEnv): Promise<string> {
  const configured = env.SUPERIU_DSH_NODE?.trim();
  const candidates = configured
    ? [configured]
    : ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version'], {
        timeout: 3_000,
        windowsHide: true,
        maxBuffer: 4_096
      });
      if (nodeVersionSupported(stdout)) return candidate;
    } catch {
      continue;
    }
  }
  throw new DshError(
    'node_unsupported',
    'DSH requires a system Node.js >= 24.9.0 (Electron cannot run its native plugins).'
  );
}

export function resolveDshCli(env: NodeJS.ProcessEnv): string {
  const configured = env.SUPERIU_DSH_BIN?.trim();
  let cliPath: string;
  if (configured) {
    cliPath = path.resolve(configured);
  } else {
    try {
      cliPath = path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js');
    } catch {
      throw new DshError('cli_missing', 'The managed @deepseek-ai/dsh runtime is not installed.');
    }
  }
  if (!fs.existsSync(cliPath)) {
    throw new DshError('cli_missing', `DSH CLI does not exist: ${cliPath}`);
  }
  return cliPath;
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new DshError('start_failed', 'Could not allocate a loopback port for DSH.');
  return port;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The process group may already have exited; fall back to the child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    return;
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export async function stopDshProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) return;
  signalProcessTree(child, 'SIGTERM');
  if (await waitForExit(child, 3_000)) return;
  signalProcessTree(child, 'SIGKILL');
  await waitForExit(child, 3_000);
}
