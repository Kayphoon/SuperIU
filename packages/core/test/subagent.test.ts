import { describe, it, expect, vi } from 'vitest';
import {
  BUILTIN_SUBAGENTS,
  SubagentRegistry,
  SubagentRunner,
  createSubagentTool,
  type SubagentDefinition,
  type SubagentRunResult
} from '../src/subagent/index.js';
import type { StepModelCaller, StepExecutionResult } from '../src/loop/types.js';
import type { ToolDefinition } from '../src/loop/engine.js';

const BUILTIN_ROLES = ['explorer', 'fixer', 'designer', 'librarian', 'oracle'];

/** A one-shot step caller: returns each queued result in order. */
function scriptedStepCaller(results: StepExecutionResult[]): StepModelCaller & { calls: number } {
  let index = 0;
  const caller = {
    calls: 0,
    async callStep() {
      caller.calls++;
      const result = results[index] ?? results[results.length - 1];
      index++;
      return result;
    }
  };
  return caller;
}

function textResult(text: string): StepExecutionResult {
  return { text, toolCalls: [] };
}

const toolExecutor = () => ({
  executeTool: vi.fn(async (toolCall: { id: string; name: string }) => ({
    toolCallId: toolCall.id,
    name: toolCall.name,
    result: 'tool output',
    isError: false
  }))
});

const dummyTool = (description: string): ToolDefinition => ({
  description,
  parameters: {},
  execute: async () => 'ok'
});

describe('SubagentRegistry', () => {
  it('ships the five built-in roles', () => {
    const registry = new SubagentRegistry();
    expect(BUILTIN_SUBAGENTS).toHaveLength(5);
    expect(registry.list().map((d) => d.role).sort()).toEqual([...BUILTIN_ROLES].sort());
    for (const role of BUILTIN_ROLES) {
      expect(registry.has(role)).toBe(true);
    }
  });

  it('resolves roles case-insensitively', () => {
    const registry = new SubagentRegistry();
    expect(registry.get('EXPLORER')).toBeDefined();
    expect(registry.get('Fixer')?.role).toBe('fixer');
  });

  it('registers a custom persona without disturbing built-ins', () => {
    const registry = new SubagentRegistry();
    const custom: SubagentDefinition = {
      role: 'auditor',
      name: 'Auditor',
      description: 'Security review',
      systemPrompt: 'You audit security.'
    };
    registry.register(custom);

    expect(registry.has('auditor')).toBe(true);
    expect(registry.require('auditor').systemPrompt).toBe('You audit security.');
    // Built-ins are untouched.
    expect(registry.list()).toHaveLength(6);
  });

  it('overwrites a built-in when re-registered', () => {
    const registry = new SubagentRegistry();
    registry.register({ ...BUILTIN_SUBAGENTS[0], systemPrompt: 'replaced' });
    expect(registry.get('explorer')?.systemPrompt).toBe('replaced');
    expect(registry.list()).toHaveLength(5);
  });

  it('unregisters a persona and reports whether it existed', () => {
    const registry = new SubagentRegistry();
    expect(registry.unregister('oracle')).toBe(true);
    expect(registry.has('oracle')).toBe(false);
    expect(registry.unregister('oracle')).toBe(false);
  });

  it('require throws for an unknown role and lists alternatives', () => {
    const registry = new SubagentRegistry();
    expect(() => registry.require('nobody')).toThrowError(/Unknown subagent role 'nobody'/);
    expect(() => registry.require('nobody')).toThrowError(/explorer/);
  });

  it('returns defensive copies so callers cannot mutate stored definitions', () => {
    const registry = new SubagentRegistry();
    const first = registry.get('fixer')!;
    first.description = 'mutated';
    expect(registry.get('fixer')!.description).not.toBe('mutated');
  });

  it('rejects a definition with no role', () => {
    const registry = new SubagentRegistry([]);
    expect(() => registry.register({ ...BUILTIN_SUBAGENTS[0], role: '' })).toThrowError(
      /must declare a role/
    );
  });

  it('starts empty when constructed with an explicit empty list', () => {
    const registry = new SubagentRegistry([]);
    expect(registry.list()).toEqual([]);
  });
});

