import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { jsonResult } from './_format.js';
import * as core from '../core/replay.js';
import { replayWalk, DEFAULT_WALK_SECTIONS, DEFAULT_MAX_BARS } from '../core/backtest.js';
import { backtestPull } from '../sidecar/backtest_socket.js';
import { backtestFromSignals } from '../sidecar/signal_pnl.js';
import { backtestRunStrategy } from '../sidecar/strategy_report.js';

// Load a {t, values} series from a JSONL file (as written by backtest_pull /
// replay_walk `out`). One JSON row per non-empty line.
function loadSeriesJsonl(path) {
  const text = readFileSync(path, 'utf-8');
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// The full report (trades + equity_curve) can be large for long ranges — a
// compact summary keeps the MCP response small when streaming to `out`.
function summarizeReport(r) {
  const { trades, equity_curve, ...rest } = r;
  return { ...rest, trades: trades.length, equity_points: equity_curve.length };
}

export function registerReplayTools(server) {
  server.tool('backtest_pull', 'Headless (no-browser) backtest: pull a Pine indicator\'s full per-bar output over TradingView\'s WebSocket — array-speed vs replay_walk. Returns the same {t, values} row shape. Requires a TradingView session token in the TV_SESSION (+ TV_SIGNATURE) environment. indicator_id is "STD;RSI" (built-in) or "USER;<hash>" (your saved/private script).', {
    symbol: z.string().describe('Symbol, e.g. "NASDAQ:AAPL", "NYSE:F", "BINANCE:BTCUSDT".'),
    indicator_id: z.string().describe('Indicator id: "STD;RSI" (built-in) or "USER;<hash>" (private/saved).'),
    from: z.string().optional().describe('Start date (YYYY-MM-DD or ISO). Filters the pulled bars.'),
    to: z.string().optional().describe('End date (YYYY-MM-DD or ISO).'),
    timeframe: z.string().optional().describe('Timeframe: "D" (default), "60", "15", "W", etc.'),
    range: z.coerce.number().optional().describe('Bar count to pull (default 500). Must be deep enough to reach `from`.'),
    out: z.string().optional().describe('File path to stream JSONL rows to. Omit to return the series inline.'),
  }, async ({ symbol, indicator_id, from, to, timeframe, range, out }) => {
    try { return jsonResult(await backtestPull({ symbol, indicatorId: indicator_id, from, to, timeframe, range, out })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('backtest_from_signals', 'Code-side P&L: turn a captured signal series ({t, values} rows from backtest_pull / replay_walk) into net profit, win rate, expectancy, max drawdown and an equity curve using simple declarative entry/exit rules. Runs in code (no browser, no token) — sidesteps Pine\'s 2000-order strategy cap. Pass the series inline (series) or point at a JSONL file (series_path). Rates are fractions in [0,1]; gross_loss is a positive magnitude.', {
    series: z.array(z.object({ t: z.number(), values: z.record(z.any()) })).optional().describe('Inline series: [{t, values:{...}}]. Omit if using series_path.'),
    series_path: z.string().optional().describe('Path to a JSONL series file (from backtest_pull/replay_walk out). Omit if passing series inline.'),
    rules: z.object({
      side: z.enum(['long', 'short']).optional().describe('Trade direction (default long).'),
      entry: z.any().describe('Entry predicate: {field, op, value?|field2?} or {all|any:[...]}|{not:...}. ops: > < >= <= == != crosses_above crosses_below rising falling truthy falsy.'),
      exit: z.any().optional().describe('Exit predicate (same grammar). Omitted → positions ride to end-of-data.'),
      price_field: z.string().optional().describe('values field used as the fill price (default "close"). Must be present in the series.'),
      qty: z.number().optional().describe('Units per trade (default 1).'),
      fee_per_trade: z.number().optional().describe('Round-turn cost subtracted from each trade (default 0).'),
      initial_capital: z.number().optional().describe('Enables %-drawdown vs equity.'),
    }).passthrough().describe('Entry/exit rules.'),
    out: z.string().optional().describe('Write the full report JSON here and return only a summary (recommended for long series).'),
  }, async ({ series, series_path, rules, out }) => {
    try {
      let s = series;
      if (!s && series_path) s = loadSeriesJsonl(series_path);
      if (!s) throw new Error('Provide `series` (inline) or `series_path` (JSONL file).');
      const report = backtestFromSignals({ series: s, rules });
      if (out) {
        writeFileSync(out, JSON.stringify(report, null, 2));
        return jsonResult({ success: true, engine: 'signals', out_path: out, ...summarizeReport(report) });
      }
      return jsonResult({ success: true, engine: 'signals', ...report });
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('backtest_run_strategy', 'Headless strategy backtest: load a Pine strategy() script over the socket and read TradingView\'s own backtest report (net profit, win rate, profit factor, max drawdown, full trade list) — no screenshots. Returns the same canonical metrics schema as backtest_from_signals (recomputed from the trade list), plus TV\'s native aggregates under tv_native. Requires a TradingView session token in TV_SESSION (+ TV_SIGNATURE). script_id is "USER;<hash>" (your saved strategy) or a built-in "STD;...".', {
    script_id: z.string().describe('Strategy script id: "USER;<hash>" (saved/private) or "STD;..." (built-in).'),
    symbol: z.string().describe('Symbol, e.g. "NASDAQ:AAPL".'),
    timeframe: z.string().optional().describe('Timeframe: "D" (default), "60", "W", etc.'),
    range: z.coerce.number().optional().describe('Bar count to load for the backtest (default 500).'),
    from: z.string().optional().describe('Optional: filter the returned trade list to entries on/after this date.'),
    to: z.string().optional().describe('Optional: filter the returned trade list to entries on/before this date.'),
    initial_capital: z.coerce.number().optional().describe('Starting capital for the code-side equity curve (default 0).'),
  }, async ({ script_id, symbol, timeframe, range, from, to, initial_capital }) => {
    try { return jsonResult(await backtestRunStrategy({ scriptId: script_id, symbol, timeframe, range, from, to, initial_capital })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_walk', `Backtest capture loop: step replay from a start date to an end date and record every bar's study values + Pine graphics into a timestamped series (keyed on OHLCV bar time). Use capture to target one indicator by name. Writes JSONL to 'out' if given (recommended for long ranges), else returns the series inline. Default sections: ${DEFAULT_WALK_SECTIONS.join(', ')}. Default max_bars: ${DEFAULT_MAX_BARS}.`, {
    from: z.string().describe('Start date (YYYY-MM-DD or ISO with offset for intraday).'),
    to: z.string().describe('End date (YYYY-MM-DD or ISO). Walk stops at the first bar on/after this date.'),
    capture: z.string().optional().describe('Substring to match the indicator/study name to capture. Omit to capture all.'),
    resolution: z.string().optional().describe('Replay stepping granularity (e.g. "1H", "1D", "auto"). See replay_set_resolution.'),
    sections: z.array(z.string()).optional().describe(`Snapshot sections per bar (subset of ohlcv, studies, pine_labels, pine_lines, pine_tables, pine_boxes). Default: ${DEFAULT_WALK_SECTIONS.join(', ')}.`),
    max_bars: z.coerce.number().optional().describe(`Safety cap on bars captured (default ${DEFAULT_MAX_BARS}). If hit before 'to', result.truncated=true.`),
    out: z.string().optional().describe('File path to stream JSONL rows to (one bar per line). Omit to return the series inline.'),
  }, async (args) => {
    try { return jsonResult(await replayWalk(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_start', 'Start bar replay mode, optionally at a specific date', {
    date: z.string().optional().describe('Date to start replay from (YYYY-MM-DD format). If omitted, selects first available date.'),
  }, async ({ date }) => {
    try { return jsonResult(await core.start({ date })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_step', 'Advance one bar in replay mode', {}, async () => {
    try { return jsonResult(await core.step()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_autoplay', 'Toggle autoplay in replay mode, optionally set speed', {
    speed: z.coerce.number().optional().describe('Autoplay delay in ms (lower = faster). Valid values: 100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000. Leave empty to just toggle.'),
  }, async ({ speed }) => {
    try { return jsonResult(await core.autoplay({ speed })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_set_resolution', 'Set the replay stepping granularity (e.g. "1", "1S", "1H", "1D", or "auto"). Valid set depends on the chart symbol/timeframe; invalid values are rejected before touching cloud state.', {
    resolution: z.string().describe('Replay resolution: "1"/"5"/"15" (min), "1S" (sec), "1H"/"4H", "1D", or "auto".'),
  }, async ({ resolution }) => {
    try { return jsonResult(await core.setResolution({ resolution })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_stop', 'Stop replay and return to realtime', {}, async () => {
    try { return jsonResult(await core.stop()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_trade', 'Execute a trade action in replay mode (buy, sell, or close position)', {
    action: z.string().describe('Trade action: buy, sell, or close'),
  }, async ({ action }) => {
    try { return jsonResult(await core.trade({ action })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_status', 'Get current replay mode status', {}, async () => {
    try { return jsonResult(await core.status()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
