import * as os from 'node:os';
import { execSync } from 'node:child_process';
import type { WorkstationInfo } from './types.js';

export function getGitBranch(cwd: string = process.cwd()): string | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

export function getWorkstationInfo(cwd: string = process.cwd()): WorkstationInfo {
  const osType = os.platform();
  const osRelease = os.release();
  const arch = os.arch();
  const nodeVersion = process.version;
  const timestamp = new Date().toISOString();
  const gitBranch = getGitBranch(cwd);

  return {
    os: `${osType} ${osRelease}`,
    arch,
    nodeVersion,
    cwd,
    gitBranch,
    timestamp
  };
}

/**
 * Render the workstation block.
 *
 * Emits OS, Arch, Node, CWD, and Git Branch. The volatile ISO `Time` line
 * is intentionally omitted to maintain a 100% byte-identical static prefix
 * across turns for prompt caching. Real-world chronology is persisted in the
 * JSONL session storage and models can query current time on-demand via tools (`bash("date")`).
 */
export function formatWorkstationXml(info: WorkstationInfo): string {
  const lines: string[] = [
    '<workstation>',
    `- OS: ${info.os}`,
    `- Arch: ${info.arch}`,
    `- Node: ${info.nodeVersion}`,
    `- CWD: ${info.cwd}`
  ];

  if (info.gitBranch) {
    lines.push(`- Git Branch: ${info.gitBranch}`);
  }

  lines.push('</workstation>');
  return lines.join('\n');
}
