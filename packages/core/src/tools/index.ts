import { createBashTool, type BashToolOptions } from './bash.js';
import { createReadFileTool, createWriteFileTool, type FsToolOptions } from './fs.js';

export * from './bash.js';
export * from './fs.js';

export interface ToolCollectionOptions extends BashToolOptions, FsToolOptions {}

export function createTools(options: ToolCollectionOptions = {}) {
  return {
    bash: createBashTool(options),
    read_file: createReadFileTool(options),
    write_file: createWriteFileTool(options)
  };
}
