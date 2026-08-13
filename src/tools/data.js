import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/data.js';
import { getBiasSignal } from '../core/bias.js';
import { chartSnapshot, SNAPSHOT_SECTIONS } from '../core/snapshot.js';

export function registerDataTools(server) {
  server.tool('chart_snapshot', `One concurrent capture of the current bar: chart state + current-bar OHLCV + study values + Pine graphics (lines/labels/tables/boxes). Filter with study_filter; limit sections with include (${SNAPSHOT_SECTIONS.join(', ')}). Ideal for per-bar capture during replay.`, {
    study_filter: z.string().optional().describe('Substring to match study name across all sections. Omit for all studies.'),
    include: z.array(z.string()).optional().describe(`Sections to capture (subset of: ${SNAPSHOT_SECTIONS.join(', ')}). Omit for all.`),
    max_labels: z.coerce.number().optional().describe('Cap on Pine labels captured (passed through to the labels section).'),
  }, async ({ study_filter, include, max_labels }) => {
    try { return jsonResult(await chartSnapshot({ study_filter, include, max_labels })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_ohlcv', 'Get OHLCV bar data from the chart. Use summary=true for compact stats instead of all bars (saves context).', {
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
  }, async ({ count, summary }) => {
    try { return jsonResult(await core.getOhlcv({ count, summary })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getIndicator({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_strategy_results', 'Get strategy performance metrics from Strategy Tester', {}, async () => {
    try { return jsonResult(await core.getStrategyResults()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_trades', 'Get trade list from Strategy Tester', {
    max_trades: z.coerce.number().optional().describe('Maximum trades to return'),
  }, async ({ max_trades }) => {
    try { return jsonResult(await core.getTrades({ max_trades })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_equity', 'Get equity curve data from Strategy Tester', {}, async () => {
    try { return jsonResult(await core.getEquity()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('quote_get', 'Get real-time quote data for a symbol (price, OHLC, volume)', {
    symbol: z.string().optional().describe('Symbol to quote (blank = current chart symbol)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getQuote({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {}, async () => {
    try { return jsonResult(await core.getDepth()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Open the DOM panel in TradingView before using this tool.' }, true); }
  });

  server.tool('scanner_enrich', 'Batch-enrich symbols with price + 30d & 60d average volume + market cap + description via the TradingView scanner REST endpoint (quality filter). One cross-origin POST returns data for up to 500 symbols. Used by a downstream mover-refresh step to drop sub-$N price, thin-volume, micro-cap tickers BEFORE they reach triage. Output.enriched is keyed by UPPER-cased symbol (each carries avg_vol_30d + avg_vol_60d); output.missing lists requested symbols the endpoint did not return (typically delisted or non-US).', {
    symbols: z.array(z.string()).describe('Array of fully-qualified symbols (e.g., ["NASDAQ:AAPL","NYSE:IBM"]). Max 500 per call.'),
  }, async ({ symbols }) => {
    try { return jsonResult(await core.enrichSymbols({ symbols })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineLines({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
  }, async ({ study_filter, max_labels, verbose }) => {
    try { return jsonResult(await core.getPineLabels({ study_filter, max_labels, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
  }, async ({ study_filter }) => {
    try { return jsonResult(await core.getPineTables({ study_filter })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineBoxes({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_study_values', 'Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).', {}, async () => {
    try { return jsonResult(await core.getStudyValues()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_bias_signal', 'Infer directional bias (bullish/bearish/neutral) for custom Pine indicators that draw only lines/labels/boxes with no plot() output (data_get_study_values returns nothing for these). Checks label/table text for explicit bias keywords first (high confidence), then falls back to a sweep→confirmation (CSD/BOS/CHoCH) label-price sequence heuristic (low confidence). Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "3Cs", "Key Levels"). Omit for all label/table-drawing studies.'),
  }, async ({ study_filter }) => {
    try { return jsonResult(await getBiasSignal({ study_filter })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
