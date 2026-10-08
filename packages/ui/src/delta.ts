import { createReadStream } from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';

/**
 * Patch container magic: five ASCII bytes `SUIU1`, immediately followed by a
 * one-byte format version. Kept as a literal so a stale client can reject a
 * newer patch by reading five bytes.
 */
export const DELTA_MAGIC = 'SUIU1';

/** On-disk patch format version understood by this module. */
export const DELTA_VERSION = 1;

/**
 * Plaintext prefix length: 5 (magic) + 1 (version) + 4 (sourceSize) + 32
 * (sourceSha256) + 4 (targetSize) + 32 (targetSha256). The header is
 * deliberately not gzipped so a client can preflight a patch with a single
 * small range request instead of downloading the whole body.
 */
export const DELTA_HEADER_SIZE = 78;

export interface DeltaHeader {
  version: number;
  sourceSize: number;
  sourceSha256: string;
  targetSize: number;
  targetSha256: string;
}

/**
 * Content-defined chunking bounds. MIN/MAX keep chunks near the 64 KiB average
 * implied by MASK while bounding the hash work per chunk.
 */
const MIN_CHUNK = 8192;
const MASK = 0xFFFF;
const MAX_CHUNK = 131072;

/**
 * 256-entry gear table from a fixed LCG (Numerical Recipes multiplier).
 * Constants are literal rather than seeded from the clock so chunk boundaries —
 * and therefore patch bytes — are identical across processes and runs.
 */
const GEAR = (() => {
  const table = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let i = 0; i < 256; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    table[i] = state;
  }
  return table;
})();

/**
 * Content-defined chunk boundaries over `buf`. The gear hash is reset per chunk
 * and a cut happens at the first hash whose low 16 bits are zero, never before
 * MIN_CHUNK and never after MAX_CHUNK bytes. Boundaries therefore follow the
 * bytes themselves: a region that only shifted keeps producing the same chunks
 * and stays reusable by the diff.
 */
function* chunkRanges(buf: Uint8Array): Generator<{ offset: number; length: number }> {
  let start = 0;
  while (start < buf.length) {
    let hash = 0;
    let end = start;
    const limit = Math.min(start + MAX_CHUNK, buf.length);
    while (end < limit) {
      hash = ((hash << 1) + GEAR[buf[end]]) >>> 0;
      end += 1;
      if (end - start >= MIN_CHUNK && (hash & MASK) === 0) break;
    }
    yield { offset: start, length: end - start };
    start = end;
  }
}

/** Lowercase hex sha256 of a byte range. */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Lowercase hex sha256 of a file, streamed so large files are never held whole. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Parse and validate the plaintext patch header; throws on any shape violation. */
export function parseDeltaHeader(buf: Uint8Array): DeltaHeader {
  // Re-view without copying when the caller already handed us a Buffer.
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.length < DELTA_HEADER_SIZE) {
    throw new Error(`delta patch too short: ${view.length} bytes, need at least ${DELTA_HEADER_SIZE}`);
  }
  const magic = view.toString('latin1', 0, 5);
  if (magic !== DELTA_MAGIC) {
    throw new Error(`bad delta magic: expected ${DELTA_MAGIC}, got ${JSON.stringify(magic)}`);
  }
  const version = view[5];
  if (version !== DELTA_VERSION) {
    throw new Error(`unsupported delta version ${version}, expected ${DELTA_VERSION}`);
  }
  return {
    version,
    sourceSize: view.readUInt32BE(6),
    sourceSha256: view.toString('hex', 10, 42),
    targetSize: view.readUInt32BE(42),
    targetSha256: view.toString('hex', 46, 78)
  };
}

/**
 * zlib's callback API promisified locally, keeping this module inside its
 * allowed imports (node:util is deliberately not pulled in). The executor form
 * is used because this package compiles against lib ES2022, where
 * `Promise.withResolvers` is not yet declared.
 */
