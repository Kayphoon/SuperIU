/**
 * Seamless-reconnection tests for `POST /api/chat` and `GET /api/chat/stream`.
 *
 * A real ephemeral server is driven over HTTP with a parked `AgentRunner.run`,
 * so the SSE framing, the per-turn journal, the grace window and the reattach
 * replay are all exercised end to end rather than through mocks of the seams
 * under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner, type RunnerCallbacks } from '@agent/core';
import { startServer, type ServerHandle } from '../src/server.js';

interface SseFrame {
  type: string;
  seqId?: number;
  [key: string]: unknown;
}

/** Parse a `fetch` SSE body, handing each `data:` frame to `onFrame`. */
async function readSse(
  response: Response,
  onFrame: (frame: SseFrame) => boolean | void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        const frame = JSON.parse(dataLine.slice('data: '.length)) as SseFrame;
        if (onFrame(frame) === true) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
  } catch {
    // The client aborted mid-read: the disconnect under test, not a failure.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Seamless reconnection (chat turn journal)', () => {
  let handle: ServerHandle | undefined;
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'superiu-chat-reconnect-'));
  });

  afterEach(async () => {
    if (handle) {
      const closing = handle;
      handle = undefined;
      await closing.close();
    }
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function boot(chatGraceMs: number): Promise<void> {
    handle = await startServer({
      port: 0,
      host: '127.0.0.1',
      workspaceDir: workspace,
      quiet: true,
      webAuth: false,
      gatewayPath: null,
      mcpConfigPath: null,
      chatGraceMs
    });
  }

  /** Park the next `run()` so the turn stays in flight until `release()`. */
  function parkRun(): {
    captured: () => RunnerCallbacks;
    release: (text?: string) => void;
    instance: () => AgentRunner;
  } {
    let callbacks: RunnerCallbacks | undefined;
    let release!: (text?: string) => void;
    const spy = vi.spyOn(AgentRunner.prototype, 'run').mockImplementation(
      (_prompt: string, cbs?: RunnerCallbacks) =>
        new Promise<string>((resolve) => {
          callbacks = cbs;
          release = (text = 'final') => resolve(text);
        })
    );
    return {
      captured: () => callbacks!,
      release: (text?: string) => release(text),
      instance: () => spy.mock.instances[0] as AgentRunner
    };
  }

  async function status(): Promise<{ activeTurn: { turnId: string; lastSeqId: number } | null }> {
    const response = await fetch(`${handle!.url}/api/status`);
    return (await response.json()) as { activeTurn: { turnId: string; lastSeqId: number } | null };
  }

  async function startChat(signal?: AbortSignal): Promise<Response> {
    return fetch(`${handle!.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
      signal
    });
  }

  it('stamps strictly increasing seqId from 1 and reports the active turn', async () => {
    const parked = parkRun();
    await boot(10_000);

    const chat = await startChat();
    expect(chat.status).toBe(200);
    await vi.waitFor(() => expect(parked.captured()).toBeDefined());

    const frames: SseFrame[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const reading = readSse(chat, (frame) => {
      frames.push(frame);
      if (frame.type === 'done') {
        resolveDone();
        return true;
      }
    });

    const callbacks = parked.captured();
    callbacks.onStatusChange?.('running');
    callbacks.onChunk?.('a');
    callbacks.onChunk?.('b');

    await vi.waitFor(() => expect(frames.length).toBe(3));
    expect(frames.map((f) => f.seqId)).toEqual([1, 2, 3]);

    // While the turn is in flight the status carries the live journal head.
    const running = await status();
    expect(running.activeTurn).not.toBeNull();
    expect(running.activeTurn!.lastSeqId).toBe(3);
    expect(typeof running.activeTurn!.turnId).toBe('string');

    parked.release('final');
    await done;
    await reading;

    expect(frames.map((f) => f.seqId)).toEqual([1, 2, 3, 4]);
    expect(frames.map((f) => f.type)).toEqual(['status', 'chunk', 'chunk', 'done']);

    // Terminal: idle again, even though the journal is retained for catch-up.
    expect((await status()).activeTurn).toBeNull();
  });

  it('keeps the turn running and the journal intact when the socket drops', async () => {
    const parked = parkRun();
    const abortSpy = vi.spyOn(AgentRunner.prototype, 'abort');
    await boot(10_000);

    const controller = new AbortController();
    const chat = await startChat(controller.signal);
    await vi.waitFor(() => expect(parked.captured()).toBeDefined());

    const seen: SseFrame[] = [];
    const reading = readSse(chat, (frame) => {
      seen.push(frame);
    });

    parked.captured().onChunk?.('one');
    parked.captured().onChunk?.('two');
    await vi.waitFor(() => expect(seen.length).toBe(2));

    controller.abort();
    await reading;
    // Let the server observe the close before asserting.
    await sleep(50);

    // The turn is NOT aborted immediately, and its frames are still journaled.
    expect(abortSpy).not.toHaveBeenCalled();
    const running = await status();
    expect(running.activeTurn).not.toBeNull();
    expect(running.activeTurn!.lastSeqId).toBe(2);

    // Settle so the grace timer cannot outlive the test.
    parked.release('final');
    await vi.waitFor(async () => expect((await status()).activeTurn).toBeNull());
  });

  it('replays exactly the missed frames on reattach and continues to terminal', async () => {
    const parked = parkRun();
    await boot(10_000);

    const controller = new AbortController();
    const chat = await startChat(controller.signal);
    await vi.waitFor(() => expect(parked.captured()).toBeDefined());

    const seen: SseFrame[] = [];
    const reading = readSse(chat, (frame) => {
      seen.push(frame);
    });

    parked.captured().onStatusChange?.('running'); // seqId 1
    parked.captured().onChunk?.('one'); // seqId 2
    parked.captured().onChunk?.('two'); // seqId 3
    await vi.waitFor(() => expect(seen.length).toBe(3));

    controller.abort();
    await reading;

    // Frames produced while nobody is attached are journaled, not delivered.
    parked.captured().onChunk?.('three'); // seqId 4
    parked.captured().onChunk?.('four'); // seqId 5

    const stream = await fetch(`${handle!.url}/api/chat/stream?fromSeqId=2`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    const replayed: SseFrame[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const streamReading = readSse(stream, (frame) => {
      replayed.push(frame);
      if (frame.type === 'done') {
        resolveDone();
        return true;
      }
    });

    // A live frame after reattach, then the terminal frame.
    parked.captured().onChunk?.('five'); // seqId 6
    parked.release('final'); // seqId 7

    await done;
    await streamReading;

    // Exactly the frames after 2, in order: no duplicates, no gaps.
    expect(replayed.map((f) => f.seqId)).toEqual([3, 4, 5, 6, 7]);
    expect(replayed.map((f) => f.type)).toEqual(['chunk', 'chunk', 'chunk', 'chunk', 'done']);
  });

  it('aborts the turn when no client reattaches before the grace window', async () => {
    const parked = parkRun();
    const abortSpy = vi.spyOn(AgentRunner.prototype, 'abort');
    await boot(80);

    const controller = new AbortController();
    const chat = await startChat(controller.signal);
    await vi.waitFor(() => expect(parked.captured()).toBeDefined());

    const reading = readSse(chat, () => undefined);
    parked.captured().onChunk?.('x');
    controller.abort();
    await reading;

    await vi.waitFor(() => expect(abortSpy).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    // Settle the parked run so nothing leaks into the next test.
    parked.release('final');
    await vi.waitFor(async () => expect((await status()).activeTurn).toBeNull());
  });

  it('answers a stream request with a sync frame when no turn is active', async () => {
    await boot(1_000);

    const response = await fetch(`${handle!.url}/api/chat/stream?fromSeqId=0`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toBe('data: {"type":"sync","activeTurn":null}\n\n');
  });
});
