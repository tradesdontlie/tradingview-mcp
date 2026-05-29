/**
 * Core screenshot/capture logic.
 *
 * Steps:
 *   1. Validate inputs, ensure output dir.
 *   2. Connect to CDP.
 *   3. (Optional) zoom to `date`: resolve resolution -> compute IST-aware center
 *      + half-window -> setVisibleRange -> poll until the chart actually settled.
 *   4. Resolve clip region (full | chart | strategy_tester) by trying multiple
 *      selectors. If a non-full region selector misses on every candidate, THROW
 *      (no silent fallback to full — caller must know the region failed).
 *   5. Optionally trigger TV's own takeScreenshot() side-effect; ALWAYS still
 *      capture via CDP so a real file is produced.
 *   6. CDP captureScreenshot with `captureBeyondViewport: true`.
 *   7. Verify the PNG header before writing.
 *   8. Write file + return uniform metadata (file_path, region, size, zoom, clip).
 */
import {
  getClient as _getClient,
  evaluate as _evaluate,
  evaluateAsync as _evaluateAsync,
  getChartCollection as _getChartCollection,
} from '../connection.js';
import { setVisibleRange as _setVisibleRange } from './chart.js';
import { expandRangeToMinBars, secPerBar } from './timeframe.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// NSE session midpoint (≈ 12:25 IST = 06:55 UTC). Used as zoom center for
// intraday `date` requests so the chart isn't centered post-market.
const NSE_SESSION_MIDPOINT_UTC_HOURS = 6;
const NSE_SESSION_MIDPOINT_UTC_MINS = 55;

// Multi-selector lists — TV class names are partly hashed, so we try several.
const CHART_SELECTORS = [
  '.chart-container',
  '[class*="chart-container"]',
  '.layout__area--center',
  '[class*="layout__area--center"]',
  '[class*="chart-widget"]',
  '.chart-markup-table',
];
const STRATEGY_SELECTORS = [
  '[data-name="backtesting"]',
  '[data-name="backtesting-content-wrapper"]',
  '[class*="strategyReport"]',
  '[class*="bottom-widgetbar-content"][class*="backtesting"]',
];

// Blocking overlays the chart can't be screenshotted through. Any element
// matching one of these selectors AND covering ≥10% of the viewport counts.
const OVERLAY_SELECTORS = [
  '[role="dialog"]',
  '[class*="modal"]',
  '[class*="dialog"]',
  '[class*="overlay"]',
];

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
    getChartCollection: deps?.getChartCollection || _getChartCollection,
    setVisibleRange: deps?.setVisibleRange || _setVisibleRange,
    now: deps?.now || (() => Date.now()),
    sleep: deps?.sleep || (ms => new Promise(r => setTimeout(r, ms))),
    write: deps?.write || writeFileSync,
    mkdir: deps?.mkdir || mkdirSync,
  };
}

/**
 * @param {string|number} resolution e.g. "5", "60", "4H", "D", "W", "M"
 * @returns {number|null} minutes if intraday, else null
 */
