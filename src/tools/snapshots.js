// Snapshot / price tools ported from atilaahmettaner Python MCP.
// Group A: Yahoo-Finance-backed read-only quotes + macro snapshots.

import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as yahoo from '../core/yahoo.js';

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
}
