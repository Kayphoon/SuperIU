/**
 * Tests for `@agent/ui/delta` — the binary patch format used to ship an update
 * as a diff against the installed build.
 *
 * Everything runs against real files in a throwaway tmpdir and the module under
 * test is never mocked, so the on-disk header layout, the content-defined
 * chunking and the gzipped command stream are all exercised for real.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  DELTA_HEADER_SIZE,
  DELTA_MAGIC,
  DELTA_VERSION,
  applyDelta,
  createDelta,
  parseDeltaHeader,
  sha256File,
  sha256Hex,
  type DeltaStats
} from '../src/delta.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UNIT = 64 * 1024;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'suiu-delta-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Structured fixture: one seeded pseudo-random 64 KiB block repeated across the
 * file, stamped with a per-block marker. The repetition is what makes the diff
 * small; the high-entropy body is what keeps the gear hash varied enough for
 * chunk cuts to be content-determined, so a shifted region re-syncs.
 */
function structured(size: number): Buffer {
  const unit = noise(UNIT, 0x51ed);
  const buf = Buffer.allocUnsafe(size);
  for (let offset = 0; offset < size; offset += UNIT) {
    const length = Math.min(UNIT, size - offset);
    unit.copy(buf, offset, 0, length);
    const marker = Buffer.from(`#${(offset / UNIT).toString(16).padStart(8, '0')}`, 'utf8');
    marker.copy(buf, offset, 0, Math.min(marker.length, length));
  }
  return buf;
}

/**
 * Incompressible filler. The `salt` keeps two streams from being mere shifts of
 * one another, which matters when a test needs genuinely unrelated inputs.
 */
function noise(size: number, seed: number, salt = 0): Buffer {
  const buf = Buffer.allocUnsafe(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    buf[i] = ((state >>> 24) ^ salt) & 0xff;
  }
  return buf;
}

async function writeFixture(name: string, data: Uint8Array): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, data);
  return filePath;
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(stat(filePath)).rejects.toThrow();
}

describe('createDelta + applyDelta round-trip', () => {
  it('reproduces a target built from the source with an edit and an insertion', async () => {
    const source = structured(4 * 1024 * 1024);
    const editOffset = 1_500_000;
    const insertOffset = 2_500_000;
    const edited = Buffer.from(source);
    for (let i = 0; i < 100; i += 1) {
      edited[editOffset + i] = (edited[editOffset + i] + 1) & 0xff;
    }
    const insertion = noise(64 * 1024, 0x5eed);
    const target = Buffer.concat([edited.subarray(0, insertOffset), insertion, edited.subarray(insertOffset)]);

    const sourcePath = await writeFixture('source.bin', source);
    const targetPath = await writeFixture('target.bin', target);
    const patchPath = path.join(dir, 'delta.patch');
    const outPath = path.join(dir, 'out.bin');

    const stats: DeltaStats = await createDelta(sourcePath, targetPath, patchPath);

    expect(stats.sourceSize).toBe(source.length);
    expect(stats.targetSize).toBe(target.length);
    expect(stats.patchSize).toBe((await stat(patchPath)).size);
    expect(stats.copyBytes).toBeGreaterThan(0);
    expect(stats.insertBytes).toBeGreaterThan(0);
    expect(stats.copyBytes + stats.insertBytes).toBe(target.length);
    // The 64 KiB insertion shifts everything after it; content-defined chunking
    // must still recognise that region rather than re-sending it.
    expect(stats.copyBytes).toBeGreaterThan(target.length * 0.9);
    expect(stats.patchSize).toBeLessThan(target.length / 2);

    await applyDelta(sourcePath, patchPath, outPath);
    expect(await sha256File(outPath)).toBe(sha256Hex(target));
    // The fixture helper and the streaming hash must agree on the same bytes.
    expect(await sha256File(targetPath)).toBe(sha256Hex(target));
  });
});

