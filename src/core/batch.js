/**
 * Core batch execution logic.
 */
import {
  evaluate as _evaluate,
  getClient as _getClient,
  getChartApi as _getChartApi,
  getChartCollection as _getChartCollection,
  safeString,
} from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';
import { getOhlcv as _getOhlcv } from './data.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getClient: deps?.getClient || _getClient,
    getChartApi: deps?.getChartApi || _getChartApi,
    getChartCollection: deps?.getChartCollection || _getChartCollection,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
    getOhlcv: deps?.getOhlcv || _getOhlcv,
    writeFile: deps?.writeFile || writeFileSync,
    mkdir: deps?.mkdir || ((p) => mkdirSync(p, { recursive: true })),
  };
}

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count, _deps }) {
  const { evaluate, getClient, getChartApi, getChartCollection, waitForChartReady, getOhlcv, writeFile, mkdir } = _resolve(_deps);
  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  const delay = delay_ms || 2000;
  const results = [];

  let colPath, apiPath;
  try { colPath = await getChartCollection(); } catch {}
  try { apiPath = await getChartApi(); } catch {}

  for (const symbol of symbols) {
    for (const tf of tfs) {
      const combo = { symbol, timeframe: tf };
      try {
        if (colPath) await evaluate(`${colPath}.setSymbol(${safeString(symbol)})`);
        else if (apiPath) await evaluate(`${apiPath}.setSymbol(${safeString(symbol)})`);

        if (tf) {
          if (colPath) await evaluate(`${colPath}.setResolution(${safeString(tf)})`);
          else if (apiPath) await evaluate(`${apiPath}.setResolution(${safeString(tf)})`);
        }

        await waitForChartReady(symbol);
        await new Promise(r => setTimeout(r, delay));

        let actionResult;
        if (action === 'screenshot') {
          mkdir(SCREENSHOT_DIR);
          const client = await getClient();
          // Match capture_screenshot: bring the connected tab to front so the
          // painted surface matches the symbol we just set (see core/capture.js).
          try { await client.Page.bringToFront(); } catch {}
          const { data } = await client.Page.captureScreenshot({ format: 'png' });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fname = `batch_${symbol}_${tf || 'default'}_${ts}`.replace(/[\/\\]/g, '_') + '.png';
          const filePath = join(SCREENSHOT_DIR, fname);
          writeFile(filePath, Buffer.from(data, 'base64'));
          actionResult = { file_path: filePath };
        } else if (action === 'get_ohlcv') {
          // Reuse the proven direct-bars reader (core/data.js getOhlcv). The old
          // path used the chart's async data-export API, which this TradingView
          // Desktop build rejects with "Data export is not supported" — surfacing
          // as the opaque "Uncaught (in promise)" CDP error for every symbol.
          const limit = Math.min(ohlcv_count || 100, 500);
          const ohlcv = await getOhlcv({ count: limit, summary: true });
          // Compact per-symbol summary for screening: drop the success flag and
          // the bulky last_5_bars array.
          const { success, last_5_bars, ...summary } = ohlcv;
          actionResult = summary;
        } else if (action === 'get_strategy_results') {
          await new Promise(r => setTimeout(r, 1000));
          actionResult = await evaluate(`
            (function() {
              var metrics = {};
              var panel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
              if (!panel) return { error: 'Strategy Tester not found' };
              var items = panel.querySelectorAll('[class*="reportItem"], [class*="metric"]');
              items.forEach(function(item) {
                var label = item.querySelector('[class*="label"]');
                var value = item.querySelector('[class*="value"]');
                if (label && value) metrics[label.textContent.trim()] = value.textContent.trim();
              });
              return { metric_count: Object.keys(metrics).length, metrics: metrics };
            })()
          `);
        } else {
          actionResult = { error: 'Unknown action: ' + action };
        }
        results.push({ ...combo, success: true, result: actionResult });
      } catch (err) {
        results.push({ ...combo, success: false, error: err.message });
      }
    }
  }

  const successCount = results.filter(r => r.success).length;
  return { success: true, total_iterations: results.length, successful: successCount, failed: results.length - successCount, results };
}
