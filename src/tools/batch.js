import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/batch.js';

export function registerBatchTools(server) {
  server.tool('batch_run', 'Run an action across multiple symbols and/or timeframes', {
    symbols: z.array(z.string()).describe('Array of symbols to iterate (e.g., ["BTCUSD", "ETHUSD", "AAPL"])'),
    timeframes: z.array(z.string()).optional().describe('Array of timeframes (e.g., ["D", "60", "15"])'),
    action: z.string().describe('Action to run: screenshot, get_ohlcv, get_strategy_results'),
    delay_ms: z.coerce.number().optional().describe('Delay between iterations in ms (default 2000)'),
    ohlcv_count: z.coerce.number().optional().describe('Bar count for get_ohlcv action (default 100)'),
    output_dir: z.string().optional().describe('Absolute path to save directory for batch screenshots (default: screenshots/ in project root)'),
  }, async ({ symbols, timeframes, action, delay_ms, ohlcv_count, output_dir }) => {
    try { return jsonResult(await core.batchRun({ symbols, timeframes, action, delay_ms, ohlcv_count, output_dir })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
