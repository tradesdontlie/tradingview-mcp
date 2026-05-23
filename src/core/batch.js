/**
 * Core batch execution logic.
 */
import { evaluate, evaluateAsync, getClient, getChartApi, getChartCollection, safeString, KNOWN_PATHS } from '../connection.js';
import { waitForChartReady } from '../wait.js';

// Same path used by data_get_ohlcv — reads directly from chart's bar storage (no Promise, no rejection)
const CHART_API  = 'window.TradingViewApi._activeChartWidgetWV.value()';
const BARS_PATH  = KNOWN_PATHS ? KNOWN_PATHS.mainSeriesBars : `${CHART_API}._chartWidget.model().mainSeries().bars()`;
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }) {
  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  const delay = delay_ms || 2000;
  const results = [];

  for (const symbol of symbols) {
    for (const tf of tfs) {
      const combo = { symbol, timeframe: tf };
      try {
        // Use the same stable CHART_API path that chart_set_symbol uses
        await evaluate(`${CHART_API}.setSymbol(${safeString(symbol)})`);

        if (tf) {
          await evaluate(`${CHART_API}.setResolution(${safeString(tf)})`);
        }

        await waitForChartReady(symbol);
        await new Promise(r => setTimeout(r, delay));

        let actionResult;
        if (action === 'screenshot') {
          mkdirSync(SCREENSHOT_DIR, { recursive: true });
          const client = await getClient();
          const { data } = await client.Page.captureScreenshot({ format: 'png' });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fname = `batch_${symbol}_${tf || 'default'}_${ts}`.replace(/[\/\\]/g, '_') + '.png';
          const filePath = join(SCREENSHOT_DIR, fname);
          writeFileSync(filePath, Buffer.from(data, 'base64'));
          actionResult = { file_path: filePath };
        } else if (action === 'get_ohlcv') {
          // Use direct bar storage read — same as data_get_ohlcv, no Promise rejection risk
          const limit = Math.min(ohlcv_count || 100, 500);
          const raw = await evaluate(`
            (function() {
              var bars = ${BARS_PATH};
              if (!bars || typeof bars.lastIndex !== 'function') return null;
              var result = [];
              var end = bars.lastIndex();
              var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
              for (var i = start; i <= end; i++) {
                var v = bars.valueAt(i);
                if (v) result.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
              }
              return { bars: result, total: bars.size() };
            })()
          `);
          if (!raw || !raw.bars || raw.bars.length === 0) {
            actionResult = { error: 'No bar data — chart may still be loading' };
          } else {
            actionResult = { bar_count: raw.bars.length, total_available: raw.total, bars: raw.bars };
          }
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
          actionResult = { error: 'Unknown action or API not available: ' + action };
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
