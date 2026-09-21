import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { SpilloverResult } from './types.js';

export async function ensureSpilloverDir(spilloverDir?: string): Promise<string> {
  const targetDir = spilloverDir || path.join(os.homedir(), '.myagent', 'spillover');
  try {
    await fs.mkdir(targetDir, { recursive: true });
    return targetDir;
  } catch (err) {
    // Fallback to local workspace .myagent/spillover if homedir cannot be written
    const fallbackDir = path.resolve('.myagent', 'spillover');
    await fs.mkdir(fallbackDir, { recursive: true });
    return fallbackDir;
  }
}

export async function handleSpillover(
  output: string,
  spilloverDir?: string,
  maxChars = 2000
): Promise<SpilloverResult> {
  if (output.length <= maxChars) {
    return {
      content: output,
      spilled: false
    };
  }

  const dir = await ensureSpilloverDir(spilloverDir);
  const fileId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const filePath = path.join(dir, `spillover-${fileId}.log`);

  await fs.writeFile(filePath, output, 'utf-8');

  const previewSlice = Math.min(800, Math.floor(maxChars * 0.4));
  const head = output.slice(0, previewSlice);
  const tail = output.slice(-previewSlice);

  const truncatedMessage = [
    `[OUTPUT TRUNCATED: Length ${output.length} chars exceeds limit (${maxChars} chars). Full log saved to: ${filePath}]`,
    `--- Head Preview (first ${previewSlice} chars) ---`,
    head,
    `--- Tail Preview (last ${previewSlice} chars) ---`,
    tail,
    `[Tip: Use read_file tool with line/offset params to inspect specific sections]`
  ].join('\n');

  return {
    content: truncatedMessage,
    spilled: true,
    filePath
  };
}
