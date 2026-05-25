// Hyperliquid tools (Phase 1.5) — 6 tools.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as hl from '../core/hyperliquid.js';

const INTERVALS = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);

export function registerHyperliquidTools(server) {
  server.tool(
    'hyperliquid_meta',
    'Universe of perps on Hyperliquid: name, leverage limits, margin tables. No auth, free.',
    {},
    async () => {
      try { return jsonResult(await hl.meta()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'hyperliquid_ticker',
    'Live ticker for a Hyperliquid perp: mark price, oracle price, funding rate, open interest, 24h volume.',
    { coin: z.string().describe('e.g. BTC, ETH, SOL') },
    async ({ coin }) => {
      try { return jsonResult(await hl.getTicker(coin)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'hyperliquid_orderbook',
    'L2 orderbook snapshot for a perp. Returns top N levels of bids + asks.',
    {
      coin: z.string(),
      n_levels: z.number().int().min(1).max(50).default(10),
    },
    async ({ coin, n_levels }) => {
      try { return jsonResult(await hl.l2Snapshot({ coin, nLevels: n_levels })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'hyperliquid_candles',
    'OHLCV candle history for a perp. Returns last 100 candles by default.',
    {
      coin: z.string(),
      interval: INTERVALS.default('1h'),
      lookback_hours: z.number().int().min(1).max(720).optional(),
    },
    async ({ coin, interval, lookback_hours }) => {
      try {
        const end = Date.now();
        const start = lookback_hours ? end - lookback_hours * 3_600_000 : undefined;
        return jsonResult(await hl.candleSnapshot({ coin, interval, startTime: start, endTime: end }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'hyperliquid_funding',
    'Funding rate history for a Hyperliquid perp over the last 7 days (default).',
    { coin: z.string() },
    async ({ coin }) => {
      try { return jsonResult(await hl.fundingHistory({ coin })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'hyperliquid_open_interest_history',
    'Snapshot OI + ticker context for all perps. Useful as a market-wide OI/funding screener.',
    {},
    async () => {
      try {
        const r = await hl.metaAndAssetCtxs();
        if (!Array.isArray(r) || r.length < 2) return jsonResult({ error: 'unexpected response' });
        const [meta, ctxs] = r;
        const rows = (meta?.universe || []).map((u, i) => ({
          coin: u.name,
          mark_price: Number(ctxs[i]?.markPx ?? 'NaN'),
          oracle_price: Number(ctxs[i]?.oraclePx ?? 'NaN'),
          funding: Number(ctxs[i]?.funding ?? 'NaN'),
          open_interest: Number(ctxs[i]?.openInterest ?? 'NaN'),
          day_volume: Number(ctxs[i]?.dayNtlVlm ?? 'NaN'),
        }));
        return jsonResult({ count: rows.length, rows });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
