/**
 * `POST /api/settings` runtime-save tests: a real ephemeral server with the
 * settings file pinned into a temp workspace, driven over HTTP.
 *
 * The behavior under test is the "Settings Strata" rule: a settings save is
 * accepted at ANY time. When the runner is idle the patch is applied and the
 * runner rebuilt immediately; when a turn is in flight the save is still
 * accepted (never 409), the file is written, and the rebuild is DEFERRED and
 * reported as `pendingRebuild: true`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '@agent/core';
import { startServer, type ServerHandle } from '../src/server.js';

describe('Settings API runtime saves', () => {
  let handle: ServerHandle | undefined;
  let workspace: string;
  let settingsPath: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-settings-runtime-'));
    settingsPath = path.join(workspace, '.superiu', 'ui-settings.json');
  });

  afterEach(async () => {
    if (handle) {
      const closing = handle;
      handle = undefined;
      await closing.close();
    }
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function boot(): Promise<ServerHandle> {
    handle = await startServer({
      port: 0,
      host: '127.0.0.1',
      workspaceDir: workspace,
      quiet: true,
      webAuth: false,
      gatewayPath: null,
      mcpConfigPath: null
    });
    return handle;
  }

  async function api(
    route: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${handle!.url}${route}`, {
      method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      headers: options.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    return { status: response.status, body: await response.json() };
  }

  function readSettingsFile(): any {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  }

  it('applies a settings patch and restarts the runner while idle', async () => {
    await boot();

    const { status, body } = await api('/api/settings', {
      body: { modelName: 'gpt-5.6-terra', reviewModelName: 'idle-review-model', autoReview: false }
    });

    expect(status).toBe(200);
    expect(body.restarted).toBe(true);
    expect(body.pendingRebuild).toBe(false);
    expect(body.autoReview).toBe(false);

    const onDisk = readSettingsFile();
    expect(onDisk.modelName).toBe('gpt-5.6-terra');
    expect(onDisk.reviewModelName).toBe('idle-review-model');
    expect(onDisk.autoReview).toBe(false);
  });

  it('accepts a settings save while the runner is busy and defers the rebuild', async () => {
    await boot();

    // Park the live runner in a non-idle state: the turn's `run()` never
    // resolves until `release()` is called, exactly like a slow model call.
    let release!: () => void;
    const runSpy = vi.spyOn(AgentRunner.prototype, 'run').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('ok');
        })
    );

    // Start a turn. It parks; the SSE stream is drained only at the end.
    const chat = await fetch(`${handle!.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hold the turn open' })
    });
    expect(chat.status).toBe(200);

    await vi.waitFor(() => expect(runSpy.mock.instances.length).toBeGreaterThan(0));
    const liveRunner = runSpy.mock.instances[0] as AgentRunner;
    liveRunner.status = 'tool_calling';

    // A full patch arrives mid-turn. It must NOT be refused with 409.
    const { status, body } = await api('/api/settings', {
      body: {
        modelName: 'gpt-4o',
        reviewModelName: 'test-model',
        autoReview: false,
        reasoningEffort: ''
      }
    });

    expect(status).toBe(200);
    expect(status).not.toBe(409);
    expect(body.restarted).toBe(false);
    expect(body.pendingRebuild).toBe(true);
    expect(body.autoReview).toBe(false);

    // The file is written immediately even though the rebuild is deferred.
    const onDisk = readSettingsFile();
    expect(onDisk.autoReview).toBe(false);
    expect(onDisk.reviewModelName).toBe('test-model');

    // Let the parked turn finish so the deferred rebuild drains inside
    // `handleChat`'s finally rather than leaking into the next test.
    liveRunner.status = 'idle';
    release();
    await chat.text();
    await vi.waitFor(() => expect(handle!.isIdle()).toBe(true));
  });
});
