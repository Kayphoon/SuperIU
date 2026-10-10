/**
 * Tests for the Electron-free desktop settings module + first-run gating.
 *
 * The module under test deliberately has no Electron import, so these run in a
 * plain `node` environment (no `electron` binary required).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  needsOnboarding,
  readDesktopSettings,
  resolveGatewayConfig,
  settingsFilePath,
  writeDesktopSettings,
  type DesktopSettings,
  type GatewayConfig
} from '../src/settings.js';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** A resolved gateway in the "nothing configured" local shape. */
const localGateway: GatewayConfig = { mode: 'local', workspaceRoot: '/tmp' };

const ONBOARDING_ENV = ['SUPERIU_SKIP_ONBOARDING', 'SUPERIU_FORCE_ONBOARDING'] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ONBOARDING_ENV) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ONBOARDING_ENV) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// needsOnboarding
// ---------------------------------------------------------------------------

describe('needsOnboarding', () => {
  it('is true on a fresh workspace with no settings file', () => {
    expect(needsOnboarding(readDesktopSettings(makeTmpDir()), localGateway)).toBe(true);
  });

  it('is false once onboarding has been completed', () => {
    expect(needsOnboarding({ onboardingCompleted: true }, localGateway)).toBe(false);
  });

  it.each(['local', 'gateway', 'remote', 'custom_url'] as const)(
    'is false for an explicit connectionMode %s',
    (mode) => {
      expect(needsOnboarding({ connectionMode: mode }, localGateway)).toBe(false);
    }
  );

  it('is false when the resolved gateway is not local', () => {
    expect(needsOnboarding({}, { ...localGateway, mode: 'gateway' })).toBe(false);
    expect(needsOnboarding({}, { ...localGateway, mode: 'remote' })).toBe(false);
    expect(needsOnboarding({}, { ...localGateway, mode: 'custom_url' })).toBe(false);
  });

  it('is false under SUPERIU_SKIP_ONBOARDING even when fresh', () => {
    process.env.SUPERIU_SKIP_ONBOARDING = '1';
    expect(needsOnboarding(readDesktopSettings(makeTmpDir()), localGateway)).toBe(false);
  });

  it('is true under SUPERIU_FORCE_ONBOARDING even when already completed', () => {
    process.env.SUPERIU_FORCE_ONBOARDING = '1';
    expect(needsOnboarding({ onboardingCompleted: true }, { ...localGateway, mode: 'gateway' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readDesktopSettings / writeDesktopSettings
// ---------------------------------------------------------------------------

describe('readDesktopSettings', () => {
  it('returns {} for a missing file', () => {
    expect(readDesktopSettings(makeTmpDir())).toEqual({});
  });

  it('returns {} for corrupt JSON', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.dirname(settingsFilePath(dir)), { recursive: true });
    fs.writeFileSync(settingsFilePath(dir), '{ not json ]', 'utf-8');
    expect(readDesktopSettings(dir)).toEqual({});
  });

  it('returns {} when the JSON is a non-object', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.dirname(settingsFilePath(dir)), { recursive: true });
    fs.writeFileSync(settingsFilePath(dir), '[1,2,3]', 'utf-8');
    expect(readDesktopSettings(dir)).toEqual({});
  });
});

describe('writeDesktopSettings', () => {
  it('preserves server-owned keys while adding a desktop key', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.dirname(settingsFilePath(dir)), { recursive: true });
    const seeded = {
      providers: [{ id: 'openai' }],
      apiKey: 'sk-secret',
      connectionMode: 'gateway'
    };
    fs.writeFileSync(settingsFilePath(dir), JSON.stringify(seeded, null, 2), 'utf-8');

    writeDesktopSettings(dir, { onboardingCompleted: true });

    const written = JSON.parse(fs.readFileSync(settingsFilePath(dir), 'utf-8')) as DesktopSettings & {
      providers?: unknown;
      apiKey?: string;
    };
    // Server-owned keys survive the read-modify-write…
    expect(written.providers).toEqual([{ id: 'openai' }]);
    expect(written.apiKey).toBe('sk-secret');
    // …and the desktop key is added without disturbing the foreign ones.
    expect(written.onboardingCompleted).toBe(true);
    expect(written.connectionMode).toBe('gateway');
  });

  it('replaces corrupt JSON cleanly instead of throwing', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.dirname(settingsFilePath(dir)), { recursive: true });
    fs.writeFileSync(settingsFilePath(dir), '<broken>', 'utf-8');

    expect(() => writeDesktopSettings(dir, { connectionMode: 'local' })).not.toThrow();
    expect(readDesktopSettings(dir)).toEqual({ connectionMode: 'local' });
  });

  it('creates the settings directory when absent', () => {
    const dir = makeTmpDir();
    writeDesktopSettings(dir, { onboardingCompleted: true });
    expect(fs.existsSync(settingsFilePath(dir))).toBe(true);
  });

  it('creates the file 0600 — it may hold apiKey before the SPA server exists', () => {
    // On a fresh install the desktop shell is the FIRST creator of this file, so
    // a missing mode here would leave a credential-bearing file world-readable
    // (umask 022 → 0644) and no later SPA save could tighten it, since Node's
    // `mode` option only applies at creation.
    const dir = makeTmpDir();
    writeDesktopSettings(dir, { onboardingCompleted: true });
    const mode = fs.statSync(settingsFilePath(dir)).mode & 0o777;
    // Windows has no POSIX mode bits; everywhere else it must be exactly 0600.
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });

  it('tightens a pre-existing wider file', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.dirname(settingsFilePath(dir)), { recursive: true });
    fs.writeFileSync(settingsFilePath(dir), '{}', { encoding: 'utf-8', mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(settingsFilePath(dir), 0o644);

    writeDesktopSettings(dir, { onboardingCompleted: true });

    if (process.platform !== 'win32') {
      expect(fs.statSync(settingsFilePath(dir)).mode & 0o777).toBe(0o600);
    }
  });

  it('round-trips a fixed local forward port through the remote block', () => {
    // What the wizard's 本地转发端口 field ends up as: `resolveGatewayConfig`
    // reads `remote.localPort` back on the next boot, so dropping it here would
    // silently re-allocate an ephemeral port.
    const dir = makeTmpDir();
    writeDesktopSettings(dir, {
      connectionMode: 'remote',
      remote: { alias: 'prod-1', workspace: '/srv/app', localPort: 51234 },
      onboardingCompleted: true
    });
    expect(readDesktopSettings(dir).remote).toEqual({
      alias: 'prod-1',
      workspace: '/srv/app',
      localPort: 51234
    });
  });

  it('round-trips customUrl settings', () => {
    const dir = makeTmpDir();
    writeDesktopSettings(dir, {
      connectionMode: 'custom_url',
      customUrl: { url: 'http://192.168.1.50:4000', token: 'token-xyz' },
      onboardingCompleted: true
    });
    expect(readDesktopSettings(dir).customUrl).toEqual({
      url: 'http://192.168.1.50:4000',
      token: 'token-xyz'
    });
  });
});

