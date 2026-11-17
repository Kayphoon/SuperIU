/**
 * Lifecycle tests for {@link NativeCapture}.
 *
 * Each test runs a real child process and drives the same stdin/stdout contract
 * the Swift helper implements. The fake helper is a generated Node script, not
 * a stub of `spawn`: it exits only when the production code sends `quit` or
 * closes stdin, so a broken stop path leaves a live process behind.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeCapture, isNativeCaptureSupported } from '../src/native_capture.js';

type HelperMode = 'quit' | 'eof' | 'stubborn' | 'delayed';

let dir: string;
let captures: NativeCapture[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'native-capture-test-'));
  captures = [];
});

afterEach(async () => {
  for (const capture of captures.splice(0)) await capture.stop();
  rmSync(dir, { recursive: true, force: true });
});

function writeHelper(mode: HelperMode, marker: string): string {
  const probe = `
import { appendFileSync } from 'node:fs';
const marker = ${JSON.stringify(marker)};
const append = (line) => appendFileSync(marker, line + '\\n');
append('pid:' + process.pid);
`;

  const body: Record<HelperMode, string> = {
    quit: `
process.stdout.write('SUPERIU_NATIVE_READY\\n');
append('ready');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let newline;
  while ((newline = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, newline);
    buf = buf.slice(newline + 1);
    append('line:' + line);
    if (line === 'quit') {
      append('quit');
      process.exit(0);
    }
  }
});
process.stdin.on('end', () => {
  append('eof');
  process.exit(0);
});
`,
    eof: `
process.stdout.write('SUPERIU_NATIVE_READY\\n');
append('ready');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let newline;
  while ((newline = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, newline);
    buf = buf.slice(newline + 1);
    if (line === 'quit') append('ignored:quit');
  }
});
process.stdin.on('end', () => {
  append('eof');
  process.exit(0);
});
`,
    stubborn: `
process.on('SIGTERM', () => {});
process.stdin.resume();
process.stdout.write('SUPERIU_NATIVE_READY\\n');
append('ready');
setInterval(() => {}, 1000);
`,
    delayed: `
const timer = setTimeout(() => {
  process.stdout.write('SUPERIU_NATIVE_READY\\n');
  append('ready');
}, 500);
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  clearTimeout(timer);
  append('eof');
  process.exit(0);
});
`
  };

  const script = path.join(dir, `${mode}.mjs`);
  writeFileSync(script, `#!/usr/bin/env node\n${probe}\n${body[mode]}`, 'utf-8');
  chmodSync(script, 0o755);
  return script;
}

function markerLines(marker: string): string[] {
  if (!existsSync(marker)) return [];
  return readFileSync(marker, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidFrom(marker: string): number {
  const line = markerLines(marker).find((entry) => entry.startsWith('pid:'));
  if (!line) throw new Error('helper recorded no pid');
  return Number.parseInt(line.slice('pid:'.length), 10);
}

function makeCapture(binaryPath: string, stopTimeoutMs = 2_000): NativeCapture {
  const capture = new NativeCapture({
    binaryPath,
    readyTimeoutMs: 5_000,
    stopTimeoutMs,
    log: () => {}
  });
  captures.push(capture);
  return capture;
}

describe('isNativeCaptureSupported', () => {
  it('allows only macOS 14 and newer', () => {
    expect(isNativeCaptureSupported('linux', '6.17.0')).toBe(false);
    expect(isNativeCaptureSupported('darwin', '13.6.0')).toBe(false);
    expect(isNativeCaptureSupported('darwin', '14.0.0')).toBe(true);
  });
});

describe('NativeCapture', () => {
  it('starts one helper for concurrent start calls and exits it on quit', async () => {
    const marker = path.join(dir, 'quit.log');
    const capture = makeCapture(writeHelper('quit', marker));

    const [first, second] = await Promise.all([capture.start(), capture.start()]);
    expect(first).toBe(true);
    expect(second).toBe(true);

    const pid = pidFrom(marker);
    await capture.stop();

    const lines = markerLines(marker);
    expect(lines.filter((line) => line.startsWith('pid:'))).toHaveLength(1);
    expect(lines.filter((line) => line === 'ready')).toHaveLength(1);
    expect(lines.filter((line) => line === 'quit')).toHaveLength(1);
    expect(lines).not.toContain('eof');
    expect(isAlive(pid)).toBe(false);
  });

  it('exits a helper that ignores quit once stdin closes', async () => {
    const marker = path.join(dir, 'eof.log');
    const capture = makeCapture(writeHelper('eof', marker));

    expect(await capture.start()).toBe(true);
    const pid = pidFrom(marker);

    await capture.stop();

    expect(markerLines(marker)).toEqual([
      expect.stringMatching(/^pid:/),
      'ready',
      'ignored:quit',
      'eof'
    ]);
    expect(isAlive(pid)).toBe(false);
  });

  it('completes an idempotent close while start is still settling', async () => {
    const marker = path.join(dir, 'slow.log');
    const capture = makeCapture(writeHelper('delayed', marker));

    const start = capture.start();
    const stop = capture.stop();
    expect(capture.stop()).toBe(stop);

    expect(await start).toBe(false);
    await stop;

    const lines = markerLines(marker);
    expect(lines.filter((line) => line.startsWith('pid:'))).toHaveLength(1);
    expect(lines).not.toContain('ready');
    expect(lines).toContain('eof');
  });

  it('force-kills an unresponsive helper after the stop timeout', async () => {
    const marker = path.join(dir, 'stubborn.log');
    const capture = makeCapture(writeHelper('stubborn', marker), 200);

    expect(await capture.start()).toBe(true);
    const pid = pidFrom(marker);

    await capture.stop();

    expect(isAlive(pid)).toBe(false);
  });

  it('reports a missing helper without throwing', async () => {
    const logs: string[] = [];
    const binaryPath = path.join(dir, 'missing-helper');
    const capture = new NativeCapture({
      binaryPath,
      readyTimeoutMs: 500,
      stopTimeoutMs: 200,
      log: (_level, message) => logs.push(message)
    });
    captures.push(capture);

    expect(await capture.start()).toBe(false);
    expect(logs.join('\n')).toContain(binaryPath);
  });
});
