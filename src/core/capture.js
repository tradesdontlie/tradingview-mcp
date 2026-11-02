/**
 * Core screenshot/capture logic.
 */
import { getClient as getClientDefault, evaluate as evaluateDefault, getChartCollection as getChartCollectionDefault } from '../connection.js';
import { waitForChartRender as waitForChartRenderDefault } from '../wait.js';
import { writeFileSync, mkdirSync } from 'fs';
import { getOutputDirectory, sanitizeOutputBasename } from '../output-paths.js';
import { join } from 'path';

export async function captureScreenshot({ region, filename, method, waitForRender = false, _deps } = {}) {
  const getClient = _deps?.getClient || getClientDefault;
  const evaluate = _deps?.evaluate || evaluateDefault;
  const getChartCollection = _deps?.getChartCollection || getChartCollectionDefault;
  const waitForChartRender = _deps?.waitForChartRender || waitForChartRenderDefault;

  if (waitForRender) await waitForChartRender();

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = sanitizeOutputBasename(filename || `tv_${region || 'full'}_${ts}`);


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

  const { data } = await client.Page.captureScreenshot(params);
  const directory = getOutputDirectory('screenshots');
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, `${fname}.png`);
  writeFileSync(filePath, Buffer.from(data, 'base64'));

  return {
    success: true, method: 'cdp', file_path: filePath, region,
    waited_for_render: !!waitForRender,
    size_bytes: Buffer.from(data, 'base64').length,
  };
}
