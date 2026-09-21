import { tool } from 'ai';
import { z } from 'zod';
import { execa } from 'execa';
import * as path from 'node:path';
import { handleSpillover } from '../spillover.js';

export interface BashToolOptions {
  workspaceDir?: string;
  spilloverDir?: string;
  getSignal?: () => AbortSignal | undefined;
}

export function createBashTool(options: BashToolOptions = {}) {
  return tool({
    description: 'Execute a bash command in the workspace directory with process tree protection and timeout safeguards.',
    parameters: z.object({
      command: z.string().describe('The bash command to execute')
    }),
    execute: async ({ command }) => {
      const cwd = options.workspaceDir ? path.resolve(options.workspaceDir) : process.cwd();
      const signal = options.getSignal?.();

      const subprocess = execa(command, {
        shell: true,
        cwd,
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
      }, 30_000);
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

        let combined = '';
        if (stdout && stderr) {
          combined = `${stdout}\n--- stderr ---\n${stderr}`;
        } else {
          combined = stdout || stderr || '(no output)';
        }

        const spillResult = await handleSpillover(combined, options.spilloverDir);

        if (result.isCanceled || (signal && signal.aborted)) {
          return `[Process aborted by user/signal]\n${spillResult.content}`;
        }

        if (timedOut) {
          return `[Process timed out after 30 seconds]\n${spillResult.content}`;
        }

        if (result.exitCode !== 0 && result.exitCode !== undefined) {
          return `[Process exited with code ${result.exitCode}]\n${spillResult.content}`;
        }

        return spillResult.content;
      } catch (err: unknown) {
        const isCanceled =
          Boolean(err && typeof err === 'object' && 'isCanceled' in err && err.isCanceled);
        const isAbort =
          (err instanceof Error && (err.name === 'AbortError' || isCanceled)) ||
          Boolean(signal?.aborted);
        if (isAbort) {
          return '[Process aborted by user/signal]';
        }
        const message = err instanceof Error ? err.message : String(err);
        return `[Process execution error: ${message}]`;
      } finally {
        clearTimeout(timeoutTimer);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      }
    }
  });
}
