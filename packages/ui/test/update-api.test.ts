import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startServer,
  type ServerHandle,
  writePendingResumeMarker,
  checkAndConsumePendingResume
} from '../src/server.js';

describe('Server /api/update endpoints', () => {
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('GET /api/update returns default when no hooks configured', async () => {
    handle = await startServer({
      port: 0,
      host: '127.0.0.1',
      version: '0.2.29',
      quiet: true,
      webAuth: false
    });

    const res = await fetch(`${handle.url}/api/update`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.current).toBe('0.2.29');
    expect(body.hasUpdate).toBe(false);
    expect(body.canUpdate).toBe(false);
  });

  it('GET /api/update calls onCheckUpdate hook', async () => {
    handle = await startServer({
      port: 0,
      host: '127.0.0.1',
      version: '0.2.29',
      quiet: true,
      webAuth: false
    });

    handle.setUpdateHooks({
      onCheckUpdate: async () => ({
        current: '0.2.29',
        latest: '0.2.30',
        hasUpdate: true,
        canUpdate: true
      })
    });

    const res = await fetch(`${handle.url}/api/update`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.current).toBe('0.2.29');
    expect(body.latest).toBe('0.2.30');
    expect(body.hasUpdate).toBe(true);
    expect(body.canUpdate).toBe(true);
  });

  it('POST /api/update executes onApplyUpdate when idle', async () => {
    let applied = false;
    handle = await startServer({
      port: 0,
      host: '127.0.0.1',
      version: '0.2.29',
      quiet: true,
      webAuth: false
    });

    handle.setUpdateHooks({
      onApplyUpdate: async () => {
        applied = true;
        return { updated: true, current: '0.2.29' };
      }
    });

    const res = await fetch(`${handle.url}/api/update`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.status).toBe('applying');

    // Wait a brief tick for async apply
    await new Promise((r) => setTimeout(r, 120));
    expect(applied).toBe(true);
  });

  it('POST /api/update rejects when no onApplyUpdate hook configured', async () => {
    handle = await startServer({
      port: 0,
      host: '127.0.0.1',
      version: '0.2.29',
      quiet: true,
      webAuth: false
    });

    const res = await fetch(`${handle.url}/api/update`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('writePendingResumeMarker and checkAndConsumePendingResume manage resume marker atomically', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-resume-test-'));
    try {
      expect(checkAndConsumePendingResume(tmpDir)).toBeNull();

      writePendingResumeMarker(tmpDir, {
        sessionId: 'test-session-123',
        leafId: 'test-leaf-456',
        timestamp: 1234567890,
        reason: 'server_update'
      });

      const marker = checkAndConsumePendingResume(tmpDir);
      expect(marker).not.toBeNull();
      expect(marker?.sessionId).toBe('test-session-123');
      expect(marker?.leafId).toBe('test-leaf-456');
      expect(marker?.reason).toBe('server_update');

      // Once consumed, the marker file is removed atomically
      expect(checkAndConsumePendingResume(tmpDir)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