describe('SubagentRunner', () => {
  it('returns isolated context: parent messages are never referenced', async () => {
    const stepCaller = scriptedStepCaller([textResult('child answer')]);
    const capturedSystems: string[] = [];
    const spyingCaller: StepModelCaller = {
      async callStep(params) {
        capturedSystems.push(params.system);
        // Every call gets a fresh message list of exactly the seed prompt.
        expect(params.messages).toHaveLength(1);
        return stepCaller.callStep(params);
      }
    };

    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller: spyingCaller,
      toolExecutor: toolExecutor()
    });

    const result = await runner.run({ agent: 'explorer', prompt: 'find the thing' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('child answer');
    expect(result.stepsCount).toBe(1);
    expect(capturedSystems).toHaveLength(1);
    // The persona's own system prompt is present.
    expect(capturedSystems[0]).toContain('Explorer');
  });

  it('injects caller-provided structured context into the system prompt', async () => {
    let seenSystem = '';
    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller: {
        async callStep(params) {
          seenSystem = params.system;
          return textResult('done');
        }
      },
      toolExecutor: toolExecutor()
    });

    await runner.run({
      agent: 'fixer',
      prompt: 'x',
      context: { file: 'a.ts', line: 42 }
    });

    expect(seenSystem).toContain('<context>');
    expect(seenSystem).toContain('"file": "a.ts"');
    expect(seenSystem).toContain('"line": 42');
  });

  it('prefixes the base system prompt ahead of the persona prompt', async () => {
    let seenSystem = '';
    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller: {
        async callStep(params) {
          seenSystem = params.system;
          return textResult('done');
        }
      },
      toolExecutor: toolExecutor(),
      baseSystemPrompt: 'SHARED DIRECTIVES'
    });

    await runner.run({ agent: 'oracle', prompt: 'x' });

    expect(seenSystem.indexOf('SHARED DIRECTIVES')).toBeLessThan(
      seenSystem.indexOf('Oracle')
    );
  });

  it('filters tools via the persona allowlist', () => {
    const tools: Record<string, ToolDefinition> = {
      read_file: dummyTool('read'),
      glob: dummyTool('glob'),
      grep: dummyTool('grep'),
      bash: dummyTool('bash'),
      write_file: dummyTool('write')
    };

    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller: scriptedStepCaller([textResult('ok')]),
      toolExecutor: toolExecutor(),
      tools
    });

    const explorer = new SubagentRegistry().require('explorer');
    // Explorer declares ['read_file', 'glob', 'grep'].
    expect(Object.keys(runner.toolsFor(explorer)).sort()).toEqual([
      'glob',
      'grep',
      'read_file'
    ]);
  });

  it('exposes every tool when a persona declares no allowlist', () => {
    const tools: Record<string, ToolDefinition> = {
      a: dummyTool('a'),
      b: dummyTool('b')
    };
    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller: scriptedStepCaller([textResult('ok')]),
      toolExecutor: toolExecutor(),
      tools
    });

    // Fixer has no allowedTools.
    const fixer = new SubagentRegistry().require('fixer');
    expect(Object.keys(runner.toolsFor(fixer)).sort()).toEqual(['a', 'b']);
  });

  it('passes only the filtered tools to the step caller', async () => {
    let seenTools: Record<string, unknown> | undefined;
    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller: {
        async callStep(params) {
          seenTools = params.tools;
          return textResult('ok');
        }
      },
      toolExecutor: toolExecutor(),
      tools: {
        read_file: dummyTool('read'),
        bash: dummyTool('bash')
      }
    });

    await runner.run({ agent: 'explorer', prompt: 'x' });
    expect(Object.keys(seenTools ?? {})).toEqual(['read_file']);
  });

  it('drives a tool-calling step and returns the synchronous final text', async () => {
    const executor = toolExecutor();
    const stepCaller = scriptedStepCaller([
      {
        text: 'let me look',
        toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.ts' } }]
      },
      { text: 'final synthesized answer', toolCalls: [] }
    ]);

    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller,
      toolExecutor: executor,
      tools: { read_file: dummyTool('read') }
    });

    const result = await runner.run({ agent: 'explorer', prompt: 'read a.ts' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('final synthesized answer');
    expect(result.toolCallsCount).toBe(1);
    expect(result.stepsCount).toBe(2);
    expect(executor.executeTool).toHaveBeenCalledOnce();
    expect(executor.executeTool.mock.calls[0][0]).toMatchObject({
      id: 'call-1',
      name: 'read_file'
    });
  });

  it('feeds tool results back as child-local history', async () => {
    const messageLists: unknown[][] = [];
    const stepCaller: StepModelCaller = {
      async callStep(params) {
        messageLists.push([...params.messages]);
        if (messageLists.length === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'read_file', args: {} }]
          };
        }
        return { text: 'done', toolCalls: [] };
      }
    };

    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller,
      toolExecutor: toolExecutor(),
      tools: { read_file: dummyTool('read') }
    });

    await runner.run({ agent: 'explorer', prompt: 'go' });

    // Second call sees seed + assistant + tool messages (3), all child-local.
    expect(messageLists[0]).toHaveLength(1);
    expect(messageLists[1]).toHaveLength(3);
    expect((messageLists[1][1] as { role: string }).role).toBe('assistant');
    expect((messageLists[1][2] as { role: string }).role).toBe('tool');
  });

  it('returns a failure result for an unknown role without calling the model', async () => {
    const stepCaller = scriptedStepCaller([textResult('never')]);
    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller,
      toolExecutor: toolExecutor()
    });

    const result = await runner.run({ agent: 'ghost', prompt: 'x' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown subagent role 'ghost'/);
    expect(stepCaller.calls).toBe(0);
  });

  it('respects a persona step limit and synthesizes a limit message', async () => {
    const registry = new SubagentRegistry([]);
    registry.register({
      role: 'limited',
      name: 'Limited',
      description: 'loops forever',
      systemPrompt: 'loop',
      maxSteps: 2
    });

    let calls = 0;
    const runner = new SubagentRunner({
      registry,
      stepCaller: {
        async callStep() {
          calls++;
          return {
            text: 'still going',
            toolCalls: [{ id: `c${calls}`, name: 'read_file', args: {} }]
          };
        }
      },
      toolExecutor: toolExecutor(),
      tools: { read_file: dummyTool('read') }
    });

    const result = await runner.run({ agent: 'limited', prompt: 'go' });

    expect(calls).toBe(2);
    expect(result.stepsCount).toBe(2);
    expect(result.result).toBe('still going');
  });

  it('uses the default step budget when a persona sets none', async () => {
    const registry = new SubagentRegistry([]);
    registry.register({
      role: 'unbounded',
      name: 'Unbounded',
      description: 'no maxSteps',
      systemPrompt: 'x',
      allowedTools: []
    });

    let calls = 0;
    const runner = new SubagentRunner({
      registry,
      stepCaller: {
        async callStep() {
          calls++;
          return { text: '', toolCalls: [{ id: `c${calls}`, name: 't', args: {} }] };
        }
      },
      toolExecutor: toolExecutor(),
      tools: { t: dummyTool('t') },
      defaultMaxSteps: 3
    });

    const result = await runner.run({ agent: 'unbounded', prompt: 'go' });
    expect(result.stepsCount).toBe(3);
    expect(calls).toBe(3);
  });

  it('converts a thrown error into a failed result', async () => {
    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller: {
        async callStep() {
          throw new Error('provider exploded');
        }
      },
      toolExecutor: toolExecutor()
    });

    const result = await runner.run({ agent: 'explorer', prompt: 'x' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('provider exploded');
    expect(result.result).toContain('[Subagent error]');
  });

  it('selects a per-persona step caller from a factory', async () => {
    const invoked: string[] = [];
    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller: (definition: SubagentDefinition) => {
        invoked.push(definition.role);
        return {
          async callStep() {
            return textResult(`answered by ${definition.role}`);
          }
        };
      },
      toolExecutor: toolExecutor()
    });

    const result = await runner.run({ agent: 'librarian', prompt: 'x' });
    expect(invoked).toEqual(['librarian']);
    expect(result.result).toBe('answered by librarian');
  });
});

