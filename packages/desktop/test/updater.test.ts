/**
 * Unit tests for the desktop updater: version parsing and semver precedence,
 * macOS asset selection by architecture, the atomic bundle swap, and the
 * silent-download state machine.
 *
 * The GitHub API is stubbed rather than called, and the Electron runtime is
 * mocked, so the whole file runs in the plain node environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type * as Fsp from 'node:fs/promises';
import {
  checkForUpdate,
  getUpdateState,
  installPreparedUpdate,
  onUpdateState,
  parseVersion,
  replaceBundle,
  semverGt,
  selectMacAsset,
  versionFromAssetName
} from '../src/updater.js';
import type { UpdateState } from '../src/updater.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// `rename` is the one filesystem step of `replaceBundle` that has no cheaper
// way to be made to fail, so the swap tests drive it through this switch. Every
// other call passes straight through to the real implementation, keeping the
// mock inert for the rest of the file.
const renameControl = vi.hoisted(() => ({
  failWhenDestination: null as string | null,
  fired: false
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof Fsp;
  return {
    ...actual,
    rename: async (...args: Parameters<typeof Fsp.rename>): Promise<void> => {
      if (
        !renameControl.fired &&
        renameControl.failWhenDestination !== null &&
        String(args[1]) === renameControl.failWhenDestination
      ) {
        renameControl.fired = true;
        throw new Error('simulated staging rename failure');
      }
      return actual.rename(...args);
    }
  };
});

// The updater imports `electron` unconditionally, so the module needs a runtime
// to load in this plain-node test file. The stubs are inert: nothing here shows
// dialogs or relaunches on the paths under test.
vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    getPath: () => tmpdir(),
    isPackaged: false,
    relaunch: vi.fn(),
    quit: vi.fn()
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) }
}));

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
  it('parses a strict major.minor.patch triple', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('strips a leading v/V', () => {
    expect(parseVersion('v1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('V2.0.0')).toMatchObject({ major: 2, minor: 0, patch: 0 });
  });

  it('defaults missing minor/patch to zero', () => {
    expect(parseVersion('1')).toMatchObject({ major: 1, minor: 0, patch: 0 });
    expect(parseVersion('1.2')).toMatchObject({ major: 1, minor: 2, patch: 0 });
  });

  it('captures a pre-release identifier list', () => {
    expect(parseVersion('1.0.0-beta.2')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['beta', '2']
    });
  });

  it('ignores build metadata', () => {
    expect(parseVersion('1.2.3+build.7')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: []
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseVersion('  v0.1.0  ')).toMatchObject({ major: 0, minor: 1, patch: 0 });
  });

  it('returns null for non-version input', () => {
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// semverGt
// ---------------------------------------------------------------------------

describe('semverGt', () => {
  it('compares major, minor and patch in order', () => {
    expect(semverGt('2.0.0', '1.9.9')).toBe(true);
    expect(semverGt('1.3.0', '1.2.9')).toBe(true);
    expect(semverGt('1.2.4', '1.2.3')).toBe(true);
  });

  it('is false for equal versions', () => {
    expect(semverGt('1.2.3', '1.2.3')).toBe(false);
    expect(semverGt('v1.2.3', '1.2.3')).toBe(false);
  });

  it('is false for older versions', () => {
    expect(semverGt('1.2.3', '2.0.0')).toBe(false);
    expect(semverGt('0.1.0', '0.1.1')).toBe(false);
  });

  it('treats a pre-release as lower than its release', () => {
    expect(semverGt('1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(semverGt('1.0.0-rc.1', '1.0.0')).toBe(false);
  });

  it('orders pre-release identifiers per semver', () => {
    expect(semverGt('1.0.0-alpha.2', '1.0.0-alpha.1')).toBe(true);
    expect(semverGt('1.0.0-beta', '1.0.0-alpha')).toBe(true);
    expect(semverGt('1.0.0-alpha.1', '1.0.0-alpha')).toBe(true);
    // Numeric identifiers rank below alphanumeric ones.
    expect(semverGt('1.0.0-alpha', '1.0.0-1')).toBe(true);
  });

  it('never reports an update for unparseable input', () => {
    expect(semverGt('garbage', '1.0.0')).toBe(false);
    expect(semverGt('1.0.0', 'garbage')).toBe(false);
    expect(semverGt(undefined, '1.0.0')).toBe(false);
  });

  it('handles the default repo tag shape (v-prefixed)', () => {
    expect(semverGt('v0.2.0', '0.1.0')).toBe(true);
    expect(semverGt('v0.1.0', '0.1.0')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// versionFromAssetName
// ---------------------------------------------------------------------------

describe('versionFromAssetName', () => {
  it('extracts the version from a desktop asset name', () => {
    expect(versionFromAssetName('SuperIU-0.2.0-mac-arm64.zip')).toBe('0.2.0');
    expect(versionFromAssetName('SuperIU-1.0.0-mac-x64.zip')).toBe('1.0.0');
  });

  it('keeps pre-release identifiers', () => {
    expect(versionFromAssetName('SuperIU-1.0.0-beta.3-mac-arm64.zip')).toBe('1.0.0-beta.3');
  });

  it('returns null for names without an embedded semver', () => {
    expect(versionFromAssetName('superiu-server-linux-x64')).toBeNull();
    expect(versionFromAssetName('latest')).toBeNull();
    expect(versionFromAssetName(undefined)).toBeNull();
    expect(versionFromAssetName(null)).toBeNull();
    expect(versionFromAssetName('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectMacAsset
// ---------------------------------------------------------------------------

describe('selectMacAsset', () => {
  const release = [
    { name: 'SuperIU-0.2.0-mac-arm64.zip', browser_download_url: 'https://x/arm64.zip' },
    { name: 'SuperIU-0.2.0-mac-x64.zip', browser_download_url: 'https://x/x64.zip' },
    { name: 'SuperIU-0.2.0-windows-x64.zip', browser_download_url: 'https://x/win.zip' },
    { name: 'SuperIU-0.2.0-linux-x64.tar.gz', browser_download_url: 'https://x/linux.tgz' }
  ];

  it('picks the arm64 macOS zip for arm64', () => {
    expect(selectMacAsset(release, 'arm64')).toMatchObject({
      name: 'SuperIU-0.2.0-mac-arm64.zip',
      browser_download_url: 'https://x/arm64.zip'
    });
  });

  it('picks the x64 macOS zip for x64', () => {
    expect(selectMacAsset(release, 'x64')).toMatchObject({
      name: 'SuperIU-0.2.0-mac-x64.zip',
      browser_download_url: 'https://x/x64.zip'
    });
  });

  it('treats any non-arm64 arch as x64', () => {
    expect(selectMacAsset(release, 'ia32')?.name).toBe('SuperIU-0.2.0-mac-x64.zip');
  });

  it('falls back to a universal mac zip when no arch suffix matches', () => {
    const assets = [
      { name: 'SuperIU-0.2.0-windows-x64.zip', browser_download_url: 'https://x/win.zip' },
      { name: 'SuperIU-0.2.0-mac-universal.zip', browser_download_url: 'https://x/uni.zip' }
    ];
    expect(selectMacAsset(assets, 'arm64')).toMatchObject({
      browser_download_url: 'https://x/uni.zip'
    });
  });

  it('picks the highest embedded version when stale assets coexist', () => {
    const assets = [
      { name: 'SuperIU-0.1.0-mac-arm64.zip', browser_download_url: 'https://x/old.zip' },
      { name: 'SuperIU-0.2.0-mac-arm64.zip', browser_download_url: 'https://x/new.zip' }
    ];
    expect(selectMacAsset(assets, 'arm64')?.browser_download_url).toBe('https://x/new.zip');
    // Reversed order must pick the same asset — order must not matter.
    expect(selectMacAsset([...assets].reverse(), 'arm64')?.browser_download_url).toBe(
      'https://x/new.zip'
    );
  });

  it('returns null when there is no macOS asset', () => {
    const assets = [
      { name: 'SuperIU-0.2.0-windows-x64.zip', browser_download_url: 'https://x/win.zip' }
    ];
    expect(selectMacAsset(assets, 'arm64')).toBeNull();
  });

  it('ignores non-zip assets even if they name mac', () => {
    const assets = [
      { name: 'SuperIU-0.2.0-mac-arm64.dmg', browser_download_url: 'https://x/mac.dmg' }
    ];
    expect(selectMacAsset(assets, 'arm64')).toBeNull();
  });

  it('ignores an asset without a download URL', () => {
    const assets = [{ name: 'SuperIU-0.2.0-mac-arm64.zip' }];
    expect(selectMacAsset(assets, 'arm64')).toBeNull();
  });

  it('returns null for missing/empty assets', () => {
    expect(selectMacAsset(undefined, 'arm64')).toBeNull();
    expect(selectMacAsset([], 'arm64')).toBeNull();
  });

  it('matches the arch case-insensitively', () => {
    const assets = [
      { name: 'SuperIU-0.2.0-Mac-ARM64.zip', browser_download_url: 'https://x/arm.zip' }
    ];
    expect(selectMacAsset(assets, 'arm64')).toMatchObject({
      browser_download_url: 'https://x/arm.zip'
    });
  });
});

// ---------------------------------------------------------------------------
// replaceBundle
// ---------------------------------------------------------------------------

describe('replaceBundle', () => {
  let parentDir: string;

  /** A minimal `.app` whose only meaningful content is a marker file. */
  function makeBundle(at: string, marker: string): string {
    const contents = path.join(at, 'Contents');
    mkdirSync(contents, { recursive: true });
    writeFileSync(path.join(contents, 'Info.plist'), marker);
    return at;
  }

  beforeEach(() => {
    parentDir = mkdtempSync(path.join(tmpdir(), 'superiu-swap-'));
    renameControl.failWhenDestination = null;
    renameControl.fired = false;
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('swaps in the prepared bundle over the live one', async () => {
    const target = makeBundle(path.join(parentDir, 'SuperIU.app'), 'old');
    const prepared = makeBundle(path.join(parentDir, 'prepared', 'SuperIU.app'), 'new');

    await replaceBundle(prepared, target);

    expect(readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf-8')).toBe('new');
  });

  it('leaves no scratch directories behind after a successful swap', async () => {
    const target = makeBundle(path.join(parentDir, 'SuperIU.app'), 'old');
    const prepared = makeBundle(path.join(parentDir, 'prepared', 'SuperIU.app'), 'new');

    await replaceBundle(prepared, target);

    // Any sibling starting with a dot is one of the swap's own scratch copies.
    expect(readdirSync(parentDir).filter((entry) => entry.startsWith('.SuperIU.app.'))).toEqual([]);
  });

  it('restores the original bundle when the staging rename fails', async () => {
    const target = makeBundle(path.join(parentDir, 'SuperIU.app'), 'old');
    const prepared = makeBundle(path.join(parentDir, 'prepared', 'SuperIU.app'), 'new');

    // Fail the second rename — staging -> target — the exact step that would
    // otherwise leave the user with no installed app. Failing the first rename
    // would be vacuous: nothing has moved aside yet, so the restore never runs.
    renameControl.failWhenDestination = target;

    await expect(replaceBundle(prepared, target)).rejects.toThrow('simulated staging rename failure');

    expect(renameControl.fired).toBe(true);
    expect(readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf-8')).toBe('old');
    expect(readdirSync(parentDir).filter((entry) => entry.startsWith('.SuperIU.app.'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// update state machine
// ---------------------------------------------------------------------------

describe('update state', () => {
  // The offline probe is the cheapest way to make the state machine move: the
  // GitHub call rejects, `checkForUpdates` swallows it, and the phase walks
  // `checking` -> `idle` with no network and no download.
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts idle', () => {
    expect(getUpdateState().phase).toBe('idle');
  });

  it('delivers changes to subscribers and stops after unsubscribe', async () => {
    const kept: UpdateState[] = [];
    const dropped: UpdateState[] = [];
    onUpdateState((state) => kept.push(state));
    const unsubscribe = onUpdateState((state) => dropped.push(state));
    unsubscribe();

    await checkForUpdate(false);

    // Delivery must be real, otherwise the unsubscribe assertion proves nothing.
    expect(kept.length).toBeGreaterThan(0);
    expect(dropped).toEqual([]);
  });

  it('refuses to install before an update is prepared', async () => {
    await expect(installPreparedUpdate()).rejects.toThrow();
    // Rejection must not leave the machine looking mid-install.
    expect(getUpdateState().phase).toBe('idle');
  });
});


