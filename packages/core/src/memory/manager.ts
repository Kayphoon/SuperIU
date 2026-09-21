import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { MemoryPaths } from '../types.js';

const DEFAULT_SOUL = `# SOUL / Identity
- Tone: Pragmatic, evidence-first, concise engineer.
- Philosophy: Correctness first, then maintainability. Avoid unnecessary abstractions.
- Behavior: Solve problems directly, verify steps rigorously with available tools.
`;

const DEFAULT_USER = `# USER / Environment
- OS: macOS / POSIX
- Shell: bash / zsh
- Style: Direct, technical, no pleasantries or filler.
`;

const DEFAULT_MEMORY = `# MEMORY / Long-term Facts
- Project: SuperIU Agent Platform
- Architecture: One Core, Two Shells (Core + CLI / Web)
`;

export async function resolveMemoryDir(customDir?: string): Promise<string> {
  if (customDir) {
    const resolved = path.resolve(customDir);
    await fs.mkdir(resolved, { recursive: true });
    return resolved;
  }

  // Priority 1: Current working directory .myagent/
  const localDir = path.resolve('.myagent');
  try {
    await fs.mkdir(localDir, { recursive: true });
    return localDir;
  } catch {
    // Priority 2: User homedir ~/.myagent/
    const homeDir = path.join(os.homedir(), '.myagent');
    await fs.mkdir(homeDir, { recursive: true });
    return homeDir;
  }
}

export async function ensureMemoryFiles(memoryDir?: string): Promise<MemoryPaths> {
  const dir = await resolveMemoryDir(memoryDir);

  const soulPath = path.join(dir, 'SOUL.md');
  const userPath = path.join(dir, 'USER.md');
  const memoryPath = path.join(dir, 'MEMORY.md');

  const initFile = async (filePath: string, defaultContent: string) => {
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, defaultContent, 'utf-8');
    }
  };

  await Promise.all([
    initFile(soulPath, DEFAULT_SOUL),
    initFile(userPath, DEFAULT_USER),
    initFile(memoryPath, DEFAULT_MEMORY)
  ]);

  return { soulPath, userPath, memoryPath };
}

export async function loadLayeredMemory(memoryDir?: string): Promise<string> {
  const paths = await ensureMemoryFiles(memoryDir);

  const [soul, user, memory] = await Promise.all([
    fs.readFile(paths.soulPath, 'utf-8').catch(() => DEFAULT_SOUL),
    fs.readFile(paths.userPath, 'utf-8').catch(() => DEFAULT_USER),
    fs.readFile(paths.memoryPath, 'utf-8').catch(() => DEFAULT_MEMORY)
  ]);

  return [
    '# LAYERED MEMORY',
    '## Soul (Identity & Principles)',
    soul.trim(),
    '## User Context & Preferences',
    user.trim(),
    '## Long-Term Memory & Project Facts',
    memory.trim()
  ].join('\n\n');
}
