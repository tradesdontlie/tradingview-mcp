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

  if (date) {
    const d = new Date(date);
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${date}. Use ISO format e.g. "2025-01-15".`);
    d.setUTCHours(0, 0, 0, 0);
    const from = Math.floor(d.getTime() / 1000);
    const to = from + 86400;
    await setVisibleRange({ from, to });
    await new Promise(r => setTimeout(r, 600));
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
  };
}
