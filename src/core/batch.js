/**
 * Core batch execution logic.
 */
import { evaluate as evaluateDefault, evaluateAsync as evaluateAsyncDefault, getClient as getClientDefault, getChartApi as getChartApiDefault, getChartCollection as getChartCollectionDefault, safeString } from '../connection.js';
import { waitForChartReady as waitForChartReadyDefault } from '../wait.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getOutputDirectory, sanitizeOutputBasename } from '../output-paths.js';

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count, _deps }) {
  const evaluate = _deps?.evaluate || evaluateDefault;
  const evaluateAsync = _deps?.evaluateAsync || evaluateAsyncDefault;
  const getClient = _deps?.getClient || getClientDefault;
  const getChartApi = _deps?.getChartApi || getChartApiDefault;
  const getChartCollection = _deps?.getChartCollection || getChartCollectionDefault;
  const waitForChartReady = _deps?.waitForChartReady || waitForChartReadyDefault;
  const sleep = _deps?.sleep || (ms => new Promise(r => setTimeout(r, ms)));
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
        await sleep(delay);

        let actionResult;
        if (action === 'screenshot') {
          const client = await getClient();
          const { data } = await client.Page.captureScreenshot({ format: 'png' });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fname = sanitizeOutputBasename(`batch_${symbol}_${tf || 'default'}_${ts}`) + '.png';
          const directory = getOutputDirectory('screenshots');
          mkdirSync(directory, { recursive: true });
          const filePath = join(directory, fname);
          writeFileSync(filePath, Buffer.from(data, 'base64'));
          actionResult = { file_path: filePath };
        } else if (action === 'get_ohlcv' && apiPath) {
          const limit = Math.min(ohlcv_count || 100, 500);
          actionResult = await evaluateAsync(`
            new Promise(function(resolve, reject) {
              ${apiPath}.exportData({ includeTime: true, includeSeries: true, includeStudies: false })
                .then(function(result) {
                  var bars = (result.data || []).slice(-${limit});
                  resolve({ bar_count: bars.length, last_bar: bars[bars.length - 1] || null });
                }).catch(reject);
            })
          `);
        } else if (action === 'get_strategy_results') {
          await sleep(1000);
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
