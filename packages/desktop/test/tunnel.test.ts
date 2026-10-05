import { describe, expect, it } from 'vitest';
import { isPortFree, pickFreePort } from '../src/remote/tunnel.js';

describe('tunnel', () => {
  it('isPortFree rejects invalid ports including 0', async () => {
    expect(await isPortFree(0)).toBe(false);
    expect(await isPortFree(-1)).toBe(false);
    expect(await isPortFree(65536)).toBe(false);
    expect(await isPortFree(NaN)).toBe(false);
  });

  it('pickFreePort allocates a valid non-zero port', async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});
