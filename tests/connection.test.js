/**
 * Tests for CDP target selection in src/connection.js.
 * The desktop app exposes internal file:// pages alongside the real chart tabs, so
 * selection must key on the tradingview.com host rather than the substring
 * "tradingview" — see pickChartTarget().
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickChartTarget } from '../src/connection.js';

// The app's internal container page. On Windows MSIX the install path itself contains
// "TradingView.Desktop", which is what defeated the old loose match.
const CONTAINER = {
  type: 'page',
  id: 'container',
  url: 'file:///C:/Program%20Files/WindowsApps/TradingView.Desktop_3.3.0.7992_x64__n534cwy3pjxzj/resources/app.asar/app/browser-api-container/index.html',
};
const CHART = { type: 'page', id: 'chart', url: 'https://www.tradingview.com/chart/KPT1bD7n/' };
const SCREENER = { type: 'page', id: 'screener', url: 'https://www.tradingview.com/etf-screener/' };

describe('pickChartTarget()', () => {
  it('prefers a chart page', () => {
    assert.equal(pickChartTarget([CONTAINER, SCREENER, CHART])?.id, 'chart');
  });

  it('ignores the app container page even when it is the only "tradingview" match', () => {
    // Regression: the container was selected and then cached, leaving every tool
    // reporting api_available:false until the process restarted.
    assert.equal(pickChartTarget([CONTAINER]), null);
  });

  it('falls back to another tradingview.com page when no chart is open', () => {
    assert.equal(pickChartTarget([CONTAINER, SCREENER])?.id, 'screener');
  });

  it('ignores non-page targets such as workers', () => {
    const worker = { type: 'worker', id: 'w', url: 'https://www.tradingview.com/chart/abc/' };
    assert.equal(pickChartTarget([worker]), null);
  });

  it('does not match a lookalike host', () => {
    const spoof = { type: 'page', id: 'spoof', url: 'https://nottradingview.com/chart/x/' };
    assert.equal(pickChartTarget([spoof]), null);
  });

  it('matches chart pages on a subdomain', () => {
    const sub = { type: 'page', id: 'sub', url: 'https://in.tradingview.com/chart/abc/' };
    assert.equal(pickChartTarget([sub])?.id, 'sub');
  });

  it('tolerates empty, missing, and malformed target lists', () => {
    assert.equal(pickChartTarget([]), null);
    assert.equal(pickChartTarget(undefined), null);
    assert.equal(pickChartTarget([{ type: 'page' }, null, { url: 'x' }]), null);
  });
});
