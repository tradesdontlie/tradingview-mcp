// India broker read-only MCP tools. Unified surface across:
//   Upstox       — NSE/BSE equities + F&O
//   Delta India  — crypto F&O (perps + futures)
//   CoinDCX      — Indian crypto spot

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as upstox from '../core/brokers/upstox.js';
import * as delta from '../core/brokers/delta_india.js';
import * as coindcx from '../core/brokers/coindcx.js';
import { safeStatus } from '../core/secrets.js';

const BROKER = z.enum(['upstox', 'delta', 'coindcx']);

async function dispatch(broker, action) {
  switch (broker) {
    case 'upstox':  return action.upstox();
    case 'delta':   return action.delta();
    case 'coindcx': return action.coindcx();
    default: throw new Error(`unknown broker ${broker}`);
  }
}

export function registerBrokerTools(server) {
  server.tool(
    'broker_status',
    'Show which India brokers have API keys configured (read-only paths). Reports config file location.',
    {},
    async () => jsonResult(safeStatus())
  );

  server.tool(
    'broker_holdings',
    'Holdings / wallet balances for an India broker. Upstox: long-term holdings. Delta: wallet balances. CoinDCX: balances.',
    { broker: BROKER },
    async ({ broker }) => {
      try {
        return jsonResult({
          broker,
          data: await dispatch(broker, {
            upstox: upstox.holdings,
            delta: delta.walletBalances,
            coindcx: coindcx.balances,
          }),
        });
      } catch (err) {
        return jsonResult({ success: false, broker, error: err.message }, true);
      }
    }
  );

  server.tool(
    'broker_positions',
    'Open positions. Upstox: short-term positions. Delta: open positions. CoinDCX: trade history snapshot (no native positions).',
    { broker: BROKER },
    async ({ broker }) => {
      try {
        return jsonResult({
          broker,
          data: await dispatch(broker, {
            upstox: upstox.positions,
            delta: delta.openPositions,
            coindcx: coindcx.tradeHistory,
          }),
        });
      } catch (err) {
        return jsonResult({ success: false, broker, error: err.message }, true);
      }
    }
  );

  server.tool(
    'broker_orders',
    'Order list / history. Upstox retrieves all. Delta: open orders. CoinDCX: active orders.',
    { broker: BROKER },
    async ({ broker }) => {
      try {
        return jsonResult({
          broker,
          data: await dispatch(broker, {
            upstox: upstox.orders,
            delta: delta.orderHistory,
            coindcx: coindcx.activeOrders,
          }),
        });
      } catch (err) {
        return jsonResult({ success: false, broker, error: err.message }, true);
      }
    }
  );

  server.tool(
    'broker_funds',
    'Account funds + margin info.',
    { broker: BROKER },
    async ({ broker }) => {
      try {
        return jsonResult({
          broker,
          data: await dispatch(broker, {
            upstox: upstox.funds,
            delta: delta.walletBalances,
            coindcx: coindcx.userInfo,
          }),
        });
      } catch (err) {
        return jsonResult({ success: false, broker, error: err.message }, true);
      }
    }
  );

  server.tool(
    'broker_ltp',
    'Last traded price. Upstox: pass instrument_key (e.g. NSE_EQ|INE002A01018). Delta: pass symbol (e.g. BTCUSDT). CoinDCX: pass market (e.g. BTCINR). Returns broker raw payload.',
    {
      broker: BROKER,
      symbol: z.string().describe('Broker-native identifier'),
    },
    async ({ broker, symbol }) => {
      try {
        if (broker === 'upstox') return jsonResult({ broker, data: await upstox.ltp(symbol) });
        if (broker === 'delta') return jsonResult({ broker, data: await delta.ticker(symbol) });
        if (broker === 'coindcx') {
          const t = await coindcx.tickers();
          const match = (t || []).find(x => x.market === symbol);
          return jsonResult({ broker, data: match || { error: `market ${symbol} not found` } });
        }
        throw new Error(`unknown broker ${broker}`);
      } catch (err) {
        return jsonResult({ success: false, broker, error: err.message }, true);
      }
    }
  );

  server.tool(
    'broker_markets',
    'List public market metadata (no auth). Delta: products. CoinDCX: markets. Upstox: instruments (large, skipped here).',
    {
      broker: z.enum(['delta', 'coindcx']),
    },
    async ({ broker }) => {
      try {
        if (broker === 'delta') return jsonResult({ broker, data: await delta.products() });
        if (broker === 'coindcx') return jsonResult({ broker, data: await coindcx.markets() });
        throw new Error(`unknown broker ${broker}`);
      } catch (err) {
        return jsonResult({ success: false, broker, error: err.message }, true);
      }
    }
  );
}
