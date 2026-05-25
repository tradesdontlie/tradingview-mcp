import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/data.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerDataTools(server) {
  server.tool('data_get_ohlcv', 'Get OHLCV bar data from the chart. Use summary=true (default behaviour: pass it explicitly) for compact stats — much smaller output.', {
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
  }, async ({ count, summary }) => {
    try { return jsonResult(await core.getOhlcv({ count, summary })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getIndicator({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('data_get_strategy_results', 'Strategy backtest metrics. Defaults to a compact summary (~30 high-signal keys). Pass summary=false for the raw report, fields=[...] to whitelist top-level keys, or include=["orders","trades","equity"] to opt back into the heavy arrays that are dropped by default.', {
    summary: z.coerce.boolean().optional().describe('Return only headline metrics (~30 keys, ~1 KB). Default: true.'),
    fields: z.array(z.string()).optional().describe('Whitelist of top-level keys to return (e.g. ["net_profit","total_trades","sharpe_ratio"]). Applies AFTER summary.'),
    include: z.array(z.enum(['orders', 'trades', 'equity', 'raw_report'])).optional().describe('Opt back into heavy arrays normally dropped. Use sparingly — these can be 5-20 KB.'),
  }, async ({ summary, fields, include }) => {
    try { return jsonResult(await core.getStrategyResults({ summary: summary !== false, fields, include })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('strategy_get_report', 'CONSOLIDATED: one call returns strategy metrics summary + recent trades + chart context (symbol, timeframe, delayed-feed flag, exchange). Replaces data_get_strategy_results + data_get_trades + chart_get_state + symbol_info.', {
    max_trades: z.coerce.number().int().min(0).max(20).optional().describe('Number of recent trades to include (default 10)'),
    include: z.array(z.enum(['raw_report'])).optional().describe('Opt into raw report data (large, normally summarised away)'),
  }, async ({ max_trades, include }) => {
    try { return jsonResult(await core.getStrategyReport({ max_trades, include })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('chart_export_csv',
    'Export closed-trades or equity-curve data from the active Strategy Tester to a local CSV file. Returns the absolute file path (not the file contents) so large datasets bypass the MCP context window. Feed the resulting CSV into alpha_pbo_cscv / alpha_hac_inference / alpha_deflate_sharpe_siyolah / external Python or R analysis. Bypasses the 20-trade cap of data_get_trades by reading the raw strategy report.',
    {
      kind: z.enum(['trades', 'equity']).describe('"trades" = closed-trade list (full, bypasses 20-trade cap). "equity" = bar-by-bar equity curve.'),
      filename: z.string().optional().describe('Custom filename without extension. Default: auto-derived from kind + ISO timestamp.'),
      max_rows: z.coerce.number().int().min(1).max(50000).optional().describe('Hard cap on rows. Default 10000.'),
    },
    async ({ kind, filename, max_rows }) => {
      try { return jsonResult(await core.exportCsv({ kind, filename, max_rows })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
    READ_ONLY);

  server.tool('data_get_trades', 'Trade list from Strategy Tester. Returns up to max_trades (default/max 20).', {
    max_trades: z.coerce.number().int().min(1).max(20).optional().describe('Maximum trades to return (default 20)'),
  }, async ({ max_trades }) => {
    try { return jsonResult(await core.getTrades({ max_trades })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('data_get_equity', 'Equity curve data from Strategy Tester.', {}, async () => {
    try { return jsonResult(await core.getEquity()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('quote_get', 'Get real-time quote (price, OHLC, volume) for a symbol. Omit `symbol` to use the current chart symbol.', {
    symbol: z.string().optional().describe('Symbol to quote (blank = current chart symbol)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getQuote({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('depth_get', 'Order book / DOM (Depth of Market) data. Requires the DOM panel to be open in TradingView.', {}, async () => {
    try { return jsonResult(await core.getDepth()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Open the DOM panel in TradingView before using this tool.' }, true); }
  }, READ_ONLY);

  server.tool('data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineLines({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
  }, async ({ study_filter, max_labels, verbose }) => {
    try { return jsonResult(await core.getPineLabels({ study_filter, max_labels, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
  }, async ({ study_filter }) => {
    try { return jsonResult(await core.getPineTables({ study_filter })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineBoxes({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('data_get_study_values', 'Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).', {}, async () => {
    try { return jsonResult(await core.getStudyValues()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('strategy_get_inputs', 'List the active strategy\'s input declarations with current values (id, type, value, min/max). Use the returned `id`s as keys for strategy_set_inputs or pine_grid_search axes.', {}, async () => {
    try { return jsonResult(await core.getStrategyInputs()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('strategy_set_inputs', 'Set inputs on the active strategy WITHOUT recompiling the Pine source. Re-runs the backtest in place. Pass an object keyed by input id (use strategy_get_inputs to discover ids).', {
    inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe('Object keyed by input id, e.g. {"rsiLength": 21, "buyLevel": 25}'),
  }, async ({ inputs }) => {
    try { return jsonResult(await core.setStrategyInputs({ inputs })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });

  server.tool('pine_grid_search', 'Grid-search the active strategy: vary 1-3 inputs across discrete value lists, re-run the backtest for each combination, return a leaderboard ranked by the chosen metric (default sharpe_ratio). Original inputs are restored on completion. Capped at 200 combinations; budget ~2 seconds per combo.', {
    axes: z.array(z.object({
      id: z.string().describe('Input id from strategy_get_inputs'),
      values: z.array(z.union([z.number(), z.string(), z.boolean()])).min(1).describe('Discrete values to test, e.g. [9, 14, 21]'),
    })).min(1).max(3).describe('1-3 axes; cartesian product is the test grid.'),
    metric: z.enum(['sharpe_ratio', 'sortino_ratio', 'net_profit', 'net_profit_pct', 'profit_factor', 'percent_profitable', 'total_trades', 'max_drawdown_pct']).optional().describe('Metric to rank by (default sharpe_ratio)'),
    direction: z.enum(['max', 'min']).optional().describe('max = higher is better (default); min = lower is better (e.g. for max_drawdown_pct)'),
    max_combinations: z.coerce.number().int().min(1).max(200).optional().describe('Hard cap (default 25)'),
    settle_ms: z.coerce.number().int().min(500).max(10000).optional().describe('Wait between setting inputs and reading metrics, ms (default 1800)'),
  }, async ({ axes, metric, direction, max_combinations, settle_ms }) => {
    try { return jsonResult(await core.gridSearch({ axes, metric, direction, max_combinations, settle_ms })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

  server.tool('strategy_validate_quality', 'Assert the active strategy\'s metrics against quality thresholds. Returns pass/fail per check + an overall verdict. Use after a backtest to gate decisions (e.g. only deploy if Sharpe >= 1.0 AND max DD <= 15% AND trades >= 30).', {
    thresholds: z.object({
      min_sharpe: z.number().optional().describe('Minimum acceptable Sharpe ratio'),
      min_profit_factor: z.number().optional().describe('Minimum acceptable profit factor (gross_profit/gross_loss)'),
      max_drawdown_pct: z.number().optional().describe('Maximum acceptable drawdown as a fraction (0.15 = 15%)'),
      min_trades: z.number().int().optional().describe('Minimum total trades (statistical significance gate)'),
      min_win_rate: z.number().optional().describe('Minimum win rate as a fraction (0.4 = 40%)'),
      min_net_profit_pct: z.number().optional().describe('Minimum net profit as a fraction (0.10 = +10%)'),
    }).describe('Threshold object. Each key is optional; only provided ones are checked.'),
  }, async ({ thresholds }) => {
    try { return jsonResult(await core.validateQuality({ thresholds })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);
}
