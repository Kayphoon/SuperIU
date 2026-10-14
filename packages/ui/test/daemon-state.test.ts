/**
 * Daemon state-file ownership tests.
 *
 * `<workspace>/.superiu/server.json` is one path per workspace, so two daemons
 * pointed at the same workspace share it. A daemon must therefore never delete
 * a state file that names a different process: doing so orphans the live
 * daemon, which then reports `{"running":false}` and cannot be found by
 * `update` to be restarted after a binary swap.
 *
 * Observed in the field: a second daemon started against a live workspace was
 * killed, its shutdown removed the winner's state file, and the subsequent
 * `superiu-server update` swapped the binary but reported `restarted:false`,
 * leaving the old process serving from the replaced inode.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeStateIfOwned } from '../src/daemon.js';

const tempDirs: string[] = [];
function tempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-state-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.superiu'), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function statePath(workspace: string): string {
  return path.join(workspace, '.superiu', 'server.json');
}

describe('daemon state file ownership', () => {
  it("keeps another process's state file", () => {
    const workspace = tempWorkspace();
    fs.writeFileSync(statePath(workspace), JSON.stringify({ pid: 999999 }));

    removeStateIfOwned(workspace, process.pid);

    expect(fs.existsSync(statePath(workspace))).toBe(true);
    expect(JSON.parse(fs.readFileSync(statePath(workspace), 'utf-8')).pid).toBe(999999);
  });

  it('removes its own state file', () => {
    const workspace = tempWorkspace();
    fs.writeFileSync(statePath(workspace), JSON.stringify({ pid: process.pid }));

    removeStateIfOwned(workspace, process.pid);

    expect(fs.existsSync(statePath(workspace))).toBe(false);
  });

  it('removes a corrupt state file rather than leaving it behind', () => {
    const workspace = tempWorkspace();
    fs.writeFileSync(statePath(workspace), 'not json');

    removeStateIfOwned(workspace, process.pid);

    expect(fs.existsSync(statePath(workspace))).toBe(false);
  });

  it('is a no-op when no state file exists', () => {
    const workspace = tempWorkspace();

    expect(() => removeStateIfOwned(workspace, process.pid)).not.toThrow();
    expect(fs.existsSync(statePath(workspace))).toBe(false);
  });
});
