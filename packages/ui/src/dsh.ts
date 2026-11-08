import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  DshError,
  reserveLoopbackPort,
  resolveDshCli,
  resolveDshNode,
  stopDshProcess,
  type DshErrorCode
} from './dsh_process.js';

export type DshState = 'idle' | 'checking' | 'starting' | 'ready' | 'error';

export interface DshStatus {
  state: DshState;
  managed: boolean;
  url?: string;
  error?: DshErrorCode;
}

export interface DshManagerOptions {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

type ProbeResult =
  | { kind: 'ready' }
  | { kind: 'not_dsh' }
  | { kind: 'auth_required' }
  | { kind: 'unavailable' }
  | { kind: 'untrusted' };

function loopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DshError('invalid_url', 'DSH URL must be an absolute loopback HTTP(S) URL.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '::1'].includes(hostname) && !(net.isIP(hostname) === 4 && hostname.startsWith('127.'))
  ) {
    throw new DshError('invalid_url', 'DSH URL must use loopback HTTP(S).');
  }
  return url;
}

async function probeDsh(url: URL, publicHost: string): Promise<ProbeResult> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = transport.request(url, {
      method: 'GET',
      timeout: 1_500,
      headers: { host: publicHost, accept: 'text/html' }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 32_768) body += chunk.slice(0, 32_768 - body.length);
      });
      res.on('end', () => {
        if (res.statusCode === 200 && body.includes('__ModuleLoader__')) {
          resolve({ kind: 'ready' });
          return;
        }
        if (res.statusCode === 303 && url.searchParams.has('token')) {
          resolve({ kind: 'ready' });
          return;
        }
        if (res.statusCode === 401 && body.includes('dsh web authentication required')) {
          resolve({ kind: 'auth_required' });
          return;
        }
        if (res.statusCode === 403) {
          resolve({ kind: 'untrusted' });
          return;
        }
        resolve({ kind: 'not_dsh' });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ kind: 'unavailable' }));
    req.end();
  });
}

export class DshManager {
  private state: DshState = 'idle';
  private managed = false;
  private error?: DshErrorCode;
  private targetOrigin?: string;
  private publicLaunchPath?: string;
  private child?: ChildProcess;
  private log?: fs.WriteStream;
  private starting?: Promise<DshStatus>;
  private closed = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startupTimeoutMs: number;
  private readonly options: DshManagerOptions;

  constructor(options: DshManagerOptions) {
    this.options = options;
    this.env = { ...process.env, ...options.env };
    this.startupTimeoutMs = options.startupTimeoutMs ?? 90_000;
  }

  getStatus(): DshStatus {
    return {
      state: this.state,
      managed: this.managed,
      ...(this.state === 'ready' && this.publicLaunchPath ? { url: this.publicLaunchPath } : {}),
      ...(this.error ? { error: this.error } : {})
    };
  }

  getTargetOrigin(): string | undefined {
    return this.state === 'ready' ? this.targetOrigin : undefined;
  }

