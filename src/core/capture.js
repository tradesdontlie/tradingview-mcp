/**
 * Core screenshot/capture logic.
 */
import { getClient, evaluate, getChartCollection } from '../connection.js';
import { setVisibleRange } from './chart.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

export async function captureScreenshot({ region, filename, method, date } = {}) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  let zoomMeta = null;
  if (date) {
    const d = new Date(date);
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${date}. Use ISO format e.g. "2025-01-15".`);

    const resolution = await evaluate(`
      (function() {
        try { return window.TradingViewApi._activeChartWidgetWV.value().resolution(); } catch(e) { return '5'; }
      })()
    `);

    // Center on noon UTC, expand window based on timeframe
    d.setUTCHours(12, 0, 0, 0);
    const center = Math.floor(d.getTime() / 1000);
    const res = String(resolution).toUpperCase();
    let halfWindow;
    if (res === 'D' || res === '1D')       halfWindow = 15 * 86400;   // ±15 days → 1-month view
    else if (res === 'W' || res === '1W')  halfWindow = 91 * 86400;   // ±91 days → 6-month view
    else if (res === 'M' || res === '1M')  halfWindow = 182 * 86400;  // ±182 days → 1-year view
    else {
      const mins = parseInt(res, 10) || 5;
      if (mins >= 60) halfWindow = 2 * 86400;   // hourly → ±2 days
      else            halfWindow = 12 * 3600;    // intraday → just that day
    }

    await setVisibleRange({ from: center - halfWindow, to: center + halfWindow });
    await new Promise(r => setTimeout(r, 600));
    zoomMeta = { date, resolution, window_seconds: halfWindow * 2 };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const datePart = date ? `_${date}` : '';
  const fname = (filename || `tv_${region || 'full'}${datePart}_${ts}`).replace(/[\/\\]/g, '_');
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);

  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api',
        note: 'takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI',
      };
    } catch {
      // Fall through to CDP method
    }
  }

  const client = await getClient();
  let clip = undefined;

  if (region === 'chart') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  } else if (region === 'strategy_tester') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  }

  const params = { format: 'png' };
  if (clip) params.clip = clip;

  const { data } = await client.Page.captureScreenshot(params);
  const buf = Buffer.from(data, 'base64');
  writeFileSync(filePath, buf);

  return {
    success: true, method: 'cdp', file_path: filePath, region,
    size_bytes: buf.length,
    ...(zoomMeta && { zoom: zoomMeta }),
  };
}
