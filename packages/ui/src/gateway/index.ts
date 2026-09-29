/**
 * `@agent/ui/gateway`
 *
 * The VPS Gateway: a WebSocket endpoint that the desktop/web client connects to
 * for remote agent control, streamed events, catch-up after reconnection, and
 * device-targeted RPC.
 */

export * from './errors.js';
export * from './registry.js';
export * from './event_hub.js';
export * from './server.js';
