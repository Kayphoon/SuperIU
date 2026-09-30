/**
 * Smoke test: MCP + Subagent wiring inside `@agent/core`'s AgentRunner.
 *
 * Run with `bun scripts/smoke-subagent-mcp.ts` after building core
 * (`pnpm --filter @agent/core run build`). Uses only in-memory / mock
 * facilities — no network and no external MCP server processes.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentRunner,
  McpManager,
  SubagentRegistry,
  BUILTIN_SUBAGENTS,
  MockStepAdapter,
  type SubagentDefinition
} from '../packages/core/dist/index.js';

let failures = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function test(name: string, fn: () => Promise<void> | void) {
  process.stdout.write(`▶ ${name}...\n`);
  try {
    await fn();
    process.stdout.write(`  ✔ ${name}\n`);
  } catch (err: unknown) {
    failures++;
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`  ✖ ${name}: ${message}\n`);
  }
}

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'superiu-subagent-mcp-'));
  const workspace = path.join(sandbox, 'workspace');
  await fs.mkdir(workspace, { recursive: true });

  // -------------------------------------------------------------------------
  // Test 1: SubagentRegistry lists the five built-in specialists.
  // -------------------------------------------------------------------------
  await test('SubagentRegistry lists the 5 built-in subagents', () => {
    const registry = new SubagentRegistry();
    const roles = registry
      .list()
      .map((d: SubagentDefinition) => d.role)
      .sort();

    const expected = ['designer', 'explorer', 'fixer', 'librarian', 'oracle'];
    assert(
      JSON.stringify(roles) === JSON.stringify(expected),
      `expected roles ${JSON.stringify(expected)}, got ${JSON.stringify(roles)}`
    );
    assert(BUILTIN_SUBAGENTS.length === 5, `BUILTIN_SUBAGENTS has ${BUILTIN_SUBAGENTS.length}, expected 5`);

    for (const role of expected) {
      assert(registry.has(role), `registry is missing '${role}'`);
      assert(registry.get(role)?.systemPrompt, `'${role}' has no system prompt`);
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: McpManager handles configs / mock stdio server without errors.
  // -------------------------------------------------------------------------
  await test('McpManager registers configs and degrades gracefully', async () => {
    const errors: Array<{ server: string; error: Error }> = [];
    const manager = new McpManager({ configPath: null, onError: (server, error) => errors.push({ server, error }) });

    // Programmatic registration of a mock stdio server.
    manager.addServer({
      name: 'mock-stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: {}
    });
    assert(manager.listServerNames().includes('mock-stdio'), 'server not registered');

    // A bogus command must fail without throwing, reporting via onError.
    manager.addServer({ name: 'unreachable', command: 'definitely-not-a-real-command-xyz' });
    const client = await manager.connect('unreachable');
    assert(client === null, 'connecting a bogus server should return null');
    assert(errors.some((e) => e.server === 'unreachable'), 'onError was not invoked for failed connect');
    assert(!manager.isConnected('unreachable'), 'failed server should not be marked connected');

    // A malformed config file is reported, not thrown.
    const badConfig = path.join(sandbox, 'bad-mcp.json');
    await fs.writeFile(badConfig, '{ not valid json', 'utf-8');
    const added = await manager.loadConfigFile(badConfig);
    assert(added.length === 0, 'malformed config should load zero servers');
    assert(errors.some((e) => e.server.startsWith('config:')), 'malformed config was not reported');

    // A missing config file is empty success, not an error.
    const missing = await manager.loadConfigFile(path.join(sandbox, 'does-not-exist.json'));
    assert(missing.length === 0, 'missing config should load zero servers');

    // As a disabled server, `connect` short-circuits to null.
    await manager.disableServer('mock-stdio');
    assert(!manager.isConnected('mock-stdio'), 'disabled server should be disconnected');

    await manager.closeAll();

    // An injected manager still exposes tools (empty when nothing connected).
    const empty = await manager.asCoreTools();
    assert(typeof empty === 'object', 'asCoreTools should return an object');
  });

  // -------------------------------------------------------------------------
  // Test 3: AgentRunner initializes with the `subagent` tool present.
  // -------------------------------------------------------------------------
  await test('AgentRunner exposes the subagent tool and MCP manager', () => {
    const runner = new AgentRunner({
      workspaceDir: workspace,
      spilloverDir: path.join(sandbox, 'spill'),
      stepCaller: new MockStepAdapter([{ text: 'ok' }]),
    });

    assert(runner.mcpManager instanceof McpManager, 'mcpManager not initialized');
    assert(runner.getMcpManager() === runner.mcpManager, 'getMcpManager returned a different instance');
    assert(runner.getSubagentRegistry() instanceof SubagentRegistry, 'registry not initialized');
    assert(runner.getSubagentRegistry().has('explorer'), 'default registry missing built-ins');
    assert(runner.subagentRunner, 'subagentRunner not initialized');

    const subagentTool = runner.engine.tools['subagent'];
    assert(subagentTool, 'subagent tool missing from engine tools');
    assert(
      typeof (subagentTool as { execute?: unknown }).execute === 'function',
      'subagent tool has no execute handler'
    );

    // The core tools are still present alongside it.
    assert(runner.engine.tools['bash'] || Object.keys(runner.engine.tools).length > 1, 'core tools missing');

    runner.close();
  });

  await test('enableSubagents: false omits the subagent tool', () => {
    const runner = new AgentRunner({
      workspaceDir: workspace,
      spilloverDir: path.join(sandbox, 'spill-2'),
      stepCaller: new MockStepAdapter([{ text: 'ok' }]),
      enableSubagents: false
    });

    assert(!runner.engine.tools['subagent'], 'subagent tool should be absent when disabled');
    assert(runner.subagentRunner === undefined, 'subagentRunner should be undefined when disabled');
    // Registry is still available for inspection.
    assert(runner.getSubagentRegistry() instanceof SubagentRegistry, 'registry should still exist');

    runner.close();
  });

  await test('initMcp with a null config path is a safe no-op', async () => {
    const runner = new AgentRunner({
      workspaceDir: workspace,
      spilloverDir: path.join(sandbox, 'spill-3'),
      stepCaller: new MockStepAdapter([{ text: 'ok' }]),
      mcpConfigPath: null
    });

    await runner.initMcp();
    assert(runner.mcpManager.listServerNames().length === 0, 'no servers should be configured');
    assert(runner.engine.tools['subagent'], 'subagent tool should survive initMcp');

    const tools = await runner.getTools();
    assert(tools['subagent'], 'getTools() should include the subagent tool');

    runner.close();
  });

  await fs.rm(sandbox, { recursive: true, force: true });

  if (failures > 0) {
    process.stdout.write(`\n${failures} test(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write('\nAll subagent/MCP smoke tests passed\n');
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
