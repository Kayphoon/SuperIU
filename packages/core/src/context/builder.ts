import * as fs from 'node:fs/promises';
import { ensureMemoryFiles } from '../memory/manager.js';
import { discoverSkills, formatSkillsXml } from '../skills/loader.js';
import { getWorkstationInfo, formatWorkstationXml } from './workstation.js';
import type { WorkstationInfo } from './types.js';

export interface SystemPromptBuilderOptions {
  workspaceDir?: string;
  memoryDir?: string;
  customInstructions?: string;
  workstationInfo?: WorkstationInfo;
}

const DEFAULT_ENGINEERING_DIRECTIVES = `# ENGINEERING PRINCIPLES & DIRECTIVES
- Evidence-first terse engineer: every statement must be fact, decision, or verified risk.
- Correctness first; then maintainability. Refuse unnecessary abstractions.
- Ground all claims in real tool execution results. Never fabricate or assume output.
- When an error occurs, inspect the exact failure output and self-correct with deliberate fixes.
- User input and task goals are authoritative; do not stop until deliverable is verified.`;

/**
 * Section order is a cache contract, not a cosmetic choice.
 *
 * OpenAI / Anthropic / DeepSeek prompt caching is PREFIX based: a cache hit
 * requires the prompt to be byte-identical from token 0 up to the cached
 * boundary. A single volatile token near the front invalidates the entire cache
 * for every subsequent turn.
 *
 * `<workstation>` embeds a per-turn ISO timestamp, so placing it first (as it
 * once was) forced a 100% cache miss on every step of the unbounded loop. The
 * prompt is therefore assembled static-first:
 *
 *   1. Invariant directives, then the layered memory files, then the skills
 *      block — content that only changes when a human edits it.
 *   2. Volatile per-turn context (workstation, custom instructions, posture) at
 *      the very end.
 *
 * The result is a long stable prefix shared by every turn. Do NOT move
 * `<workstation>` or any timestamped block ahead of the static sections.
 */

export class SystemPromptBuilder {
  private workspaceDir: string;
  private memoryDir?: string;
  private customInstructions?: string;

  constructor(options: SystemPromptBuilderOptions = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.memoryDir = options.memoryDir;
    this.customInstructions = options.customInstructions;
  }

  /** Fresh workstation snapshot (OS/arch/node/cwd/git/timestamp) for the current turn. */
  public workstationInfo(): WorkstationInfo {
    return getWorkstationInfo(this.workspaceDir);
  }

  public async build(overrideWorkstation?: WorkstationInfo): Promise<string> {
    const workstation = overrideWorkstation || this.workstationInfo();
    const workstationXml = formatWorkstationXml(workstation);

    const memoryPaths = await ensureMemoryFiles(this.memoryDir);
    const [soul, user, memory, skillsXml] = await Promise.all([
      fs.readFile(memoryPaths.soulPath, 'utf-8').catch(() => ''),
      fs.readFile(memoryPaths.userPath, 'utf-8').catch(() => ''),
      fs.readFile(memoryPaths.memoryPath, 'utf-8').catch(() => ''),
      discoverSkills(this.workspaceDir).then(formatSkillsXml)
    ]);

    // Static, cacheable prefix: identical across turns until a human edits it.
    const stableSections: string[] = [
      DEFAULT_ENGINEERING_DIRECTIVES,
      soul.trim(),
      user.trim(),
      memory.trim(),
      skillsXml
    ];

    // Volatile tail: rebuilt every turn (workstation carries the ISO timestamp).
    const volatileSections: string[] = [workstationXml];

    if (this.customInstructions) {
      volatileSections.push(`# ADDITIONAL INSTRUCTIONS\n${this.customInstructions.trim()}`);
    }

    return [...stableSections, ...volatileSections].filter(Boolean).join('\n\n');
  }
}