function gzipAsync(data: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(data, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

function gunzipAsync(data: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(data, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

export interface DeltaStats {
  sourceSize: number;
  targetSize: number;
  patchSize: number;
  copyBytes: number;
  insertBytes: number;
}

/** COPY is a range of the source; INSERT is a verbatim run of the target. */
type Command = { copy: true; offset: number; length: number } | { copy: false; start: number; length: number };

/** Build a patch that reconstructs `targetPath` from `sourcePath`. */
export async function createDelta(sourcePath: string, targetPath: string, outPath: string): Promise<DeltaStats> {
  const source = await readFile(sourcePath);
  const target = await readFile(targetPath);
  if (source.length > 0xffffffff || target.length > 0xffffffff) {
    throw new Error('delta format addresses 32-bit sizes only');
  }

  const sourceSha = sha256Hex(source);
  const targetSha = sha256Hex(target);

  const dictionary = new Map<string, { offset: number; length: number }>();
  for (const chunk of chunkRanges(source)) {
    const key = sha256Hex(source.subarray(chunk.offset, chunk.offset + chunk.length));
    if (!dictionary.has(key)) dictionary.set(key, { offset: chunk.offset, length: chunk.length });
  }

  const commands: Command[] = [];
  let copyBytes = 0;
  let insertBytes = 0;
  let insertStart = 0;
  let insertLength = 0;

  const flushInsert = () => {
    if (insertLength > 0) {
      commands.push({ copy: false, start: insertStart, length: insertLength });
      insertStart = 0;
      insertLength = 0;
    }
  };

  for (const chunk of chunkRanges(target)) {
    const match = dictionary.get(sha256Hex(target.subarray(chunk.offset, chunk.offset + chunk.length)));
    if (match) {
      flushInsert();
      const previous = commands[commands.length - 1];
      if (previous && previous.copy && previous.offset + previous.length === match.offset) {
        previous.length += match.length;
      } else {
        commands.push({ copy: true, offset: match.offset, length: match.length });
      }
      copyBytes += chunk.length;
    } else {
      if (insertLength === 0) insertStart = chunk.offset;
      insertLength += chunk.length;
      insertBytes += chunk.length;
    }
  }
  flushInsert();

  const streamSize = commands.reduce((total, command) => total + (command.copy ? 9 : 5 + command.length), 0);
  const stream = Buffer.allocUnsafe(streamSize);
  let cursor = 0;
  for (const command of commands) {
    if (command.copy) {
      stream[cursor] = 0x01;
      stream.writeUInt32BE(command.offset, cursor + 1);
      stream.writeUInt32BE(command.length, cursor + 5);
      cursor += 9;
    } else {
      stream[cursor] = 0x02;
      stream.writeUInt32BE(command.length, cursor + 1);
      target.copy(stream, cursor + 5, command.start, command.start + command.length);
      cursor += 5 + command.length;
    }
  }

  const header = Buffer.alloc(DELTA_HEADER_SIZE);
  header.write(DELTA_MAGIC, 0, 'latin1');
  header[5] = DELTA_VERSION;
  header.writeUInt32BE(source.length, 6);
  Buffer.from(sourceSha, 'hex').copy(header, 10);
  header.writeUInt32BE(target.length, 42);
  Buffer.from(targetSha, 'hex').copy(header, 46);

  const body = await gzipAsync(stream);

  const handle = await open(outPath, 'w');
  try {
    await handle.write(header);
    await handle.write(body);
  } finally {
    await handle.close();
  }

  return {
    sourceSize: source.length,
    targetSize: target.length,
    patchSize: DELTA_HEADER_SIZE + body.length,
    copyBytes,
    insertBytes
  };
}

/**
 * Reconstruct the target from `sourcePath` + `patchPath` into `outPath`. The
 * source is checked against the header before any work, the command stream is
 * written straight to disk in target order, and the finished file is checked
 * for both size and sha256. Any failure removes `outPath` so the caller can
 * fall back to a full download without risking a half-written file.
 */
export async function applyDelta(sourcePath: string, patchPath: string, outPath: string): Promise<void> {
  let complete = false;
  try {
    const patch = await readFile(patchPath);
    const header = parseDeltaHeader(patch);

    const sourceInfo = await stat(sourcePath);
    if (sourceInfo.size !== header.sourceSize) {
      throw new Error(`delta source size mismatch: have ${sourceInfo.size}, patch expects ${header.sourceSize}`);
    }
    const source = await readFile(sourcePath);
    if (sha256Hex(source) !== header.sourceSha256) {
      throw new Error('delta source sha256 mismatch');
    }

    const stream = await gunzipAsync(patch.subarray(DELTA_HEADER_SIZE));

    const handle = await open(outPath, 'w');
    try {
      let cursor = 0;
      let written = 0;
      while (cursor < stream.length) {
        const tag = stream[cursor];
        if (tag === 0x01) {
          if (cursor + 9 > stream.length) throw new Error('delta command stream truncated in COPY command');
          const offset = stream.readUInt32BE(cursor + 1);
          const length = stream.readUInt32BE(cursor + 5);
          if (offset + length > source.length) throw new Error('delta COPY range outside source file');
          await handle.write(source.subarray(offset, offset + length));
          written += length;
          cursor += 9;
        } else if (tag === 0x02) {
          if (cursor + 5 > stream.length) throw new Error('delta command stream truncated in INSERT command');
          const length = stream.readUInt32BE(cursor + 1);
          if (cursor + 5 + length > stream.length) throw new Error('delta INSERT payload truncated');
          await handle.write(stream.subarray(cursor + 5, cursor + 5 + length));
          written += length;
          cursor += 5 + length;
        } else {
          throw new Error(`unknown delta command tag 0x${tag.toString(16)}`);
        }
      }
      if (written !== header.targetSize) {
        throw new Error(`delta produced ${written} bytes, patch declares ${header.targetSize}`);
      }
    } finally {
      await handle.close();
    }

    const produced = await stat(outPath);
    if (produced.size !== header.targetSize) {
      throw new Error(`delta output size mismatch: ${produced.size} != ${header.targetSize}`);
    }
    if ((await sha256File(outPath)) !== header.targetSha256) {
      throw new Error('delta output sha256 mismatch');
    }
    complete = true;
  } finally {
    if (!complete) await rm(outPath, { force: true });
  }
}
