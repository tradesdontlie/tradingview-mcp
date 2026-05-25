// Snapshot / price tools ported from atilaahmettaner Python MCP.
// Group A: Yahoo-Finance-backed read-only quotes + macro snapshots.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as yahoo from '../core/yahoo.js';
import * as btcMarket from '../core/bitcoin_market.js';
import * as extendedHours from '../core/extended_hours.js';
import * as options from '../core/options.js';
import * as exchangesCore from '../core/exchanges.js';

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
    'exchanges_list',
    'List TradingView-supported exchanges, grouped by category (crypto, india_equities, india_derivatives, india_crypto, global_equities, asia_equities, middle_east, australia). Returns by_category + flat all + count.',
    {},
    async () => {
      try {
        return jsonResult(exchangesCore.listExchanges());
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'stock_options_unusual_activity',
    'Rank options contracts by today volume / standing open-interest ratio across the soonest N expirations. Flags strikes where today V is a multiple of OI — classic institutional positioning signal. Filters illiquid noise via min_volume. Returns top_n unusual contracts with V/OI, IV, strike-vs-spot %, plus aggregate put/call totals.',
    {
      symbol: z.string().describe('US stock symbol'),
      top_n: z.number().int().min(1).max(50).default(10).describe('How many top strikes to return'),
      min_volume: z.number().int().min(1).default(100).describe('Min volume floor to filter illiquid noise'),
      expiries: z.number().int().min(1).max(10).default(4).describe('How many soonest expirations to scan'),
    },
    async ({ symbol, top_n, min_volume, expiries }) => {
      try {
        return jsonResult(await options.getUnusualOptionsActivity(symbol, { top_n, min_volume, expiries }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'stock_options_chain',
    'Full options chain (calls + puts) for a US stock symbol and one expiry. If expiry omitted, uses the nearest. Each contract: strike, last, bid, ask, volume, open_interest, IV, in_the_money, expiration.',
    {
      symbol: z.string().describe('US stock symbol (e.g. AAPL, TSLA, SPY)'),
      expiry: z.string().optional().describe('Optional ISO date YYYY-MM-DD'),
    },
    async ({ symbol, expiry }) => {
      try {
        return jsonResult(await options.getOptionsChain(symbol, expiry));
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
