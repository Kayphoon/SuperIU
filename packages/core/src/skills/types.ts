/**
 * Public Agent Skills standard (`.agents/skills/<name>/SKILL.md`).
 *
 * A skill is a directory containing a `SKILL.md` whose YAML frontmatter carries
 * at least `name` and `description`. Only frontmatter is read during discovery;
 * the body is loaded lazily by `readSkill()` so the system prompt stays cheap.
 */
export interface AgentSkill {
  name: string;
  description: string;
  filePath: string;
  content?: string;
}
