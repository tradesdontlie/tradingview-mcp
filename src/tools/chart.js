import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerChartTools(server) {
  server.tool('chart_get_state', 'Get current chart state (symbol, timeframe, chart type, indicators)', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getState())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_symbol', 'Change the chart symbol', {
    symbol: z.string().describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)'),
    target_id: targetIdParam,
  }, async ({ symbol, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.setSymbol({ symbol }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_timeframe', 'Change the chart timeframe/resolution', {
    timeframe: z.string().describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M)'),
    target_id: targetIdParam,
  }, async ({ timeframe, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.setTimeframe({ timeframe }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_type', 'Change chart type', {
    chart_type: z.string().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number'),
    target_id: targetIdParam,
  }, async ({ chart_type, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.setType({ chart_type }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_manage_indicator', 'Add or remove an indicator/study on the chart', {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    indicator: z.string().describe('Full indicator name: "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work.'),
    entity_id: z.string().optional().describe('Entity ID to remove (from chart_get_state). Required for remove.'),
    inputs: z.string().optional().describe('JSON string of input overrides for the indicator (e.g., \'{"length": 20}\')'),
    target_id: targetIdParam,
  }, async ({ action, indicator, entity_id, inputs, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.manageIndicator({ action, indicator, entity_id, inputs }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_get_visible_range', 'Get the visible date range (unix timestamps) and bars range on the chart', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getVisibleRange())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_set_visible_range', 'Zoom the chart to a specific date range (unix timestamps)', {
    from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
    to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
    target_id: targetIdParam,
  }, async ({ from, to, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.setVisibleRange({ from, to }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string'),
    target_id: targetIdParam,
  }, async ({ date, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.scrollToDate({ date }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {
    target_id: targetIdParam,
  }, async ({ target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.symbolInfo())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('symbol_search', 'Search for symbols by name or keyword', {
    query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES")'),
    type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
  }, async ({ query, type }) => {
    try { return jsonResult(await core.symbolSearch({ query, type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
