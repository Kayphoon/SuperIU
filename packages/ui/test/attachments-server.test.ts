import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startServer, type ServerHandle } from '../src/server.js';

describe('Attachments HTTP server endpoints', () => {
  let tmpDir: string;
  let serverHandle: ServerHandle;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-ui-att-test-'));
    serverHandle = await startServer({
      port: 0,
      host: '127.0.0.1',
      workspaceDir: tmpDir,
      webAuth: false
    });
  });

  afterEach(async () => {
    await serverHandle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /api/upload saves image and GET /api/attachments/:filename retrieves it', async () => {
    const tinyPngBase64 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const uploadRes = await fetch(`${serverHandle.url}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'pixel.png',
        type: 'image/png',
        data: tinyPngBase64
      })
    });

    expect(uploadRes.status).toBe(200);
    const uploaded = await uploadRes.json();
    expect(uploaded.type).toBe('image');
    expect(uploaded.mimeType).toBe('image/png');
    expect(uploaded.name).toBe('pixel.png');
    expect(typeof uploaded.url).toBe('string');
    expect(uploaded.url.startsWith('/api/attachments/')).toBe(true);

    const filename = uploaded.url.replace('/api/attachments/', '');
    const savedPath = path.join(tmpDir, '.superiu', 'attachments', filename);
    expect(fs.existsSync(savedPath)).toBe(true);

    const getRes = await fetch(`${serverHandle.url}${uploaded.url}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('image/png');
    const bytes = await getRes.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('GET /api/attachments handles non-existent or invalid files', async () => {
    const notFoundRes = await fetch(`${serverHandle.url}/api/attachments/non-existent.png`);
    expect(notFoundRes.status).toBe(404);

    const badRes = await fetch(`${serverHandle.url}/api/attachments/%2e%2e%2foutside.txt`);
    expect([400, 404]).toContain(badRes.status);
  });

  it('POST /api/upload returns 400 when data is missing', async () => {
    const badRes = await fetch(`${serverHandle.url}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'missing-data.png' })
    });
    expect(badRes.status).toBe(400);
  });
});
