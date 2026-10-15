/**
 * Tests for the network resilience banner, the layered health machine and the
 * manual retry interaction in `@agent/ui`.
 *
 * The SPA is one inline module with no importable exports, so the DOM contract
 * (markup, classes, ids, `data-state` values) and the wiring between the machine
 * and its side effects are asserted against the served file. The machine's own
 * clock and transitions are exercised for real in `reconnect-health.test.ts`,
 * which extracts the pure region and drives it with a fake clock.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.resolve(__dirname, '../public/index.html');
const i18nPath = path.resolve(__dirname, '../public/i18n.js');

describe('Network Resilience Banner & Retry Feedback', () => {
  it('defines required i18n keys for retrying and failure feedback in both locales', () => {
    const content = fs.readFileSync(i18nPath, 'utf8');
    expect(content).toContain("'net.banner.retrying': '正在重试…'");
    expect(content).toContain("'net.banner.retryFailed': '重新连接失败，服务暂不可用'");
    expect(content).toContain("'net.banner.retryFailedBtn': '重试失败'");
    expect(content).toContain("'net.banner.reload': '刷新页面'");

    expect(content).toContain("'net.banner.retrying': 'Retrying…'");
    expect(content).toContain("'net.banner.retryFailed': 'Reconnection failed, server unavailable'");
    expect(content).toContain("'net.banner.retryFailedBtn': 'Retry failed'");
    expect(content).toContain("'net.banner.reload': 'Reload page'");
  });

  it('defines the layered-reconnect i18n keys in both locales', () => {
    const content = fs.readFileSync(i18nPath, 'utf8');
    expect(content).toContain("'net.banner.reconnectNow': '立即重连'");
    expect(content).toContain("'net.composer.queued': '已排队 {n} 条'");
    expect(content).toContain("'net.composer.queuedHint': '连接恢复后将自动发送'");
    expect(content).toContain("'net.queue.cancel': '取消'");
    expect(content).toContain("'net.stream.resuming': '正在恢复生成…'");

    expect(content).toContain("'net.banner.reconnectNow': 'Reconnect now'");
    expect(content).toContain("'net.composer.queued': '{n} queued'");
    expect(content).toContain("'net.composer.queuedHint': 'Will send automatically when reconnected'");
    expect(content).toContain("'net.queue.cancel': 'Cancel'");
    expect(content).toContain("'net.stream.resuming': 'Resuming…'");

    // `net.banner.online` and `net.banner.retry` are gone: nothing in
    // `packages/ui/public/` reads them any more (the banner now hides on heal
    // and its button is `net.banner.reconnectNow`).
    expect(content).not.toContain("'net.banner.online':");
    expect(content).not.toContain("'net.banner.retry':");
  });

  it('contains proper retry button markup, no-drag properties, and disabled/spinner styles in index.html', () => {
    const html = fs.readFileSync(indexPath, 'utf8');

    // Markup. The DOWN banner's button now says "reconnect" (it re-establishes
    // the transport), but every id/class stays put.
    expect(html).toContain('id="btn-net-retry"');
    expect(html).toContain('class="siu-net-banner-btn no-drag"');
    expect(html).toContain('data-i18n="net.banner.reconnectNow"');
    expect(html).toContain('立即重连');
    expect(html).toContain('id="btn-net-reload"');
    expect(html).toContain('data-i18n="net.banner.reload"');

    // CSS — the banner's accepted design is untouched.
    expect(html).toContain('-webkit-app-region: no-drag;');
    expect(html).toContain('bottom: 92px;');
    expect(html).toContain('border-radius: 9999px;');
    expect(html).toContain('z-index: 75;');
    expect(html).toContain('.siu-net-banner-btn:disabled');
    expect(html).toContain(".siu-net-banner-btn[data-state='error']");
    expect(html).toContain('.siu-net-spinner');
    expect(html).toContain('animation: siu-spin');
  });

  it('implements handleManualNetworkRetry with reconnectTransport, debounce, spinner, and error feedback', () => {
    const html = fs.readFileSync(indexPath, 'utf8');

    // Logic guards
    expect(html).toContain('async function handleManualNetworkRetry()');
    expect(html).toContain('function handleRetryFailure()');
    expect(html).toContain('if (netState.retrying) return;');
    // The click path now also asks the desktop shell to re-establish the
    // transport, fire-and-forget and guarded.
    expect(html).toContain('window.superiuDesktop?.reconnectTransport?.()');
    expect(html).toContain("dot.dataset.status = 'thinking'");
    expect(html).toContain('btnRetry.disabled = true');
    expect(html).toContain('siu-net-spinner');
    expect(html).toContain("tr('net.banner.retrying')");
    expect(html).toContain("tr('net.banner.retryFailed')");
    expect(html).toContain("tr('net.banner.retryFailedBtn')");
    expect(html).toContain("toast(tr('net.banner.retryFailed'), 'error')");
    expect(html).toContain('handleManualNetworkRetry()');
  });

  it('keeps the existing escalation: reload only after two failed explicit reconnects', () => {
    const html = fs.readFileSync(indexPath, 'utf8');
    expect(html).toContain('manualRetryCount += 1;');
    expect(html).toContain("if (btnReload && manualRetryCount >= 2 && netState.status !== 'online') {");
  });
});

describe('Layered health machine wiring', () => {
  const html = fs.readFileSync(indexPath, 'utf8');

  it('replaces the binary driver with the four-state machine and a single config object', () => {
    // The old two-strikes rule is gone; the clock decides.
    expect(html).not.toContain('netState.consecutiveFailures >= 2');
    expect(html).not.toContain('function setConnectionState(next)');

    expect(html).toContain('const NET_HEALTH_CONFIG = {');
    expect(html).toContain('degradedAfterMs: 3000');
    expect(html).toContain('downAfterMs: 15000');
    expect(html).toContain('apiRetryDeadlineMs: 30000');
    expect(html).toContain('function createHealthMachine(options)');
    expect(html).toContain('const netHealth = createHealthMachine();');
    expect(html).toContain('netHealth.subscribe(applyHealthState);');
  });

  it('maps the machine onto the banner, the titlebar dot and the stale badge', () => {
    // Banner `data-state` vocabulary preserved.
    expect(html).toContain('banner.dataset.state = netState.status;');
    expect(html).toContain('function healthBannerState(health) {');
    // DEGRADED is ambient only — the banner must stay hidden.
    expect(html).toContain('banner.hidden = true;');
    // Amber pulse on the titlebar dot at DEGRADED.
    expect(html).toContain("dot.dataset.status = 'tool_calling';");
    expect(html).toContain("dot.classList.add('siu-pulse');");
    // DOWN is deterministic: red, no pulse.
    expect(html).toContain("dot.dataset.status = 'error';");
    expect(html).toContain("dot.classList.remove('siu-pulse');");
    // HEALTHY hands the dot back to the connection UI.
    expect(html).toContain('updateConnectionUI(activeConnectionInfo);');
    // RECOVERING stays silent (no stale badge).
    expect(html).toContain("const ambient = health === 'DEGRADED' || health === 'DOWN';");
  });

  it('makes the machine the sole owner of the dot while an episode is active', () => {
    // updateConnectionUI stands down on non-HEALTHY states, so the two writers
    // cannot fight and a probe-driven recovery cannot leave the dot amber.
    expect(html).toContain("const machineOwnsDot = netHealth.state !== 'HEALTHY';");
    expect(html).toContain('const setDotStatus = (status) => {');
    expect(html).toContain('if (machineOwnsDot) return;');
    // All seven former direct writes now route through the guard.
    expect(html).not.toMatch(/\n\s+dot\.dataset\.status = 'idle';/);
    expect(html).toContain("setDotStatus('idle');");
    expect(html).toContain("setDotStatus('tool_calling');");
    expect(html).toContain("setDotStatus('completed');");
    expect(html).toContain("setDotStatus('error');");
  });

  it('re-checks the heal deadline and backs off so a flapping link cannot spin', () => {
    expect(html).toContain('const healed = await netHealth.waitHealthy(healUntil - Date.now());');
    // The budget is re-checked AFTER the wait, before another request fires.
    expect(html).toContain('if (healed && Date.now() < healUntil) {');
    // A breathe between heal cycles.
    expect(html).toContain('await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 250));');
  });

  it('drives the machine from every hook the spec names', () => {
    // api() failure reports to the shell, guarded and fire-and-forget.
    expect(html).toContain('window.superiuDesktop?.reportNetworkFailure?.()');
    // Bridge pushes drive the machine and seed the clock.
    expect(html).toContain('function applyTransportSignal(info) {');
    expect(html).toContain("if (info.transport === 'ok') {");
    expect(html).toContain("info.transport === 'tunnel-restarting'");
    expect(html).toContain("info.transport === 'gateway-reconnecting'");
    expect(html).toContain("info.transport === 'server-unreachable'");
    expect(html).toContain('markTransportDown(info.downSinceMs);');
    // online/offline/visibility feed it.
    expect(html).toContain('netHealth.refresh(true);');
    expect(html).toContain("netHealth.state !== 'HEALTHY'");
    // api() GETs heal by waiting for HEALTHY within the per-call deadline.
    expect(html).toContain('await netHealth.waitHealthy(healUntil - Date.now())');
  });

  it('queues held prompts and drains them on recovery', () => {
    expect(html).toContain('const pendingQueue = createPendingQueue({');
    expect(html).toContain("storageKey: 'superiu.pendingQueue'");
    expect(html).toContain('function enqueuePendingPrompt(text) {');
    expect(html).toContain('function renderComposerQueueHint() {');
    expect(html).toContain('function renderQueuedPrompt(item) {');
    expect(html).toContain('function restorePendingQueue() {');
    expect(html).toContain('async function drainPendingQueue() {');
    // The queue drains through the normal sendPrompt path, holding on `busy`.
    expect(html).toContain('await sendPrompt(item.text, { fromQueue: true })');
    expect(html).toContain('if (opts.fromQueue && response.status === 409) {');
    // submit() queues instead of dropping while below HEALTHY.
    expect(html).toContain("if (netHealth.state !== 'HEALTHY') {");
    expect(html).toContain('enqueuePendingPrompt(value.trim());');
    // Restored across a reload and drained once boot is done.
    expect(html).toContain('restorePendingQueue();');
    expect(html).toContain('void drainPendingQueue();');
  });
});

describe('Stream hold-and-reattach wiring', () => {
  const html = fs.readFileSync(indexPath, 'utf8');

  it('tracks the resume point and dedupes a replay through the shared dispatch', () => {
    expect(html).toContain('const seqTracker = createSeqTracker();');
    // Every frame — initial POST and reattach alike — goes through the dedupe.
    expect(html).toContain('if (!seqTracker.accept(event)) return;');
    expect(html).toContain('classifyStreamEnd({ aborted: false, terminal: terminalSeen })');
    // A position-less `sync` frame is handled but never advances the point.
    expect(html).toContain('if (event.type === SSE_FRAME_SYNC && event.activeTurn === null) syncIdle = true;');
  });

  it('holds on a mid-stream drop and reattaches from the last seqId', () => {
    expect(html).toContain('const pumpTurn = async () => {');
    expect(html).toContain("showResumeNote();");
    // The hold waits on the health clock within the shared deadline.
    expect(html).toContain('netHealth.waitHealthy(maxWaitMs)');
    expect(html).toContain('waitHealthyOrAbort(controller.signal, NET_HEALTH_CONFIG.apiRetryDeadlineMs)');
    // Reattach replays exactly the missed tail, then continues live.
    expect(html).toContain("fetch('/api/chat/stream?fromSeqId=' + seqTracker.lastSeqId");
  });

  it('reattaches even when the status probe reports no active turn', () => {
    // The server retains the terminal journal, so a null `activeTurn` does NOT
    // mean "reconcile": the reattach GET is still attempted so the missed
    // `chunk` frames (the answer text) replay through the `done` handler.
    expect(html).not.toContain('if (!statusPayload.activeTurn) return STREAM_OUTCOME.RECONCILE;');
    // A failed probe is still just another drop.
    expect(html).toContain('if (!statusPayload) continue;');
    // RECONCILE is driven ONLY by the reattach stream's `sync` frame.
    expect(html).toContain('if (syncIdle) return STREAM_OUTCOME.RECONCILE;');
    // The probe reads the status but the flow falls through to the reattach GET.
    expect(html).toContain('const statusPayload = await refreshStatus({ signal: controller.signal });');
  });

  it('forwards the abort signal into the status probe so Stop is responsive', () => {
    expect(html).toContain("api('/api/status', { signal: options.signal })");
    expect(html).toContain('const statusPayload = await refreshStatus({ signal: controller.signal });');
  });

  it('renders the resuming indicator with the existing note and key, and removes it', () => {
    expect(html).toContain("resumeNote = systemNote(tr('net.stream.resuming'));");
    // Cleared on every exit: terminal, abort, reconcile and fallback.
    expect(html).toContain('clearResumeNote();');
    expect(html).toContain('resumeNote.remove();');
    // No new visual language: the indicator is a plain note row.
    expect(html).not.toContain('siu-stream-resuming');
  });

  it('no longer unconditionally appends net.streamInterrupted on a mid-stream drop', () => {
    // The old "any non-abort read failure → interrupted" catch is gone.
    expect(html).not.toContain("if (err.name !== 'AbortError') {");
    // The note now appears in exactly ONE place: the spent-budget fallback.
    const sites = html.split("tr('net.streamInterrupted')").length - 1;
    expect(sites).toBe(1);
    expect(html).toContain('if (outcome === STREAM_OUTCOME.INTERRUPTED) {');
    expect(html).toContain("if (contentReceived) turn.appendChild(systemNote(tr('net.streamInterrupted'), 'error'));");
    // Reconcile closes the turn cleanly instead of erroring.
    expect(html).toContain('if (outcome === STREAM_OUTCOME.RECONCILE) {');
    expect(html).toContain('collapseTurnSteps();');
  });

  it('keeps the explicit abort path untouched', () => {
    expect(html).toContain("if (outcome === STREAM_OUTCOME.ABORTED) {");
    expect(html).toContain("turn.appendChild(systemNote(tr('transcript.aborted')));");
    expect(html).toContain('async function abortTurn() {');
  });
});
