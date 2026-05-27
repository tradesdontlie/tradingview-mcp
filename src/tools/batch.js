import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/batch.js';

export function registerBatchTools(server) {
  server.tool('batch_run', 'Run an action across multiple symbols and/or timeframes', {
    symbols: z.array(z.string()).describe('Array of symbols to iterate (e.g., ["BTCUSD", "ETHUSD", "AAPL"])'),
    timeframes: z.array(z.string()).optional().describe('Array of timeframes (e.g., ["D", "60", "15"])'),
    action: z.string().describe('Action to run: screenshot, get_ohlcv, get_strategy_results'),
    delay_ms: z.coerce.number().optional().describe('Delay between iterations in ms (default 2000)'),
    ohlcv_count: z.coerce.number().optional().describe('Bar count for get_ohlcv action (default 100)'),
  }, async ({ symbols, timeframes, action, delay_ms, ohlcv_count }) => {
    try { return jsonResult(await core.batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_extract_per_symbol', 'Iterate over symbols[]; for each: chart_ensure_symbol → pine_wait_for_output(expected_for_symbol=symbol) → read the named study\'s emit kinds → record one row. ONE MCP call replaces N × (chart_ensure_symbol + sleep + data_get_pine_<emit>). Returns per-symbol rows with payload + mutation_id provenance. Optional verify_with_known_good fails fast on broken pipeline; abort_after_consecutive_empty bails on coverage loss (audit C6/A1-F1 — the 244-ticker sweep that shipped 8/244).', {
    study_filter: z.string().describe('Study name substring; the Pine study must already be on the chart.'),
    symbols: z.array(z.string()).min(1).max(500).describe('Symbols to iterate (1-500). Example ["TADAWUL:2222","TADAWUL:1120","TADAWUL:1031"].'),
    emit: z.array(z.enum(['labels', 'lines', 'boxes', 'tables'])).optional().describe('Which Pine output kinds to capture per symbol. Default ["labels"].'),
    max_per_symbol: z.coerce.number().int().min(1).max(1000).optional().describe('Cap on items per symbol per emit kind. Default 200.'),
    wait_after_switch_s: z.coerce.number().min(0).max(30).optional().describe('Per-symbol pine_wait_for_output timeout. Default 8.'),
    abort_after_consecutive_empty: z.coerce.number().int().min(0).optional().describe('Bail out after N consecutive empty results. 0 = never abort. Default 0.'),
    verify_with_known_good: z.string().optional().describe('If set, runs this symbol FIRST and aborts the sweep if it returns empty (signals broken pipeline vs sparse coverage).'),
  }, async (args) => {
    try { return jsonResult(await core.extractPerSymbol(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
