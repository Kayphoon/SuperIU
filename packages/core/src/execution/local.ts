import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execa } from 'execa';
import type { ExecutionContext } from './types.js';

export interface LocalExecutionContextOptions {
  workspaceDir?: string;
  spilloverDir?: string;
}

/**
 * Executes filesystem and command operations directly on the local machine
 * (the server process), using `node:fs/promises` and `execa`.
 */
export class LocalExecutionContext implements ExecutionContext {
  readonly location = 'server' as const;
  readonly workspaceDir: string;
  readonly spilloverDir?: string;

  constructor(options: LocalExecutionContextOptions = {}) {
    this.workspaceDir = options.workspaceDir ? path.resolve(options.workspaceDir) : process.cwd();
    this.spilloverDir = options.spilloverDir;
  }

  /** Resolve a possibly-relative path against the workspace root. */
  resolvePath(targetPath: string): string {
    return path.isAbsolute(targetPath) ? targetPath : path.resolve(this.workspaceDir, targetPath);
  }

  async readFile(params: { path: string; offset?: number; limit?: number }): Promise<string> {
    const resolvedPath = this.resolvePath(params.path);
    return fs.readFile(resolvedPath, 'utf-8');
  }

  async writeFile(params: { path: string; content: string }): Promise<{ bytesWritten: number }> {
    const resolvedPath = this.resolvePath(params.path);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, params.content, 'utf-8');
    return { bytesWritten: Buffer.byteLength(params.content, 'utf-8') };
  }

  async executeCommand(params: {
    command: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{
    stdout: string;
    stderr: string;
    exitCode?: number;
    isCanceled?: boolean;
    timedOut?: boolean;
  }> {
    const { command, timeoutMs = 30_000, signal } = params;

    const subprocess = execa(command, {
      shell: true,
      cwd: this.workspaceDir,
      detached: process.platform !== 'win32',
      reject: false
    });

    const killTree = (sig: NodeJS.Signals = 'SIGKILL') => {
      const pid = subprocess.pid;
      if (typeof pid === 'number' && pid > 0) {
        if (process.platform !== 'win32') {
          try {
            process.kill(-pid, sig);
            return;
          } catch {
            // Fall through if ESRCH (already terminated) or permission error
          }
        }
        try {
          process.kill(pid, sig);
        } catch {
          // Fall through
        }
      }
      try {
        subprocess.kill(sig);
      } catch {
        // Ignore
      }
    };

    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      const forceTimer = setTimeout(() => {
        killTree('SIGKILL');
      }, 2000);
      forceTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();

    const onAbort = () => {
      killTree('SIGKILL');
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      const result = await subprocess;

      const stdout = result.stdout ? result.stdout.trim() : '';
      const stderr = result.stderr ? result.stderr.trim() : '';

      return {
        stdout,
        stderr,
        exitCode: result.exitCode,
        isCanceled: result.isCanceled || Boolean(signal?.aborted),
        timedOut
      };
    } catch (err: unknown) {
      const isCanceled =
        Boolean(err && typeof err === 'object' && 'isCanceled' in err && err.isCanceled) ||
        Boolean(signal?.aborted);
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: '',
        stderr: message,
        isCanceled,
        timedOut
      };
    } finally {
      clearTimeout(timeoutTimer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }
}
