/**
 * Guards the transport-health IPC contract.
 *
 * The preload bridge inlines the channel literals (it cannot import local
 * modules under `sandbox: true`); the compile-time annotations there pin them to
 * these constants, so this test locks the constants themselves against
 * accidental renames that would silently break the renderer.
 */

import { describe, expect, it } from 'vitest';
import { INVOKE } from '../src/ipc.js';

describe('ipc transport channels', () => {
  it('exposes the reconnect-transport invoke channel', () => {
    expect(INVOKE.reconnectTransport).toBe('superiu:reconnect-transport');
  });

  it('exposes the report-network-failure invoke channel', () => {
    expect(INVOKE.reportNetworkFailure).toBe('superiu:report-network-failure');
  });
});
