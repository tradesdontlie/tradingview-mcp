import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/batch.js';

export function registerBatchTools(server) {
  server.tool('batch_run', 'Run an action across multiple symbols and/or timeframes', {
    symbols: z.array(z.string()).max(20).describe('Array of symbols to iterate (max 20) (e.g., ["BTCUSD", "ETHUSD", "AAPL"])'),
    timeframes: z.array(z.string()).max(10).optional().describe('Array of timeframes (max 10) (e.g., ["D", "60", "15"])'),
    action: z.enum(['screenshot', 'get_ohlcv', 'get_strategy_results']).describe('Action to run: screenshot, get_ohlcv, get_strategy_results'),
    delay_ms: z.coerce.number().optional().describe('Delay between iterations in ms (default 2000)'),
    ohlcv_count: z.coerce.number().int().positive().max(500).optional().describe('Bar count for get_ohlcv action (max 500, default 100)'),
  }, async ({ symbols, timeframes, action, delay_ms, ohlcv_count }) => {
    try { return jsonResult(await core.batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
