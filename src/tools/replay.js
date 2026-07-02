import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/replay.js';
import { replayWalk, DEFAULT_WALK_SECTIONS, DEFAULT_MAX_BARS } from '../core/backtest.js';
import { backtestPull } from '../sidecar/backtest_socket.js';

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
