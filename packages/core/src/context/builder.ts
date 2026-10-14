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
- User input and task goals are authoritative; do not stop until deliverable is verified.
- When invoking tools (bash, read_file, write_file), always provide an extremely short, punchy 'description' of 3-6 words (under 12 Chinese characters) stating your immediate action (e.g. 'Parse otty docs', '检查 Git 提交历史', '搜索 xkf 关键词', '读取鉴权路由'). Never write full sentences, subordinate clauses, or long explanations.`;

/**
 * Section order is a cache contract, not a cosmetic choice.
 *
 * OpenAI / Anthropic / DeepSeek prompt caching is PREFIX based: a cache hit
 * requires the prompt to be byte-identical from token 0 up to the cached
 * boundary. A single volatile token near the front invalidates the entire cache
 * for every subsequent turn.
 *
 * `<workstation>` omits volatile ISO timestamps (which are recorded in JSONL
 * session files and retrievable on-demand via tools), allowing the entire
 * system prompt to remain byte-identical across conversation turns:
 *
 *   1. Invariant directives, then layered memory files, skills, and the static
 *      workstation block.
 *   2. Optional per-turn custom instructions at the very end.
 *
 * The result is a 100% stable prefix shared across turns.
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
      skillsXml,
      workstationXml
    ];

    // Volatile tail: optional per-turn instructions.
    const volatileSections: string[] = [];

    if (this.customInstructions) {
      volatileSections.push(`# ADDITIONAL INSTRUCTIONS\n${this.customInstructions.trim()}`);
    }

    return [...stableSections, ...volatileSections].filter(Boolean).join('\n\n');
  }
}