describe('createSubagentTool', () => {
  it('advertises registry roles in the description', () => {
    const registry = new SubagentRegistry();
    const toolDef = createSubagentTool({
      registry,
      runner: {} as never
    }) as unknown as { description?: string };

    expect(toolDef.description).toContain('explorer:');
    expect(toolDef.description).toContain('oracle:');
  });

  it('dispatches to the runner and returns the synthesized result', async () => {
    const registry = new SubagentRegistry();
    const run = vi.fn(
      async (): Promise<SubagentRunResult> => ({
        success: true,
        result: 'REPORT: all good',
        toolCallsCount: 1,
        stepsCount: 2
      })
    );
    const toolDef = createSubagentTool({
      registry,
      runner: { run } as never
    }) as unknown as { execute: (input: { agent: string; prompt: string }) => Promise<string> };

    const output = await toolDef.execute({ agent: 'explorer', prompt: 'survey' });

    expect(run).toHaveBeenCalledWith({ agent: 'explorer', prompt: 'survey' });
    expect(output).toBe('REPORT: all good');
  });

  it('surfaces a failure as readable text rather than throwing', async () => {
    const run = vi.fn(
      async (): Promise<SubagentRunResult> => ({
        success: false,
        result: 'nope',
        toolCallsCount: 0,
        stepsCount: 0,
        error: 'device offline'
      })
    );
    const toolDef = createSubagentTool({
      runner: { run } as never
    }) as unknown as { execute: (input: { agent: string; prompt: string }) => Promise<string> };

    const output = await toolDef.execute({ agent: 'fixer', prompt: 'x' });
    expect(output).toBe("Subagent 'fixer' failed: device offline");
  });

  it('runs end-to-end through the real runner', async () => {
    const runner = new SubagentRunner({
      registry: new SubagentRegistry(),
      stepCaller: {
        async callStep() {
          return textResult('end-to-end result');
        }
      },
      toolExecutor: toolExecutor()
    });

    const toolDef = createSubagentTool({ registry: new SubagentRegistry(), runner }) as unknown as {
      execute: (input: { agent: string; prompt: string }) => Promise<string>;
    };

    expect(await toolDef.execute({ agent: 'designer', prompt: 'polish' })).toBe(
      'end-to-end result'
    );
  });
});
