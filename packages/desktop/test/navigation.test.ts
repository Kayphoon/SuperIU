import { describe, expect, it } from 'vitest';
import {
  decideNavigationFailure,
  decideRenderProcessGone,
  NAV_RETRY_BASE_DELAY_MS,
  NAV_RETRY_DEADLINE_MS,
  NAV_RETRY_MAX_DELAY_MS,
  normalizeNavUrl,
  type NavigationFailure,
} from '../src/remote/navigation.js';

const SPA = 'http://127.0.0.1:52379/';

/** A main-frame failure of the remote SPA navigation, with overridable fields. */
function failure(over: Partial<NavigationFailure> = {}): NavigationFailure {
  return {
    errorCode: -102,
    errorDescription: 'ERR_CONNECTION_REFUSED',
    isMainFrame: true,
    url: SPA,
    targetUrl: SPA,
    attempts: 0,
    elapsedMs: 0,
    ...over,
  };
}

describe('normalizeNavUrl', () => {
  it('drops a bare trailing slash but keeps a real path', () => {
    expect(normalizeNavUrl('http://127.0.0.1:58992')).toBe(normalizeNavUrl('http://127.0.0.1:58992/'));
    expect(normalizeNavUrl('http://127.0.0.1:58992/deep')).toBe('http://127.0.0.1:58992/deep');
    expect(normalizeNavUrl('http://127.0.0.1:58992/a/')).toBe('http://127.0.0.1:58992/a/');
  });

  it('keeps opaque-origin URLs verbatim so they only match themselves', () => {
    // `new URL('data:…')` parses with origin "null"; normalizing it would compare "null".
    expect(normalizeNavUrl('data:text/html,<p>x</p>')).toBe('data:text/html,<p>x</p>');
    expect(normalizeNavUrl('file:///tmp/onboarding.html')).toBe('file:///tmp/onboarding.html');
  });

  it('keeps a status-page data URL from matching the SPA target', () => {
    expect(
      decideNavigationFailure(
        failure({ url: 'data:text/html,%3Cp%3Ex%3C/p%3E', errorCode: -102 })
      )
    ).toEqual({ kind: 'ignore' });
  });
});

describe('decideNavigationFailure', () => {
  it('ignores sub-frame failures', () => {
    expect(decideNavigationFailure(failure({ isMainFrame: false }))).toEqual({ kind: 'ignore' });
  });

  it('ignores ERR_ABORTED, which a superseding navigation produces', () => {
    expect(decideNavigationFailure(failure({ errorCode: -3, errorDescription: 'ERR_ABORTED' }))).toEqual(
      { kind: 'ignore' }
    );
  });

  it('ignores failures when no remote session is active', () => {
    expect(decideNavigationFailure(failure({ targetUrl: null }))).toEqual({ kind: 'ignore' });
  });

  it('ignores failures of a URL other than the SPA (e.g. the status page itself)', () => {
    expect(decideNavigationFailure(failure({ url: 'data:text/html;charset=utf-8,<p>x</p>' }))).toEqual(
      { kind: 'ignore' }
    );
  });

  it('matches Chromium\u2019s normalized URL against a bare-origin target', () => {
    // Chromium reports `http://127.0.0.1:58992/`; the connect result yields the origin.
    expect(
      decideNavigationFailure(failure({ url: SPA, targetUrl: 'http://127.0.0.1:52379' }))
    ).toEqual({ kind: 'retry', delayMs: NAV_RETRY_BASE_DELAY_MS });
  });

  it('does not confuse a different port or path with the target', () => {
    expect(decideNavigationFailure(failure({ targetUrl: 'http://127.0.0.1:52380' }))).toEqual({
      kind: 'ignore',
    });
    expect(decideNavigationFailure(failure({ url: 'http://127.0.0.1:52379/other' }))).toEqual({
      kind: 'ignore',
    });
  });

  it('backs off exponentially, capped at the maximum delay', () => {
    const delays = [0, 1, 2, 3, 4, 8].map((attempts) => {
      const decision = decideNavigationFailure(failure({ attempts }));
      if (decision.kind !== 'retry') throw new Error(`expected retry, got ${decision.kind}`);
      return decision.delayMs;
    });
    expect(delays).toEqual([
      NAV_RETRY_BASE_DELAY_MS,
      NAV_RETRY_BASE_DELAY_MS * 2,
      NAV_RETRY_BASE_DELAY_MS * 4,
      NAV_RETRY_BASE_DELAY_MS * 8,
      NAV_RETRY_MAX_DELAY_MS,
      NAV_RETRY_MAX_DELAY_MS,
    ]);
  });

  it('keeps retrying across the ssh tunnel restart backoff', () => {
    // The tunnel restarts on second-scale backoff; a 40s-old failure is still worth retrying.
    expect(decideNavigationFailure(failure({ attempts: 12, elapsedMs: 40_000 }))).toEqual({
      kind: 'retry',
      delayMs: NAV_RETRY_MAX_DELAY_MS,
    });
  });

  it('gives up with the description and error code once the deadline passes', () => {
    const decision = decideNavigationFailure(
      failure({ attempts: 20, elapsedMs: NAV_RETRY_DEADLINE_MS })
    );
    expect(decision.kind).toBe('failed');
    if (decision.kind !== 'failed') throw new Error('unreachable');
    expect(decision.message).toContain('ERR_CONNECTION_REFUSED');
    expect(decision.message).toContain('-102');
  });
});

describe('decideRenderProcessGone', () => {
  it('reloads the SPA after a crashed renderer', () => {
    expect(decideRenderProcessGone('crashed', SPA)).toBe('reload');
  });

  it('ignores a clean exit and any exit with no remote session', () => {
    expect(decideRenderProcessGone('clean-exit', SPA)).toBe('ignore');
    expect(decideRenderProcessGone('crashed', null)).toBe('ignore');
  });
});
