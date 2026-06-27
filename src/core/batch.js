/**
 * Core batch execution logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, getClient as _getClient, getChartApi as _getChartApi, getChartCollection as _getChartCollection, safeString } from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';
import { SCREENSHOT_DIR, safeScreenshotName, pruneScreenshots } from './capture.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// Default per-symbol settle delay after chart-ready, giving studies/indicators
// time to finish rendering before the action (screenshot/export) runs.
const DEFAULT_BATCH_DELAY_MS = 2000;
// Extra wait for the Strategy Tester report DOM to populate before scraping it.
const STRATEGY_REPORT_SETTLE_MS = 1000;
// Defense-in-depth cap on total work: symbols × timeframes. The MCP schema caps
// symbols ≤ 20 and timeframes ≤ 10 individually, but a 20×10 sweep with the 2s
// default delay would still block for minutes and write 200 screenshots. Reject
// oversized sweeps up front rather than starting an unbounded loop.
export const MAX_BATCH_ITERATIONS = 50;

/**
 * Validate the total iteration count (symbols × timeframes) against
 * MAX_BATCH_ITERATIONS. Pure + exported so the cap is unit-testable offline.
 * Throws a clear Error when exceeded.
 */
export function assertBatchSize(symbols, timeframes) {
  const symCount = Array.isArray(symbols) ? symbols.length : 0;
  const tfCount = (Array.isArray(timeframes) && timeframes.length > 0) ? timeframes.length : 1;
  const total = symCount * tfCount;
  if (total > MAX_BATCH_ITERATIONS) {
    throw new Error(
      `Batch too large: ${symCount} symbols × ${tfCount} timeframes = ${total} iterations ` +
      `exceeds the maximum of ${MAX_BATCH_ITERATIONS}. Reduce symbols or timeframes.`
    );
  }
  return total;
}

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    getClient: deps?.getClient || _getClient,
    getChartApi: deps?.getChartApi || _getChartApi,
    getChartCollection: deps?.getChartCollection || _getChartCollection,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
  };
}

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count, _deps }) {
  const { evaluate, evaluateAsync, getClient, getChartApi, getChartCollection, waitForChartReady } = _resolve(_deps);
  assertBatchSize(symbols, timeframes);
  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  const delay = delay_ms || DEFAULT_BATCH_DELAY_MS;
  const results = [];

  let colPath, apiPath;
  try { colPath = await getChartCollection(); } catch {}
  try { apiPath = await getChartApi(); } catch {}

  // Ensure the screenshot dir exists once, before the loop — not per iteration.
  if (action === 'screenshot') await mkdir(SCREENSHOT_DIR, { recursive: true });

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

        const ready = await waitForChartReady(symbol, tf);
        if (!ready) {
          results.push({
            ...combo,
            success: false,
            error: 'Chart did not stabilize within timeout (symbol/timeframe may not have applied)',
          });
          continue;
        }
        await new Promise(r => setTimeout(r, delay));

        let actionResult;
        if (action === 'screenshot') {
          const client = await getClient();
          const { data } = await client.Page.captureScreenshot({ format: 'png' });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fname = safeScreenshotName(`batch_${symbol}_${tf || 'default'}_${ts}`) + '.png';
          const filePath = join(SCREENSHOT_DIR, fname);
          // Decode the base64 payload once; reuse the buffer for the async write.
          const buffer = Buffer.from(data, 'base64');
          await writeFile(filePath, buffer);
          actionResult = { file_path: filePath, size_bytes: buffer.length };
        } else if (action === 'get_ohlcv' && apiPath) {
          const limit = Math.min(ohlcv_count || 100, 500);
          // Tail-read the last N bars straight from the series (mirrors getOhlcv)
          // rather than exportData({includeSeries:true}), which materializes and
          // serializes the ENTIRE chart history in-page on every iteration.
          actionResult = await evaluate(`
            (function() {
              var bars = ${apiPath}._chartWidget.model().mainSeries().bars();
              if (!bars || typeof bars.lastIndex !== 'function') return { bar_count: 0, last_bar: null };
              var end = bars.lastIndex();
              var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
              var count = 0, last = null;
              for (var i = start; i <= end; i++) {
                var v = bars.valueAt(i);
                if (v) { count++; last = { time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 }; }
              }
              return { bar_count: count, last_bar: last };
            })()
          `);
        } else if (action === 'get_strategy_results') {
          await new Promise(r => setTimeout(r, STRATEGY_REPORT_SETTLE_MS));
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
          throw new Error('Unknown action or API not available: ' + action);
        }
        results.push({ ...combo, success: true, result: actionResult });
      } catch (err) {
        results.push({ ...combo, success: false, error: err.message });
      }
    }
  }

  // Enforce screenshot retention once after the sweep, not inside the loop.
  if (action === 'screenshot') {
    try { await pruneScreenshots(); } catch {}
  }

  const successCount = results.filter(r => r.success).length;
  const failedCount = results.length - successCount;
  return { success: failedCount === 0, total_iterations: results.length, successful: successCount, failed: failedCount, results };
}
