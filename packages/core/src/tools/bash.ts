import { tool } from 'ai';
import { z } from 'zod';
import { handleSpillover } from '../spillover.js';
import { LocalExecutionContext } from '../execution/local.js';
import type { ExecutionContext } from '../execution/types.js';

export interface BashToolOptions {
  workspaceDir?: string;
  spilloverDir?: string;
  getSignal?: () => AbortSignal | undefined;
  /** Optional execution context. Falls back to a local context when omitted. */
  context?: ExecutionContext;
}

function resolveContext(options: BashToolOptions): ExecutionContext {
  if (options.context) {
    return options.context;
  }
  return new LocalExecutionContext({
    workspaceDir: options.workspaceDir,
    spilloverDir: options.spilloverDir
  });
}

export async function executeBashCommand(
  command: string,
  options: BashToolOptions = {}
): Promise<string> {
  const context = resolveContext(options);
  const signal = options.getSignal?.();
  const spilloverDir = options.spilloverDir ?? context.spilloverDir;

  const result = await context.executeCommand({ command, signal });

  const stdout = result.stdout ? result.stdout.trim() : '';
  const stderr = result.stderr ? result.stderr.trim() : '';

  let combined = '';
  if (stdout && stderr) {
    combined = `${stdout}\n--- stderr ---\n${stderr}`;
  } else {
    combined = stdout || stderr || '(no output)';
  }

  const spillResult = await handleSpillover(combined, spilloverDir);

  if (result.isCanceled || (signal && signal.aborted)) {
    return `[Process aborted by user/signal]\n${spillResult.content}`;
  }

  if (result.timedOut) {
    return `[Process timed out after 30 seconds]\n${spillResult.content}`;
  }

  if (result.exitCode !== 0 && result.exitCode !== undefined) {
    return `[Process exited with code ${result.exitCode}]\n${spillResult.content}`;
  }

  return spillResult.content;
}

export function createBashTool(options: BashToolOptions = {}) {
  return tool({
    description: 'Execute a bash command in the workspace directory with process tree protection and timeout safeguards.',
    parameters: z.object({
      command: z.string().describe('The bash command to execute')
    }),
    execute: async ({ command }) => executeBashCommand(command, options)
  });
}
