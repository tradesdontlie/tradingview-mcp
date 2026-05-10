import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/strategy.js';

export function registerStrategyTools(server) {
  server.tool('strategy_open', 'Open a saved TradingView strategy/layout by name with optional verification and panel setup', {
    name: z.string().describe('Strategy or saved layout name to open, e.g. "8AM Breakout Algo" or "Hit & Run Algo"'),
    symbol: z.string().optional().describe('Optional expected active-chart symbol to verify after opening'),
    timeframe: z.string().optional().describe('Optional expected active-chart timeframe/resolution to verify after opening'),
    panels: z.array(z.enum(['pine-editor', 'strategy-tester', 'watchlist', 'alerts', 'trading'])).optional().describe('Optional panels to open after the layout is active'),
    dry_run: z.coerce.boolean().optional().describe('If true, only resolve and describe what would happen without changing TradingView'),
  }, async ({ name, symbol, timeframe, panels, dry_run }) => {
    try { return jsonResult(await core.openStrategy({ name, symbol, timeframe, panels, dry_run })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
