/**
 * Tests for src/core/capture.js — pure helpers + injected-deps integration.
 * No live CDP / TradingView needed; all dependencies mocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureScreenshot, computeZoomWindow, intradayMinutes,
  sanitizeFilename, isValidPng, findRegionBounds, waitForChartSettled,
  detectBlockingOverlay, ensureVisibleAndAutofit,
} from '../src/core/capture.js';
import {
  secPerBar, nearestTfKey, minBarsFor, expandRangeToMinBars, MIN_BARS_BY_TF,
} from '../src/core/timeframe.js';

// ── helpers ──────────────────────────────────────────────────────────────
const VALID_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const VALID_PNG_B64 = VALID_PNG.toString('base64');
const INVALID_BYTES_B64 = Buffer.from('not-a-png').toString('base64');

function makeDeps({ regionBounds = null, capturePayloadB64 = VALID_PNG_B64, visibleRange = null, resolution = '5', apiThrows = false, overlay = null, tighten = { n: 30, min: 100, max: 110, padded: 0.6 } } = {}) {
  const calls = { evaluate: [], evaluateAsync: [], setVisibleRange: [], getChartCollection: 0, captureScreenshot: [], write: [], mkdir: [] };
  const evaluate = async (expr) => {
    calls.evaluate.push(expr);
    if (/window\.innerWidth/.test(expr)) return overlay;            // detectBlockingOverlay probe
    if (/scaleReset|executeActionById/.test(expr)) return true;      // Y-axis autofit (TV native)
    if (/document\.querySelector/.test(expr)) return regionBounds;
    if (/resolution\(\)/.test(expr)) return resolution;
    return null;
  };
  const evaluateAsync = async (expr) => {
    calls.evaluateAsync.push(expr);
    if (/getVisibleRange/.test(expr)) return visibleRange;
    if (/requestAnimationFrame/.test(expr)) return null;
    return null;
  };
  const setVisibleRange = async (args) => { calls.setVisibleRange.push(args); };
  const getChartCollection = async () => { calls.getChartCollection++; if (apiThrows) throw new Error('boom'); return 'window.__col'; };
  const getClient = async () => ({
    Page: { captureScreenshot: async (params) => { calls.captureScreenshot.push(params); return { data: capturePayloadB64 }; } },
  });
  const write = (p, b) => { calls.write.push({ p, len: b.length }); };
  const mkdir = (p) => { calls.mkdir.push(p); };
  const sleep = async () => {};   // collapse time
  let _t = 1_700_000_000_000;
  const now = () => (_t += 50);   // monotonic so timeout eventually fires
  return { deps: { evaluate, evaluateAsync, setVisibleRange, getChartCollection, getClient, write, mkdir, sleep, now }, calls };
}

// ── pure helpers ─────────────────────────────────────────────────────────

test('intradayMinutes parses common timeframes', () => {
  assert.equal(intradayMinutes('5'), 5);
  assert.equal(intradayMinutes('60'), 60);
  assert.equal(intradayMinutes('1'), 1);
  assert.equal(intradayMinutes('4H'), 240);
  assert.equal(intradayMinutes('D'), null);
  assert.equal(intradayMinutes('1D'), null);
  assert.equal(intradayMinutes('W'), null);
  assert.equal(intradayMinutes('M'), null);
  assert.equal(intradayMinutes('garbage'), null);
});

test('computeZoomWindow centers intraday on NSE session midpoint (~06:55 UTC)', () => {
  const { center, halfWindow } = computeZoomWindow('2025-01-15', '5');
  const dt = new Date(center * 1000);
  assert.equal(dt.getUTCFullYear(), 2025);
  assert.equal(dt.getUTCMonth(), 0);
  assert.equal(dt.getUTCDate(), 15);
  assert.equal(dt.getUTCHours(), 6);
  assert.equal(dt.getUTCMinutes(), 55);
  assert.equal(halfWindow, 4 * 3600);
});

test('computeZoomWindow daily centers on 12:00 UTC, ±15d', () => {
  const { center, halfWindow } = computeZoomWindow('2025-06-10', 'D');
  const dt = new Date(center * 1000);
  assert.equal(dt.getUTCHours(), 12);
  assert.equal(halfWindow, 15 * 86400);
});

test('computeZoomWindow weekly/monthly halfWindows', () => {
  assert.equal(computeZoomWindow('2025-06-10', 'W').halfWindow, 91 * 86400);
  assert.equal(computeZoomWindow('2025-06-10', 'M').halfWindow, 182 * 86400);
});

test('computeZoomWindow hourly = ±2 days', () => {
  assert.equal(computeZoomWindow('2025-06-10', '60').halfWindow, 2 * 86400);
  assert.equal(computeZoomWindow('2025-06-10', '4H').halfWindow, 2 * 86400);
});

test('computeZoomWindow throws on bad date', () => {
  assert.throws(() => computeZoomWindow('not-a-date', 'D'), /Invalid date/);
});

test('sanitizeFilename strips unsafe chars + caps length', () => {
  assert.equal(sanitizeFilename('foo/bar:baz?.png'), 'foo_bar_baz_.png');
  assert.equal(sanitizeFilename('a b/c\\d|e*f'), 'a_b_c_d_e_f');
  assert.equal(sanitizeFilename('x'.repeat(500)).length, 200);
});

test('isValidPng accepts PNG header, rejects junk', () => {
  assert.equal(isValidPng(VALID_PNG), true);
  assert.equal(isValidPng(Buffer.from('not-a-png')), false);
  assert.equal(isValidPng(Buffer.alloc(0)), false);
  assert.equal(isValidPng(null), false);
});

// ── findRegionBounds ─────────────────────────────────────────────────────

test('findRegionBounds returns first matching selector result', async () => {
  const bounds = { x: 10, y: 20, width: 800, height: 600, selector: '.chart-container' };
  const { deps } = makeDeps({ regionBounds: bounds });
  const r = await findRegionBounds(['.chart-container'], { _deps: deps });
  assert.deepEqual(r, bounds);
});

test('findRegionBounds returns null when no selector matches', async () => {
  const { deps } = makeDeps({ regionBounds: null });
  const r = await findRegionBounds(['.does-not-exist'], { _deps: deps });
  assert.equal(r, null);
});

// ── captureScreenshot ────────────────────────────────────────────────────

test('captureScreenshot full region — no clip, captureBeyondViewport set, writes file', async () => {
  const { deps, calls } = makeDeps();
  const out = await captureScreenshot({ _deps: deps });
  assert.equal(out.success, true);
  assert.equal(out.region, 'full');
  assert.equal(out.method, 'cdp');
  assert.ok(out.file_path.endsWith('.png'));
  assert.equal(out.size_bytes, VALID_PNG.length);
  const params = calls.captureScreenshot[0];
  assert.equal(params.format, 'png');
  assert.equal(params.captureBeyondViewport, true);
  assert.equal(params.clip, undefined);
  assert.equal(calls.write.length, 1);
});

test('captureScreenshot chart region — selector hit, clip passed to CDP', async () => {
  const bounds = { x: 100, y: 50, width: 1200, height: 700, selector: '.chart-container' };
  const { deps, calls } = makeDeps({ regionBounds: bounds });
  const out = await captureScreenshot({ region: 'chart', _deps: deps });
  assert.equal(out.region, 'chart');
  assert.deepEqual(out.clip, { selector: '.chart-container', x: 100, y: 50, width: 1200, height: 700 });
  const params = calls.captureScreenshot[0];
  assert.deepEqual(params.clip, { x: 100, y: 50, width: 1200, height: 700, scale: 1 });
});

test('captureScreenshot chart region — ALL selectors miss => throws (no silent fallback)', async () => {
  const { deps } = makeDeps({ regionBounds: null });
  await assert.rejects(
    captureScreenshot({ region: 'chart', _deps: deps }),
    /Region "chart" not found.*CHART_SELECTORS/s
  );
});

test('captureScreenshot strategy_tester miss surfaces STRATEGY_SELECTORS hint', async () => {
  const { deps } = makeDeps({ regionBounds: null });
  await assert.rejects(
    captureScreenshot({ region: 'strategy_tester', _deps: deps }),
    /Region "strategy_tester" not found.*STRATEGY_SELECTORS/s
  );
});

test('captureScreenshot with date — computes range, calls setVisibleRange, reports zoom meta', async () => {
  const target = computeZoomWindow('2025-01-15', '5');
  const visibleRange = { from: target.center - target.halfWindow, to: target.center + target.halfWindow };
  const { deps, calls } = makeDeps({ visibleRange });
  const out = await captureScreenshot({ date: '2025-01-15', timeframe: '5', _deps: deps });
  assert.ok(calls.setVisibleRange.length >= 1);                    // date zoom; auto_fit may also expand
  assert.equal(calls.setVisibleRange[0].from, visibleRange.from);   // first call = the date-zoom one
  assert.equal(calls.setVisibleRange[0].to, visibleRange.to);
  assert.ok(out.zoom);
  assert.equal(out.zoom.date, '2025-01-15');
  assert.equal(out.zoom.resolution, '5');
  assert.equal(out.zoom.settled, true);
});

test('captureScreenshot with date — settle never confirms => zoom.settled false but still succeeds', async () => {
  const { deps } = makeDeps({ visibleRange: null });   // poll returns null forever
  const out = await captureScreenshot({ date: '2025-01-15', timeframe: '5', _deps: deps });
  assert.equal(out.success, true);
  assert.equal(out.zoom.settled, false);
});

test('captureScreenshot invalid date => throws', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    captureScreenshot({ date: 'not-a-date', _deps: deps }),
    /Invalid date/
  );
});

test('captureScreenshot api method — side-effect triggered + file still produced via CDP', async () => {
  const { deps, calls } = makeDeps();
  const out = await captureScreenshot({ method: 'api', _deps: deps });
  assert.equal(calls.getChartCollection, 1);
  assert.equal(out.method, 'cdp');
  assert.ok(out.file_path);
  assert.match(out.api_note, /takeScreenshot\(\) side-effect/);
});

test('captureScreenshot api method failure — note captures error, CDP still succeeds', async () => {
  const { deps } = makeDeps({ apiThrows: true });
  const out = await captureScreenshot({ method: 'api', _deps: deps });
  assert.equal(out.success, true);
  assert.match(out.api_note, /takeScreenshot\(\) failed/);
});

test('captureScreenshot invalid PNG bytes => throws (does not write garbage)', async () => {
  const { deps, calls } = makeDeps({ capturePayloadB64: INVALID_BYTES_B64 });
  await assert.rejects(
    captureScreenshot({ _deps: deps }),
    /not a valid PNG/
  );
  assert.equal(calls.write.length, 0);
});

test('captureScreenshot sanitizes custom filename', async () => {
  const { deps } = makeDeps();
  const out = await captureScreenshot({ filename: 'a/b:c d', _deps: deps });
  assert.ok(/\/a_b_c_d\.png$/.test(out.file_path));
});

// ── overlay detection ────────────────────────────────────────────────────

test('detectBlockingOverlay returns null when nothing present', async () => {
  const { deps } = makeDeps({ overlay: null });
  assert.equal(await detectBlockingOverlay({ _deps: deps }), null);
});

test('detectBlockingOverlay surfaces session_disconnected with text + kind', async () => {
  const fake = { selector: '[role="dialog"]', width: 600, height: 400, areaFrac: 0.42, text: 'Session disconnected — your account was used elsewhere', kind: 'session_disconnected' };
  const { deps } = makeDeps({ overlay: fake });
  const r = await detectBlockingOverlay({ _deps: deps });
  assert.equal(r.kind, 'session_disconnected');
  assert.equal(r.areaFrac, 0.42);
});

test('captureScreenshot fails fast with actionable hint when session_disconnected modal is up', async () => {
  const overlay = { selector: '[role="dialog"]', width: 600, height: 400, areaFrac: 0.42, text: 'Session disconnected', kind: 'session_disconnected' };
  const { deps, calls } = makeDeps({ overlay });
  await assert.rejects(
    captureScreenshot({ region: 'chart', _deps: deps }),
    /session_disconnected[\s\S]*Connect[\s\S]*ignore_overlay=true/
  );
  assert.equal(calls.captureScreenshot.length, 0, 'must not invoke CDP capture when overlay blocks');
  assert.equal(calls.write.length, 0, 'must not write a file when overlay blocks');
});

test('captureScreenshot fails fast on login/paywall/cookie modals with kind-specific hint', async () => {
  for (const kind of ['login', 'paywall', 'cookie', 'onboarding', 'unknown']) {
    const overlay = { selector: '[class*="modal"]', width: 800, height: 600, areaFrac: 0.5, text: kind, kind };
    const { deps } = makeDeps({ overlay });
    await assert.rejects(captureScreenshot({ _deps: deps }), new RegExp(`kind="${kind}"`));
  }
});

test('captureScreenshot with ignore_overlay=true bypasses the overlay check and captures', async () => {
  const overlay = { selector: '[role="dialog"]', width: 600, height: 400, areaFrac: 0.42, text: 'whatever', kind: 'unknown' };
  const { deps } = makeDeps({ overlay });
  const out = await captureScreenshot({ ignore_overlay: true, _deps: deps });
  assert.equal(out.success, true);
  assert.ok(out.file_path);
});

// ── timeframe helpers ────────────────────────────────────────────────────

test('secPerBar covers minutes, hours, D/W/M', () => {
  assert.equal(secPerBar('1'), 60);
  assert.equal(secPerBar('5'), 300);
  assert.equal(secPerBar('60'), 3600);
  assert.equal(secPerBar('4H'), 4 * 3600);
  assert.equal(secPerBar('D'), 86400);
  assert.equal(secPerBar('1D'), 86400);
  assert.equal(secPerBar('W'), 7 * 86400);
  assert.equal(secPerBar('M'), 30 * 86400);
});

test('nearestTfKey returns defined key as-is', () => {
  assert.equal(nearestTfKey('5'), '5');
  assert.equal(nearestTfKey('D'), 'D');
  assert.equal(nearestTfKey('1D'), 'D');           // normalized via secPerBar match
});

test('nearestTfKey falls back to the closest defined key for unknown tf', () => {
  // 10m is defined (10), 7m is unknown -> nearest by sec-per-bar should be 5 or 10
  const k = nearestTfKey('7');
  assert.ok(['5', '10'].includes(k));
  // 45m unknown -> nearest is 30 or 60
  const k2 = nearestTfKey('45');
  assert.ok(['30', '60'].includes(k2));
});

test('minBarsFor returns the configured value for the (nearest) tf', () => {
  assert.equal(minBarsFor('5'), MIN_BARS_BY_TF['5']);
  assert.equal(minBarsFor('D'), MIN_BARS_BY_TF['D']);
});

test('expandRangeToMinBars expands a tight range; leaves wide alone', () => {
  // 5m needs ≥ 75 bars * 300s = 22500s
  const tight = expandRangeToMinBars({ from: 1000, to: 1300, timeframe: '5' });   // span 300s
  assert.equal(tight.expanded, true);
  assert.equal(tight.to - tight.from >= 22500, true);
  const wide = expandRangeToMinBars({ from: 0, to: 30 * 86400, timeframe: '5' });  // way more
  assert.equal(wide.expanded, false);
});

test('expandRangeToMinBars honors min_bars override', () => {
  const r = expandRangeToMinBars({ from: 1000, to: 2000, timeframe: '5', minBars: 200 });
  assert.equal(r.expanded, true);
  assert.equal(r.target, 200);
  assert.equal(r.to - r.from >= 200 * 300, true);
});

// ── ensureVisibleAndAutofit ──────────────────────────────────────────────

test('ensureVisibleAndAutofit expands a tight range, calls setVisibleRange + autoscale', async () => {
  const { deps, calls } = makeDeps({ visibleRange: { from: 1000, to: 1300, resolution: '5' }, resolution: '5' });
  const r = await ensureVisibleAndAutofit({ _deps: deps });
  assert.equal(r.expanded, true);
  assert.equal(r.autofitted, true);
  assert.equal(calls.setVisibleRange.length, 1, 'setVisibleRange must be called when expanding');
  assert.equal(calls.setVisibleRange[0].to - calls.setVisibleRange[0].from >= 75 * 300, true);
  assert.ok(calls.evaluate.some(e => /scaleReset/.test(e)), 'TV scaleReset must be invoked');
});

test('ensureVisibleAndAutofit leaves wide range alone but still autofits Y', async () => {
  const { deps, calls } = makeDeps({ visibleRange: { from: 0, to: 30 * 86400, resolution: '5' } });
  const r = await ensureVisibleAndAutofit({ _deps: deps });
  assert.equal(r.expanded, false);
  assert.equal(r.autofitted, true);
  assert.equal(calls.setVisibleRange.length, 0);
  assert.ok(calls.evaluate.some(e => /scaleReset/.test(e)));
});

test('captureScreenshot runs auto_fit by default and includes fit metadata', async () => {
  const { deps, calls } = makeDeps({ visibleRange: { from: 1000, to: 1300, resolution: '5' } });
  const out = await captureScreenshot({ _deps: deps });
  assert.ok(out.fit, 'fit metadata must be present');
  assert.equal(out.fit.expanded, true);
  assert.equal(out.fit.autofitted, true);
  assert.equal(calls.setVisibleRange.length, 1);
});

test('captureScreenshot with auto_fit=false skips range expansion and Y autofit', async () => {
  const { deps, calls } = makeDeps({ visibleRange: { from: 1000, to: 1300, resolution: '5' } });
  const out = await captureScreenshot({ auto_fit: false, _deps: deps });
  assert.equal(out.fit, undefined);
  assert.equal(calls.setVisibleRange.length, 0);
  assert.equal(calls.evaluate.filter(e => /scaleReset/.test(e)).length, 0);
});

test('captureScreenshot respects min_bars override', async () => {
  const { deps, calls } = makeDeps({ visibleRange: { from: 1000, to: 1300, resolution: '5' } });
  const out = await captureScreenshot({ min_bars: 200, _deps: deps });
  assert.equal(out.fit.expanded, true);
  assert.equal(out.fit.target, 200);
  assert.equal(calls.setVisibleRange[0].to - calls.setVisibleRange[0].from >= 200 * 300, true);
});

// ── waitForChartSettled ──────────────────────────────────────────────────

test('waitForChartSettled returns true when poll matches target within tolerance', async () => {
  const { deps } = makeDeps({ visibleRange: { from: 1000, to: 2000 } });
  const ok = await waitForChartSettled(1050, 1950, { timeoutMs: 1000, _deps: deps });   // within 120
  assert.equal(ok, true);
});

test('waitForChartSettled returns false on timeout when no match', async () => {
  const { deps } = makeDeps({ visibleRange: { from: 0, to: 10 } });
  const ok = await waitForChartSettled(9999, 99999, { timeoutMs: 500, _deps: deps });
  assert.equal(ok, false);
});
