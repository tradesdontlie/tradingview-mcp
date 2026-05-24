import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/batch.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerBatchTools(server) {
  server.tool('batch_run', 'Run an action across multiple symbols and/or timeframes', {
    symbols: z.array(z.string()).describe('Array of symbols to iterate (e.g., ["BTCUSD", "ETHUSD", "AAPL"])'),
    timeframes: z.array(z.string()).optional().describe('Array of timeframes (e.g., ["D", "60", "15"])'),
    action: z.string().describe('Action to run: screenshot, get_ohlcv, get_strategy_results'),
    delay_ms: z.coerce.number().optional().describe('Delay between iterations in ms (default 2000)'),
    ohlcv_count: z.coerce.number().optional().describe('Bar count for get_ohlcv action (default 100)'),
    target_id: targetIdParam,
  }, async ({ symbols, timeframes, action, delay_ms, ohlcv_count, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