export function intradayMinutes(resolution) {
  const r = String(resolution).toUpperCase().trim();
  if (r === 'D' || r === '1D' || r === 'W' || r === '1W' || r === 'M' || r === '1M') return null;
  const n = parseInt(r, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return r.endsWith('H') ? n * 60 : n;
}

/**
 * Compute the zoom center + halfWindow for a date+resolution. Pure — testable.
 * @returns {{center:number, halfWindow:number}}
 */
export function computeZoomWindow(date, resolution) {
  const d = new Date(date);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${date}. Use ISO format e.g. "2025-01-15".`);
  const res = String(resolution).toUpperCase();
  const mins = intradayMinutes(res);
  if (mins == null) d.setUTCHours(12, 0, 0, 0);
  else d.setUTCHours(NSE_SESSION_MIDPOINT_UTC_HOURS, NSE_SESSION_MIDPOINT_UTC_MINS, 0, 0);
  const center = Math.floor(d.getTime() / 1000);
  let halfWindow;
  if (res === 'D' || res === '1D') halfWindow = 15 * 86400;
  else if (res === 'W' || res === '1W') halfWindow = 91 * 86400;
  else if (res === 'M' || res === '1M') halfWindow = 182 * 86400;
  else if (mins != null && mins >= 60) halfWindow = 2 * 86400;
  else halfWindow = 4 * 3600;                   // ±4h covers NSE 6h15m session
  return { center, halfWindow };
}

/** Filesystem-safe filename. */
export function sanitizeFilename(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
}

/** PNG header sanity check. */
export function isValidPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.slice(0, 8).equals(PNG_HEADER);
}

/**
 * Poll the chart's actual visibleRange until it matches `targetFrom/To` (±120s),
 * then commit two RAFs to ensure paint. Falls back to a short fixed wait if the
 * TV API path is unavailable.
 */
export async function waitForChartSettled(targetFrom, targetTo, { timeoutMs = 3000, _deps } = {}) {
  const { evaluateAsync, sleep, now } = _resolve(_deps);
  const start = now();
  let lastErr = null;
  while (now() - start < timeoutMs) {
    try {
      const cur = await evaluateAsync(`
        (async () => {
          try {
            var chart = window.TradingViewApi._activeChartWidgetWV.value().activeChart();
            var r = await chart.getVisibleRange();
            return { from: r.from, to: r.to };
          } catch (e) { return null; }
        })()
      `);
      if (cur && Number.isFinite(cur.from) && Number.isFinite(cur.to)
        && Math.abs(cur.from - targetFrom) < 120 && Math.abs(cur.to - targetTo) < 120) {
        await evaluateAsync(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        return true;
      }
    } catch (e) { lastErr = e; }
    await sleep(150);
  }
  await sleep(400);   // best-effort grace if poll never confirmed
  return false;
}

/**
 * Try each selector; return the first whose element has bounds > 50×50.
 * Returns null if all miss.
 */
export async function findRegionBounds(selectors, { _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return evaluate(`
    (function() {
      var sels = ${JSON.stringify(selectors)};
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el) {
          var r = el.getBoundingClientRect();
          if (r.width > 50 && r.height > 50) {
            return { x: r.x, y: r.y, width: r.width, height: r.height, selector: sels[i] };
          }
        }
      }
      return null;
    })()
  `);
}

/**
 * Detect a blocking overlay (login modal, "Session disconnected" dialog, paywall,
 * etc.) that would render the screenshot useless. Returns `{kind, selector, text, ...}`
 * or `null`. Pre-capture probe — fail-fast beats writing a 400KB modal image.
 */
export async function detectBlockingOverlay({ minAreaFrac = 0.10, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  return evaluate(`
    (function() {
      var vw = window.innerWidth, vh = window.innerHeight, vp = vw * vh || 1;
      var sels = ${JSON.stringify(OVERLAY_SELECTORS)};
      for (var i = 0; i < sels.length; i++) {
        var nodes = document.querySelectorAll(sels[i]);
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          var style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') < 0.1) continue;
          var r = el.getBoundingClientRect();
          var areaFrac = (r.width * r.height) / vp;
          if (areaFrac < ${minAreaFrac}) continue;
          var text = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
          var kind = 'unknown';
          if (/session disconnected/i.test(text)) kind = 'session_disconnected';
          else if (/sign in|log in|sign up/i.test(text)) kind = 'login';
          else if (/upgrade|trial|subscription|go pro/i.test(text)) kind = 'paywall';
          else if (/cookie|consent|privacy/i.test(text)) kind = 'cookie';
          else if (/welcome|onboarding|tour/i.test(text)) kind = 'onboarding';
          return { selector: sels[i], width: r.width, height: r.height, areaFrac: areaFrac, text: text, kind: kind };
        }
      }
      return null;
    })()
  `);
}

function overlayActionHint(kind) {
  switch (kind) {
    case 'session_disconnected': return 'Click "Connect" in the TradingView Desktop app. Your account was opened in another browser/device (NSE rules → one active session). Ensure no other TV tab is open.';
    case 'login':                return 'Log in to TradingView Desktop, then retry.';
    case 'paywall':              return 'Dismiss the paywall/upgrade dialog (or upgrade) and retry.';
    case 'cookie':               return 'Accept/dismiss the cookie/consent banner and retry.';
    case 'onboarding':           return 'Close the onboarding/tour overlay and retry.';
    default:                     return 'Close the dialog manually, or pass ignore_overlay=true to capture it anyway.';
  }
}

/**
 * Read the chart's current visible range + resolution, expand to meet min-bars
 * for the timeframe ("more is OK, less is not"), then trigger Y-axis autoscale
 * so candles aren't clipped/squashed in the screenshot.
 *
 * Returns `{ resolution, from, to, expanded, target, autofitted }`.
 */
export async function ensureVisibleAndAutofit({ timeframe, minBars, settleMs = 1500, _deps } = {}) {
  const { evaluate, evaluateAsync, setVisibleRange, sleep } = _resolve(_deps);

  // TV exposes the chart object DIRECTLY at _activeChartWidgetWV.value() — no
  // `.activeChart()` indirection on this build. getVisibleRange returns a Promise.
  const state = await evaluateAsync(`
    (async () => {
      try {
        var w = window.TradingViewApi._activeChartWidgetWV.value();
        var r = await w.getVisibleRange();
        return { from: r.from, to: r.to, resolution: w.resolution() };
      } catch (e) { return null; }
    })()
  `);

  // stateProbed=false means the TV-internal API path returned null; resolution
  // and range fall back to caller-supplied values. Surface this so callers know
  // the autofit ran without ground truth from the chart.
  let info = {
    resolution: timeframe || (state && state.resolution) || '5',
    expanded: false,
    autofitted: false,
    stateProbed: !!(state && Number.isFinite(state.from) && Number.isFinite(state.to)),
  };
  if (info.stateProbed) {
    const tf = timeframe || state.resolution || '5';
    const exp = expandRangeToMinBars({ from: state.from, to: state.to, timeframe: tf, minBars });
    info = { ...info, from: exp.from, to: exp.to, expanded: exp.expanded, target: exp.target, spanBars: exp.spanBars, resolution: tf };
    if (exp.expanded) {
      await setVisibleRange({ from: exp.from, to: exp.to, _deps });
      await waitForChartSettled(exp.from, exp.to, { timeoutMs: settleMs, _deps });
    }
  }

  // Y-axis autofit via TV's native "Reset chart" action — preserves the visible
  // X range we set, refits Y tight to the candles. Equivalent to clicking the
  // reset button in the chart. Single action; no manual price-scale math needed.
  const ok = await evaluate(`
    (function() {
      try {
        var w = window.TradingViewApi._activeChartWidgetWV.value();
        if (typeof w.executeActionById === 'function') {
          w.executeActionById('scaleReset');
          return true;
        }
        return false;
      } catch (e) { return false; }
    })()
  `);
  info.autofitted = !!ok;

  await sleep(250);
  return info;
}

export async function captureScreenshot({ region, filename, method, date, timeframe, ignore_overlay, auto_fit, min_bars, _deps } = {}) {
  const deps = _resolve(_deps);
  const { evaluate, getClient, getChartCollection, setVisibleRange, write, mkdir } = deps;

  mkdir(SCREENSHOT_DIR, { recursive: true });

  // Step 0: bail fast on blocking overlays (session disconnect, login, paywall…).
  // `ignore_overlay: true` bypasses (e.g. when you actually want to screenshot the modal).
  if (!ignore_overlay) {
    const overlay = await detectBlockingOverlay({ _deps });
    if (overlay) {
      const pct = (overlay.areaFrac * 100).toFixed(0);
      throw new Error(
        `Blocking overlay detected: kind="${overlay.kind}" selector="${overlay.selector}" covers ${pct}% of viewport. ` +
        `Text: "${overlay.text}". ${overlayActionHint(overlay.kind)} ` +
        `(Or pass ignore_overlay=true to capture anyway.)`
      );
    }
  }

  // Step 3: optional zoom-to-date
  let zoomMeta = null;
  if (date) {
    let resolution = timeframe;
    if (!resolution) {
      try {
        resolution = await evaluate(`
          (function() {
            try { return window.TradingViewApi._activeChartWidgetWV.value().resolution(); }
            catch (e) { return null; }
          })()
        `);
      } catch { resolution = null; }
    }
    if (!resolution) resolution = '5';
    const { center, halfWindow } = computeZoomWindow(date, resolution);
    const from = center - halfWindow, to = center + halfWindow;
    await setVisibleRange({ from, to, _deps });
    const settled = await waitForChartSettled(from, to, { timeoutMs: 3000, _deps });
    zoomMeta = { date, resolution: String(resolution).toUpperCase(), window_seconds: halfWindow * 2, settled };
  }

  // Step 3.5: ensure ≥ min-bars visible for current timeframe + Y-axis autofit.
  // "More is OK, less is not" — only expands a tight range. auto_fit=false skips.
  // Best-effort: a failure here should not block the screenshot, but the error
  // is surfaced via `fit.error` so production debugging is not opaque.
  let fitMeta = null;
  if (auto_fit !== false) {
    try { fitMeta = await ensureVisibleAndAutofit({ timeframe, minBars: min_bars, _deps }); }
    catch (e) { fitMeta = { error: e?.message || String(e) }; }
  }

  // Step 4: resolve clip — never silently fall back when a region is requested
  let clip;
  let clipMeta = null;
  if (region === 'chart' || region === 'strategy_tester') {
    const sels = region === 'chart' ? CHART_SELECTORS : STRATEGY_SELECTORS;
    const bounds = await findRegionBounds(sels, { _deps });
    if (!bounds) {
      throw new Error(
        `Region "${region}" not found. Selectors tried: ${sels.join(', ')}. ` +
        `TV DOM may have changed — update ${region === 'chart' ? 'CHART_SELECTORS' : 'STRATEGY_SELECTORS'} in src/core/capture.js.`
      );
    }
    clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
    clipMeta = { selector: bounds.selector, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }

  // Step 5: optional TV-API side-effect; still always capture via CDP for bytes
  let apiNote = null;
  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      apiNote = 'takeScreenshot() side-effect triggered; file_path below is from CDP capture';
    } catch (e) {
      apiNote = `takeScreenshot() failed: ${e.message}; using CDP only`;
    }
  }

  // Step 6: capture
  const client = await getClient();
  const params = { format: 'png', captureBeyondViewport: true, ...(clip ? { clip } : {}) };
  const { data } = await client.Page.captureScreenshot(params);
  const buf = Buffer.from(data, 'base64');

  // Step 7: validate
  if (!isValidPng(buf)) {
    throw new Error(
      `Captured ${buf.length} bytes but not a valid PNG. Chart may not have rendered.` +
      (zoomMeta ? ` zoom=${JSON.stringify(zoomMeta)}` : '')
    );
  }

  // Step 8: write + return
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const datePart = date ? `_${date}` : '';
  const fname = sanitizeFilename(filename || `tv_${region || 'full'}${datePart}_${ts}`);
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);
  write(filePath, buf);

  return {
    success: true,
    method: 'cdp',
    region: region || 'full',
    file_path: filePath,
    size_bytes: buf.length,
    ...(clipMeta && { clip: clipMeta }),
    ...(zoomMeta && { zoom: zoomMeta }),
    ...(fitMeta && { fit: fitMeta }),
    ...(apiNote && { api_note: apiNote }),
  };
}
