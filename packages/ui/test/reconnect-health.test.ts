/**
 * Focused tests for the pure reconnection core.
 *
 * The SPA ships as one inline module with no importable exports, so the pure
 * health clock and pending-prompt queue are delimited by sentinel comments in
 * `index.html`. This suite extracts exactly that region and evaluates it, so the
 * SHIPPED logic runs under a fake clock and an in-memory storage — not a
 * re-implementation that could drift from it. The DOM contract is asserted
 * separately in `network-banner.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.resolve(__dirname, '../public/index.html');

const START_MARKER = '// >>> NET-HEALTH-PURE-START';
const END_MARKER = '// >>> NET-HEALTH-PURE-END';

interface HealthMachine {
  readonly state: string;
  elapsedMs(): number;
  downSinceMs(): number;
  subscribe(cb: (state: string) => void): () => void;
  fail(meta?: { downSinceMs?: number; online?: boolean }): string;
  succeed(): string;
  refresh(online?: boolean): string;
  waitHealthy(maxWaitMs?: number): Promise<boolean>;
  dispose(): void;
}

interface QueueItem {
  id: string;
  text: string;
  at: number;
}

interface PendingQueue {
  restore(): QueueItem[];
  size(): number;
  list(): QueueItem[];
  peek(): QueueItem | null;
  enqueue(text: string): QueueItem;
  remove(id: string): void;
  dequeue(): QueueItem | null;
  clear(): void;
}

interface MachineOptions {
  config?: Record<string, number>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

interface QueueOptions {
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  storageKey?: string;
  now?: () => number;
}

interface SeqTracker {
  readonly lastSeqId: number;
  accept(event: { seqId?: number; type?: string }): boolean;
}

interface PureApi {
  NET_HEALTH_CONFIG: Record<string, number>;
  createHealthMachine(options?: MachineOptions): HealthMachine;
  createPendingQueue(options?: QueueOptions): PendingQueue;
  healthBannerState(health: string): string;
  createSeqTracker(): SeqTracker;
  classifyStreamEnd(meta: { aborted?: boolean; terminal?: boolean }): string;
  MAX_STREAM_REATTACH_ATTEMPTS: number;
  SSE_FRAME_SYNC: string;
  STREAM_OUTCOME: Record<string, string>;
}

function loadPureLogic(): PureApi {
  const html = fs.readFileSync(indexPath, 'utf8');
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const source = html.slice(start, end);
  // `new Function` because the region is inline module code with no exports.
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    source +
      '\nreturn { NET_HEALTH_CONFIG, createHealthMachine, createPendingQueue, healthBannerState,' +
      ' createSeqTracker, classifyStreamEnd, MAX_STREAM_REATTACH_ATTEMPTS, SSE_FRAME_SYNC, STREAM_OUTCOME };'
  );
  return factory() as PureApi;
}

/** A deterministic clock + timer queue, so the windows run without sleeping. */
function makeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  const timers: Array<{ fn: () => void; at: number }> = [];
  const run = () => {
    timers.sort((a, b) => a.at - b.at);
    while (timers.length && timers[0].at <= now) {
      const next = timers.shift();
      next?.fn();
    }
  };
  return {
    now: () => now,
    at: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const handle = { fn, at: now + ms };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle: unknown) => {
      const index = timers.indexOf(handle as { fn: () => void; at: number });
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      now += ms;
      run();
    },
    run
  };
}

