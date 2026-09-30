/**
 * Unit tests for the pure half of the desktop updater: version parsing and
 * semver precedence, and macOS asset selection by architecture.
 *
 * The impure half (`checkForUpdates`, `downloadAndInstallUpdate`) requires a
 * live Electron runtime and the GitHub API, so it is deliberately not exercised
 * here.
 */

import { describe, it, expect } from 'vitest';
import { parseVersion, semverGt, selectMacAsset } from '../src/updater.js';

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