describe('applyDelta source verification', () => {
  it('rejects a source whose content differs and leaves no output', async () => {
    const source = structured(1024 * 1024);
    const target = Buffer.concat([
      source.subarray(0, 500_000),
      Buffer.from('replacement-region'),
      source.subarray(500_000)
    ]);

    const sourcePath = await writeFixture('source.bin', source);
    const targetPath = await writeFixture('target.bin', target);
    const patchPath = path.join(dir, 'delta.patch');
    const outPath = path.join(dir, 'out.bin');
    await createDelta(sourcePath, targetPath, patchPath);

    const sameSize = Buffer.from(source);
    sameSize[17] ^= 0xff;
    const wrongSameSize = await writeFixture('wrong-same-size.bin', sameSize);
    await expect(applyDelta(wrongSameSize, patchPath, outPath)).rejects.toThrow(/sha256/);
    await expectMissing(outPath);

    const wrongSize = await writeFixture('wrong-size.bin', source.subarray(0, source.length - 1));
    await expect(applyDelta(wrongSize, patchPath, outPath)).rejects.toThrow(/size/);
    await expectMissing(outPath);

    // Control: the real source still applies, so the failures above were about
    // the source and not about the patch.
    await applyDelta(sourcePath, patchPath, outPath);
    expect(await sha256File(outPath)).toBe(sha256Hex(target));
  });
});

describe('applyDelta patch verification', () => {
  it('rejects a truncated patch and a flipped body byte', async () => {
    const source = structured(512 * 1024);
    const target = Buffer.concat([source.subarray(0, 100_000), noise(32 * 1024, 7), source.subarray(100_000)]);

    const sourcePath = await writeFixture('source.bin', source);
    const targetPath = await writeFixture('target.bin', target);
    const patchPath = path.join(dir, 'delta.patch');
    const outPath = path.join(dir, 'out.bin');
    await createDelta(sourcePath, targetPath, patchPath);

    const patch = await readFile(patchPath);
    expect(patch.length).toBeGreaterThan(DELTA_HEADER_SIZE + 32);

    const truncatedPath = path.join(dir, 'truncated.patch');
    const keep = DELTA_HEADER_SIZE + Math.floor((patch.length - DELTA_HEADER_SIZE) / 2);
    await writeFile(truncatedPath, patch.subarray(0, keep));
    await expect(applyDelta(sourcePath, truncatedPath, outPath)).rejects.toThrow();
    await expectMissing(outPath);

    const flipped = Buffer.from(patch);
    flipped[DELTA_HEADER_SIZE + 10] ^= 0xff;
    const flippedPath = path.join(dir, 'flipped.patch');
    await writeFile(flippedPath, flipped);
    await expect(applyDelta(sourcePath, flippedPath, outPath)).rejects.toThrow();
    await expectMissing(outPath);

    await applyDelta(sourcePath, patchPath, outPath);
    expect(await sha256File(outPath)).toBe(sha256Hex(target));
  });
});

describe('unrelated source and target', () => {
  it('falls back to all-INSERT commands and still reproduces the target', async () => {
    const source = noise(512 * 1024, 11);
    const target = noise(512 * 1024, 11, 0xa5);

    const sourcePath = await writeFixture('source.bin', source);
    const targetPath = await writeFixture('target.bin', target);
    const patchPath = path.join(dir, 'delta.patch');
    const outPath = path.join(dir, 'out.bin');

    const stats = await createDelta(sourcePath, targetPath, patchPath);
    expect(stats.copyBytes).toBe(0);
    expect(stats.insertBytes).toBe(target.length);

    await applyDelta(sourcePath, patchPath, outPath);
    expect(await sha256File(outPath)).toBe(sha256Hex(target));
  });
});