function makeMachine(api: PureApi, clock: ReturnType<typeof makeClock>, config?: Record<string, number>) {
  return api.createHealthMachine({ config, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
}

function memoryStorage(seed: Record<string, string> = {}) {
  const store = { ...seed };
  return {
    store,
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    }
  };
}

describe('Pure health machine', () => {
  const api = loadPureLogic();

  it('ships the layered thresholds in one config object', () => {
    expect(api.NET_HEALTH_CONFIG.degradedAfterMs).toBe(3000);
    expect(api.NET_HEALTH_CONFIG.downAfterMs).toBe(15000);
    expect(api.NET_HEALTH_CONFIG.apiRetryDeadlineMs).toBe(30000);
  });

  it('walks RECOVERING → DEGRADED → DOWN from the FIRST failure of an episode', () => {
    const clock = makeClock();
    const machine = makeMachine(api, clock);

    expect(machine.state).toBe('HEALTHY');
    machine.fail({ online: true });
    expect(machine.state).toBe('RECOVERING');

    clock.advance(2999);
    expect(machine.state).toBe('RECOVERING');

    clock.advance(1);
    expect(machine.state).toBe('DEGRADED');

    clock.advance(11999);
    expect(machine.state).toBe('DEGRADED');

    clock.advance(1);
    expect(machine.state).toBe('DOWN');
  });

  it('measures from the first failure, not from each probe', () => {
    const clock = makeClock();
    const machine = makeMachine(api, clock);

    machine.fail({ online: true });
    clock.advance(2000);
    // A second failure mid-episode must NOT restart the window.
    machine.fail({ online: true });
    clock.advance(1000);
    expect(machine.state).toBe('DEGRADED');
  });

  it('seeds the clock from downSinceMs so a late observer sees the real elapsed time', () => {
    const clock = makeClock();
    const machine = makeMachine(api, clock);
    machine.fail({ online: true, downSinceMs: clock.now() - 5000 });
    expect(machine.state).toBe('DEGRADED');
    expect(machine.elapsedMs()).toBe(5000);
  });

  it('collapses straight to HEALTHY on a confirmed success', () => {
    const clock = makeClock();
    const machine = makeMachine(api, clock);
    machine.fail({ online: true });
    clock.advance(4000);
    expect(machine.state).toBe('DEGRADED');
    machine.succeed();
    expect(machine.state).toBe('HEALTHY');
    expect(machine.downSinceMs()).toBe(0);
  });

  it('fast-paths to DOWN when navigator.onLine is false', () => {
    const clock = makeClock();
    const machine = makeMachine(api, clock);
    machine.fail({ online: false });
    expect(machine.state).toBe('DOWN');
  });

  it('never treats navigator.onLine === true as proof of health', () => {
    const clock = makeClock();
    const machine = makeMachine(api, clock);
    machine.fail({ online: true });
    clock.advance(20000);
    expect(machine.state).toBe('DOWN');
    // Coming back online only re-evaluates; it cannot clear the episode.
    machine.refresh(true);
    expect(machine.state).toBe('DOWN');
  });

  it('maps health to the banner data-state vocabulary, hiding everything below DOWN', () => {
    expect(api.healthBannerState('HEALTHY')).toBe('online');
    expect(api.healthBannerState('RECOVERING')).toBe('online');
    expect(api.healthBannerState('DEGRADED')).toBe('degraded');
    expect(api.healthBannerState('DOWN')).toBe('offline');
  });

  it('notifies subscribers on every transition', () => {
    const clock = makeClock();
    const machine = makeMachine(api, clock);
    const seen: string[] = [];
    const unsubscribe = machine.subscribe((state) => seen.push(state));
    machine.fail({ online: true });
    clock.advance(3000);
    clock.advance(12000);
    machine.succeed();
    unsubscribe();
    machine.fail({ online: true });
    expect(seen).toEqual(['RECOVERING', 'DEGRADED', 'DOWN', 'HEALTHY']);
  });

  it('honours a shrunken config for tests', () => {
    const clock = makeClock();
    const machine = makeMachine(api, clock, { degradedAfterMs: 10, downAfterMs: 20 });
    machine.fail({ online: true });
    expect(machine.state).toBe('RECOVERING');
    clock.advance(10);
    expect(machine.state).toBe('DEGRADED');
    clock.advance(10);
    expect(machine.state).toBe('DOWN');
  });

  it('resolves waitHealthy on recovery and rejects the wait on the deadline', async () => {
    const clock = makeClock();
    const machine = makeMachine(api, clock);

    machine.fail({ online: true });
    const healed = machine.waitHealthy(30000);
    clock.advance(1000);
    machine.succeed();
    await expect(healed).resolves.toBe(true);

    machine.fail({ online: true });
    const stuck = machine.waitHealthy(500);
    clock.advance(500);
    await expect(stuck).resolves.toBe(false);
  });
});

describe('Pure pending queue', () => {
  const api = loadPureLogic();

  it('enqueues in order and dequeues FIFO', () => {
    const queue = api.createPendingQueue({ storage: memoryStorage() });
    queue.enqueue('first');
    queue.enqueue('second');
    expect(queue.size()).toBe(2);
    expect(queue.peek()?.text).toBe('first');
    expect(queue.dequeue()?.text).toBe('first');
    expect(queue.dequeue()?.text).toBe('second');
    expect(queue.dequeue()).toBeNull();
  });

  it('removes a canceled entry by id', () => {
    const queue = api.createPendingQueue({ storage: memoryStorage() });
    const a = queue.enqueue('keep');
    const b = queue.enqueue('cancel');
    queue.remove(b.id);
    expect(queue.list().map((item) => item.text)).toEqual(['keep']);
    expect(queue.peek()?.id).toBe(a.id);
  });

  it('persists and restores across a reload', () => {
    const storage = memoryStorage();
    const first = api.createPendingQueue({ storage, storageKey: 'q' });
    first.enqueue('one');
    first.enqueue('two');
    first.dequeue(); // 'one' sent

    const second = api.createPendingQueue({ storage, storageKey: 'q' });
    expect(second.restore().map((item) => item.text)).toEqual(['two']);
  });

  it('drops malformed persisted entries', () => {
    const storage = memoryStorage({ q: JSON.stringify([{ id: 'a', text: 'ok' }, { id: 'b' }, null, 'nope']) });
    const queue = api.createPendingQueue({ storage, storageKey: 'q' });
    expect(queue.restore().map((item) => item.text)).toEqual(['ok']);
  });

  it('rewrites the store after dropping malformed entries on restore', () => {
    const storage = memoryStorage({ q: JSON.stringify([{ id: 'a', text: 'ok' }, { id: 'b' }, null, 'nope']) });
    const queue = api.createPendingQueue({ storage, storageKey: 'q' });
    queue.restore();
    // The cleaned list is durable, so the corrupt entries are not re-parsed and
    // re-dropped on every reload.
    expect(JSON.parse(storage.store.q)).toEqual([{ id: 'a', text: 'ok' }]);
  });

  it('survives storage that throws (private mode)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      }
    };
    const queue = api.createPendingQueue({ storage: throwing });
    queue.enqueue('still works');
    expect(queue.size()).toBe(1);
    expect(queue.restore()).toEqual([]);
  });
});

