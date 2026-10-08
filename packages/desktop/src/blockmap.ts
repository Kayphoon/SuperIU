/**
 * Differential-update engine for the desktop updater.
 *
 * A release ships `<archive>.blockmap` next to the archive: a fixed-offset
 * chunking of the archive in which every chunk is identified by its sha256.
 * The client chunks its cached previous archive the same way, then downloads
 * only the chunks it cannot reproduce locally, coalescing neighbouring gaps into
 * a single HTTP range request.
 *
 * Fixed offsets (chunk `i` always covers
 * `[i * chunkSize, min((i + 1) * chunkSize, filesize))`) mean an insertion near
 * the front invalidates every later chunk, unlike a content-defined chunking.
 * That cost buys a generator and a reassembler that are trivially guaranteed to
 * agree, which matters more here than the extra bytes: block maps are produced
 * by the packaging script and consumed by a client that cannot be redeployed in
 * lockstep.
 *
 * The module is pure — no Electron, no environment, no configuration. The caller
 * supplies the URL, the cache path and the destination, and falls back to a full
 * download whenever anything in here throws.
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export const BLOCKMAP_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 65536;

export interface BlockMap {
  /** Format revision; only {@link BLOCKMAP_VERSION} is understood. */
  version: number;
  /** Total bytes of the described file. */
  filesize: number;
  /** Lowercase hex sha256 of the whole file. */
  sha256: string;
  /** Bytes per block. */
  chunkSize: number;
  /** Lowercase hex sha256 of each chunk, in file order. */
  blocks: string[];
}

export interface BlockPlanEntry {
  /** Block index in the map. */
  index: number;
  /** Byte offset in the target file, always `index * chunkSize`. */
  offset: number;
  /** Bytes in this block. */
  length: number;
  /** Offset in the local file to copy from, or null when it must be downloaded. */
  localOffset: number | null;
}

export interface DiffStats {
  /** Bytes of the target file in total. */
  totalBytes: number;
  /** Bytes reusable from the local file. */
  localBytes: number;
  /** Bytes that must be downloaded. */
  remoteBytes: number;
  /** Number of contiguous HTTP range requests the remote bytes need. */
  remoteRanges: number;
}

/** Bytes per read while re-hashing the finished file; the file is never buffered whole. */
const VERIFY_CHUNK_SIZE = 1 << 20;

const HEX_SHA256 = /^[0-9a-f]{64}$/;

function assertChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkSize must be a positive safe integer, got ${String(chunkSize)}`);
  }
}

/**
 * Chunk a file and hash every chunk, synchronously, for the packaging script.
 * Chunk `i` covers `[i * chunkSize, min((i + 1) * chunkSize, filesize))`.
 *
 * Synchronous by contract: the release pipeline runs it once on a finished
 * archive and is not worth making async-aware. The file is read through one
 * reusable buffer so a multi-hundred-megabyte archive never sits in memory.
 */
export function computeBlockMapSync(filePath: string, chunkSize: number = DEFAULT_CHUNK_SIZE): BlockMap {
  assertChunkSize(chunkSize);

  const filesize = statSync(filePath).size;
  const blocks: string[] = [];
  const whole = createHash('sha256');
  const buffer = Buffer.allocUnsafe(chunkSize);
  const fd = openSync(filePath, 'r');
  try {
    let offset = 0;
    while (offset < filesize) {
      const want = Math.min(chunkSize, filesize - offset);
      let filled = 0;
      while (filled < want) {
        const bytesRead = readSync(fd, buffer, filled, want - filled, offset + filled);
        if (bytesRead <= 0) {
          throw new Error(`unexpected end of file while reading ${filePath} at byte ${offset + filled}`);
        }
        filled += bytesRead;
      }
      const chunk = buffer.subarray(0, want);
      whole.update(chunk);
      blocks.push(createHash('sha256').update(chunk).digest('hex'));
      offset += want;
    }
  } finally {
    closeSync(fd);
  }

  return { version: BLOCKMAP_VERSION, filesize, sha256: whole.digest('hex'), chunkSize, blocks };
}

/** Serialize a block map for shipping as the `<archive>.blockmap` sidecar. */
export function serializeBlockMap(map: BlockMap): string {
  return JSON.stringify(map);
}

/**
 * Parse and fully validate a block map sidecar.
 *
 * Everything is checked up front — including the block count implied by
 * `filesize`/`chunkSize` — because the only consumer is a download path that
 * falls back to a plain full download when this throws. A partially trusted map
 * would instead corrupt the assembled archive.
 */
export function parseBlockMap(text: string): BlockMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`block map is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('block map must be a JSON object');
  }

  const raw = parsed as Record<string, unknown>;

  if (raw.version !== BLOCKMAP_VERSION) {
    throw new Error(`unsupported block map version: expected ${BLOCKMAP_VERSION}, got ${String(raw.version)}`);
  }

  const chunkSize = raw.chunkSize;
  if (typeof chunkSize !== 'number' || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`block map chunkSize must be a positive safe integer, got ${String(chunkSize)}`);
  }

  const filesize = raw.filesize;
  if (typeof filesize !== 'number' || !Number.isSafeInteger(filesize) || filesize < 0) {
    throw new Error(`block map filesize must be a non-negative safe integer, got ${String(filesize)}`);
  }

  const sha256 = raw.sha256;
  if (typeof sha256 !== 'string' || !HEX_SHA256.test(sha256)) {
    throw new Error(`block map sha256 must be 64 lowercase hex characters, got ${String(sha256)}`);
  }

  const blocks = raw.blocks;
  if (!Array.isArray(blocks)) {
    throw new Error('block map blocks must be an array');
  }
  const expected = Math.ceil(filesize / chunkSize);
  if (blocks.length !== expected) {
    throw new Error(
      `block map has ${blocks.length} blocks but ${expected} are required for ${filesize} bytes at ${chunkSize} bytes per block`
    );
  }

  const checked: string[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block: unknown = blocks[index];
    if (typeof block !== 'string' || !HEX_SHA256.test(block)) {
      throw new Error(`block map block ${index} must be 64 lowercase hex characters, got ${String(block)}`);
    }
    checked.push(block);
  }

  return { version: BLOCKMAP_VERSION, filesize, sha256, chunkSize, blocks: checked };
}

