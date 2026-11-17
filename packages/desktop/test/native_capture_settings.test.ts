import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeCapture } from '../src/native_capture.js';
import { NativeCaptureService } from '../src/native_capture_service.js';
import {
  DEFAULT_NATIVE_CAPTURE_SETTINGS,
  NativeCaptureSettingsError,
  parseNativeCaptureSettings
} from '../src/native_capture_settings.js';

let directory: string;
const services: NativeCaptureService[] = [];
const peers: NativeCapture[] = [];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-settings-'));
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const peer of peers.splice(0)) await peer.stop();
  fs.rmSync(directory, { recursive: true, force: true });
});

function helper(mode = 'normal'): string {
  const filename = path.join(directory, `${mode}-helper.mjs`);
  const fixture = fs.readFileSync(new URL('./fixtures/native-settings-helper.mjs', import.meta.url), 'utf8');
  fs.writeFileSync(filename, `#!/usr/bin/env node\nconst fixtureMode = ${JSON.stringify(mode)};\n${fixture}`);
  fs.chmodSync(filename, 0o755);
  return filename;
}

function service(supported = true): NativeCaptureService {
  const instance = new NativeCaptureService({
    binaryPath: helper(),
    settingsPath: path.join(directory, 'preferences', 'native-capture.json'),
    supported
  });
  services.push(instance);
  return instance;
}

function savedSettings(): unknown {
  return JSON.parse(fs.readFileSync(path.join(directory, 'preferences', 'native-capture.json'), 'utf8'));
}

describe('native capture settings boundary', () => {
  it.each([
    { enabled: 'yes' },
    { captureShortcut: { keyCode: -1, modifiers: 768 } },
    { captureShortcut: { keyCode: 128, modifiers: 768 } },
    { captureShortcut: { keyCode: 1.5, modifiers: 768 } },
    { captureShortcut: { keyCode: 1, modifiers: 0 } },
    { captureShortcut: { keyCode: 1, modifiers: 512 } },
    { captureShortcut: { keyCode: 1, modifiers: 1024 } },
    { captureShortcut: { keyCode: 1, modifiers: 2 ** 32 + 768 } },
    { historyShortcut: { keyCode: 19, modifiers: 768 } },
    { imagePersistenceEnabled: 'false' }
  ])('rejects invalid preference input %j', (patch) => {
    expect(() => parseNativeCaptureSettings({ ...DEFAULT_NATIVE_CAPTURE_SETTINGS, ...patch }))
      .toThrow(NativeCaptureSettingsError);
  });
});

describe('machine-local capture preferences with a real child peer', () => {
  it('adopts an existing image-cache opt-in before creating the first host preferences', async () => {
    const instance = service();
    await instance.start();

    expect((await instance.getState()).settings.imagePersistenceEnabled).toBe(true);
    expect(savedSettings()).toEqual({ ...DEFAULT_NATIVE_CAPTURE_SETTINGS, imagePersistenceEnabled: true });
  });

  it('applies custom shortcuts to the live peer and persists them', async () => {
    const instance = service();
    await instance.start();
    const requested = {
      ...DEFAULT_NATIVE_CAPTURE_SETTINGS,
      captureShortcut: { keyCode: 1, modifiers: 2304 },
      historyShortcut: { keyCode: 11, modifiers: 4608 }
    };

    await instance.setSettings(requested);

    expect((await instance.getState()).settings).toEqual(requested);
    expect(savedSettings()).toEqual(requested);
    const peerState: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'peer-state.json'), 'utf8'));
    expect(peerState).toEqual({
      configuration: {
        captureShortcut: { keyCode: 1, modifiers: 2304 },
        historyShortcut: { keyCode: 11, modifiers: 4608 },
        imagePersistenceEnabled: false
      },
      historyCount: 3
    });
  });

  it('restores disabled preferences after restart without spawning a helper', async () => {
    const instance = service();
    await instance.start();
    const requested = {
      ...DEFAULT_NATIVE_CAPTURE_SETTINGS,
      enabled: false,
      captureShortcut: { keyCode: 1, modifiers: 2304 },
      imagePersistenceEnabled: true
    };
    await instance.setSettings(requested);
    const restarted = service();

    await restarted.start();

    expect(await restarted.getState()).toEqual({ supported: true, running: false, settings: requested });
    expect(fs.readFileSync(path.join(directory, 'starts.log'), 'utf8')).toBe('start\n');
  });

  it('restores saved shortcuts to a new helper after restarting the service', async () => {
    const instance = service();
    await instance.start();
    const requested = {
      ...DEFAULT_NATIVE_CAPTURE_SETTINGS,
      captureShortcut: { keyCode: 1, modifiers: 2304 },
      historyShortcut: { keyCode: 11, modifiers: 4608 }
    };
    await instance.setSettings(requested);
    await instance.stop();
    const restarted = service();

    await restarted.start();

    expect((await restarted.getState()).settings).toEqual(requested);
    expect(fs.readFileSync(path.join(directory, 'starts.log'), 'utf8')).toBe('start\nstart\n');
  });

  it('keeps the previous working configuration and saved file when the peer rejects a shortcut', async () => {
    const instance = service();
    await instance.start();
    const previous = savedSettings();

    await expect(instance.setSettings({
      ...DEFAULT_NATIVE_CAPTURE_SETTINGS,
      captureShortcut: { keyCode: 12, modifiers: 768 }
    })).rejects.toThrow('Shortcut is occupied.');

    expect(savedSettings()).toEqual(previous);
    expect((await instance.getState()).settings).toEqual(previous);
  });

  it('serializes consecutive edits so the last acknowledged configuration survives', async () => {
    const instance = service();
    await instance.start();
    const first = { ...DEFAULT_NATIVE_CAPTURE_SETTINGS, captureShortcut: { keyCode: 1, modifiers: 2304 } };
    const last = { ...first, historyShortcut: { keyCode: 11, modifiers: 4608 } };

    await Promise.all([instance.setSettings(first), instance.setSettings(last)]);

    expect((await instance.getState()).settings).toEqual(last);
    expect(savedSettings()).toEqual(last);
  });

  it('clears history through the running peer', async () => {
    const instance = service();
    await instance.start();

    await instance.clearHistory();

    const peerState: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'peer-state.json'), 'utf8'));
    expect(peerState).toMatchObject({ historyCount: 0 });
  });

  it('does not launch native code or save native preferences on an unsupported platform', async () => {
    const instance = service(false);
    await instance.start();

    await expect(instance.setSettings(DEFAULT_NATIVE_CAPTURE_SETTINGS)).rejects.toThrow('macOS 14+');

    expect((await instance.getState()).supported).toBe(false);
    expect(fs.existsSync(path.join(directory, 'starts.log'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'preferences', 'native-capture.json'))).toBe(false);
  });
});

describe('native settings request lifetime', () => {
  it.each(['exit', 'malformed'])('rejects a request when the peer sends %s instead of a valid result', async (mode) => {
    const peer = new NativeCapture({ binaryPath: helper(mode), log: () => {} });
    peers.push(peer);
    expect(await peer.start()).toBe(true);

    await expect(peer.getSettings()).rejects.toThrow(NativeCaptureSettingsError);
  });
});