describe('Pure stream-reattach core', () => {
  const api = loadPureLogic();

  it('tracks the highest seqId and starts at 0', () => {
    const tracker = api.createSeqTracker();
    expect(tracker.lastSeqId).toBe(0);
    expect(tracker.accept({ seqId: 1, type: 'chunk' })).toBe(true);
    expect(tracker.lastSeqId).toBe(1);
    expect(tracker.accept({ seqId: 2, type: 'chunk' })).toBe(true);
    expect(tracker.lastSeqId).toBe(2);
  });

  it('skips a replayed frame at or below the resume point', () => {
    const tracker = api.createSeqTracker();
    tracker.accept({ seqId: 5, type: 'chunk' });
    // A reattach replays from lastSeqId; the boundary frame and anything older
    // are duplicates and must not be applied twice.
    expect(tracker.accept({ seqId: 5, type: 'chunk' })).toBe(false);
    expect(tracker.accept({ seqId: 4, type: 'chunk' })).toBe(false);
    expect(tracker.lastSeqId).toBe(5);
    // A strictly higher id is the next frame: apply it.
    expect(tracker.accept({ seqId: 6, type: 'chunk' })).toBe(true);
    expect(tracker.lastSeqId).toBe(6);
  });

  it('applies a position-less frame without advancing the resume point', () => {
    const tracker = api.createSeqTracker();
    tracker.accept({ seqId: 3, type: 'chunk' });
    // The `sync` probe carries no seqId: it must be handled, but it is not a
    // position and must not move the resume point.
    expect(tracker.accept({ type: api.SSE_FRAME_SYNC, activeTurn: null })).toBe(true);
    expect(tracker.lastSeqId).toBe(3);
  });

  it('classifies terminal, dropped and aborted stream ends', () => {
    expect(api.classifyStreamEnd({ terminal: true })).toBe('terminal');
    expect(api.classifyStreamEnd({})).toBe('dropped');
    expect(api.classifyStreamEnd({ aborted: true })).toBe('aborted');
    // An abort wins even if a terminal frame was seen: the explicit Stop owns
    // the transcript, not the hold machinery.
    expect(api.classifyStreamEnd({ aborted: true, terminal: true })).toBe('aborted');
  });

  it('bounds the reattach loop and names its outcomes', () => {
    expect(api.MAX_STREAM_REATTACH_ATTEMPTS).toBeGreaterThan(0);
    expect(api.STREAM_OUTCOME.TERMINAL).toBe('terminal');
    expect(api.STREAM_OUTCOME.INTERRUPTED).toBe('interrupted');
    expect(api.STREAM_OUTCOME.RECONCILE).toBe('reconcile');
    expect(api.SSE_FRAME_SYNC).toBe('sync');
  });
});