// ---------------------------------------------------------------------------
// resolveGatewayConfig
// ---------------------------------------------------------------------------

describe('resolveGatewayConfig', () => {
  const CUSTOM_ENV = ['SUPERIU_CUSTOM_URL', 'SUPERIU_CUSTOM_TOKEN', 'SUPERIU_CONNECTION_MODE'] as const;
  const originalCustomEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of CUSTOM_ENV) {
      originalCustomEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CUSTOM_ENV) {
      if (originalCustomEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalCustomEnv[key];
    }
  });

  it('resolves custom_url mode from settings file', () => {
    const dir = makeTmpDir();
    writeDesktopSettings(dir, {
      connectionMode: 'custom_url',
      customUrl: { url: 'https://custom.superiu.internal:8080', token: 'auth-key-123' }
    });

    const config = resolveGatewayConfig(dir);
    expect(config.mode).toBe('custom_url');
    expect(config.url).toBe('https://custom.superiu.internal:8080');
    expect(config.token).toBe('auth-key-123');
    expect(config.customUrl).toEqual({
      url: 'https://custom.superiu.internal:8080',
      token: 'auth-key-123'
    });
  });

  it('resolves custom_url mode from environment variables overriding settings', () => {
    const dir = makeTmpDir();
    writeDesktopSettings(dir, {
      connectionMode: 'local',
      customUrl: { url: 'http://old.example.com', token: 'old-token' }
    });

    process.env.SUPERIU_CONNECTION_MODE = 'custom_url';
    process.env.SUPERIU_CUSTOM_URL = 'http://new.example.com';
    process.env.SUPERIU_CUSTOM_TOKEN = 'new-token';

    const config = resolveGatewayConfig(dir);
    expect(config.mode).toBe('custom_url');
    expect(config.url).toBe('http://new.example.com');
    expect(config.token).toBe('new-token');
    expect(config.customUrl).toEqual({
      url: 'http://new.example.com',
      token: 'new-token'
    });
  });
});
