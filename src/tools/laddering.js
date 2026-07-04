import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/laddering.js';

/**
 * Laddering tools — pure order-construction arithmetic, no live chart/exchange
 * calls of their own. Encodes Chapter 1 (1.9.2, "Laddering"): split a single
 * intended order into N equally-sized limit orders at N equally-spaced price
 * levels across a range, "to lower the average buying price" — exactly the
 * curriculum's worked example ("$10k... 5 different buy orders, each valued
 * at $2k, across a price range of $25k to $26k"). An order-construction aid
 * for entries, not a directional signal — it doesn't feed confluence_assess.
 */
export function registerLadderingTools(server) {
  server.tool(
    'laddering_build_orders',
    'Split a single intended order into N equally-sized limit orders at N equally-spaced price levels spanning a range ' +
    '(Chapter 1\'s "price ladder trading" — "distribute 5 different buy orders, each valued at $2k, across a price range of ' +
    '$25k to $26k" to lower the average entry price). Returns the order list (price + size per rung), the size per order, and ' +
    'the resulting average fill price assuming every rung executes.',
    {
      side: z.enum(['buy', 'sell']).describe('Order side'),
      total_size: z.coerce.number().positive().describe('Total notional/quantity to split across the ladder (e.g. 10000 for $10k total)'),
      price_low: z.coerce.number().positive().describe('Lower bound of the price range to ladder across'),
      price_high: z.coerce.number().positive().describe('Upper bound of the price range to ladder across (must exceed price_low)'),
      num_orders: z.coerce.number().int().min(2).describe('How many equally-sized, equally-spaced orders to split into (at least 2 — laddering means "multiple")'),
    },
    async ({ side, total_size, price_low, price_high, num_orders }) => {
      try {
        return jsonResult({
          success: true,
          ...core.buildLadderOrders({ side, totalSize: total_size, priceLow: price_low, priceHigh: price_high, numOrders: num_orders }),
        });
      } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