/**
 * Map each chunk hash of `filePath` to the offset of the chunk that produced it,
 * using exactly the chunking of {@link computeBlockMapSync}.
 *
 * sha256 equality implies equal length, so a hash alone is enough to decide that
 * a local range can satisfy a target block; no length-qualified key is needed.
 * The earliest offset wins for a repeated chunk so the plan is deterministic.
 */
export async function hashLocalBlocks(filePath: string, chunkSize: number): Promise<Map<string, number>> {
  assertChunkSize(chunkSize);

  const index = new Map<string, number>();
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    while (offset < size) {
      const want = Math.min(chunkSize, size - offset);
      let filled = 0;
      while (filled < want) {
        const { bytesRead } = await handle.read(buffer, filled, want - filled, offset + filled);
        if (bytesRead <= 0) {
          throw new Error(`unexpected end of file while reading ${filePath} at byte ${offset + filled}`);
        }
        filled += bytesRead;
      }
      const hash = createHash('sha256').update(buffer.subarray(0, want)).digest('hex');
      if (!index.has(hash)) {
        index.set(hash, offset);
      }
      offset += want;
    }
  } finally {
    await handle.close();
  }
  return index;
}

/**
 * Decide, block by block, where each piece of the target comes from.
 *
 * Lookups go through the block hash rather than same-index alignment, so a block
 * that merely shifted position in the archive is still copied locally instead of
 * downloaded again.
 */
export function planBlockDiff(localIndex: Map<string, number>, map: BlockMap): BlockPlanEntry[] {
  const plan: BlockPlanEntry[] = [];
  for (let index = 0; index < map.blocks.length; index += 1) {
    const localOffset = localIndex.get(map.blocks[index] as string);
    plan.push({
      index,
      offset: index * map.chunkSize,
      length: Math.min(map.chunkSize, map.filesize - index * map.chunkSize),
      // `??` and not `||`: offset 0 is a perfectly good local source.
      localOffset: localOffset ?? null
    });
  }
  return plan;
}

/**
 * Summarize a plan for the UI and for tests: how many bytes are already on disk
 * and how many round trips the rest costs.
 */
export function summarizePlan(plan: BlockPlanEntry[]): DiffStats {
  let totalBytes = 0;
  let localBytes = 0;
  let remoteBytes = 0;
  let remoteRanges = 0;
  for (let position = 0; position < plan.length; position += 1) {
    const entry = plan[position] as BlockPlanEntry;
    totalBytes += entry.length;
    if (entry.localOffset === null) {
      remoteBytes += entry.length;
      // A run starts wherever a remote block follows a local one (or the file).
      if (position === 0 || (plan[position - 1] as BlockPlanEntry).localOffset !== null) {
        remoteRanges += 1;
      }
    } else {
      localBytes += entry.length;
    }
  }
  return { totalBytes, localBytes, remoteBytes, remoteRanges };
}

/**
 * Reassemble the target archive: copy matching blocks out of the local cache,
 * fetch the rest with HTTP range requests, then verify size and sha256.
 *
 * Blocks are written strictly in target order, and consecutive remote blocks
 * share one range request, because the round trip — not the bytes — is what
 * dominates a differential update. The body is streamed straight to disk so a
 * 100 MB archive never sits in memory.
 *
 * Any failure deletes `outPath` and rethrows; the caller then falls back to a
 * full download, so a half-written archive must never be left behind.
 */
