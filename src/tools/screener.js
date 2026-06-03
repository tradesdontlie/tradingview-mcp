import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener.js';

export function registerScreenerTools(server) {
  server.tool(
    'screener_scan',
    'Run a market screener via an AUTHENTICATED fetch to scanner.tradingview.com from inside your logged-in TradingView session (not anonymous, so not rate-limited). Discovers movers across a whole market — the one thing the chart tools cannot do. market: us/egypt/uae/ksa/crypto/global. Pass filters as scanner clauses, e.g. [{"left":"exchange","operation":"equal","right":"NASDAQ"},{"left":"RSI","operation":"in_range","right":[35,65]}].',
    {
      market: z.string().optional().describe('Market: us, egypt, uae, ksa, crypto, global (default us/america)'),
      columns: z.array(z.string()).optional().describe('Column ids, e.g. ["name","close","change","volume","RSI","EMA50","EMA200","ADX"]'),
      filters: z.array(z.object({
        left: z.string(),
        operation: z.string(),
        right: z.any(),
      })).optional().describe('Scanner filter clauses {left, operation, right}'),
      sort_by: z.string().optional().describe('Column id to sort by (e.g. "change", "volume")'),
      sort_order: z.enum(['asc', 'desc']).optional().describe('Sort order (default desc)'),
      limit: z.coerce.number().optional().describe('Max rows (default 50)'),
      tickers: z.array(z.string()).optional().describe('Explicit tickers (e.g. ["NASDAQ:AAPL"]) — tickers mode, ignores filters'),
    },
    async ({ market, columns, filters, sort_by, sort_order, limit, tickers }) => {
      try {
        return jsonResult(await core.scan({
          market,
          columns,
          filters,
          tickers,
          sort: sort_by ? { sortBy: sort_by, sortOrder: sort_order } : undefined,
          range: limit ? [0, Math.max(1, Math.floor(limit))] : undefined,
        }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message, hint: 'Ensure TradingView Desktop is logged in. Column/filter ids must match TradingView scanner schema.' }, true);
      }
    },
  );

  server.tool(
    'screener_quote',
    'Get a real-time quote for ANY symbol WITHOUT changing the chart, via the authenticated scanner. Use a fully-qualified ticker like "NASDAQ:AAPL" or "EGX:COMI" for reliable resolution.',
    {
      symbol: z.string().describe('Fully-qualified ticker, e.g. NASDAQ:NVDA, EGX:COMI, DFM:EMAAR'),
    },
    async ({ symbol }) => {
      try { return jsonResult(await core.quoteSymbol(symbol)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
