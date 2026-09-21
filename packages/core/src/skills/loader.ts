import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSkill } from './types.js';

/** Directory holding one sub-directory per skill, relative to a root. */
const SKILLS_SUBDIR = path.join('.agents', 'skills');
/** File name that marks a directory as a skill. */
const SKILL_FILE = 'SKILL.md';

interface Frontmatter {
  name?: string;
  description?: string;
}

/**
 * Parse the leading `---` YAML block. Deliberately not a full YAML parser: the
 * standard only mandates `name` and `description`, and `description` may be a
 * plain scalar, a quoted scalar, or a block scalar (`|` literal / `>` folded)
 * spanning indented lines.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) {
    return {};
  }

  const lines = match[1].split('\n');
  const result: Frontmatter = {};

  for (let i = 0; i < lines.length; i++) {
    const keyMatch = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!keyMatch) {
      continue;
    }

    const key = keyMatch[1];
    if (key !== 'name' && key !== 'description') {
      continue;
    }

    let value = keyMatch[2].trim();

    // Block scalar: `|` keeps newlines, `>` folds them into spaces.
    const blockMatch = /^([|>])[-+]?[0-9]*$/.exec(value);
    if (blockMatch) {
      const folded = blockMatch[1] === '>';
      const blockLines: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^[ \t]/.test(lines[i + 1]))) {
        i++;
        blockLines.push(lines[i]);
      }
      value = stripIndent(blockLines, folded);
    } else {
      value = unquote(value);
    }

    if (value) {
      result[key] = value;
    }
  }

  return result;
}

/** Remove the common indentation of a block scalar and join its lines. */
function stripIndent(blockLines: string[], folded: boolean): string {
  const indents = blockLines
    .filter((line) => line.trim() !== '')
    .map((line) => /^[ \t]*/.exec(line)![0].length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;

  const trimmed = blockLines
    .map((line) => line.slice(common))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');

  return folded ? trimmed.replace(/\n+/g, ' ') : trimmed;
}

function unquote(value: string): string {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

/**
 * Maximum characters of a skill description rendered into the prompt block.
 * Descriptions in the wild (installed user-global skills) run to many hundreds
 * of characters, and this block is rebuilt on every turn, so it is capped to
 * keep the system prompt bounded. The full text stays available via `readSkill`.
 */
export const SKILL_DESCRIPTION_MAX_CHARS = 400;

/**
 * Collapse a description into one line and bound its length, preferring to cut
 * at a word boundary so the summary stays readable.
 */
function toSingleLine(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SKILL_DESCRIPTION_MAX_CHARS) {
    return collapsed;
  }

  const clipped = collapsed.slice(0, SKILL_DESCRIPTION_MAX_CHARS);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

async function readSkillDirectory(skillsRoot: string): Promise<AgentSkill[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(skillsRoot);
  } catch {
    return [];
  }

  const skills: AgentSkill[] = [];

  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue;
    }

    const filePath = path.join(skillsRoot, entry, SKILL_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue; // Not a skill directory (no SKILL.md).
    }

    const frontmatter = parseFrontmatter(raw);

    skills.push({
      name: frontmatter.name?.trim() || entry,
      description: frontmatter.description?.trim() || '',
      filePath
    });
  }

  return skills;
}

/**
 * Discover skills from the workspace and the user-global root.
 * Workspace skills shadow same-name user skills, so a project can pin a
 * specific version of a shared skill.
 */
export async function discoverSkills(
  workspaceDir?: string,
  userHomeDir?: string
): Promise<AgentSkill[]> {
  const workspaceRoot = path.resolve(workspaceDir || process.cwd());
  const userRoot = path.resolve(userHomeDir || os.homedir());

  const [workspaceSkills, userSkills] = await Promise.all([
    readSkillDirectory(path.join(workspaceRoot, SKILLS_SUBDIR)),
    readSkillDirectory(path.join(userRoot, SKILLS_SUBDIR))
  ]);

  const shadowed = new Set(workspaceSkills.map((skill) => skill.name));

  return [...workspaceSkills, ...userSkills.filter((skill) => !shadowed.has(skill.name))].sort(
    (a, b) => a.name.localeCompare(b.name)
  );
}

/**
 * Render the standard `<skills>` block plus the read-before-acting guidance.
 * The absolute `SKILL.md` path is included on each line so the guidance is
 * directly actionable with `read_file`.
 */
export function formatSkillsXml(skills: AgentSkill[]): string {
  if (skills.length === 0) {
    return '';
  }

  const lines = skills.map((skill) => {
    const summary = toSingleLine(skill.description);
    return summary
      ? `- ${skill.name}: ${summary} (path: ${skill.filePath})`
      : `- ${skill.name} (path: ${skill.filePath})`;
  });

  return [
    '<skills>',
    ...lines,
    '</skills>',
    '',
    'When a task relates to any available skill above, read its detailed instructions using ' +
      '`read_file` at its file path before proceeding.'
  ].join('\n');
}

/** Load the full `SKILL.md` body for one skill by name, or `null` if unknown. */
export async function readSkill(
  name: string,
  workspaceDir?: string,
  userHomeDir?: string
): Promise<string | null> {
  const skills = await discoverSkills(workspaceDir, userHomeDir);
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) {
    return null;
  }

  try {
    return await fs.readFile(skill.filePath, 'utf-8');
  } catch {
    return null;
  }
}
