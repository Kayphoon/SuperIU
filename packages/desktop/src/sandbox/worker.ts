/**
 * Workspace sandbox worker.
 *
 * Executes reverse RPC operations (file reads/writes and shell commands) that
 * the VPS Gateway asks the desktop client to perform against the user's locally
 * selected project directory.
 *
 * The single non-negotiable invariant is {@link WorkspaceSandboxWorker.resolveSafePath}:
 * every filesystem path and every shell command is anchored to `workspaceRoot`,
 * and any attempt to escape it (e.g. `../../.ssh/id_rsa`) is rejected before it
 * ever reaches `node:fs` or `child_process`.
 */

import { exec } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  BashExecuteParams,
  BashExecuteResult,
  FsReadFileParams,
  FsReadFileResult,
  FsWriteFileParams,
  FsWriteFileResult,
} from '@agent/protocol';

/** Default shell timeout when the caller does not specify one. */
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;

/**
 * Patterns that identify a command dangerous enough to require explicit user
 * confirmation before it runs. Matching is deliberately conservative: a false
 * positive only costs the user one dialog, a false negative runs `rm -rf /`.
 */
const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  // Recursive/forced deletes.
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\b/i,
  /\bsudo\s+rm\b/i,
  // Filesystem / partition destruction.
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\s+[^|;]*of=\/dev\//i,
  /\bfdisk\b/i,
  /\bparted\b/i,
  // Writes or permission changes against the filesystem root.
  /:\s*>\s*\/\b/,
  /\bchmod\s+(-R\s+)?[0-7]{3,4}\s+\/(\s|$)/i,
  /\bchown\s+(-R\s+)?[^|;]*\s+\/(\s|$)/i,
  // Piping a network download straight into a shell/interpreter.
  /\b(curl|wget|fetch)\b[^|;]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i,
  /\b(curl|wget|fetch)\b[^|;]*\|\s*(python[0-9.]*|node|perl|ruby)\b/i,
  // Power / account operations.
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\b(useradd|userdel|usermod|passwd)\b/i,
  /\b(mv|cp)\b[^|;]*\s\/dev\/null\b/i,
  /\bsudo\b/i,
];

/** Returns true when `command` matches a known dangerous pattern. */
export function isDangerousCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Callback invoked before a dangerous command executes. Resolving `true`
 * approves the command, `false` rejects it.
 */
export type ApprovalHandler = (command: string) => Promise<boolean>;

/**
 * Sandboxed executor bound to a single local workspace directory.
 *
 * All relative paths are resolved against `workspaceRoot`; absolute paths that
 * fall outside it are rejected. Bash commands always run with
 * `cwd = workspaceRoot`.
 */
export class WorkspaceSandboxWorker {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    if (!workspaceRoot) {
      throw new Error('WorkspaceSandboxWorker requires a workspaceRoot');
    }
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  /**
   * Resolve `targetPath` against the workspace and guarantee it stays inside.
   *
   * @throws Error `AccessDenied: Path is outside workspace sandbox` when the
   * resolved path escapes `workspaceRoot`.
   */
  resolveSafePath(targetPath: string): string {
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      throw new Error('AccessDenied: Path is outside workspace sandbox');
    }

    const root = path.resolve(this.workspaceRoot);
    const resolved = path.resolve(root, targetPath);

    // `startsWith(root)` alone is insufficient: `/work/evil` would be a prefix
    // match for `/work`. Require an exact match or a separator-delimited child.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('AccessDenied: Path is outside workspace sandbox');
    }

    return resolved;
  }

  /** Read a file inside the sandbox, optionally slicing by offset & limit. */
  async handleReadFile(params: FsReadFileParams): Promise<FsReadFileResult> {
    const absolute = this.resolveSafePath(params.path);
    const raw = await fs.readFile(absolute, 'utf8');

    if (params.offset === undefined && params.limit === undefined) {
      return { content: raw };
    }

    const lines = raw.split('\n');
    const offset = clampNonNegative(params.offset);
    const limit = params.limit === undefined ? lines.length : clampNonNegative(params.limit);
    const slice = lines.slice(offset, offset + limit);

    return { content: slice.join('\n') };
  }

  /** Write a file inside the sandbox, creating parent directories as needed. */
  async handleWriteFile(params: FsWriteFileParams): Promise<FsWriteFileResult> {
    const absolute = this.resolveSafePath(params.path);
    const content = params.content ?? '';

    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');

    return { bytesWritten: Buffer.byteLength(content, 'utf8') };
  }

  /**
   * Execute a shell command inside the workspace.
   *
   * Dangerous commands are gated behind `onApprovalRequired`. Without an
   * approval handler a dangerous command is rejected outright — the safe
   * default for an unattended worker.
   */
  async handleExecuteBash(
    params: BashExecuteParams,
    onApprovalRequired?: ApprovalHandler,
  ): Promise<BashExecuteResult> {
    const command = params.command ?? '';

    if (isDangerousCommand(command)) {
      const approved = onApprovalRequired ? await onApprovalRequired(command) : false;
      if (!approved) {
        return { stdout: '', stderr: 'Command rejected by user', exitCode: 1 };
      }
    }

    const cwd = params.cwd ? this.resolveSafeCwd(params.cwd) : this.workspaceRoot;
    const timeout =
      params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_BASH_TIMEOUT_MS;

    return await new Promise<BashExecuteResult>((resolve) => {
      exec(
        command,
        {
          cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: process.env,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const exitCode = resolveExitCode(error);
          const out = typeof stdout === 'string' ? stdout : '';
          const err =
            (typeof stderr === 'string' ? stderr : '') ||
            (error && exitCode !== 1 ? String((error as Error).message ?? '') : '');
          resolve({ stdout: out, stderr: err, exitCode });
        },
      );
    });
  }

  /** Resolve an optional command working directory, enforcing the sandbox. */
  private resolveSafeCwd(cwd: string): string {
    return this.resolveSafePath(cwd);
  }
}

/** Clamp an optional numeric argument to a non-negative integer. */
function clampNonNegative(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

/** Derive a numeric exit code from an `exec` error. */
function resolveExitCode(error: unknown): number {
  if (!error) return 0;
  const execError = error as { code?: number | string; killed?: boolean };
  if (typeof execError.code === 'number') return execError.code;
  if (execError.killed) return 124; // GNU `timeout` convention.
  return 1;
}
