/**
 * Core screenshot/capture logic.
 */
import { getClient, evaluate, getChartCollection, withTimeout } from '../connection.js';
import { waitForChartRender } from '../wait.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

export async function captureScreenshot({ region, filename, method, waitForRender = false } = {}) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  if (waitForRender) await waitForChartRender();

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = (filename || `tv_${region || 'full'}_${ts}`).replace(/[\/\\]/g, '_').replace(/\.\./g, '_');
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);

  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api', waited_for_render: !!waitForRender,
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

  // Bounded: Page.captureScreenshot hangs forever on unresponsive renderers
  // (upstream issue #174). Race with a generous budget for big captures.
  const { data } = await withTimeout(
    client.Page.captureScreenshot(params),
    60000,
    'Page.captureScreenshot',
  );
  const buf = Buffer.from(data, 'base64');
  writeFileSync(filePath, buf);

  // Remote deployments (SSE over Tailscale) can't read VPS-local paths, so the
  // image is embedded as a data URL in addition to being written to disk.
  // Images can be large — cap embedded preview at ~2 MB.
  const includeData = buf.length <= 2 * 1024 * 1024;
  return {
    success: true, method: 'cdp', file_path: filePath, region,
    waited_for_render: !!waitForRender,
    size_bytes: buf.length,
    ...(includeData ? { image_base64: `data:image/png;base64,${data}` } : { note: 'image too large to embed (>2MB) — read file_path on the host' }),
  };
}
