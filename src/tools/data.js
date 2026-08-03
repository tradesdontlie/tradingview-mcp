import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/data.js';

export function registerDataTools(server) {
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

  server.tool('data_get_strategy_results', 'Get strategy performance metrics from Strategy Tester. Auto-opens the panel and auto-unhides a hidden strategy (TradingView never computes reports for hidden strategies); result includes unhidden_strategies when that happened.', {}, async () => {
    try { return jsonResult(await core.getStrategyResults()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_trades', 'Get trade list from Strategy Tester. Auto-opens the panel and auto-unhides a hidden strategy.', {
    max_trades: z.coerce.number().optional().describe('Maximum trades to return'),
  }, async ({ max_trades }) => {
    try { return jsonResult(await core.getTrades({ max_trades })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_equity', 'Get equity curve data from Strategy Tester', {}, async () => {
    try { return jsonResult(await core.getEquity()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('quote_get', 'Get real-time quote data for a symbol (price, OHLC, volume). If symbol is provided and differs from the current chart, the chart is briefly switched to fetch the quote and then restored — adds ~1-2s and serializes parallel calls.', {
    symbol: z.string().optional().describe('Symbol to quote (blank = current chart symbol). Non-blank values cause a chart switch + restore.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getQuote({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {}, async () => {
    try { return jsonResult(await core.getDepth()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Open the DOM panel in TradingView before using this tool.' }, true); }
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

  // --- Symbol data panels (Forecast, Technicals, Financials, ...) ------------
  // Every tool below defaults to the chart's current symbol; pass an
  // exchange-qualified symbol (e.g. "NASDAQ:AMZN") to read any other one
  // without touching the chart.

  server.tool('data_get_key_stats', 'Key stats for a symbol: market cap, next earnings date, volume, average volume, dividend yield, P/E, EPS, beta, shares outstanding.', {
    symbol: z.string().optional().describe('Exchange-qualified symbol (e.g. "NASDAQ:AMZN"). Omit for the current chart symbol.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getKeyStats({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_technicals', 'Technicals consensus gauges (Strong buy…Strong sell) for Summary, Moving Averages and Oscillators, plus the underlying indicator values (RSI, Stoch, MACD, ADX, CCI, EMAs, SMAs).', {
    symbol: z.string().optional().describe('Exchange-qualified symbol. Omit for the current chart symbol.'),
    timeframe: z.string().optional().describe('Timeframe for the gauges: 1, 5, 15, 30, 60, 120, 240, 1D (default), 1W, 1M'),
  }, async ({ symbol, timeframe }) => {
    try { return jsonResult(await core.getTechnicals({ symbol, timeframe })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_forecast', 'Analyst forecast: price target low/average/high, upside % vs current price, consensus rating and the analyst buy/hold/sell breakdown.', {
    symbol: z.string().optional().describe('Exchange-qualified symbol. Omit for the current chart symbol.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getForecast({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_financials', 'Income statement history: revenue, gross profit, net income, diluted EPS, EBITDA, free cash flow, debt/assets and margins, per annual or quarterly period (newest first).', {
    symbol: z.string().optional().describe('Exchange-qualified symbol. Omit for the current chart symbol.'),
    period: z.enum(['annual', 'quarterly']).optional().describe('Reporting period (default annual)'),
    limit: z.coerce.number().optional().describe('How many periods to return (default 8, max 32)'),
  }, async ({ symbol, period, limit }) => {
    try { return jsonResult(await core.getFinancials({ symbol, period, limit })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_seasonals', 'Seasonality for the current chart symbol: average return, win rate, best and worst outcome per calendar month. Derived from monthly bars — briefly switches the chart to 1M and restores the original resolution.', {
    years: z.coerce.number().optional().describe('Lookback window in years (default 10, max 30)'),
  }, async ({ years }) => {
    try { return jsonResult(await core.getSeasonals({ years })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_news', 'Recent news headlines for a symbol: title, source, publish date, breaking flag and article link.', {
    symbol: z.string().optional().describe('Exchange-qualified symbol. Omit for the current chart symbol.'),
    limit: z.coerce.number().optional().describe('Max headlines to return (default 15, max 50)'),
  }, async ({ symbol, limit }) => {
    try { return jsonResult(await core.getNews({ symbol, limit })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_options', 'Options ATM implied-volatility term structure: per expiry, the ATM strike and ATM IV %. Only available for optionable US equities and ETFs.', {
    symbol: z.string().optional().describe('Exchange-qualified symbol. Omit for the current chart symbol.'),
    max_expirations: z.coerce.number().optional().describe('How many expiries to return, nearest first (default 10, max 30)'),
  }, async ({ symbol, max_expirations }) => {
    try { return jsonResult(await core.getOptions({ symbol, max_expirations })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_etf_profile', 'ETF/fund profile: AUM, expense ratio, NAV, fund type. Returns an error for non-fund instruments.', {
    symbol: z.string().optional().describe('Exchange-qualified symbol (e.g. "AMEX:SPY"). Omit for the current chart symbol.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getEtfProfile({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_bond_info', 'Bond/yield instrument info: current yield, coupon, maturity date. Returns an error for non-bond instruments.', {
    symbol: z.string().optional().describe('Exchange-qualified symbol (e.g. "TVC:US10Y"). Omit for the current chart symbol.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getBondInfo({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
