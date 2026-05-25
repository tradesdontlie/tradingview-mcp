// Snapshot / price tools ported from atilaahmettaner Python MCP.
// Group A: Yahoo-Finance-backed read-only quotes + macro snapshots.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as yahoo from '../core/yahoo.js';
import * as btcMarket from '../core/bitcoin_market.js';
import * as extendedHours from '../core/extended_hours.js';

export function registerSnapshotTools(server) {
  server.tool(
    'yahoo_price',
    'Real-time price quote from Yahoo Finance for any stock, crypto, ETF or index. Examples: AAPL, BTC-USD, SPY, ^GSPC, EURUSD=X, THYAO.IS, RELIANCE.NS.',
    {
      symbol: z.string().describe('Yahoo Finance symbol'),
    },
    async ({ symbol }) => {
      try {
        return jsonResult(await yahoo.getPrice(symbol));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'market_snapshot',
    'Snapshot of major global markets: indices (S&P500, Dow, NASDAQ, VIX), crypto (BTC, ETH, SOL, BNB), FX (EUR/GBP/JPY USD), ETFs (SPY, QQQ, GLD). One call returns symbol/price/change_pct/currency per group.',
    {},
    async () => {
      try {
        return jsonResult(await yahoo.getMarketSnapshot());
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'stock_extended_hours',
    'Latest pre-market / regular / post-market prices for a US stock symbol. Returns separate blocks per session with timestamps + change % vs previous close. Walks 1m candles from Yahoo includePrePost=true. Returns null per session when no print exists.',
    {
      symbol: z.string().describe('US stock symbol (e.g. AAPL, NVDA, SPY)'),
    },
    async ({ symbol }) => {
      try {
        return jsonResult(await extendedHours.getExtendedHoursPrice(symbol));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bitcoin_market_pulse',
    'Single-call BTC macro context: price + 24h change, BTC/ETH dominance, total crypto market cap, and a labeled risk assessment (HIGH_RISK / OPPORTUNITY_WITH_CAUTION / ALT_RISK / ALT_FAVORABLE / NEUTRAL) for alt-coin decisions. Source: CoinGecko public API. No key needed.',
    {},
    async () => {
      try {
        return jsonResult(await btcMarket.getBitcoinMarketPulse());
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
