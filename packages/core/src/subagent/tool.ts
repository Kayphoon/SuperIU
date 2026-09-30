import { tool } from 'ai';
import { z } from 'zod';
import type { SubagentRegistry } from './registry.js';
import type { SubagentRunner } from './runner.js';
import type { SubagentRole } from './types.js';

export interface SubagentToolOptions {
  /** Runner that executes the child turn. */
  runner: SubagentRunner;
  /**
   * Optional registry. When supplied, its roles are listed in the tool
   * description so the parent model knows which specialists are available.
   */
  registry?: SubagentRegistry;
  /** Optional override for the tool description body. */
  description?: string;
}

const ROLE_HINT = "'explorer', 'fixer', 'designer', 'librarian', 'oracle'";

function baseDescription(options: SubagentToolOptions): string {
  const available = options.registry
    ? options.registry
        .list()
        .map((d) => `- ${d.role}: ${d.description}`)
        .join('\n')
    : undefined;

  const header =
    'Dispatch a specialized subagent to handle a bounded task and return its ' +
    'synthesized result. The subagent runs in an isolated context with its own ' +
    'history and tools, so its work never pollutes the main conversation.';

  const guidance =
    'Use this to offload focused work: reconnaissance, a bounded implementation, ' +
    'UI work, external research, or a hard architecture/debugging question. Give ' +
    'a specific, self-contained prompt — the subagent does not see this ' +
    'conversation.';

  return [
    header,
    available ? `\nAvailable specialists:\n${available}` : '',
    `\nGuidance: ${guidance}`
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Builds the AI SDK-compatible `subagent` tool.
 *
 * The tool is intentionally thin: schema + dispatch. All isolation and child
 * loop semantics live in {@link SubagentRunner}.
 */
export function createSubagentTool(options: SubagentToolOptions) {
  return tool({
    description: options.description ?? baseDescription(options),
    parameters: z.object({
      agent: z
        .string()
        .describe(`Target specialist agent role: ${ROLE_HINT}`),
      prompt: z
        .string()
        .describe('The specific, bounded task or question for the subagent to perform')
    }),
    execute: async ({ agent, prompt }) => {
      const result = await options.runner.run({
        agent: agent as SubagentRole,
        prompt
      });

      if (!result.success) {
        return `Subagent '${agent}' failed: ${result.error ?? result.result}`;
      }

      return result.result;
    }
  });
}
