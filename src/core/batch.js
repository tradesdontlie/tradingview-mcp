/**
 * Core batch execution logic.
 */
import { evaluate, evaluateAsync, getClient, getChartApi, getChartCollection, safeString } from '../connection.js';
import { waitForChartReady } from '../wait.js';
import { getStrategyResults, getStrategyFingerprint, normalizeSymbol } from './data.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

// How long to wait for a strategy report to recompute after a symbol change
// before giving up and flagging the read as possibly stale.
const STRATEGY_RECOMPUTE_TIMEOUT_MS = 15000;
const STRATEGY_POLL_INTERVAL_MS = 400;

/**
 * Build one iteration's result row.
 * An action can fail WITHOUT throwing — it returns `{ error }`. Deriving
 * success from "no exception was thrown" made a sweep in which every single
 * iteration failed report `successful: 15, failed: 0`. Success must come from
 * the payload. Exported for testing.
 */
export function buildIterationResult(combo, actionResult) {
  const actionError = actionResult && typeof actionResult === 'object' ? actionResult.error : null;
  return {
    ...combo,
    success: !actionError,
    ...(actionError && { error: actionError }),
    result: actionResult,
  };
}

/** Aggregate iteration rows into the batch envelope. Exported for testing. */
export function summarizeBatch(results) {
  const successCount = results.filter(r => r.success).length;
  const failedCount = results.length - successCount;
  const staleCount = results.filter(r => r.result?.stale_warning).length;
  return {
    success: failedCount === 0,
    total_iterations: results.length,
    successful: successCount,
    failed: failedCount,
    ...(staleCount > 0 && { stale: staleCount }),
  };
}

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }) {
  const tfs = timeframes && timeframes.length > 0 ? timeframes : [null];
  const delay = delay_ms || 2000;
  const results = [];

  let colPath, apiPath;
  try { colPath = await getChartCollection(); } catch {}
  try { apiPath = await getChartApi(); } catch {}

  // Baseline for staleness detection — the report belonging to whatever symbol
  // the chart was on before the sweep started.
  let prevFingerprint;
  if (action === 'get_strategy_results') {
    try { prevFingerprint = await getStrategyFingerprint(); } catch { prevFingerprint = null; }
  }

  for (const symbol of symbols) {
    for (const tf of tfs) {
      const combo = { symbol, timeframe: tf };
      try {
        // Whether we should expect the strategy report to change. If the chart
        // is already showing this symbol, nothing recomputes and the
        // fingerprint stays put — without this the very first iteration of a
        // sweep gets flagged stale purely because the chart happened to
        // already be there.
        let symbolChanged = true;
        if (action === 'get_strategy_results' && apiPath) {
          try {
            const cur = await evaluate(`${apiPath}.symbol()`);
            symbolChanged = normalizeSymbol(cur) !== normalizeSymbol(symbol);
          } catch { /* assume it changed */ }
        }

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
          mkdirSync(SCREENSHOT_DIR, { recursive: true });
          const client = await getClient();
          const { data } = await client.Page.captureScreenshot({ format: 'png' });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fname = `batch_${symbol}_${tf || 'default'}_${ts}`.replace(/[\/\\]/g, '_') + '.png';
          const filePath = join(SCREENSHOT_DIR, fname);
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
          // Was a DOM scrape of the Strategy Tester panel, which failed with
          // "Strategy Tester not found" whenever the panel was closed — every
          // iteration of a sweep. getStrategyResults() reads TradingView's
          // internal report object and opens/unhides the panel itself.
          // Nothing to wait for when the chart was already on this symbol.
          let recomputed = !symbolChanged;
          if (symbolChanged) {
            const deadline = Date.now() + STRATEGY_RECOMPUTE_TIMEOUT_MS;
            while (Date.now() < deadline) {
              const fp = await getStrategyFingerprint();
              if (fp !== null && fp !== prevFingerprint) { recomputed = true; break; }
              await new Promise(r => setTimeout(r, STRATEGY_POLL_INTERVAL_MS));
            }
          }

          actionResult = await getStrategyResults();
          prevFingerprint = await getStrategyFingerprint();

          if (!recomputed && !actionResult.error) {
            actionResult = {
              ...actionResult,
              stale_warning: 'Strategy report did not change after the symbol switch within '
                + STRATEGY_RECOMPUTE_TIMEOUT_MS + 'ms — these numbers may belong to the previous symbol. '
                + 'Raise delay_ms, or re-read this symbol individually with data_get_strategy_results.',
            };
          }
        } else {
          actionResult = { error: 'Unknown action or API not available: ' + action };
        }

        results.push(buildIterationResult(combo, actionResult));
      } catch (err) {
        results.push({ ...combo, success: false, error: err.message });
      }
    }
  }

  return { ...summarizeBatch(results), results };
}
