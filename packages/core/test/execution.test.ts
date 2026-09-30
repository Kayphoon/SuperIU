import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LocalExecutionContext,
  RemoteDesktopExecutionContext,
  TargetDeviceOfflineError
} from '../src/execution/index.js';
import type { RpcDelegate } from '../src/execution/remote.js';

const tmpDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('LocalExecutionContext', () => {
  it('reports its location and resolves relative paths against the workspace', async () => {
    const workspaceDir = await makeWorkspace();
    const ctx = new LocalExecutionContext({ workspaceDir });

    expect(ctx.location).toBe('server');
    expect(ctx.workspaceDir).toBe(path.resolve(workspaceDir));
    expect(ctx.resolvePath('a/b.txt')).toBe(path.resolve(workspaceDir, 'a/b.txt'));
    expect(ctx.resolvePath('/abs/path')).toBe('/abs/path');
  });

  it('defaults the workspace to the process cwd', () => {
    const ctx = new LocalExecutionContext();
    expect(ctx.workspaceDir).toBe(process.cwd());
  });

  it('writes and reads a file, creating parent directories', async () => {
    const workspaceDir = await makeWorkspace();
    const ctx = new LocalExecutionContext({ workspaceDir });

    const { bytesWritten } = await ctx.writeFile({
      path: 'nested/dir/note.txt',
      content: 'hello world'
    });

    expect(bytesWritten).toBe(Buffer.byteLength('hello world', 'utf-8'));
    expect(await ctx.readFile({ path: 'nested/dir/note.txt' })).toBe('hello world');
    // The bytes really landed on disk.
    expect(await fs.readFile(path.join(workspaceDir, 'nested/dir/note.txt'), 'utf-8')).toBe(
      'hello world'
    );
  });

  it('reads absolute paths outside the workspace', async () => {
    const workspaceDir = await makeWorkspace();
    const other = await makeWorkspace();
    await fs.writeFile(path.join(other, 'x.txt'), 'outside', 'utf-8');

    const ctx = new LocalExecutionContext({ workspaceDir });
    expect(await ctx.readFile({ path: path.join(other, 'x.txt') })).toBe('outside');
  });

  it('rejects reading a missing file', async () => {
    const workspaceDir = await makeWorkspace();
    const ctx = new LocalExecutionContext({ workspaceDir });
    await expect(ctx.readFile({ path: 'nope.txt' })).rejects.toThrow();
  });

  it('executes a command and captures stdout and exit code', async () => {
    const workspaceDir = await makeWorkspace();
    const ctx = new LocalExecutionContext({ workspaceDir });

    const result = await ctx.executeCommand({ command: 'echo hello-from-shell' });

    expect(result.stdout).toBe('hello-from-shell');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('runs commands in the workspace directory', async () => {
    const workspaceDir = await makeWorkspace();
    await fs.writeFile(path.join(workspaceDir, 'marker.txt'), 'm', 'utf-8');
    const ctx = new LocalExecutionContext({ workspaceDir });

    const result = await ctx.executeCommand({ command: 'ls' });
    expect(result.stdout).toContain('marker.txt');
  });

  it('does not throw on a non-zero exit and captures stderr', async () => {
    const workspaceDir = await makeWorkspace();
    const ctx = new LocalExecutionContext({ workspaceDir });

    const result = await ctx.executeCommand({
      command: 'sh -c "echo oops 1>&2; exit 3"'
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('oops');
  });

  it('honors an AbortSignal', async () => {
    const workspaceDir = await makeWorkspace();
    const ctx = new LocalExecutionContext({ workspaceDir });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await ctx.executeCommand({
      command: 'sleep 5',
      timeoutMs: 10_000,
      signal: controller.signal
    });

    expect(result.isCanceled).toBe(true);
    expect(result.stdout).toBe('');
  });
});

describe('RemoteDesktopExecutionContext', () => {
  function makeDelegate(): RpcDelegate & { calls: Array<{ method: string; params: unknown; deviceId?: string }> } {
    const calls: Array<{ method: string; params: unknown; deviceId?: string }> = [];
    const delegate = (async (method: string, params: unknown, deviceId?: string) => {
      calls.push({ method, params, deviceId });
      switch (method) {
        case 'fs.readFile':
          return { content: 'remote contents' };
        case 'fs.writeFile':
          return { bytesWritten: 7 };
        case 'bash.execute':
          return { stdout: 'remote out', stderr: '', exitCode: 0 };
        default:
          throw new Error(`unexpected method ${method}`);
      }
    }) as unknown as RpcDelegate & { calls: typeof calls };
    delegate.calls = calls;
    return delegate;
  }

  it('reports its location and device id', () => {
    const ctx = new RemoteDesktopExecutionContext({
      deviceId: 'desk-1',
      workspaceDir: '/remote/ws',
      delegate: makeDelegate()
    });

    expect(ctx.location).toBe('desktop');
    expect(ctx.deviceId).toBe('desk-1');
    expect(ctx.workspaceDir).toBe('/remote/ws');
  });

  it('delegates readFile via fs.readFile', async () => {
    const delegate = makeDelegate();
    const ctx = new RemoteDesktopExecutionContext({
      deviceId: 'desk-1',
      workspaceDir: '/remote/ws',
      delegate
    });

    const content = await ctx.readFile({ path: 'a.txt', offset: 1, limit: 10 });

    expect(content).toBe('remote contents');
    expect(delegate.calls[0]).toEqual({
      method: 'fs.readFile',
      params: { path: 'a.txt', offset: 1, limit: 10 },
      deviceId: 'desk-1'
    });
  });

  it('delegates writeFile via fs.writeFile', async () => {
    const delegate = makeDelegate();
    const ctx = new RemoteDesktopExecutionContext({
      deviceId: 'desk-1',
      workspaceDir: '/remote/ws',
      delegate
    });

    const result = await ctx.writeFile({ path: 'b.txt', content: 'payload' });

    expect(result).toEqual({ bytesWritten: 7 });
    expect(delegate.calls[0]).toMatchObject({
      method: 'fs.writeFile',
      params: { path: 'b.txt', content: 'payload' }
    });
  });

  it('delegates executeCommand via bash.execute with the workspace as cwd', async () => {
    const delegate = makeDelegate();
    const ctx = new RemoteDesktopExecutionContext({
      deviceId: 'desk-1',
      workspaceDir: '/remote/ws',
      delegate
    });

    const result = await ctx.executeCommand({ command: 'ls', timeoutMs: 500 });

    expect(result).toEqual({ stdout: 'remote out', stderr: '', exitCode: 0 });
    expect(delegate.calls[0]).toMatchObject({
      method: 'bash.execute',
      params: { command: 'ls', cwd: '/remote/ws', timeoutMs: 500 }
    });
  });

  it('passes an existing TargetDeviceOfflineError through unchanged', async () => {
    const original = new TargetDeviceOfflineError('desk-1', 'disconnected');
    const delegate = (async () => {
      throw original;
    }) as unknown as RpcDelegate;

    const ctx = new RemoteDesktopExecutionContext({
      deviceId: 'desk-1',
      workspaceDir: '/remote/ws',
      delegate
    });

    await expect(ctx.readFile({ path: 'a.txt' })).rejects.toBe(original);
  });

  it('wraps a generic RPC failure as rpc_error', async () => {
    const delegate = (async () => {
      throw new Error('socket closed');
    }) as unknown as RpcDelegate;

    const ctx = new RemoteDesktopExecutionContext({
      deviceId: 'desk-1',
      workspaceDir: '/remote/ws',
      delegate
    });

    const error = await ctx.readFile({ path: 'a.txt' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TargetDeviceOfflineError);
    expect((error as TargetDeviceOfflineError).reason).toBe('rpc_error');
    expect((error as TargetDeviceOfflineError).deviceId).toBe('desk-1');
    expect((error as Error).message).toBe('socket closed');
  });

  it('classifies a timeout message as the timeout reason', async () => {
    const delegate = (async () => {
      throw new Error('RPC call timed out after 30s');
    }) as unknown as RpcDelegate;

    const ctx = new RemoteDesktopExecutionContext({
      workspaceDir: '/remote/ws',
      delegate
    });

    const error = (await ctx.executeCommand({ command: 'x' }).catch((e: unknown) => e)) as TargetDeviceOfflineError;
    expect(error).toBeInstanceOf(TargetDeviceOfflineError);
    expect(error.reason).toBe('timeout');
    expect(error.deviceId).toBeUndefined();
    // A custom transport message is preserved.
    expect(error.message).toBe('RPC call timed out after 30s');
  });
});

describe('TargetDeviceOfflineError', () => {
  it('carries the device id and reason', () => {
    const err = new TargetDeviceOfflineError('desk-9', 'not_connected');
    expect(err.name).toBe('TargetDeviceOfflineError');
    expect(err.deviceId).toBe('desk-9');
    expect(err.reason).toBe('not_connected');
    expect(err.message).toContain('desk-9');
  });

  it('builds a default message without a device id', () => {
    const err = new TargetDeviceOfflineError(undefined, 'timeout');
    expect(err.message).toContain('offline');
  });

  it('accepts a custom message', () => {
    const err = new TargetDeviceOfflineError('d', 'rpc_error', 'custom detail');
    expect(err.message).toBe('custom detail');
  });
});
