/**
 * Unit tests for the differential-update block map engine.
 *
 * Everything runs against real temporary files and a real `node:http` server:
 * chunking, hashing and range assembly are the entire point of the module, so
 * stubbing any of them would assert nothing about the code under test. The three
 * server personalities (range-honouring, range-ignoring, byte-corrupting) are
 * what the fallback contract is defined against.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  BLOCKMAP_VERSION,
  DEFAULT_CHUNK_SIZE,
  assembleFromBlockMap,
  computeBlockMapSync,
  hashLocalBlocks,
  parseBlockMap,
  planBlockDiff,
  serializeBlockMap,
  summarizePlan
} from '../src/blockmap.js';
import type { BlockMap } from '../src/blockmap.js';

const CHUNK = 1024;

let dir: string;
let servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'blockmap-'));
  servers = [];
});

afterEach(async () => {
  // undici pools keep-alive sockets, and those count as live connections, so
  // they have to be dropped before `close` can ever call back.
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  rmSync(dir, { recursive: true, force: true });
});

/** Deterministic xorshift32 bytes: distinct chunks, no reliance on a RNG. */
function makeData(size: number, seed: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  let state = (seed * 2654435761) >>> 0 || 0x9e3779b9;
  for (let index = 0; index < size; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    buffer[index] = state & 0xff;
  }
  return buffer;
}

