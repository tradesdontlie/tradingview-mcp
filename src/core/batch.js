/**
 * Core batch execution logic.
 */
import { evaluate, evaluateAsync, getClient, getChartApi, getChartCollection, safeString } from '../connection.js';
import { waitForChartReady } from '../wait.js';
import { ensureSymbol } from './chart.js';
import { waitForOutput } from './pine.js';
import { getPineLabels, getPineLines, getPineBoxes, getPineTables } from './data.js';
import { currentMutationId } from './_mutation_ledger.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

export async function batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }) {
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

/**
 * C6 / A1-F1 — per-symbol Pine-output extractor.
 *
 * For each symbol: ensureSymbol → waitForOutput(expected_for_symbol=sym) →
 * read the requested emit kinds → record one row. Collapses N × (set + wait
 * + read) into a single MCP call.
 *
 * Replaces the operator-session pattern (CC TV MCP.txt:431, 1337) where
 * 244 TADAWUL tickers × ~4 tool calls × ~30s shipped only 8/244.
 *
 * Options:
 *   study_filter            - required, Pine study name substring
 *   symbols                 - required, 1..500 symbols
 *   emit                    - ['labels','lines','boxes','tables'], default ['labels']
 *   max_per_symbol          - cap on items per symbol, default 200
 *   wait_after_switch_s     - per-symbol wait_for_output timeout, default 8
 *   abort_after_consecutive_empty - 0 = never abort. Otherwise bail after N
 *                                   consecutive empties.
 *   verify_with_known_good  - if set, runs this symbol FIRST; aborts the sweep
 *                             if it returns empty (signals broken pipeline vs
 *                             sparse coverage)
 */
export async function extractPerSymbol({
  study_filter,
  symbols,
  emit = ['labels'],
  max_per_symbol = 200,
  wait_after_switch_s = 8,
  abort_after_consecutive_empty = 0,
  verify_with_known_good = null,
  _deps,
} = {}) {
  if (!study_filter) throw new Error('study_filter is required');
  if (!Array.isArray(symbols) || symbols.length === 0) throw new Error('symbols must be a non-empty array');
  if (symbols.length > 500) throw new Error('symbols capped at 500');
  const validEmit = ['labels', 'lines', 'boxes', 'tables'];
  const emitArr = (Array.isArray(emit) ? emit : [emit]).filter(e => validEmit.includes(e));
  if (emitArr.length === 0) throw new Error(`emit must be one or more of ${JSON.stringify(validEmit)}`);

  const _ensureSymbol = _deps?.ensureSymbol || ensureSymbol;
  const _waitForOutput = _deps?.waitForOutput || waitForOutput;
  const _readers = {
    labels: _deps?.getPineLabels || getPineLabels,
    lines: _deps?.getPineLines || getPineLines,
    boxes: _deps?.getPineBoxes || getPineBoxes,
    tables: _deps?.getPineTables || getPineTables,
  };

  const startedAt = new Date().toISOString();
  const rows = [];
  let consecutiveEmpty = 0;
  let aborted = false;
  let abort_reason = null;

  // Optional pipeline-health verify
  const orderedSymbols = (verify_with_known_good && !symbols.includes(verify_with_known_good))
    ? [verify_with_known_good, ...symbols]
    : symbols.slice();

  for (let i = 0; i < orderedSymbols.length; i += 1) {
    const symbol = orderedSymbols[i];
    const rowStart = Date.now();
    const row = { symbol, success: false };
    try {
      const ens = await _ensureSymbol({ symbol });
      row.ensured_symbol = ens?.resolved_symbol || ens?.symbol || symbol;
      row.mutation_id_after_ensure = ens?.mutation_id ?? null;
      row.delayed_feed = !!ens?.delayed_feed;
      // wait_for_output gates BOTH on study presence + expected_for_symbol
      const wait = await _waitForOutput({
        study_filter,
        emit: emitArr[0],
        min_count: 1,
        expected_for_symbol: symbol,
        timeout_s: wait_after_switch_s,
        poll_interval_ms: 250,
      });
      if (wait.success === false) {
        row.error = wait.code || 'WAIT_FAILED';
        row.wait_last_result = wait.last_result || null;
        row.wait_ms_elapsed = wait.wait_ms_elapsed || null;
        consecutiveEmpty += 1;
      } else {
        // Read the requested emit kinds (in addition to whatever waitForOutput
        // already collected for emitArr[0]).
        const payload = {};
        for (const kind of emitArr) {
          const args = { study_filter, expected_for_symbol: symbol };
          if (kind === 'labels') args.max_labels = max_per_symbol;
          const res = await _readers[kind](args);
          payload[kind] = res?.studies || [];
        }
        const totalItems = Object.values(payload).reduce((sum, arr) => sum + arr.reduce((s, st) => {
          const c = st.total_labels ?? st.total_lines ?? st.total_boxes ?? (st.tables ? st.tables.length : 0) ?? 0;
          return s + (typeof c === 'number' ? c : 0);
        }, 0), 0);
        if (totalItems === 0) {
          consecutiveEmpty += 1;
        } else {
          consecutiveEmpty = 0;
        }
        row.success = totalItems > 0;
        row.payload = payload;
        row.total_items = totalItems;
        row.mutation_id_after_read = currentMutationId();
        row.wait_ms_elapsed = wait.wait_ms_elapsed || null;
      }
    } catch (e) {
      row.error = e.message;
      consecutiveEmpty += 1;
    }
    row.elapsed_ms = Date.now() - rowStart;
    rows.push(row);

    // Abort on verify-symbol empty
    if (i === 0 && verify_with_known_good && !row.success) {
      aborted = true;
      abort_reason = `verify_with_known_good="${verify_with_known_good}" returned empty — pipeline appears broken. Aborted before any of the requested symbols ran.`;
      break;
    }

    // Abort on N consecutive empty
    if (abort_after_consecutive_empty > 0 && consecutiveEmpty >= abort_after_consecutive_empty) {
      aborted = true;
      abort_reason = `${consecutiveEmpty} consecutive empty results (>= abort_after_consecutive_empty=${abort_after_consecutive_empty}).`;
      break;
    }
  }

  const successCount = rows.filter(r => r.success).length;
  return {
    success: !aborted || successCount > 0,
    aborted,
    abort_reason,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    symbols_requested: symbols.length,
    symbols_processed: rows.length,
    successful: successCount,
    empty: rows.length - successCount,
    rows,
  };
}
