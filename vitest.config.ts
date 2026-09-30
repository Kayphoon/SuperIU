import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve workspace packages to their TypeScript sources when present, falling
 * back to the built `dist` output otherwise.
 *
 * Tests should not depend on a prior `pnpm build`, but a partial checkout may
 * not have sources for every package, so `dist` is kept as a fallback.
 */
function workspaceAlias(name: string, dirName: string) {
  return {
    find: name,
    replacement: path.join(rootDir, 'packages', dirName, 'src', 'index.ts')
  };
}

export default defineConfig({
  resolve: {
    alias: [
      workspaceAlias('@agent/core', 'core'),
      workspaceAlias('@agent/protocol', 'protocol')
    ]
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