export async function assembleFromBlockMap(options: {
  url: string;
  localPath: string;
  outPath: string;
  map: BlockMap;
  onProgress?: (percent: number, written: number, total: number) => void;
}): Promise<void> {
  const { url, localPath, outPath, map, onProgress } = options;

  // A missing or unreadable cache means nothing can be reused; the all-remote
  // path below is a supported case, not an error.
  let localIndex: Map<string, number>;
  try {
    localIndex = await hashLocalBlocks(localPath, map.chunkSize);
  } catch {
    localIndex = new Map<string, number>();
  }

  const plan = planBlockDiff(localIndex, map);
  const out = await open(outPath, 'w');
  let local: FileHandle | null = null;
  try {
    if (plan.some((entry) => entry.localOffset !== null)) {
      local = await open(localPath, 'r');
    }

    const scratch = Buffer.allocUnsafe(map.chunkSize);
    let written = 0;
    let position = 0;
    while (position < plan.length) {
      const entry = plan[position] as BlockPlanEntry;

      if (entry.localOffset !== null) {
        await readExact(local as FileHandle, scratch, entry.localOffset, entry.length);
        await writeAll(out, scratch.subarray(0, entry.length));
        written += entry.length;
        position += 1;
        // An empty target never divides by zero; the bar is simply full.
        onProgress?.(map.filesize === 0 ? 100 : (written / map.filesize) * 100, written, map.filesize);
        continue;
      }

      let last = position;
      while (last + 1 < plan.length && (plan[last + 1] as BlockPlanEntry).localOffset === null) {
        last += 1;
      }
      const first = entry;
      const tail = plan[last] as BlockPlanEntry;
      const rangeStart = first.offset;
      const rangeEnd = tail.offset + tail.length - 1;
      const expected = rangeEnd - rangeStart + 1;

      const response = await fetch(url, { headers: { Range: `bytes=${rangeStart}-${rangeEnd}` } });
      if (response.status !== 206) {
        // 200 means the server ignored Range and is sending the whole archive.
        throw new Error(`range request was not honoured: expected status 206, got ${response.status}`);
      }
      if (response.body === null) {
        throw new Error(`range response for bytes=${rangeStart}-${rangeEnd} had no body`);
      }

      const reader = response.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value === undefined || value.length === 0) {
          continue;
        }
        received += value.length;
        if (received > expected) {
          await reader.cancel();
          throw new Error(`range response for bytes=${rangeStart}-${rangeEnd} sent more than the ${expected} bytes requested`);
        }
        await writeAll(out, value);
        written += value.length;
        onProgress?.(map.filesize === 0 ? 100 : (written / map.filesize) * 100, written, map.filesize);
      }
      if (received !== expected) {
        throw new Error(`range response for bytes=${rangeStart}-${rangeEnd} sent ${received} of ${expected} bytes`);
      }

      position = last + 1;
    }

    if (plan.length === 0) {
      onProgress?.(100, 0, 0);
    }
  } catch (error) {
    await closeQuietly(local);
    await closeQuietly(out);
    await removeQuietly(outPath);
    throw error;
  }

  await local?.close();
  await out.close();

  const { size } = await stat(outPath);
  if (size !== map.filesize) {
    await removeQuietly(outPath);
    throw new Error(`assembled file has the wrong size: expected ${map.filesize} bytes, got ${size}`);
  }
  const digest = await hashFile(outPath);
  if (digest !== map.sha256) {
    await removeQuietly(outPath);
    throw new Error(`assembled file has the wrong sha256: expected ${map.sha256}, got ${digest}`);
  }
}

/** Read exactly `length` bytes from `position`; a short read mid-file is an error, not EOF. */
async function readExact(handle: FileHandle, buffer: Buffer, position: number, length: number): Promise<void> {
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead <= 0) {
      throw new Error(`unexpected end of local file while reading byte ${position + filled}`);
    }
    filled += bytesRead;
  }
}

/** A single write may be partial, so keep going until every byte is on disk. */
async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
    if (bytesWritten <= 0) {
      throw new Error('write to the assembled file made no progress');
    }
    offset += bytesWritten;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(VERIFY_CHUNK_SIZE);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function closeQuietly(handle: FileHandle | null): Promise<void> {
  if (handle === null) {
    return;
  }
  try {
    await handle.close();
  } catch {
    // The failure that brought us here is the one worth reporting.
  }
}

async function removeQuietly(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch {
    // Best effort: a leftover file only wastes disk, the thrown error is what counts.
  }
}