  async connect(publicOrigin: string): Promise<DshStatus> {
    if (this.state === 'ready') return this.getStatus();
    if (this.starting) return this.starting;
    this.starting = this.start(publicOrigin).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(publicOrigin: string): Promise<DshStatus> {
    if (this.closed) {
      this.state = 'error';
      this.error = 'unavailable';
      return this.getStatus();
    }
    this.state = 'checking';
    this.error = undefined;
    try {
      const publicUrl = new URL(publicOrigin);
      const configured = this.env.SUPERIU_DSH_URL?.trim();
      const discoveryPort = this.env.SUPERIU_DSH_PORT?.trim() || '3080';
      const candidate = loopbackUrl(configured || `http://127.0.0.1:${discoveryPort}/`);
      if (candidate.pathname !== '/') {
        throw new DshError('invalid_url', 'DSH launch URL must use the server root.');
      }
      const probe = await probeDsh(candidate, publicUrl.host);
      if (this.closed) {
        this.state = 'idle';
        return this.getStatus();
      }
      if (probe.kind === 'ready') {
        this.targetOrigin = candidate.origin;
        this.publicLaunchPath = `/dsh/${candidate.search}`;
        this.managed = false;
        this.state = 'ready';
        return this.getStatus();
      }
      if (probe.kind === 'auth_required' && configured) {
        throw new DshError('auth_required', 'A running DSH requires its tokenized launch URL.');
      }
      if (probe.kind === 'untrusted') {
        throw new DshError('unavailable', 'The running DSH does not trust this SuperIU host.');
      }
      if (configured) {
        throw new DshError('unavailable', 'The configured DSH URL is not an accessible DSH server.');
      }
      return await this.startManaged(publicUrl);
    } catch (error) {
      this.state = 'error';
      this.error = error instanceof DshError ? error.code : 'start_failed';
      this.managed = false;
      this.targetOrigin = undefined;
      this.publicLaunchPath = undefined;
      await stopDshProcess(this.child);
      this.child = undefined;
      this.log?.end();
      this.log = undefined;
      return this.getStatus();
    }
  }

  private async startManaged(publicUrl: URL): Promise<DshStatus> {
    const [nodePath, cliPath, port] = await Promise.all([
      resolveDshNode(this.env),
      Promise.resolve().then(() => resolveDshCli(this.env)),
      reserveLoopbackPort()
    ]);
    if (this.closed) {
      this.state = 'idle';
      return this.getStatus();
    }
    this.state = 'starting';
    const logPath = path.join(this.options.workspaceDir, '.superiu', 'dsh.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const log = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    this.log = log;
    log.on('error', (error) => {
      if (this.log === log) this.log = undefined;
      console.error(`[dsh] log unavailable: ${error.message}`);
    });
    const args = [
      cliPath,
      '--profile', 'web',
      '--no-open',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--public-url', `${publicUrl.origin}/dsh/`,
      '--trusted-host', publicUrl.host
    ];
    const child = spawn(nodePath, args, {
      cwd: this.options.workspaceDir,
      env: this.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    if (this.closed) {
      await stopDshProcess(child);
      this.child = undefined;
      this.state = 'idle';
      return this.getStatus();
    }
    let output = '';
    let settled = false;
    const readiness = new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => {
        void stopDshProcess(child);
        fail(new DshError('timeout', 'DSH did not become ready before the startup timeout.'));
      }, this.startupTimeoutMs);
      const succeed = (url: URL): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(url);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const onOutput = (chunk: Buffer | string): void => {
        if (log.writable) log.write(chunk);
        output = (output + chunk.toString()).slice(-65_536);
        const match = /dsh web:\s*(https?:\/\/\S+)/.exec(output);
        if (match) succeed(new URL(match[1]));
      };
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);
      child.once('error', (error) => fail(new DshError('start_failed', error.message)));
      child.once('exit', (code, signal) => {
        if (this.log === log) this.log = undefined;
        log.end();
        if (!settled) {
          fail(new DshError('start_failed', `DSH exited before readiness (${code ?? signal ?? 'unknown'}).`));
          return;
        }
        if (this.child === child && !this.closed) {
          this.child = undefined;
          this.state = 'error';
          this.error = 'unavailable';
          this.targetOrigin = undefined;
          this.publicLaunchPath = undefined;
        }
      });
    });
    const readyUrl = await readiness;
    if (this.closed) {
      await stopDshProcess(child);
      if (this.child === child) this.child = undefined;
      this.state = 'idle';
      return this.getStatus();
    }
    if (!readyUrl.searchParams.has('token')) {
      throw new DshError('start_failed', 'DSH readiness URL did not contain a launch token.');
    }
    this.targetOrigin = `http://127.0.0.1:${port}`;
    this.publicLaunchPath = `/dsh/${readyUrl.search}`;
    this.managed = true;
    this.state = 'ready';
    return this.getStatus();
  }

  async close(): Promise<void> {
    this.closed = true;
    await stopDshProcess(this.child);
    this.child = undefined;
    await this.starting?.catch(() => undefined);
    await stopDshProcess(this.child);
    this.child = undefined;
    this.log?.end();
    this.log = undefined;
    this.targetOrigin = undefined;
    this.publicLaunchPath = undefined;
    this.state = 'idle';
  }
}
