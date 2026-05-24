import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/data.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerDataTools(server) {
  server.tool('data_get_ohlcv', 'Get OHLCV bar data from the chart. Use summary=true for compact stats instead of all bars (saves context).', {
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
    target_id: targetIdParam,
  }, async ({ count, summary, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getOhlcv({ count, summary }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
    target_id: targetIdParam,
  }, async ({ entity_id, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getIndicator({ entity_id }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_strategy_results', 'Get strategy performance metrics from Strategy Tester', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getStrategyResults())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_trades', 'Get trade list from Strategy Tester', {
    max_trades: z.coerce.number().optional().describe('Maximum trades to return'),
    target_id: targetIdParam,
  }, async ({ max_trades, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getTrades({ max_trades }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_equity', 'Get equity curve data from Strategy Tester', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getEquity())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('quote_get', 'Get real-time quote data for a symbol (price, OHLC, volume)', {
    symbol: z.string().optional().describe('Symbol to quote (blank = current chart symbol)'),
    target_id: targetIdParam,
  }, async ({ symbol, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getQuote({ symbol }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getDepth())); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Open the DOM panel in TradingView before using this tool.' }, true); }
  });

  server.tool('data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
    target_id: targetIdParam,
  }, async ({ study_filter, verbose, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getPineLines({ study_filter, verbose }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
    target_id: targetIdParam,
  }, async ({ study_filter, max_labels, verbose, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getPineLabels({ study_filter, max_labels, verbose }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    target_id: targetIdParam,
  }, async ({ study_filter, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getPineTables({ study_filter }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
    target_id: targetIdParam,
  }, async ({ study_filter, verbose, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getPineBoxes({ study_filter, verbose }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_study_values', 'Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getStudyValues())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
