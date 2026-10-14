/**
 * Static-asset recovery tests.
 *
 * A bun-compiled `superiu-server` cannot serve its SPA out of `$bunfs`, so the
 * daemon extracts the embedded assets to a real directory and passes it as
 * `publicDir`. That directory is process-external state and can be swept off
 * disk while the daemon runs (a VPS `/tmp` cleaner, an operator `rm -rf`), after
 * which every static request 404s for the rest of the process's life.
 *
 * `ensurePublicDir` is the recovery hook: one re-materialization attempt per
 * miss. These tests drive a real HTTP server so the behaviour is proven at the
 * boundary the browser actually sees, not at a mocked seam.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { startServer, type ServerHandle } from '../src/server.js';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function get(url: string, requestPath: string, accept?: string): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
  const req = http.get(`${url}${requestPath}`, accept ? { headers: { accept } } : {}, (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  });
  req.on('error', reject);
  return promise;
}

const SHELL = '<!doctype html><html><body>shell</body></html>';
const SCRIPT = 'window.__shell = true;\n';

function writeShell(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), SHELL);
  fs.writeFileSync(path.join(dir, 'app.js'), SCRIPT);
}

describe('static asset recovery', () => {
  it('re-materializes the asset directory when it disappears under a running server', async () => {
    const workspace = tempDir('superiu-recover-ws-');
    const assets = tempDir('superiu-recover-assets-');
    writeShell(assets);

    let ensureCalls = 0;
    const server = await startServer({
      port: 0,
      quiet: true,
      workspaceDir: workspace,
      publicDir: assets,
      ensurePublicDir: () => {
        ensureCalls += 1;
        writeShell(assets);
        return assets;
      }
    });
    servers.push(server);

    // Served from disk, and the recovery hook is not consulted for a hit.
    expect((await get(server.url, '/')).status).toBe(200);
    const first = await get(server.url, '/app.js');
    expect(first.status).toBe(200);
    expect(first.body).toBe(SCRIPT);
    expect(ensureCalls).toBe(0);

    // Sweep the directory the way a `/tmp` cleaner would.
    fs.rmSync(assets, { recursive: true, force: true });

    const recovered = await get(server.url, '/app.js');
    expect(recovered.status).toBe(200);
    expect(recovered.body).toBe(SCRIPT);
    expect(ensureCalls).toBe(1);

    // The shell comes back too, and later requests reuse the refreshed path.
    const shell = await get(server.url, '/', 'text/html');
    expect(shell.status).toBe(200);
    expect(shell.body).toBe(SHELL);
    expect(ensureCalls).toBe(1);
  });

  it('still 404s a missing asset when no recovery hook is provided', async () => {
    const workspace = tempDir('superiu-recover-ws-');
    const assets = tempDir('superiu-recover-assets-');
    writeShell(assets);

    const server = await startServer({ port: 0, quiet: true, workspaceDir: workspace, publicDir: assets });
    servers.push(server);

    const missing = await get(server.url, '/missing.png');
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: 'Not found: /missing.png' });

    // The SPA fallback is unchanged for navigations.
    const navigation = await get(server.url, '/some/route', 'text/html');
    expect(navigation.status).toBe(200);
    expect(navigation.body).toBe(SHELL);
  });
});
