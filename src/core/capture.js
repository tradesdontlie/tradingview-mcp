/**
 * Core screenshot/capture logic.
 */
import { getClient, evaluate, getChartCollection } from '../connection.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname, isAbsolute, resolve as pathResolve, parse as pathParse } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

export async function captureScreenshot({ region, filename, method, out_dir, path } = {}) {
  // Resolution order:
  //   1. `path` (full path including filename — wins outright)
  //   2. `out_dir` + `filename` (or auto-generated filename)
  //   3. legacy: SCREENSHOT_DIR + filename
  let filePath;
  if (path) {
    filePath = isAbsolute(path) ? path : pathResolve(process.cwd(), path);
    if (!pathParse(filePath).ext) filePath += '.png';
    mkdirSync(dirname(filePath), { recursive: true });
  } else {
    const dir = out_dir
      ? (isAbsolute(out_dir) ? out_dir : pathResolve(process.cwd(), out_dir))
      : SCREENSHOT_DIR;
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = (filename || `tv_${region}_${ts}`).replace(/[\/\\]/g, '_');
    filePath = join(dir, `${fname}.png`);
  }

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
  writeFileSync(filePath, Buffer.from(data, 'base64'));

  return {
    success: true, method: 'cdp', file_path: filePath, region,
    size_bytes: Buffer.from(data, 'base64').length,
  };
}
