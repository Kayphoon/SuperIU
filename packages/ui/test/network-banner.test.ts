/**
 * Tests for the network resilience banner and manual retry interaction in `@agent/ui`.
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
    expect(content).toContain("'net.banner.retrying': 'Retrying…'");
    expect(content).toContain("'net.banner.retryFailed': 'Reconnection failed, server unavailable'");
  });

  it('contains proper retry button markup and disabled/spinner styles in index.html', () => {
    const html = fs.readFileSync(indexPath, 'utf8');

    // Markup
    expect(html).toContain('id="btn-net-retry"');
    expect(html).toContain('class="siu-net-banner-btn"');
    expect(html).toContain('data-i18n="net.banner.retry"');

    // CSS
    expect(html).toContain('.siu-net-banner-btn:disabled');
    expect(html).toContain('.siu-net-spinner');
    expect(html).toContain('animation: siu-spin');
  });

  it('implements handleManualNetworkRetry with debounce, spinner, and error toast feedback', () => {
    const html = fs.readFileSync(indexPath, 'utf8');

    // Logic guards
    expect(html).toContain('async function handleManualNetworkRetry()');
    expect(html).toContain('if (netState.retrying) return;');
    expect(html).toContain("dot.dataset.status = 'thinking'");
    expect(html).toContain("btnRetry.disabled = true");
    expect(html).toContain("siu-net-spinner");
    expect(html).toContain("tr('net.banner.retrying')");
    expect(html).toContain("tr('net.banner.retryFailed')");
    expect(html).toContain("toast(tr('net.banner.retryFailed'), 'error')");
    expect(html).toContain("handleManualNetworkRetry()");
  });
});
