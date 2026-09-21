import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { handleSpillover } from '../spillover.js';

export interface FsToolOptions {
  workspaceDir?: string;
  spilloverDir?: string;
}

export function createReadFileTool(options: FsToolOptions = {}) {
  return tool({
    description: 'Read the contents of a file within the workspace, optionally specifying line offset and limit.',
    parameters: z.object({
      path: z.string().describe('Relative or absolute file path to read'),
      offset: z.number().optional().default(1).describe('1-based starting line number (default: 1)'),
      limit: z.number().optional().default(200).describe('Maximum number of lines to read (default: 200)')
    }),
    execute: async ({ path: targetPath, offset, limit }) => {
      const baseDir = options.workspaceDir ? path.resolve(options.workspaceDir) : process.cwd();
      const resolvedPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(baseDir, targetPath);

      try {
        const rawContent = await fs.readFile(resolvedPath, 'utf-8');
        const lines = rawContent.split(/\r?\n/);
        const startLine = Math.max(0, offset - 1);
        const endLine = startLine + Math.max(1, limit);
        const slicedLines = lines.slice(startLine, endLine);

        const indexedContent = slicedLines
          .map((line, idx) => `${startLine + idx + 1}: ${line}`)
          .join('\n');

        const spillResult = await handleSpillover(indexedContent, options.spilloverDir);
        return spillResult.content;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `[Error reading file ${targetPath}: ${message}]`;
      }
    }
  });
}

export function createWriteFileTool(options: FsToolOptions = {}) {
  return tool({
    description: 'Write or overwrite text content to a specified file within the workspace.',
    parameters: z.object({
      path: z.string().describe('Relative or absolute file path to write to'),
      content: z.string().describe('Text content to write to the file')
    }),
    execute: async ({ path: targetPath, content }) => {
      const baseDir = options.workspaceDir ? path.resolve(options.workspaceDir) : process.cwd();
      const resolvedPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(baseDir, targetPath);

      try {
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(resolvedPath, content, 'utf-8');
        const bytes = Buffer.byteLength(content, 'utf-8');
        return `Successfully wrote ${bytes} bytes to ${targetPath}`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `[Error writing file ${targetPath}: ${message}]`;
      }
    }
  });
}