function writeTemp(name: string, data: Buffer): string {
  const file = path.join(dir, name);
  writeFileSync(file, data);
  return file;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

type ServerMode = 'range' | 'ignore-range' | 'corrupt-range' | 'short-range';

interface TestServer {
  url: string;
  /** Every `Range` header received, in order. */
  ranges: string[];
}

async function startServer(body: Buffer, mode: ServerMode = 'range'): Promise<TestServer> {
  const ranges: string[] = [];
  const server = createServer((request, response) => {
    const header = request.headers.range;
    ranges.push(header ?? '<none>');

    if (mode === 'ignore-range' || header === undefined) {
      response.writeHead(200, { 'Content-Length': String(body.length) });
      response.end(body);
      return;
    }

    const match = /^bytes=(\d+)-(\d+)$/.exec(header);
    if (match === null) {
      response.writeHead(416);
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    // 'short-range' answers 206 with one byte missing; the announced length stays
    // consistent so the truncation is only visible to the caller's own check.
    const sliceEnd = mode === 'short-range' ? end : end + 1;
    // A copy, because 'corrupt-range' mutates what it sends.
    const slice = Buffer.from(body.subarray(start, sliceEnd));
    if (mode === 'corrupt-range' && slice.length > 0) {
      slice[0] = slice[0] ^ 0xff;
    }
    response.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Content-Length': String(slice.length)
    });
    response.end(slice);
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/app.zip`, ranges };
}

describe('computeBlockMapSync', () => {
  it('describes a file that is not a whole number of chunks', () => {
    const data = makeData(CHUNK * 3 + 137, 1);
    const file = writeTemp('app.zip', data);

    const map = computeBlockMapSync(file, CHUNK);

    expect(map.version).toBe(BLOCKMAP_VERSION);
    expect(map.chunkSize).toBe(CHUNK);
    expect(map.filesize).toBe(data.length);
    expect(map.sha256).toBe(sha256(data));
    expect(map.blocks).toHaveLength(4);
    for (let index = 0; index < map.blocks.length; index += 1) {
      const chunk = data.subarray(index * CHUNK, Math.min((index + 1) * CHUNK, data.length));
      expect(map.blocks[index]).toBe(sha256(chunk));
    }
    expect(map.blocks[3]).not.toBe(map.blocks[0]);
  });

  it('defaults to 65536 bytes per chunk', () => {
    const data = makeData(DEFAULT_CHUNK_SIZE + 5, 2);
    const file = writeTemp('big.zip', data);

    const map = computeBlockMapSync(file);

    expect(map.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    expect(map.filesize).toBe(data.length);
    expect(map.blocks).toHaveLength(2);
    expect(map.blocks[0]).toBe(sha256(data.subarray(0, DEFAULT_CHUNK_SIZE)));
    expect(map.blocks[1]).toBe(sha256(data.subarray(DEFAULT_CHUNK_SIZE)));
  });
});

describe('serializeBlockMap / parseBlockMap', () => {
  function sampleMap(): BlockMap {
    return computeBlockMapSync(writeTemp('sample.zip', makeData(CHUNK * 2 + 3, 3)), CHUNK);
  }

  it('round-trips through JSON', () => {
    const map = sampleMap();

    const text = serializeBlockMap(map);

    expect(text).toBe(JSON.stringify(map));
    expect(parseBlockMap(text)).toEqual(map);
  });

  it('accepts an empty file map', () => {
    const map = computeBlockMapSync(writeTemp('empty.zip', Buffer.alloc(0)), CHUNK);

    expect(map.blocks).toEqual([]);
    expect(parseBlockMap(serializeBlockMap(map))).toEqual(map);
  });

  it('rejects malformed block maps', () => {
    const map = sampleMap();
    const invalid: Array<[string, unknown]> = [
      ['version', { ...map, version: 2 }],
      ['sha256 length', { ...map, sha256: 'ab'.repeat(31) }],
      ['sha256 case', { ...map, sha256: map.sha256.toUpperCase() }],
      ['sha256 hex', { ...map, sha256: 'z'.repeat(64) }],
      ['sha256 type', { ...map, sha256: 42 }],
      ['block hex', { ...map, blocks: ['z'.repeat(64), ...map.blocks.slice(1)] }],
      ['block count too high', { ...map, blocks: [...map.blocks, 'a'.repeat(64)] }],
      ['block count too low', { ...map, blocks: map.blocks.slice(0, -1) }],
      ['blocks not an array', { ...map, blocks: 'nope' }],
      ['filesize negative', { ...map, filesize: -1 }],
      ['filesize fractional', { ...map, filesize: 1.5 }],
      ['filesize type', { ...map, filesize: '2051' }],
      ['chunkSize zero', { ...map, chunkSize: 0 }],
      ['chunkSize negative', { ...map, chunkSize: -CHUNK }],
      ['chunkSize fractional', { ...map, chunkSize: 1.5 }],
      ['chunkSize type', { ...map, chunkSize: String(CHUNK) }],
      ['chunkSize missing', { version: map.version, filesize: map.filesize, sha256: map.sha256, blocks: map.blocks }],
      ['not an object', [1, 2, 3]],
      ['empty object', {}]
    ];

    for (const [label, value] of invalid) {
      expect(() => parseBlockMap(JSON.stringify(value)), label).toThrow(Error);
    }
    expect(() => parseBlockMap('not json at all')).toThrow(Error);
    expect(() => parseBlockMap('')).toThrow(Error);
  });
});

describe('hashLocalBlocks', () => {
  it('indexes the same chunks as computeBlockMapSync', async () => {
    const data = makeData(CHUNK * 4 + 9, 4);
    const file = writeTemp('cache.zip', data);
    const map = computeBlockMapSync(file, CHUNK);

    const index = await hashLocalBlocks(file, CHUNK);

    expect(index.size).toBe(map.blocks.length);
    map.blocks.forEach((hash, position) => {
      expect(index.get(hash)).toBe(position * CHUNK);
    });
    expect(index.get(map.sha256)).toBeUndefined();
  });

  it('keeps the first offset when a chunk repeats', async () => {
    const chunk = makeData(CHUNK, 5);
    const file = writeTemp('dup.zip', Buffer.concat([chunk, chunk]));

    const index = await hashLocalBlocks(file, CHUNK);

    expect(index.size).toBe(1);
    expect(index.get(sha256(chunk))).toBe(0);
  });
});

describe('planBlockDiff / summarizePlan', () => {
  it('reuses every block of an identical local file', async () => {
    const data = makeData(CHUNK * 3, 6);
    const local = writeTemp('local.zip', data);
    const map = computeBlockMapSync(local, CHUNK);

    const plan = planBlockDiff(await hashLocalBlocks(local, CHUNK), map);

    expect(plan).toHaveLength(3);
    plan.forEach((entry, position) => {
      expect(entry.index).toBe(position);
      expect(entry.offset).toBe(position * CHUNK);
      expect(entry.length).toBe(CHUNK);
      expect(entry.localOffset).toBe(position * CHUNK);
    });
    expect(summarizePlan(plan)).toEqual({
      totalBytes: data.length,
      localBytes: data.length,
      remoteBytes: 0,
      remoteRanges: 0
    });
  });

  it('marks only the changed chunk remote and keeps its neighbours local', async () => {
    const target = makeData(CHUNK * 3 + 11, 7);
    const localData = Buffer.from(target);
    localData[CHUNK + 10] ^= 0xff;
    const local = writeTemp('local.zip', localData);
    const map = computeBlockMapSync(writeTemp('target.zip', target), CHUNK);

    const plan = planBlockDiff(await hashLocalBlocks(local, CHUNK), map);

    expect(plan.map((entry) => entry.localOffset === null)).toEqual([false, true, false, false]);
    expect(plan[1].offset).toBe(CHUNK);
    expect(plan[1].length).toBe(CHUNK);
    expect(plan[3].length).toBe(11);
    expect(summarizePlan(plan)).toEqual({
      totalBytes: target.length,
      localBytes: target.length - CHUNK,
      remoteBytes: CHUNK,
      remoteRanges: 1
    });
  });

  it('coalesces adjacent remote chunks but splits separated ones', async () => {
    const target = makeData(CHUNK * 4, 8);
    const adjacentData = Buffer.from(target);
    adjacentData[CHUNK + 1] ^= 0xff;
    adjacentData[2 * CHUNK + 1] ^= 0xff;
    const separatedData = Buffer.from(target);
    separatedData[1] ^= 0xff;
    separatedData[2 * CHUNK + 1] ^= 0xff;
    const map = computeBlockMapSync(writeTemp('target.zip', target), CHUNK);

    const adjacent = planBlockDiff(await hashLocalBlocks(writeTemp('adjacent.zip', adjacentData), CHUNK), map);
    expect(summarizePlan(adjacent).remoteBytes).toBe(CHUNK * 2);
    expect(summarizePlan(adjacent).remoteRanges).toBe(1);

    const separated = planBlockDiff(await hashLocalBlocks(writeTemp('separated.zip', separatedData), CHUNK), map);
    expect(separated.map((entry) => entry.localOffset === null)).toEqual([true, false, true, false]);
    expect(summarizePlan(separated).remoteBytes).toBe(CHUNK * 2);
    expect(summarizePlan(separated).remoteRanges).toBe(2);
  });

  it('reuses a block that only moved to a different index', async () => {
    // Local chunks [B, C, A] against target chunks [A, B, C]: hash lookup, not alignment.
    const a = makeData(CHUNK, 11);
    const b = makeData(CHUNK, 12);
    const c = makeData(CHUNK, 13);
    const local = writeTemp('rotated.zip', Buffer.concat([b, c, a]));
    const map = computeBlockMapSync(writeTemp('target.zip', Buffer.concat([a, b, c])), CHUNK);

    const plan = planBlockDiff(await hashLocalBlocks(local, CHUNK), map);

    expect(plan.map((entry) => entry.localOffset)).toEqual([2 * CHUNK, 0, CHUNK]);
    expect(summarizePlan(plan)).toEqual({
      totalBytes: CHUNK * 3,
      localBytes: CHUNK * 3,
      remoteBytes: 0,
      remoteRanges: 0
    });
  });

  it('plans nothing for an empty file', () => {
    const map = computeBlockMapSync(writeTemp('empty.zip', Buffer.alloc(0)), CHUNK);

    expect(planBlockDiff(new Map(), map)).toEqual([]);
    expect(summarizePlan([])).toEqual({ totalBytes: 0, localBytes: 0, remoteBytes: 0, remoteRanges: 0 });
  });
});

describe('assembleFromBlockMap', () => {
  it('rebuilds the target from a cache that differs in one chunk', async () => {
    const target = makeData(CHUNK * 5 + 321, 21);
    const localData = Buffer.from(target);
    for (let index = 2 * CHUNK + 7; index < 2 * CHUNK + 300; index += 1) {
      localData[index] ^= 0xff;
    }
    const local = writeTemp('cached.zip', localData);
    const map = computeBlockMapSync(writeTemp('target.zip', target), CHUNK);
    const server = await startServer(target);
    const outPath = path.join(dir, 'assembled.zip');

    const progress: Array<[number, number, number]> = [];
    await assembleFromBlockMap({
      url: server.url,
      localPath: local,
      outPath,
      map,
      onProgress: (percent, written, total) => progress.push([percent, written, total])
    });

    const assembled = readFileSync(outPath);
    expect(assembled.length).toBe(map.filesize);
    expect(assembled).toEqual(target);
    expect(sha256(assembled)).toBe(map.sha256);

    const stats = summarizePlan(planBlockDiff(await hashLocalBlocks(local, CHUNK), map));
    expect(stats.remoteBytes).toBe(CHUNK);
    expect(stats.remoteBytes).toBeLessThan(map.filesize);
    expect(stats.remoteRanges).toBe(1);

    expect(server.ranges).toEqual([`bytes=${2 * CHUNK}-${3 * CHUNK - 1}`]);
    expect(progress.at(-1)).toEqual([100, map.filesize, map.filesize]);
    for (const [percent, written, total] of progress) {
      expect(total).toBe(map.filesize);
      expect(percent).toBeGreaterThan(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
    expect(progress.map(([, written]) => written)).toEqual(
      progress.map(([, written]) => written).slice().sort((left, right) => left - right)
    );
  });

  it('issues no request when the whole file is already cached', async () => {
    const data = makeData(CHUNK * 2 + 7, 22);
    const local = writeTemp('cached.zip', data);
    const map = computeBlockMapSync(writeTemp('target.zip', data), CHUNK);
    const server = await startServer(data);
    const outPath = path.join(dir, 'assembled.zip');
    const written: number[] = [];

    await assembleFromBlockMap({
      url: server.url,
      localPath: local,
      outPath,
      map,
      onProgress: (_percent, bytes, _total) => written.push(bytes)
    });

    expect(server.ranges).toEqual([]);
    expect(readFileSync(outPath)).toEqual(data);
    expect(written.at(-1)).toBe(data.length);
  });

  it('downloads everything when no block matches', async () => {
    const target = makeData(CHUNK * 3, 23);
    const local = writeTemp('cached.zip', makeData(CHUNK * 3, 24));
    const map = computeBlockMapSync(writeTemp('target.zip', target), CHUNK);
    const server = await startServer(target);
    const outPath = path.join(dir, 'assembled.zip');

    await assembleFromBlockMap({ url: server.url, localPath: local, outPath, map });

    expect(readFileSync(outPath)).toEqual(target);
    // One coalesced request, not one per block.
    expect(server.ranges).toEqual([`bytes=0-${CHUNK * 3 - 1}`]);
  });

  it('downloads everything when the local cache is missing', async () => {
    const target = makeData(CHUNK * 2, 25);
    const map = computeBlockMapSync(writeTemp('target.zip', target), CHUNK);
    const server = await startServer(target);
    const outPath = path.join(dir, 'assembled.zip');

    await assembleFromBlockMap({
      url: server.url,
      localPath: path.join(dir, 'does-not-exist.zip'),
      outPath,
      map
    });

    expect(readFileSync(outPath)).toEqual(target);
    expect(server.ranges).toEqual([`bytes=0-${CHUNK * 2 - 1}`]);
  });

  it('throws and removes the output when the server ignores Range', async () => {
    const target = makeData(CHUNK * 2, 26);
    const localData = Buffer.from(target);
    localData[0] ^= 0xff;
    const map = computeBlockMapSync(writeTemp('target.zip', target), CHUNK);
    const server = await startServer(target, 'ignore-range');
    const outPath = path.join(dir, 'assembled.zip');

    await expect(
      assembleFromBlockMap({ url: server.url, localPath: writeTemp('cached.zip', localData), outPath, map })
    ).rejects.toThrow(/206/);

    expect(existsSync(outPath)).toBe(false);
  });

  it('throws and removes the output when a range serves the wrong bytes', async () => {
    const target = makeData(CHUNK * 2, 27);
    const localData = Buffer.from(target);
    localData[CHUNK + 5] ^= 0xff;
    const map = computeBlockMapSync(writeTemp('target.zip', target), CHUNK);
    const server = await startServer(target, 'corrupt-range');
    const outPath = path.join(dir, 'assembled.zip');

    await expect(
      assembleFromBlockMap({ url: server.url, localPath: writeTemp('cached.zip', localData), outPath, map })
    ).rejects.toThrow(/sha256/);

    expect(existsSync(outPath)).toBe(false);
  });

  it('throws and removes the output when a range is truncated', async () => {
    const target = makeData(CHUNK * 2, 28);
    const localData = Buffer.from(target);
    localData[CHUNK] ^= 0xff;
    const map = computeBlockMapSync(writeTemp('target.zip', target), CHUNK);
    const server = await startServer(target, 'short-range');
    const outPath = path.join(dir, 'assembled.zip');

    await expect(
      assembleFromBlockMap({ url: server.url, localPath: writeTemp('cached.zip', localData), outPath, map })
    ).rejects.toThrow(/sent \d+ of \d+ bytes/);

    expect(existsSync(outPath)).toBe(false);
  });

  it('handles filesize 0 without crashing', async () => {
    const empty = writeTemp('empty.zip', Buffer.alloc(0));
    const map = computeBlockMapSync(empty, CHUNK);
    const server = await startServer(Buffer.alloc(0));
    const outPath = path.join(dir, 'assembled.zip');
    const progress: Array<[number, number, number]> = [];

    await assembleFromBlockMap({
      url: server.url,
      localPath: empty,
      outPath,
      map,
      onProgress: (percent, written, total) => progress.push([percent, written, total])
    });

    expect(map.filesize).toBe(0);
    expect(map.blocks).toEqual([]);
    expect(map.sha256).toBe(sha256(Buffer.alloc(0)));
    expect(readFileSync(outPath)).toHaveLength(0);
    expect(server.ranges).toEqual([]);
    expect(progress).toEqual([[100, 0, 0]]);
  });
});
