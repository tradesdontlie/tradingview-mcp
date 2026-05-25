import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/chart.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const MUTATES   = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const NETWORK   = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerChartTools(server) {
  server.tool('chart_get_state', 'Get current chart state: symbol, timeframe, chart type, studies with entity IDs, delayed_feed flag, is_strategy per study. With verify_against_feed=true (default) also returns coherent/coherence_errors/data_symbol/data_resolution/last_chart_mutation_id; success=false + error=CHART_DATA_STATE_MISMATCH if reported state disagrees with the live feed (audit C1/A1-F4/A2-F1).', {
    verify_against_feed: z.coerce.boolean().optional().describe('Cross-check reported symbol/resolution against mainSeries() live feed. Default true. Set false for legacy snapshot-only behavior.'),
  }, async ({ verify_against_feed }) => {
    try { return jsonResult(await core.getState({ verify_against_feed: verify_against_feed !== false })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('chart_set_symbol', 'Change the chart symbol. NOTE: TradingView may silently fall back to a delayed feed (_DLY) if realtime is not entitled. Use chart_ensure_symbol if you need that confirmed.', {
    symbol: z.string().describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!, TADAWUL:6015)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.setSymbol({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('chart_ensure_symbol', 'Set symbol, wait for the chart to settle (audit C11/A1-F11/A2-F4: hard-stop default — require_ready=true returns success:false + error:CHART_NOT_READY if not ready), and report delayed_feed. Returns mutation_id + resolved canonical symbol. Prefer this over chart_set_symbol.', {
    symbol: z.string().describe('Symbol to set (with or without exchange prefix)'),
    require_ready: z.coerce.boolean().optional().describe('Hard-stop when chart not ready. Default true (audit C11). Set false for legacy "fire-and-forget" behaviour where chart_ready:false is silently tolerated.'),
    ready_timeout_ms: z.coerce.number().int().min(1000).max(60000).optional().describe('How long to wait for chart_ready. Default 10000.'),
  }, async ({ symbol, require_ready, ready_timeout_ms }) => {
    try { return jsonResult(await core.ensureSymbol({ symbol, require_ready: require_ready !== false, ready_timeout_ms })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('chart_set_timeframe', 'Change the chart timeframe/resolution', {
    timeframe: z.string().describe('Timeframe (e.g., 1, 5, 15, 60, 240, D, W, M)'),
  }, async ({ timeframe }) => {
    try { return jsonResult(await core.setTimeframe({ timeframe })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('chart_set_type', 'Change chart type', {
    chart_type: z.string().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number'),
  }, async ({ chart_type }) => {
    try { return jsonResult(await core.setType({ chart_type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('chart_clear_studies', 'Remove ALL studies on the active chart, optionally preserving an allowlist by name. Use to put the chart into a known-clean state before deploying a workflow indicator (audit C13/A1-F13). Returns removed + preserved arrays. Pass dry_run=true to preview.', {
    except_names: z.array(z.string()).optional().describe('Names to preserve (case-insensitive). Example ["EarnsExtractor"].'),
    except_built_ins: z.coerce.boolean().optional().describe('Preserve TradingView built-in studies (Volume, etc.). Default true.'),
    dry_run: z.coerce.boolean().optional().describe('Return what would be removed without actually removing. Default false.'),
  }, async ({ except_names, except_built_ins, dry_run }) => {
    try { return jsonResult(await core.clearStudies({ except_names, except_built_ins: except_built_ins !== false, dry_run })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });

  server.tool('chart_manage_indicator', 'Add or remove an indicator/study on the chart', {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    indicator: z.string().describe('Full indicator name: "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work.'),
    entity_id: z.string().optional().describe('Entity ID to remove (from chart_get_state). Required for remove.'),
    inputs: z.string().optional().describe('JSON string of input overrides for the indicator (e.g., \'{"length": 20}\')'),
  }, async ({ action, indicator, entity_id, inputs }) => {
    try { return jsonResult(await core.manageIndicator({ action, indicator, entity_id, inputs })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('chart_get_visible_range', 'Get the visible date range (unix timestamps) and bars range on the chart', {}, async () => {
    try { return jsonResult(await core.getVisibleRange()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('chart_set_visible_range', 'Zoom the chart to a specific date range (unix timestamps)', {
    from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
    to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
  }, async ({ from, to }) => {
    try { return jsonResult(await core.setVisibleRange({ from, to })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string'),
  }, async ({ date }) => {
    try { return jsonResult(await core.scrollToDate({ date })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, MUTATES);

  server.tool('symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {}, async () => {
    try { return jsonResult(await core.symbolInfo()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, READ_ONLY);

  server.tool('symbol_search', 'Search for symbols by name or keyword. Returns up to 15 raw matches — use symbol_resolve if you just want the single best match.', {
    query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES")'),
    type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
  }, async ({ query, type }) => {
    try { return jsonResult(await core.symbolSearch({ query, type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, NETWORK);

  server.tool('symbol_resolve', 'Resolve a free-text query (e.g., "6015 Americana", "AAPL") to the single best-match canonical symbol. Ranks by exact-ticker > preferred exchange > stock type. Returns up to 4 alternatives.', {
    query: z.string().describe('Free-text symbol query (ticker, name, or fragment)'),
    prefer_exchange: z.string().optional().describe('Exchange code to prefer in ranking (e.g., "TADAWUL", "NASDAQ", "BINANCE")'),
  }, async ({ query, prefer_exchange }) => {
    try { return jsonResult(await core.resolveSymbol({ query, prefer_exchange })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  }, NETWORK);
}