describe('parseDeltaHeader', () => {
  it('round-trips a real plaintext header and rejects malformed ones', async () => {
    const source = structured(300_000);
    const target = Buffer.concat([source, noise(50_000, 3)]);

    const sourcePath = await writeFixture('source.bin', source);
    const targetPath = await writeFixture('target.bin', target);
    const patchPath = path.join(dir, 'delta.patch');
    await createDelta(sourcePath, targetPath, patchPath);

    const patch = await readFile(patchPath);
    const header = parseDeltaHeader(patch);

    expect(DELTA_HEADER_SIZE).toBe(78);
    expect(DELTA_MAGIC).toBe('SUIU1');
    expect(DELTA_VERSION).toBe(1);
    expect(patch.subarray(0, 5).toString('latin1')).toBe(DELTA_MAGIC);
    expect(patch[5]).toBe(DELTA_VERSION);
    // Plaintext, not gzip: an 80-byte range read is enough to preflight it.
    expect(patch.subarray(0, 2).toString('hex')).not.toBe('1f8b');
    expect(patch.length).toBeGreaterThan(80);
    expect(parseDeltaHeader(patch.subarray(0, 80))).toEqual(header);
    // A preflight read may hand us a plain Uint8Array sitting at a byteOffset.
    const padded = Buffer.concat([Buffer.from('xxxxx'), patch.subarray(0, DELTA_HEADER_SIZE)]);
    expect(parseDeltaHeader(new Uint8Array(padded.buffer, padded.byteOffset + 5, DELTA_HEADER_SIZE))).toEqual(header);
    expect(header).toEqual({
      version: DELTA_VERSION,
      sourceSize: source.length,
      sourceSha256: sha256Hex(source),
      targetSize: target.length,
      targetSha256: sha256Hex(target)
    });
    expect(header.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(header.targetSha256).toMatch(/^[0-9a-f]{64}$/);

    expect(() => parseDeltaHeader(Buffer.alloc(78, 0xab))).toThrow(/magic/);
    expect(() => parseDeltaHeader(patch.subarray(0, 20))).toThrow(/too short/);
    expect(() => parseDeltaHeader(Buffer.alloc(0))).toThrow(/too short/);

    const badMagic = Buffer.from(patch.subarray(0, DELTA_HEADER_SIZE));
    badMagic[0] = 0x58;
    expect(() => parseDeltaHeader(badMagic)).toThrow(/magic/);

    const badVersion = Buffer.from(patch.subarray(0, DELTA_HEADER_SIZE));
    badVersion[5] = 2;
    expect(() => parseDeltaHeader(badVersion)).toThrow(/version/);

    // A gzip stream in the header slot must not be mistaken for a patch.
    const gzipLike = Buffer.alloc(DELTA_HEADER_SIZE);
    gzipLike[0] = 0x1f;
    gzipLike[1] = 0x8b;
    expect(() => parseDeltaHeader(gzipLike)).toThrow(/magic/);
  });
});

describe('empty files', () => {
  it('round-trips with an empty source and with an empty target', async () => {
    const target = structured(200_000);
    const emptySourcePath = await writeFixture('empty-source.bin', Buffer.alloc(0));
    const targetPath = await writeFixture('target.bin', target);
    const patchPath = path.join(dir, 'delta.patch');
    const outPath = path.join(dir, 'out.bin');

    const stats = await createDelta(emptySourcePath, targetPath, patchPath);
    expect(stats.sourceSize).toBe(0);
    expect(stats.copyBytes).toBe(0);
    expect(stats.insertBytes).toBe(target.length);

    const header = parseDeltaHeader(await readFile(patchPath));
    expect(header.sourceSize).toBe(0);
    expect(header.sourceSha256).toBe(EMPTY_SHA256);

    await applyDelta(emptySourcePath, patchPath, outPath);
    expect(await sha256File(outPath)).toBe(sha256Hex(target));

    const sourcePath = await writeFixture('source.bin', structured(100_000));
    const emptyTargetPath = await writeFixture('empty-target.bin', Buffer.alloc(0));
    const reversePatchPath = path.join(dir, 'reverse.patch');
    const reverseStats = await createDelta(sourcePath, emptyTargetPath, reversePatchPath);
    expect(reverseStats.targetSize).toBe(0);
    expect(reverseStats.copyBytes).toBe(0);
    expect(reverseStats.insertBytes).toBe(0);

    await applyDelta(sourcePath, reversePatchPath, outPath);
    expect((await stat(outPath)).size).toBe(0);
    expect(await sha256File(outPath)).toBe(EMPTY_SHA256);
  });
});
